"""WARP-RAG-EVAL / WARP-519 — apscheduler wiring for the hourly run.

Single AsyncIOScheduler instance owned by main.py, mirroring
services/file-indexer/scheduler_service.py's shape. WARP-519 switched this
from BlockingScheduler to AsyncIOScheduler so the cron job and the FastAPI
HTTP trigger server (server.py) can share ONE asyncio event loop — the
HTTP server needs that loop, and we don't want a second thread just to host
the scheduler.

Because a RAGAS pass is a ~12-minute blocking subprocess, the cron job must
NOT run it on the event loop (that would freeze the HTTP server for the
duration). Instead the async job hands `runner.run_once` to a thread
executor (`loop.run_in_executor(None, ...)`) and awaits it — the loop stays
free to serve HTTP the whole time.

Overlap protection is twofold:
  - apscheduler's own `max_instances=1` + `coalesce=True` stop back-to-back
    cron fires from stacking.
  - the shared `run_state.STORE` busy flag (also consulted by the HTTP
    `/run` and `/bootstrap` handlers) makes the scheduled run and any
    manual HTTP trigger mutually exclusive. A scheduled tick that arrives
    while a manual run is in flight is skipped (logged) rather than queued.

Per CLAUDE.md "no `while True` loops for scheduling": apscheduler is the
canonical replacement.
"""

from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from tzlocal import get_localzone

import runner
from config import CRON_HOUR, CRON_MINUTE
from run_state import STORE, RunStatus

logger = logging.getLogger("rag-eval.scheduler")


async def _scheduled_run() -> None:
    """Async cron job: admit via the shared busy flag, then run the
    blocking RAGAS pass in a thread executor so the event loop (and the
    HTTP server sharing it) stays responsive.

    A failure never propagates into apscheduler — it would otherwise mark
    the job as having raised. Failures here are recoverable: the next
    cron tick still fires.
    """
    run_id = runner._utc_stamp()
    admitted, current = STORE.try_begin(run_id, kind="run")
    if not admitted:
        logger.warning(
            "scheduled run skipped — a run is already in flight (%s)", current
        )
        return

    loop = asyncio.get_running_loop()
    logger.info("scheduled RAGAS run starting (run_id=%s)", run_id)
    try:
        # run_once writes results-<stamp>.json itself with its OWN stamp;
        # the run_id we registered above is only the admission/tracking
        # key. Both are UTC stamps a second or two apart — acceptable for
        # an in-memory tracking id (the filesystem artifact is canonical).
        await loop.run_in_executor(None, runner.run_once)
    except Exception as exc:  # noqa: BLE001 — explicit broad catch
        logger.exception("scheduled RAGAS run failed; skipping this slot")
        STORE.finish(run_id, RunStatus.FAILED, error=str(exc))
        return
    STORE.finish(run_id, RunStatus.SUCCEEDED)
    logger.info("scheduled RAGAS run complete (run_id=%s)", run_id)


def build_scheduler() -> AsyncIOScheduler:
    """Build + start an AsyncIOScheduler with the cron job registered.

    Must be called from inside a running asyncio event loop (AsyncIOScheduler
    binds to `asyncio.get_event_loop()` at start). main.py starts it inside
    the same loop that hosts uvicorn. Caller owns `.shutdown()` on exit.
    """
    tz = get_localzone()
    sched = AsyncIOScheduler(timezone=tz)
    sched.add_job(
        _scheduled_run,
        trigger=CronTrigger(hour=CRON_HOUR, minute=CRON_MINUTE, timezone=tz),
        id="rag_eval_hourly",
        name="RAG eval — hourly off-hours run",
        replace_existing=True,
        # If a previous slot was missed (container restart, etc.), coalesce
        # into a single run rather than firing N catch-up invocations.
        coalesce=True,
        # Never let two runs overlap — RAGAS judge calls are GPU-bound and a
        # parallel run would contend with itself. Belt-and-suspenders with
        # the run_state busy flag.
        max_instances=1,
        # If the scheduler is busy when the cron fires, allow up to 30
        # minutes of grace before considering the slot a miss.
        misfire_grace_time=30 * 60,
    )
    sched.start()
    logger.info(
        "RAGAS scheduler started — cron hour=%s minute=%s tz=%s",
        CRON_HOUR,
        CRON_MINUTE,
        tz,
    )
    return sched
