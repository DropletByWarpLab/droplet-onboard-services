"""WARP-519 — shared in-process run state for rag-eval.

A single source of truth for "is a RAGAS run currently in flight?", shared
between the apscheduler cron job and the FastAPI HTTP triggers so a manual
`POST /run` can never overlap a scheduled run (and vice-versa). This is the
in-process equivalent of apscheduler's `max_instances=1`, extended to also
cover the HTTP-triggered path that apscheduler doesn't see.

Design (per CLAUDE.md "no guessing, ever"):
  - Run status is an EXPLICIT enum field on an in-memory record, never
    derived from file absence. The filesystem (results-*.json) is the
    source of truth for COMPLETED runs that survive a restart; this
    in-memory dict is the source of truth for IN-FLIGHT runs. A rag-eval
    restart forgets in-flight runs — that's documented and acceptable.
  - A single asyncio.Lock-free flag (`_busy`) guards admission. We use a
    plain threading.Lock because the actual run executes in a thread
    executor (`loop.run_in_executor`), so the flag is touched from both
    the event-loop thread (admission, completion callbacks) and is read
    from the worker thread's wrapper. threading.Lock is the safe primitive
    across both.

The scheduler's `max_instances=1` still applies to back-to-back cron fires;
this module's flag is what makes the cron job and the HTTP triggers mutually
exclusive.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional


class RunStatus(str, Enum):
    """Explicit run lifecycle states. `unknown` is a first-class value
    returned for a runId we have no in-memory record of AND no results
    file for — never inferred silently."""

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    UNKNOWN = "unknown"


@dataclass
class RunRecord:
    """One in-flight or recently-finished run tracked in memory.

    `kind` distinguishes a single `/run` from a multi-pass `/bootstrap` so
    the status endpoint can report bootstrap progress. `runs_total` /
    `runs_done` are only meaningful for bootstrap.
    """

    run_id: str
    kind: str  # "run" | "bootstrap"
    status: RunStatus
    started_at: datetime
    finished_at: Optional[datetime] = None
    error: Optional[str] = None
    runs_total: Optional[int] = None
    runs_done: int = 0


class RunStateStore:
    """Thread-safe registry of run records + the single busy flag.

    All public methods take the internal lock; callers never touch
    `_lock` directly. `try_begin` is the admission gate: it atomically
    checks the busy flag and, if free, records a new RUNNING record and
    flips the flag — returning False (and the current run's id) if a run
    is already in flight.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._busy = False
        self._current_run_id: Optional[str] = None
        # Keep a bounded history so GET /runs/{id} can answer for runs
        # that finished since the last restart without re-reading the
        # filesystem. The filesystem remains authoritative for older runs.
        self._records: dict[str, RunRecord] = {}

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    def try_begin(
        self, run_id: str, kind: str, runs_total: Optional[int] = None
    ) -> tuple[bool, Optional[str]]:
        """Atomically admit a new run.

        Returns (True, None) and records a RUNNING entry if no run is in
        flight. Returns (False, current_run_id) if one already is — the
        caller maps that to HTTP 409.
        """
        with self._lock:
            if self._busy:
                return False, self._current_run_id
            self._busy = True
            self._current_run_id = run_id
            self._records[run_id] = RunRecord(
                run_id=run_id,
                kind=kind,
                status=RunStatus.RUNNING,
                started_at=self._now(),
                runs_total=runs_total,
            )
            return True, None

    def mark_bootstrap_progress(self, run_id: str, runs_done: int) -> None:
        with self._lock:
            rec = self._records.get(run_id)
            if rec is not None:
                rec.runs_done = runs_done

    def finish(
        self, run_id: str, status: RunStatus, error: Optional[str] = None
    ) -> None:
        """Mark a run finished (succeeded/failed) and clear the busy flag.

        Always clears `_busy` even if the run_id is unknown to us, so a
        bug in the caller can't wedge the service into a permanently-busy
        state.
        """
        with self._lock:
            rec = self._records.get(run_id)
            if rec is not None:
                rec.status = status
                rec.finished_at = self._now()
                rec.error = error
            if self._current_run_id == run_id:
                self._busy = False
                self._current_run_id = None

    def get(self, run_id: str) -> Optional[RunRecord]:
        with self._lock:
            return self._records.get(run_id)

    def current_run_id(self) -> Optional[str]:
        with self._lock:
            return self._current_run_id

    def is_busy(self) -> bool:
        with self._lock:
            return self._busy


# Process-wide singleton. Both scheduler_service (cron path) and server
# (HTTP path) import THIS instance so the busy flag is genuinely shared.
STORE = RunStateStore()
