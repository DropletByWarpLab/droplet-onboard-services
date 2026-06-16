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


def test_disconnect_drains_in_flight_keepalive_tick(event_loop, monkeypatch):
    """WARP-221 HIGH: disconnect() must wait for a tick suspended inside
    _ping() to finish before closing the httpx client, so the resumed tick
    never hits a closed client. We model that by having _ping() block on an
    event the test releases only after disconnect() has started, then assert
    the client was still open while the ping was in flight and that no
    use-after-close error escaped."""
    driver = _make_driver(monkeypatch)
    _run(driver.connect(), event_loop)

    ping_started = asyncio.Event()
    release_ping = asyncio.Event()
    client_open_during_ping = {"value": None}

    async def _blocking_ping():
        ping_started.set()
        await release_ping.wait()
        # While we were suspended, disconnect() must NOT have closed/nulled
        # the client (it should be blocked on _keepalive_lock).
        client_open_during_ping["value"] = driver._client is not None

    monkeypatch.setattr(driver, "_ping", _blocking_ping)

    async def _scenario():
        tick = asyncio.create_task(driver._keepalive_tick())
        await ping_started.wait()
        disc = asyncio.create_task(driver.disconnect())
        # Give disconnect() a chance to run up to the lock acquire; it must
        # block there because the tick holds _keepalive_lock.
        await asyncio.sleep(0.05)
        assert not disc.done(), "disconnect() should block until the tick drains"
        assert driver._client is not None, "client closed before tick finished"
        release_ping.set()
        await asyncio.gather(tick, disc)

    _run(_scenario(), event_loop)
    assert client_open_during_ping["value"] is True
    assert driver._client is None  # fully torn down afterward


def test_reconnect_without_disconnect_does_not_orphan_scheduler(
    event_loop, monkeypatch
):
    """WARP-221 LOW: a second connect() without an intervening disconnect()
    must shut the previous scheduler down rather than leaking it, so only one
    keepalive job ever pings the switch."""
    driver = _make_driver(monkeypatch)
    try:
        _run(driver.connect(), event_loop)
        first = driver._keepalive_scheduler
        assert first is not None and first.running is True
        _run(driver.connect(), event_loop)
        second = driver._keepalive_scheduler
        assert second is not None and second is not first
        assert first.running is False, "old scheduler left running (orphaned)"
        assert second.running is True
        assert len(second.get_jobs()) == 1
    finally:
        _run(driver.disconnect(), event_loop)
