"""WARP-519 — FastAPI HTTP trigger surface for rag-eval.

Lets operators fire ad-hoc RAGAS runs and the baseline bootstrap from the
dashboard (via the orchestrator proxy) without `docker exec`. Binds on the
internal Docker network ONLY — no host publish, no auth here. The
orchestrator's `/api/admin/rag-eval/*` route is the auth wall; this server
trusts that anything reaching it on the bridge network is already gated.

Endpoints:
  POST /run            → start one RAGAS pass as a background task; 202.
  POST /bootstrap      → start N sequential passes + aggregate; 202.
  GET  /runs           → recent runs: durable record files + legacy
                         results files (+ in-flight from memory).
  GET  /runs/{run_id}  → status of one run (explicit enum).
  GET  /baselines      → baselines.candidate.json if present, else 404.
  GET  /health         → liveness probe.

Concurrency: a single shared `run_state.STORE` busy flag (also consulted by
the scheduler's cron job) enforces max_instances=1 across BOTH the schedule
and the HTTP triggers. Background tasks run the blocking RAGAS subprocess in
a thread executor so the event loop / HTTP server never stalls.

The filesystem under RUNS_DIR is the source of truth for TERMINAL runs:
record-<runId>.json written by run_state.finish() (succeeded AND failed,
runs AND bootstraps) plus the runner's results-*.json. The in-memory STORE
is the source of truth for IN-FLIGHT runs only. A restart forgets in-flight
runs — documented, acceptable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import runner
# Paths are read as `config.X` at CALL time (not `from config import X`) so
# tests can monkeypatch config.RUNS_DIR / RESULTS_DIR / BASELINES_CANDIDATE
# per-test — the same contract run_state's record persistence follows.
import config
from run_state import STORE, RunRecord, RunStatus

logger = logging.getLogger("rag-eval.server")

# results-<YYYYMMDDTHHMMSSZ>.json — matches runner._utc_stamp()'s format.
_RESULTS_RE = re.compile(r"^results-(\d{8}T\d{6}Z)\.json$")

# record-<YYYYMMDDTHHMMSSZ>.json — durable terminal-run records written by
# run_state.finish(). runIds are always _utc_stamp() output, so the same
# stamp shape applies.
_RECORD_RE = re.compile(r"^record-(\d{8}T\d{6}Z)\.json$")

# Cap on how many runs GET /runs returns. The filesystem can accumulate
# hundreds over weeks of cron runs; the dashboard only shows the latest.
_RUNS_LIST_CAP = 20

# Sentinel for "baselines file absent" — distinct from any JSON value the
# file could legally contain (including null).
_MISSING = object()

# Bootstrap clamp — mirrors main.py cmd_bootstrap's intent. 1..10 keeps a
# single HTTP-triggered bootstrap bounded (10 runs ≈ 2h on the appliance).
_BOOTSTRAP_MIN = 1
_BOOTSTRAP_MAX = 10
_BOOTSTRAP_DEFAULT = 5


class BootstrapBody(BaseModel):
    runs: int = Field(default=_BOOTSTRAP_DEFAULT)


def _nan_to_null(_token: str) -> None:
    """json.load parse_constant hook — fires for the non-standard NaN /
    Infinity / -Infinity tokens. The pre-fix ragas runner wrote literal NaN
    into results files; json.load accepts them, but FastAPI's JSONResponse
    re-serializes with allow_nan=False — so ONE poisoned file on the volume
    would 500 every /runs (and /baselines) response forever. Map them to
    null on read; the dashboard treats null as "metric unavailable"."""
    return None


def _load_metrics(results_path: Path) -> Optional[dict[str, Any]]:
    """Best-effort read of the top-level `metrics` block from a results
    JSON (NaN/Infinity → null). Returns None if the file is missing/
    unreadable/has no metrics — we never fabricate numbers."""
    try:
        with results_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh, parse_constant=_nan_to_null)
    except (OSError, json.JSONDecodeError):
        return None
    metrics = data.get("metrics")
    return metrics if isinstance(metrics, dict) else None


def _load_record(path: Path) -> Optional[dict[str, Any]]:
    """Best-effort read of one record-<runId>.json (already wire-shaped by
    run_state._record_payload). None if unreadable — a corrupt record must
    skip quietly, not 500 the whole listing."""
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh, parse_constant=_nan_to_null)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


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
        # run_id doubles as the results-file stamp so results-<runId>.json
        # always matches the id handed back at admission — the two used to
        # be independent clock reads seconds apart, and lookups could miss.
        runner.run_once(stamp=run_id)
    except Exception as exc:  # noqa: BLE001 — surface, never crash the loop
        logger.exception("HTTP-triggered run failed (run_id=%s)", run_id)
        # error_summary surfaces the subprocess output tail for a
        # CalledProcessError — "exited non-zero" alone is undebuggable.
        STORE.finish(run_id, RunStatus.FAILED, error=runner.error_summary(exc))
        return
    STORE.finish(run_id, RunStatus.SUCCEEDED)
    logger.info("HTTP-triggered run complete (run_id=%s)", run_id)


def _extraction_blocking(run_id: str) -> None:
    """Executor-thread body for /run-extraction (WARP-2732, ADR-048).

    🔴 A FAILED canary is a SUCCEEDED run with a failing verdict, not a failed
    run — and the distinction is the whole point. `RunStatus.FAILED` means the
    harness broke; a canary that scored below its floors ran perfectly and
    answered "no". Collapsing the two would let somebody read a red canary as
    "the eval is flaky, try again", which is exactly the reading that gets a
    gate switched off.

    The verdict lives in the results file the runner wrote; this only records
    whether the measurement HAPPENED.
    """
    import subprocess
    import sys as _sys

    script = (
        Path(__file__).resolve().parent / "tests" / "extraction-eval" / "extraction_runner.py"
    )
    db_url = os.environ.get("DATABASE_URL")
    model = os.environ.get("FILING_CANARY_MODEL") or os.environ.get("LLM_MODEL")
    if not db_url or not model:
        # Refuse rather than run blind: a canary that quietly measured nothing
        # is WARP-1860's fifteen green all-zero nightly runs.
        STORE.finish(
            run_id,
            RunStatus.FAILED,
            error="extraction canary needs DATABASE_URL and FILING_CANARY_MODEL/LLM_MODEL",
        )
        return

    out = Path(config.RESULTS_DIR) / f"extraction-{run_id}.json"
    try:
        proc = subprocess.run(
            [
                _sys.executable, str(script),
                "--database-url", db_url,
                "--model", model,
                "--out", str(out),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("extraction canary failed to start (run_id=%s)", run_id)
        STORE.finish(run_id, RunStatus.FAILED, error=str(exc))
        return

    # rc 2 is "could not run at all" (no psycopg, no database). rc 1 is a
    # measured FAIL, which is a successful run.
    if proc.returncode >= 2:
        STORE.finish(run_id, RunStatus.FAILED, error=(proc.stderr or "")[-2000:])
        return
    STORE.finish(run_id, RunStatus.SUCCEEDED)
    logger.info(
        "extraction canary complete (run_id=%s verdict=%s)",
        run_id,
        "PASS" if proc.returncode == 0 else "FAIL",
    )


def _bootstrap_blocking(run_id: str, n_runs: int) -> None:
    """Executor-thread body for /bootstrap. Mirrors main.py cmd_bootstrap:
    N sequential runs into an isolated per-bootstrap subdir, then aggregate
    into baselines.candidate.json. Updates STORE progress + final status."""
    bootstrap_dir = config.RESULTS_DIR / f"bootstrap-{run_id}"
    logger.info(
        "HTTP-triggered bootstrap: %d runs into %s then aggregate",
        n_runs,
        bootstrap_dir,
    )
    failures = 0
    last_error: Optional[str] = None
    for i in range(1, n_runs + 1):
        logger.info("bootstrap run %d / %d (run_id=%s)", i, n_runs, run_id)
        try:
            # Inner runs keep their own fresh stamps — each pass needs its
            # own results filename inside the bootstrap subdir.
            runner.run_once(target_dir=bootstrap_dir)
        except Exception as exc:  # noqa: BLE001
            failures += 1
            last_error = runner.error_summary(exc)
            logger.exception("bootstrap run %d failed", i)
        STORE.mark_bootstrap_progress(run_id, i)

    if failures == n_runs:
        logger.error("all %d bootstrap runs failed; not aggregating", n_runs)
        error = "all bootstrap runs failed"
        if last_error:
            error += f"; last: {last_error}"
        STORE.finish(run_id, RunStatus.FAILED, error=error)
        return
    try:
        runner.aggregate_to_baselines(
            config.BASELINES_CANDIDATE, results_dir=bootstrap_dir
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
        config.BASELINES_CANDIDATE,
    )


# ── Blocking filesystem readers (run via asyncio.to_thread) ─────────────
#
# During a RAGAS run the executor thread's subprocess chatter + judge calls
# saturate the GIL; blocking glob/read work on the event loop could stall
# GET /runs past the orchestrator proxy's 10 s timeout → 503 → the dashboard
# hides everything exactly when the operator is watching a run.


def _list_runs_sync() -> dict[str, dict[str, Any]]:
    """Scan RUNS_DIR into runId → wire dict, from two durable sources:

      - record-*.json: terminal records (succeeded AND failed, runs AND
        bootstraps) written by run_state.finish(). Taken as-is.
      - legacy results-*.json with no matching record: successes from
        before record files existed. Their "succeeded" status is INFERRED
        from the file's presence — the one documented exception to
        "status is always explicit" (the old runner only left a results
        file behind when it succeeded, and there is nothing else to read).

    Attaches resultsPath + metrics (NaN → null) wherever a
    results-<runId>.json exists.
    """
    runs_dir = config.RUNS_DIR
    items: dict[str, dict[str, Any]] = {}
    if not runs_dir.exists():
        return items
    for path in runs_dir.glob("results-*.json"):
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
        }
    # Records override the legacy inference for the same runId — they carry
    # the explicit status (a failed run can have a record AND no results).
    for path in runs_dir.glob("record-*.json"):
        m = _RECORD_RE.match(path.name)
        if not m:
            continue
        record = _load_record(path)
        if record is not None:
            items[m.group(1)] = record
    for run_id, item in items.items():
        results_path = runs_dir / f"results-{run_id}.json"
        if results_path.exists():
            item["resultsPath"] = str(results_path)
            item["metrics"] = _load_metrics(results_path)
    return items


def _get_run_sync(
    run_id: str, body: Optional[dict[str, Any]]
) -> dict[str, Any]:
    """Filesystem side of GET /runs/{id}. `body` is the in-memory record's
    wire form when STORE knows the id (highest precedence); then the record
    file; then the legacy results-file inference; else explicit `unknown` —
    never inferred-failed."""
    runs_dir = config.RUNS_DIR
    results_path = runs_dir / f"results-{run_id}.json"
    if body is None:
        body = _load_record(runs_dir / f"record-{run_id}.json")
    if body is None:
        if not results_path.exists():
            return {"runId": run_id, "status": RunStatus.UNKNOWN.value}
        # Legacy pre-record success — the documented inference exception.
        body = {
            "runId": run_id,
            "kind": "run",
            "status": RunStatus.SUCCEEDED.value,
            "startedAt": _stamp_to_iso(run_id),
            "finishedAt": _stamp_to_iso(run_id),
        }
    if results_path.exists():
        body["resultsPath"] = str(results_path)
        body["metrics"] = _load_metrics(results_path)
    return body


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

    @app.post("/run-extraction")
    async def post_run_extraction() -> JSONResponse:
        """ADR-048's extraction canary (WARP-2732).

        Shares the one in-process busy flag with /run and /bootstrap: the box
        has one model and one corpus, and two evals reading the same tables at
        once measure each other.
        """
        run_id = runner._utc_stamp()
        admitted, current = STORE.try_begin(run_id, kind="extraction")
        if not admitted:
            return JSONResponse(
                status_code=409,
                content={"error": "run_in_progress", "runId": current},
            )
        loop = asyncio.get_running_loop()
        loop.run_in_executor(None, _extraction_blocking, run_id)
        return JSONResponse(
            status_code=202,
            content={
                "runId": run_id,
                "startedAt": datetime.now(timezone.utc).isoformat(),
                "suite": "extraction",
            },
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
        """Recent runs, newest first, capped. Merges the durable filesystem
        records (record-*.json + legacy results-*.json) — read off the
        event loop — then overlays any in-flight record from STORE so a
        run that hasn't finished yet still shows as `running`."""
        items = await asyncio.to_thread(_list_runs_sync)

        # The in-flight record takes highest precedence: a stale record
        # or results file for the same id must not mask a live run.
        current = STORE.current_run_id()
        if current is not None:
            rec = STORE.get(current)
            if rec is not None:
                items[current] = _record_to_wire(rec)

        ordered = sorted(
            items.values(), key=lambda r: r.get("runId", ""), reverse=True
        )
        return {"runs": ordered[:_RUNS_LIST_CAP]}

    @app.get("/runs/{run_id}")
    async def get_run(run_id: str) -> JSONResponse:
        """Status of a single run. Explicit enum — `unknown` when we have
        no in-memory record, no record file, and no results file."""
        rec = STORE.get(run_id)
        body = await asyncio.to_thread(
            _get_run_sync, run_id, _record_to_wire(rec) if rec else None
        )
        return JSONResponse(status_code=200, content=body)

    @app.get("/baselines")
    async def get_baselines() -> JSONResponse:
        def _read_sync() -> Any:
            if not config.BASELINES_CANDIDATE.exists():
                return _MISSING
            with config.BASELINES_CANDIDATE.open("r", encoding="utf-8") as fh:
                # Same NaN → null mapping as _load_metrics: the aggregate
                # of a NaN-poisoned run is itself NaN, and JSONResponse
                # (allow_nan=False) would 500 on it forever.
                return json.load(fh, parse_constant=_nan_to_null)

        try:
            data = await asyncio.to_thread(_read_sync)
        except (OSError, json.JSONDecodeError) as exc:
            return JSONResponse(
                status_code=500,
                content={"error": "baselines_unreadable", "detail": str(exc)},
            )
        if data is _MISSING:
            return JSONResponse(
                status_code=404, content={"error": "no_baselines"}
            )
        return JSONResponse(status_code=200, content=data)

    return app
