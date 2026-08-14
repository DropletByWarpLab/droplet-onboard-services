"""WARP-519 — shared in-process run state for rag-eval.

A single source of truth for "is a RAGAS run currently in flight?", shared
between the apscheduler cron job and the FastAPI HTTP triggers so a manual
`POST /run` can never overlap a scheduled run (and vice-versa). This is the
in-process equivalent of apscheduler's `max_instances=1`, extended to also
cover the HTTP-triggered path that apscheduler doesn't see.

Design (per CLAUDE.md "no guessing, ever"):
  - Run status is an EXPLICIT enum field on an in-memory record, never
    derived from file absence. The filesystem is the source of truth for
    TERMINAL runs that survive a restart: finish() persists a durable
    record-<runId>.json (succeeded AND failed, runs AND bootstraps) next
    to the runner's results-*.json. This in-memory dict is the source of
    truth for IN-FLIGHT runs only. A rag-eval restart forgets in-flight
    runs — that's documented and acceptable.
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

import json
import logging
import os
import threading

logger = logging.getLogger(__name__)
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

# IDX-08 — cap the in-memory history so it can't grow unbounded. The hourly
# cron would otherwise add ~8,760 RunRecords/year with no eviction, despite the
# "bounded history" docstring. The filesystem (results-*.json) stays
# authoritative for older runs, so trimming the in-memory tail only costs a
# filesystem re-read for a run older than the last `_MAX_RECORDS`.
_MAX_RECORDS = 256


class RunStatus(str, Enum):
    """Explicit run lifecycle states. `unknown` is a first-class value
    returned for a runId we have no in-memory record of AND no results
    file for — never inferred silently."""

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    # WARP-1868: the scheduled slot fired, the corpus gate found nothing had
    # changed, and no GPU work happened. Deliberately its own state rather
    # than a SUCCEEDED with zero metrics (which would poison the baselines)
    # or an absence (which reads as a missed slot or a crashed container).
    # A skip is a decision, and an operator should be able to see it taken.
    SKIPPED = "skipped"
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


def _record_payload(rec: RunRecord) -> dict[str, Any]:
    """Wire/disk shape of a terminal run record. Matches what the server's
    GET /runs returns for in-memory records, so a record file loaded after
    a restart is indistinguishable from a live one."""
    payload: dict[str, Any] = {
        "runId": rec.run_id,
        "kind": rec.kind,
        "status": rec.status.value,
        "startedAt": rec.started_at.isoformat(),
        "finishedAt": rec.finished_at.isoformat() if rec.finished_at else None,
    }
    if rec.error:
        payload["error"] = rec.error
    if rec.kind == "bootstrap":
        payload["runsTotal"] = rec.runs_total
        payload["runsDone"] = rec.runs_done
    return payload


def _persist_record(run_id: str, payload: dict[str, Any]) -> None:
    """Best-effort atomic write of RUNS_DIR/record-<runId>.json.

    Never raises — a full disk or bad mount must not break finish() (the
    busy-flag clear already happened; losing one record is the lesser
    evil, and the failure is logged). tmp-file + os.replace so a reader
    (GET /runs globbing record-*.json) never sees a half-written file.
    """
    try:
        # Imported (and the dir resolved) at CALL time, not module import:
        # keeps `import run_state` stdlib-only for the unit suite and lets
        # tests monkeypatch config.RUNS_DIR per-test.
        import config

        runs_dir = config.RUNS_DIR
        runs_dir.mkdir(parents=True, exist_ok=True)
        tmp = runs_dir / f"record-{run_id}.json.tmp"
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.replace(tmp, runs_dir / f"record-{run_id}.json")
    except Exception:  # noqa: BLE001 — best-effort by contract
        logger.warning("failed to persist run record %s", run_id, exc_info=True)


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
        # Keep a bounded history (capped at `_MAX_RECORDS`, evicted oldest-first
        # in `_evict_locked`) so GET /runs/{id} can answer for recent runs
        # without re-reading the filesystem. The filesystem remains
        # authoritative for older/evicted runs.
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
            self._evict_locked()
            return True, None

    def _evict_locked(self) -> None:
        """Trim oldest records down to `_MAX_RECORDS` (caller holds `_lock`).

        dict is insertion-ordered, so the oldest run_ids come first. The
        current in-flight run is never evicted, even if it sorts oldest, so a
        long-running bootstrap can't lose its own status record.
        """
        overflow = len(self._records) - _MAX_RECORDS
        if overflow <= 0:
            return
        for run_id in list(self._records.keys()):
            if overflow <= 0:
                break
            if run_id == self._current_run_id:
                continue
            del self._records[run_id]
            overflow -= 1

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

        Also persists a durable record-<runId>.json (best-effort, atomic)
        so terminal runs — crucially FAILED ones, which write no results
        file — survive both current_run_id clearing and a restart. This is
        the single choke point covering the HTTP and scheduler paths.
        """
        payload: Optional[dict[str, Any]] = None
        with self._lock:
            rec = self._records.get(run_id)
            if rec is not None:
                rec.status = status
                rec.finished_at = self._now()
                rec.error = error
                payload = _record_payload(rec)
            if self._current_run_id == run_id:
                self._busy = False
                self._current_run_id = None
            elif self._busy:
                # GWV-013: honor the docstring — a finish() with a mismatched id
                # must still release the busy flag, or a caller bug wedges the
                # service permanently busy (every /run, /bootstrap, tick 409s).
                logger.warning(
                    "RunStateStore.finish(%s) while current_run_id=%s — clearing busy anyway",
                    run_id, self._current_run_id,
                )
                self._busy = False
                self._current_run_id = None
        # Outside the lock: file I/O must never delay (or, on error, block)
        # another try_begin. The record was snapshotted under the lock.
        if payload is not None:
            _persist_record(run_id, payload)

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
