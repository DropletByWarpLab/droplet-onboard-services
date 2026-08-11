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
import functools
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from tzlocal import get_localzone

import corpus_fingerprint
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
    loop = asyncio.get_running_loop()

    # WARP-1868 — corpus gate, deliberately BEFORE admission.
    #
    # A skip does no work, so it must not occupy the busy flag even briefly:
    # a manual /run arriving in the same instant should win, not collide with
    # a tick that was about to decide it had nothing to do.
    #
    # Only the SCHEDULED path is gated. server.py's /run is a separate entry
    # into the same store and stays unconditional — an operator asking for a
    # run gets one, whatever the corpus says.
    #
    # Both calls are I/O, so they go to the executor like the run itself
    # rather than blocking the loop that is also serving HTTP.
    current_fp = await loop.run_in_executor(None, corpus_fingerprint.fetch_fingerprint)
    last_fp = await loop.run_in_executor(None, corpus_fingerprint.load_last)
    run_it, reason = corpus_fingerprint.should_run(current_fp, last_fp)
    if not run_it:
        logger.info("scheduled run SKIPPED — %s", reason)
        # Record it. An unexplained gap in the run history is
        # indistinguishable from a missed slot or a dead container, and the
        # dashboard would have nothing to render but absence.
        skip_admitted, _ = STORE.try_begin(run_id, kind="run")
        if skip_admitted:
            STORE.finish(run_id, RunStatus.SKIPPED, error=reason)
        return
    logger.info("scheduled run proceeding — %s", reason)

    admitted, current = STORE.try_begin(run_id, kind="run")
    if not admitted:
        logger.warning(
            "scheduled run skipped — a run is already in flight (%s)", current
        )
        return

    logger.info("scheduled RAGAS run starting (run_id=%s)", run_id)
    try:
        # Pass our run_id as the results-file stamp so runId ==
        # results-<stamp>.json — the two used to be independent clock
        # reads seconds apart, and results-<runId>.json lookups (metrics
        # attach on GET /runs, GET /runs/{id}) could miss.
        await loop.run_in_executor(
            None, functools.partial(runner.run_once, stamp=run_id)
        )
    except Exception as exc:  # noqa: BLE001 — explicit broad catch
        logger.exception("scheduled RAGAS run failed; skipping this slot")
        # error_summary surfaces the subprocess output tail for a
        # CalledProcessError — "exited non-zero" alone is undebuggable.
        STORE.finish(run_id, RunStatus.FAILED, error=runner.error_summary(exc))
        return
    STORE.finish(run_id, RunStatus.SUCCEEDED)
    # Record the fingerprint only AFTER the run completed. Storing it up front
    # would make a crashed or aborted run look measured, and the next tick
    # would skip a corpus that nothing actually scored.
    if current_fp:
        corpus_fingerprint.save(current_fp, run_id)
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
