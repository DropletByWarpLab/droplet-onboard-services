"""WARP-218: AsyncIOScheduler wiring — verifies the cron trigger
boots from TRANSCRIPTION_RUN_LOCAL_TIME with sane defaults.
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
from unittest.mock import patch

import pytest


@pytest.fixture
def event_loop():
    """apscheduler >= 3.11 binds AsyncIOScheduler to the *running* loop, so
    build_scheduler() has to be called from inside one. Create + tear down
    one per test rather than relying on pytest-asyncio."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop
    loop.close()


def test_parse_run_time_default_is_03_00():
    """No env var → default 03:00."""
    import scheduler_service

    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("TRANSCRIPTION_RUN_LOCAL_TIME", None)
        h, m = scheduler_service._parse_run_time()
    assert h == 3 and m == 0


def test_parse_run_time_honors_env_var():
    import scheduler_service

    with patch.dict(os.environ, {"TRANSCRIPTION_RUN_LOCAL_TIME": "02:30"}):
        h, m = scheduler_service._parse_run_time()
    assert h == 2 and m == 30


def test_parse_run_time_falls_back_on_garbage(caplog):
    """Garbage env var → default + warning logged."""
    import scheduler_service

    caplog.set_level("WARNING", logger="scheduler_service")
    with patch.dict(os.environ, {"TRANSCRIPTION_RUN_LOCAL_TIME": "banana"}):
        h, m = scheduler_service._parse_run_time()
    assert h == 3 and m == 0
    assert any("TRANSCRIPTION_RUN_LOCAL_TIME" in r.message for r in caplog.records)


def test_parse_run_time_falls_back_on_out_of_range(caplog):
    import scheduler_service

    caplog.set_level("WARNING", logger="scheduler_service")
    with patch.dict(os.environ, {"TRANSCRIPTION_RUN_LOCAL_TIME": "99:99"}):
        h, m = scheduler_service._parse_run_time()
    assert h == 3 and m == 0


def test_build_scheduler_registers_run_pass(event_loop):
    """build_scheduler() returns a started AsyncIOScheduler with
    one CronTrigger job pointing at transcription_worker.run_pass."""
    import scheduler_service

    async def _build():
        # build_scheduler() must run inside a running loop — apscheduler
        # >= 3.11 raises RuntimeError("no running event loop") otherwise.
        # run_scheduler_loop() is what guarantees that in production; this
        # test covers build_scheduler() alone.
        return scheduler_service.build_scheduler()

    sched = event_loop.run_until_complete(_build())
    try:
        jobs = sched.get_jobs()
        assert len(jobs) == 1
        # Trigger should be a cron trigger.
        assert "cron" in str(jobs[0].trigger).lower()
    finally:
        sched.shutdown(wait=False)


def test_run_scheduler_loop_registers_scheduler_from_inside_the_loop():
    """Regression guard for the apscheduler 3.11 eager-start bug.

    This drives `run_scheduler_loop` — the body of main()'s daemon thread —
    rather than calling `build_scheduler()` directly, because the bug was in
    the *ordering*, not in build_scheduler(). Building before `run_forever()`
    raises RuntimeError("no running event loop") on apscheduler >= 3.11, and
    the surrounding except/return swallows it, so the daily transcription
    pass silently never registers on the box.

    Restore the eager build and this test fails: `holder` stays empty.
    """
    import scheduler_service

    holder: dict = {}
    loop_holder: dict = {}
    thread = threading.Thread(
        target=scheduler_service.run_scheduler_loop,
        args=(holder, loop_holder),
        daemon=True,
    )
    thread.start()
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and "scheduler" not in holder:
            time.sleep(0.01)

        assert "scheduler" in holder, (
            "run_scheduler_loop never registered the scheduler — "
            "build_scheduler() was called before the loop was running"
        )
        sched = holder["scheduler"]
        assert sched.running
        jobs = sched.get_jobs()
        assert len(jobs) == 1
        assert "cron" in str(jobs[0].trigger).lower()
    finally:
        sched = holder.get("scheduler")
        if sched is not None:
            sched.shutdown(wait=False)
        loop = loop_holder.get("loop")
        if loop is not None:
            loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
