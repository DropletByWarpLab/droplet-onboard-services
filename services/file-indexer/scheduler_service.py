"""WARP-218 — apscheduler wiring for the daily transcription run.

Single AsyncIOScheduler instance owned by main.py. Reads
TRANSCRIPTION_RUN_LOCAL_TIME (default '03:00') and registers a single
CronTrigger that calls transcription_worker.run_pass() once per day in the
machine's local timezone.

Lifecycle:
  - build_scheduler() — returns a started scheduler (call shutdown() on exit)
  - on parse failures of the env var, we log a warning and fall back to 03:00
    — better than crashing the file-indexer at startup over a typo

Per CLAUDE.md "no `while True` loops for scheduling" rule — apscheduler is
the canonical Python-side replacement for hand-rolled `time.sleep` loops.
"""
from __future__ import annotations

import asyncio
import logging
import os

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from tzlocal import get_localzone

import transcription_worker

logger = logging.getLogger(__name__)

DEFAULT_HOUR = 3
DEFAULT_MINUTE = 0


def _parse_run_time() -> tuple[int, int]:
    """Parse TRANSCRIPTION_RUN_LOCAL_TIME=HH:MM with safe fallback."""
    raw = os.environ.get("TRANSCRIPTION_RUN_LOCAL_TIME", "").strip()
    if not raw:
        return DEFAULT_HOUR, DEFAULT_MINUTE
    try:
        h_str, m_str = raw.split(":", 1)
        h, m = int(h_str), int(m_str)
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError(f"out-of-range hh:mm: {raw}")
        return h, m
    except Exception as exc:
        logger.warning(
            "TRANSCRIPTION_RUN_LOCAL_TIME=%r is invalid (%s); falling back to %02d:%02d",
            raw,
            exc,
            DEFAULT_HOUR,
            DEFAULT_MINUTE,
        )
        return DEFAULT_HOUR, DEFAULT_MINUTE


def build_scheduler() -> AsyncIOScheduler:
    """Build + start a scheduler with one CronTrigger for run_pass()."""
    h, m = _parse_run_time()
    tz = get_localzone()
    scheduler = AsyncIOScheduler(timezone=tz)
    scheduler.add_job(
        transcription_worker.run_pass,
        trigger=CronTrigger(hour=h, minute=m, timezone=tz),
        id="transcription_daily_run",
        name="Daily ASR transcription run",
        replace_existing=True,
        # If we missed the previous fire (e.g. process was down at 03:00),
        # coalesce into a single run rather than triggering N times.
        coalesce=True,
        # Single sequential worker — never let two daily passes overlap.
        max_instances=1,
    )
    scheduler.start()
    logger.info(
        "Transcription scheduler started — daily run at %02d:%02d %s",
        h,
        m,
        str(tz),
    )
    return scheduler


def run_scheduler_loop(holder: dict, loop_holder: dict) -> None:
    """Run the scheduler on its own event loop until that loop is stopped.

    This is the body of main()'s daemon thread, extracted so it can be
    tested — the bug it guards against lives in the *ordering* here, not in
    build_scheduler(), and a test that only calls build_scheduler() cannot
    see it.

    apscheduler >= 3.11 binds AsyncIOScheduler to the *running* loop via
    `asyncio.get_running_loop()`. Building the scheduler here, before
    `run_forever()`, raises RuntimeError("no running event loop"), and
    because the caller swallows that the daily transcription pass would
    silently never register. So the build is deferred into the loop with
    `call_soon`.

    `holder["scheduler"]` and `loop_holder["loop"]` are how main() reaches
    both for shutdown.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop_holder["loop"] = loop

    def _start_scheduler() -> None:
        try:
            holder["scheduler"] = build_scheduler()
        except Exception:
            logger.exception("scheduler_service.build_scheduler failed")
            loop.stop()

    loop.call_soon(_start_scheduler)
    try:
        loop.run_forever()
    finally:
        loop.close()
