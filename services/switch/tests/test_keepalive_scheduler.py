"""WARP-221: AsyncIOScheduler keepalive wiring for LantronixDriver.

Verifies connect() builds a single interval-triggered keepalive job,
disconnect() tears it down, and the tick wrapper swallows ping errors —
all against the driver directly, no real switch.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from drivers.lantronix import LantronixDriver


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


def _make_driver(monkeypatch) -> LantronixDriver:
    """A driver whose connect() does no network I/O: stub _authenticate
    and the httpx client so only the scheduler wiring runs."""
    driver = LantronixDriver(
        host="127.0.0.1", port=443, username="admin", password="pw"
    )

    async def _fake_auth():
        return None

    monkeypatch.setattr(driver, "_authenticate", _fake_auth)

    class _FakeCookies:
        def set(self, *args, **kwargs):
            return None

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            self.cookies = _FakeCookies()

        async def aclose(self):
            return None

    monkeypatch.setattr("drivers.lantronix.httpx.AsyncClient", _FakeClient)
    return driver


def test_connect_starts_keepalive_scheduler(event_loop, monkeypatch):
    driver = _make_driver(monkeypatch)
    try:
        _run(driver.connect(), event_loop)
        assert driver._keepalive_scheduler is not None
        jobs = driver._keepalive_scheduler.get_jobs()
        assert len(jobs) == 1
        job = jobs[0]
        assert job.id == "lantronix_keepalive"
        assert "interval" in str(job.trigger).lower()
        assert job.max_instances == 1
        assert job.coalesce is True
        assert job.func == driver._keepalive_tick
    finally:
        _run(driver.disconnect(), event_loop)


def test_disconnect_stops_keepalive_scheduler(event_loop, monkeypatch):
    driver = _make_driver(monkeypatch)
    _run(driver.connect(), event_loop)
    sched = driver._keepalive_scheduler
    assert sched is not None and sched.running is True
    _run(driver.disconnect(), event_loop)
    assert driver._keepalive_scheduler is None
    assert sched.running is False


def test_keepalive_tick_swallows_ping_errors(event_loop, monkeypatch, caplog):
    driver = LantronixDriver(
        host="127.0.0.1", port=443, username="admin", password="pw"
    )

    async def _boom():
        raise RuntimeError("ping exploded")

    monkeypatch.setattr(driver, "_ping", _boom)
    caplog.set_level(logging.WARNING, logger="droplet.switch.lantronix")
    # Must not raise.
    _run(driver._keepalive_tick(), event_loop)
    assert any("Keepalive ping failed" in r.message for r in caplog.records)
