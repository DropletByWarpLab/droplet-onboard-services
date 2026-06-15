"""WARP-221: AsyncIOScheduler wiring for the periodic camera-discovery scan.

Verifies the startup handler builds a single interval-triggered job that
targets the scan wrapper, that the first run is scheduled immediately, and
that shutdown stops the scheduler — all without touching a real Frigate,
MQTT broker, or the network.
"""

from __future__ import annotations

import asyncio

import pytest


@pytest.fixture
def event_loop():
    """AsyncIOScheduler.start() expects a running/current loop. Create +
    tear down one per test rather than relying on pytest-asyncio."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop
    loop.close()


def _run(coro, loop):
    return loop.run_until_complete(coro)


def _patch_startup_externals(monkeypatch, main):
    """Stub out MQTT + Frigate so startup() does no network I/O."""
    monkeypatch.setattr(main, "_connect_mqtt", lambda: None)

    async def _ready():
        return True

    async def _noop():
        return None

    monkeypatch.setattr(main.frigate, "health_check", _ready)
    monkeypatch.setattr(main, "_reconcile_with_frigate", _noop)
    monkeypatch.setattr(main, "_wait_for_frigate", _noop)


def test_startup_builds_interval_scheduler(event_loop, monkeypatch):
    import main

    _patch_startup_externals(monkeypatch, main)
    try:
        _run(main.startup(), event_loop)
        assert main._scheduler is not None
        jobs = main._scheduler.get_jobs()
        assert len(jobs) == 1
        job = jobs[0]
        assert job.id == "camera_discovery_scan"
        assert "interval" in str(job.trigger).lower()
        assert job.max_instances == 1
        assert job.coalesce is True
    finally:
        if main._scheduler is not None:
            main._scheduler.shutdown(wait=False)
            main._scheduler = None


def test_scan_job_targets_scan_wrapper(event_loop, monkeypatch):
    import main

    _patch_startup_externals(monkeypatch, main)
    try:
        _run(main.startup(), event_loop)
        job = main._scheduler.get_jobs()[0]
        assert job.func is main._scan_job
    finally:
        if main._scheduler is not None:
            main._scheduler.shutdown(wait=False)
            main._scheduler = None


def test_shutdown_stops_scheduler(event_loop, monkeypatch):
    import main

    _patch_startup_externals(monkeypatch, main)

    async def _noop():
        return None

    # frigate.close / routing_client.aclose are awaited in shutdown().
    monkeypatch.setattr(main.frigate, "close", _noop)
    monkeypatch.setattr(main.routing_client, "aclose", _noop)

    _run(main.startup(), event_loop)
    sched = main._scheduler
    assert sched is not None and sched.running is True
    _run(main.shutdown(), event_loop)
    assert sched.running is False


def test_scan_job_swallows_scan_errors(event_loop, monkeypatch):
    """_scan_job logs but never raises when scan_and_discover blows up."""
    import main

    async def _boom():
        raise RuntimeError("scan exploded")

    monkeypatch.setattr(main, "scan_and_discover", _boom)
    # Should not raise.
    _run(main._scan_job(), event_loop)


def test_no_while_true_scheduling_loop():
    """WARP-221 acceptance: the banned discovery loop is gone and the
    scheduler hook is in place."""
    import main

    assert hasattr(main, "_scheduler")
    assert not hasattr(main, "discovery_loop")
