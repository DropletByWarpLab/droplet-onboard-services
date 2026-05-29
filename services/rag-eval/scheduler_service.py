"""WARP-RAG-EVAL — apscheduler wiring for the hourly off-hours run.

Mirrors services/file-indexer/scheduler_service.py's shape — one
scheduler instance owned by main.py, single cron job, named so
log lines + ad-hoc replace_existing work.

Per CLAUDE.md "no `while True` loops for scheduling": apscheduler is
the canonical replacement. We use BlockingScheduler (not AsyncIO like
file-indexer) because this service has no async surface — its entire
job is firing the scheduled run; there's nothing for an event loop to
share with.
"""

from __future__ import annotations

import logging

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger
from tzlocal import get_localzone

import runner
from config import CRON_HOUR, CRON_MINUTE

logger = logging.getLogger("rag-eval.scheduler")


def _safe_run() -> None:
    """Wrap runner.run_once so a failure never propagates into
    apscheduler — it would otherwise mark the job as having raised,
    and depending on listener config that can flake the scheduler.
    Failures here are recoverable: next hour's tick still fires.
    """
    try:
        runner.run_once()
    except Exception:  # noqa: BLE001 — explicit broad catch
        # logger.exception captures the traceback; failures are
        # observable in container logs, but the scheduler keeps running.
        logger.exception("scheduled RAGAS run failed; skipping this slot")


def build_scheduler() -> BlockingScheduler:
    """Build + return a BlockingScheduler with the cron job registered.

    Caller is responsible for `.start()` (blocks the main thread) and
    `.shutdown(wait=True)` on SIGTERM. See main.py for the wiring.
    """
    tz = get_localzone()
    sched = BlockingScheduler(timezone=tz)
    sched.add_job(
        _safe_run,
        trigger=CronTrigger(
            hour=CRON_HOUR, minute=CRON_MINUTE, timezone=tz
        ),
        id="rag_eval_hourly",
        name="RAG eval — hourly off-hours run",
        replace_existing=True,
        # If a previous slot was missed (container restart, etc.),
        # coalesce into a single run rather than firing N catch-up
        # invocations back-to-back.
        coalesce=True,
        # Never let two runs overlap — RAGAS judge calls are GPU-bound
        # and a parallel run would contend with itself.
        max_instances=1,
        # If the scheduler is busy when the cron fires, allow up to 30
        # minutes of grace before considering the slot a miss.
        misfire_grace_time=30 * 60,
    )
    logger.info(
        "RAGAS scheduler built — cron hour=%s minute=%s tz=%s",
        CRON_HOUR,
        CRON_MINUTE,
        tz,
    )
    return sched
