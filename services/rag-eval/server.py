"""WARP-519 — FastAPI HTTP trigger surface for rag-eval.

Lets operators fire ad-hoc RAGAS runs and the baseline bootstrap from the
dashboard (via the orchestrator proxy) without `docker exec`. Binds on the
internal Docker network ONLY — no host publish, no auth here. The
orchestrator's `/api/admin/rag-eval/*` route is the auth wall; this server
trusts that anything reaching it on the bridge network is already gated.

Endpoints:
  POST /run            → start one RAGAS pass as a background task; 202.
  POST /bootstrap      → start N sequential passes + aggregate; 202.
  GET  /runs           → recent runs from the filesystem (+ in-flight).
  GET  /runs/{run_id}  → status of one run (explicit enum, never inferred).
  GET  /baselines      → baselines.candidate.json if present, else 404.
  GET  /health         → liveness probe.

Concurrency: a single shared `run_state.STORE` busy flag (also consulted by
the scheduler's cron job) enforces max_instances=1 across BOTH the schedule
and the HTTP triggers. Background tasks run the blocking RAGAS subprocess in
a thread executor so the event loop / HTTP server never stalls.

The filesystem (results-*.json under RUNS_DIR) is the source of truth for
COMPLETED runs; the in-memory STORE is the source of truth for IN-FLIGHT
runs. A restart forgets in-flight runs — documented, acceptable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import runner
from config import BASELINES_CANDIDATE, RESULTS_DIR, RUNS_DIR
from run_state import STORE, RunRecord, RunStatus

logger = logging.getLogger("rag-eval.server")

# results-<YYYYMMDDTHHMMSSZ>.json — matches runner._utc_stamp()'s format.
_RESULTS_RE = re.compile(r"^results-(\d{8}T\d{6}Z)\.json$")

# Cap on how many runs GET /runs returns. The filesystem can accumulate
# hundreds over weeks of cron runs; the dashboard only shows the latest.
_RUNS_LIST_CAP = 20

# Bootstrap clamp — mirrors main.py cmd_bootstrap's intent. 1..10 keeps a
# single HTTP-triggered bootstrap bounded (10 runs ≈ 2h on the appliance).
_BOOTSTRAP_MIN = 1
_BOOTSTRAP_MAX = 10
_BOOTSTRAP_DEFAULT = 5


class BootstrapBody(BaseModel):
    runs: int = Field(default=_BOOTSTRAP_DEFAULT)


def _load_metrics(results_path: Path) -> Optional[dict[str, Any]]:
    """Best-effort read of the top-level `metrics` block from a results
    JSON. Returns None if the file is missing/unreadable/has no metrics —
    we never fabricate numbers."""
    try:
        with results_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    metrics = data.get("metrics")
    return metrics if isinstance(metrics, dict) else None


def _stamp_to_iso(stamp: str) -> Optional[str]:
    """Convert a YYYYMMDDTHHMMSSZ stamp to ISO-8601 for the wire."""
    try:
        dt = datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(
            tzinfo=timezone.utc
        )
        return dt.isoformat()
    except ValueError:
        return None


def _record_to_wire(rec: RunRecord) -> dict[str, Any]:
    wire: dict[str, Any] = {
        "runId": rec.run_id,
        "kind": rec.kind,
        "status": rec.status.value,
        "startedAt": rec.started_at.isoformat(),
        "finishedAt": rec.finished_at.isoformat() if rec.finished_at else None,
    }
    if rec.error:
        wire["error"] = rec.error
    if rec.kind == "bootstrap":
        wire["runsTotal"] = rec.runs_total
        wire["runsDone"] = rec.runs_done
    return wire


# ── Background task bodies ──────────────────────────────────────────────


def _run_once_blocking(run_id: str) -> None:
    """Executor-thread body for a single /run. Updates STORE on finish."""
    try:
        runner.run_once()
    except Exception as exc:  # noqa: BLE001 — surface, never crash the loop
        logger.exception("HTTP-triggered run failed (run_id=%s)", run_id)
        STORE.finish(run_id, RunStatus.FAILED, error=str(exc))
        return
    STORE.finish(run_id, RunStatus.SUCCEEDED)
    logger.info("HTTP-triggered run complete (run_id=%s)", run_id)


def _bootstrap_blocking(run_id: str, n_runs: int) -> None:
    """Executor-thread body for /bootstrap. Mirrors main.py cmd_bootstrap:
    N sequential runs into an isolated per-bootstrap subdir, then aggregate
    into baselines.candidate.json. Updates STORE progress + final status."""
    bootstrap_dir = RESULTS_DIR / f"bootstrap-{run_id}"
    logger.info(
        "HTTP-triggered bootstrap: %d runs into %s then aggregate",
        n_runs,
        bootstrap_dir,
    )
    failures = 0
    for i in range(1, n_runs + 1):
        logger.info("bootstrap run %d / %d (run_id=%s)", i, n_runs, run_id)
        try:
            runner.run_once(target_dir=bootstrap_dir)
        except Exception:  # noqa: BLE001
            failures += 1
            logger.exception("bootstrap run %d failed", i)
        STORE.mark_bootstrap_progress(run_id, i)

    if failures == n_runs:
        logger.error("all %d bootstrap runs failed; not aggregating", n_runs)
        STORE.finish(run_id, RunStatus.FAILED, error="all bootstrap runs failed")
        return
    try:
        runner.aggregate_to_baselines(
            BASELINES_CANDIDATE, results_dir=bootstrap_dir
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("bootstrap aggregate step failed (run_id=%s)", run_id)
        STORE.finish(run_id, RunStatus.FAILED, error=f"aggregate failed: {exc}")
        return
    STORE.finish(run_id, RunStatus.SUCCEEDED)
    logger.info(
        "HTTP-triggered bootstrap complete — %d/%d ok, baselines at %s",
        n_runs - failures,
        n_runs,
        BASELINES_CANDIDATE,
    )


# ── App factory ─────────────────────────────────────────────────────────


def create_app() -> FastAPI:
    app = FastAPI(title="rag-eval HTTP trigger", version="1.0.0")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/run")
    async def post_run() -> JSONResponse:
        run_id = runner._utc_stamp()
        admitted, current = STORE.try_begin(run_id, kind="run")
        if not admitted:
            return JSONResponse(
                status_code=409,
                content={"error": "run_in_progress", "runId": current},
            )
        loop = asyncio.get_running_loop()
        # Fire-and-forget on the executor; the task updates STORE on finish.
        loop.run_in_executor(None, _run_once_blocking, run_id)
        started_at = datetime.now(timezone.utc).isoformat()
        return JSONResponse(
            status_code=202,
            content={"runId": run_id, "startedAt": started_at},
        )

    @app.post("/bootstrap")
    async def post_bootstrap(body: BootstrapBody) -> JSONResponse:
        n_runs = max(_BOOTSTRAP_MIN, min(_BOOTSTRAP_MAX, body.runs))
        run_id = runner._utc_stamp()
        admitted, current = STORE.try_begin(
            run_id, kind="bootstrap", runs_total=n_runs
        )
        if not admitted:
            return JSONResponse(
                status_code=409,
                content={"error": "run_in_progress", "runId": current},
            )
        loop = asyncio.get_running_loop()
        loop.run_in_executor(None, _bootstrap_blocking, run_id, n_runs)
        started_at = datetime.now(timezone.utc).isoformat()
        return JSONResponse(
            status_code=202,
            content={
                "runId": run_id,
                "startedAt": started_at,
                "runs": n_runs,
            },
        )

    @app.get("/runs")
    async def get_runs() -> dict[str, Any]:
        """Recent runs, newest first, capped. Reads completed runs from the
        filesystem and overlays any in-flight record from STORE so a run
        that hasn't written its file yet still shows as `running`."""
        items: dict[str, dict[str, Any]] = {}

        # Filesystem — completed runs (the durable source of truth).
        if RUNS_DIR.exists():
            for path in RUNS_DIR.glob("results-*.json"):
                m = _RESULTS_RE.match(path.name)
                if not m:
                    continue
                stamp = m.group(1)
                items[stamp] = {
                    "runId": stamp,
                    "kind": "run",
                    "status": RunStatus.SUCCEEDED.value,
                    "startedAt": _stamp_to_iso(stamp),
                    "finishedAt": _stamp_to_iso(stamp),
                    "resultsPath": str(path),
                    "metrics": _load_metrics(path),
                }

        # Overlay in-flight / tracked records (running/failed) from memory.
        # An in-flight run has no results file yet; a failed one may not
        # either. These take precedence over a same-id filesystem entry.
        current = STORE.current_run_id()
        if current is not None:
            rec = STORE.get(current)
            if rec is not None:
                items[current] = _record_to_wire(rec)

        ordered = sorted(items.values(), key=lambda r: r["runId"], reverse=True)
        return {"runs": ordered[:_RUNS_LIST_CAP]}

    @app.get("/runs/{run_id}")
    async def get_run(run_id: str) -> JSONResponse:
        """Status of a single run. Explicit enum — `unknown` when we have
        neither an in-memory record nor a results file."""
        rec = STORE.get(run_id)
        results_path = RUNS_DIR / f"results-{run_id}.json"

        if rec is not None:
            body = _record_to_wire(rec)
            if results_path.exists():
                body["resultsPath"] = str(results_path)
                body["metrics"] = _load_metrics(results_path)
            return JSONResponse(status_code=200, content=body)

        # No in-memory record. Fall back to the filesystem: a completed run
        # from before a restart, or before this process owned it.
        if results_path.exists():
            return JSONResponse(
                status_code=200,
                content={
                    "runId": run_id,
                    "kind": "run",
                    "status": RunStatus.SUCCEEDED.value,
                    "startedAt": _stamp_to_iso(run_id),
                    "finishedAt": _stamp_to_iso(run_id),
                    "resultsPath": str(results_path),
                    "metrics": _load_metrics(results_path),
                },
            )

        # Neither — explicitly unknown, NOT inferred-failed.
        return JSONResponse(
            status_code=200,
            content={"runId": run_id, "status": RunStatus.UNKNOWN.value},
        )

    @app.get("/baselines")
    async def get_baselines() -> JSONResponse:
        if not BASELINES_CANDIDATE.exists():
            return JSONResponse(
                status_code=404, content={"error": "no_baselines"}
            )
        try:
            with BASELINES_CANDIDATE.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            return JSONResponse(
                status_code=500,
                content={"error": "baselines_unreadable", "detail": str(exc)},
            )
        return JSONResponse(status_code=200, content=data)

    return app
