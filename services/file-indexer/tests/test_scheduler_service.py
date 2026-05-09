"""WARP-218: AsyncIOScheduler wiring — verifies the cron trigger
boots from TRANSCRIPTION_RUN_LOCAL_TIME with sane defaults.
"""
from __future__ import annotations

import asyncio
import os
from unittest.mock import patch

import pytest


@pytest.fixture
def event_loop():
    """AsyncIOScheduler.start() expects a running loop. Create + tear down
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

    sched = scheduler_service.build_scheduler()
    try:
        jobs = sched.get_jobs()
        assert len(jobs) == 1
        # Trigger should be a cron trigger.
        assert "cron" in str(jobs[0].trigger).lower()
    finally:
        sched.shutdown(wait=False)
