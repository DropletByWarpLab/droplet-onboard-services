"""WARP-1510 — resilient reconnect to the OpenWrt bridge.

Root cause: the routing service made exactly ONE connect attempt at process
startup (main.py's lifespan). If that attempt lost the boot-order race,
`router_instance` stayed None forever — nothing ever tried again, so
`/health` reported "disconnected" and every route needing the router 503'd
continuously until a container restart.

These tests exercise `ReconnectCoordinator` in isolation (no FastAPI, no
real OpenWrt, no real event-loop timing) via injected `connect_fn` /
`on_connected` / `is_connected` seams — mirrors the dependency-injection
style already used by email-indexer's `IdleDeps` and this service's own
sampler modules (router passed in, never reached-into via a global).
"""
from __future__ import annotations

from typing import Optional
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import ConnectionLost
from reconnect import ON_DEMAND_COOLDOWN_SECONDS, ReconnectCoordinator


class _FakeRouterState:
    """Mirrors main.py's `router_instance` global + `_set_router_instance` /
    `_router_is_connected` helpers, scoped to one test instead of a
    module-level singleton."""

    def __init__(self) -> None:
        self.router: Optional[object] = None

    def is_connected(self) -> bool:
        return self.router is not None

    def set_connected(self, router: object) -> None:
        self.router = router


class _FakeScheduler:
    """Minimal stand-in for apscheduler's AsyncIOScheduler — just enough of
    add_job/reschedule_job/remove_job to prove the backoff wiring without a
    real event-loop clock. Tests drive ticks by awaiting the captured job
    function directly (same style as test_egress_meter.py's `await _tick`)."""

    def __init__(self) -> None:
        self.jobs: dict[str, object] = {}
        self.add_job_calls: list[dict] = []
        self.reschedule_calls: list[tuple[str, float]] = []
        self.removed: list[str] = []

    def add_job(self, func, trigger, *, seconds=None, id, **kwargs):
        self.jobs[id] = func
        self.add_job_calls.append({"trigger": trigger, "seconds": seconds, "id": id, **kwargs})

    def reschedule_job(self, job_id, *, trigger, seconds):
        self.reschedule_calls.append((job_id, seconds))

    def remove_job(self, job_id):
        self.removed.append(job_id)
        self.jobs.pop(job_id, None)


def _always_fails():
    raise ConnectionLost("test double: router unavailable")


def _fails_n_times_then_succeeds(n: int, router: object = "fake-router"):
    calls = {"count": 0}

    def _connect():
        calls["count"] += 1
        if calls["count"] <= n:
            raise ConnectionLost(f"test double: attempt {calls['count']} fails")
        return router

    _connect.calls = calls  # type: ignore[attr-defined]
    return _connect


class TestOnDemandReconnect:
    def test_reconnects_when_disconnected_and_returns_true_on_success(self):
        state = _FakeRouterState()
        connect = _fails_n_times_then_succeeds(0, router="router-obj")
        coordinator = ReconnectCoordinator(
            connect_fn=connect,
            on_connected=state.set_connected,
            is_connected=state.is_connected,
        )
        assert coordinator.maybe_reconnect_on_demand() is True
        assert state.router == "router-obj"

    def test_does_not_call_connect_fn_when_already_connected(self):
        state = _FakeRouterState()
        state.set_connected("already-there")
        calls = {"n": 0}

        def _connect():
            calls["n"] += 1
            return "should-not-be-used"

        coordinator = ReconnectCoordinator(
            connect_fn=_connect, on_connected=state.set_connected, is_connected=state.is_connected,
        )
        assert coordinator.maybe_reconnect_on_demand() is True
        assert calls["n"] == 0

    def test_failed_attempt_returns_false_and_does_not_raise(self):
        state = _FakeRouterState()
        coordinator = ReconnectCoordinator(
            connect_fn=_always_fails, on_connected=state.set_connected, is_connected=state.is_connected,
        )
        assert coordinator.maybe_reconnect_on_demand() is False
        assert state.router is None

    def test_cooldown_prevents_reconnect_storm(self):
        """A burst of concurrent/rapid requests while disconnected must
        trigger at most ONE real connect attempt within the cooldown
        window — not one attempt per request."""
        state = _FakeRouterState()
        calls = {"n": 0}

        def _connect():
            calls["n"] += 1
            raise ConnectionLost("still down")

        clock = [1000.0]
        coordinator = ReconnectCoordinator(
            connect_fn=_connect,
            on_connected=state.set_connected,
            is_connected=state.is_connected,
            cooldown_seconds=5.0,
            now_fn=lambda: clock[0],
        )
        # Simulate 5 rapid requests arriving at the same instant.
        for _ in range(5):
            assert coordinator.maybe_reconnect_on_demand() is False
        assert calls["n"] == 1

    def test_cooldown_elapsing_allows_the_next_attempt(self):
        state = _FakeRouterState()
        connect = _fails_n_times_then_succeeds(1, router="router-obj")
        clock = [1000.0]
        coordinator = ReconnectCoordinator(
            connect_fn=connect,
            on_connected=state.set_connected,
            is_connected=state.is_connected,
            cooldown_seconds=5.0,
            now_fn=lambda: clock[0],
        )
        assert coordinator.maybe_reconnect_on_demand() is False  # 1st attempt fails
        assert connect.calls["count"] == 1
        # Still inside the cooldown window — must not attempt again.
        clock[0] += 1.0
        assert coordinator.maybe_reconnect_on_demand() is False
        assert connect.calls["count"] == 1
        # Cooldown has now elapsed — the next call may attempt again.
        clock[0] += 4.5
        assert coordinator.maybe_reconnect_on_demand() is True
        assert connect.calls["count"] == 2
        assert state.router == "router-obj"

    def test_default_cooldown_matches_module_constant(self):
        state = _FakeRouterState()
        coordinator = ReconnectCoordinator(
            connect_fn=_always_fails, on_connected=state.set_connected, is_connected=state.is_connected,
        )
        assert coordinator._cooldown_seconds == ON_DEMAND_COOLDOWN_SECONDS  # noqa: SLF001


class TestBackgroundRetry:
    JOB_ID = "warp-1510-router-reconnect"

    def _coordinator(self, connect_fn, state: _FakeRouterState) -> ReconnectCoordinator:
        return ReconnectCoordinator(
            connect_fn=connect_fn, on_connected=state.set_connected, is_connected=state.is_connected,
        )

    def test_does_not_start_when_already_connected(self):
        state = _FakeRouterState()
        state.set_connected("already-there")
        coordinator = self._coordinator(_always_fails, state)
        scheduler = _FakeScheduler()
        coordinator.start_background_retry(scheduler, job_id=self.JOB_ID)
        assert scheduler.add_job_calls == []

    def test_first_registration_uses_initial_backoff_delay(self):
        state = _FakeRouterState()
        coordinator = self._coordinator(_always_fails, state)
        scheduler = _FakeScheduler()
        coordinator.start_background_retry(scheduler, job_id=self.JOB_ID)
        assert len(scheduler.add_job_calls) == 1
        assert scheduler.add_job_calls[0]["seconds"] == pytest.approx(1.0)
        assert scheduler.add_job_calls[0]["trigger"] == "interval"

    @pytest.mark.asyncio
    async def test_capped_exponential_backoff_never_exceeds_max_and_does_not_spin(self):
        state = _FakeRouterState()
        coordinator = self._coordinator(_always_fails, state)
        scheduler = _FakeScheduler()
        coordinator.start_background_retry(scheduler, job_id=self.JOB_ID)
        tick = scheduler.jobs[self.JOB_ID]

        for _ in range(15):
            await tick()

        # Every rescheduled interval stays within [1.0, 60.0] — geometric
        # growth that caps, never an unbounded/tight spin.
        intervals = [seconds for (_job_id, seconds) in scheduler.reschedule_calls]
        assert len(intervals) == 15
        assert all(1.0 <= s <= 60.0 for s in intervals)
        assert intervals[-1] == 60.0
        assert intervals == sorted(intervals)  # monotonically non-decreasing until capped
        # Still down the whole time — the job must still be registered,
        # not silently dropped.
        assert scheduler.removed == []

    @pytest.mark.asyncio
    async def test_stops_retrying_once_connected(self):
        state = _FakeRouterState()
        connect = _fails_n_times_then_succeeds(2, router="router-obj")
        coordinator = self._coordinator(connect, state)
        scheduler = _FakeScheduler()
        coordinator.start_background_retry(scheduler, job_id=self.JOB_ID)
        tick = scheduler.jobs[self.JOB_ID]

        await tick()  # fails (1)
        await tick()  # fails (2)
        assert scheduler.removed == []
        await tick()  # succeeds (3)

        assert state.router == "router-obj"
        assert scheduler.removed == [self.JOB_ID]

    @pytest.mark.asyncio
    async def test_tick_is_a_noop_and_stops_when_already_connected_elsewhere(self):
        """If an on-demand reconnect (a live request) beats the background
        job to it, the next tick must notice and stop — not attempt a
        redundant connect."""
        state = _FakeRouterState()
        calls = {"n": 0}

        def _connect():
            calls["n"] += 1
            return "should-not-be-reached"

        coordinator = self._coordinator(_connect, state)
        scheduler = _FakeScheduler()
        coordinator.start_background_retry(scheduler, job_id=self.JOB_ID)
        tick = scheduler.jobs[self.JOB_ID]

        state.set_connected("reconnected-via-on-demand-path")
        await tick()

        assert calls["n"] == 0
        assert scheduler.removed == [self.JOB_ID]


class TestOnDemandReconnectIntegration:
    """End-to-end through the real FastAPI app: a request needing the
    router while disconnected triggers the on-demand reconnect, and a
    *later* /health call reflects recovery honestly — the exact WARP-1510
    regression (no container restart needed). Mirrors test_aps.py's
    `TestApEndpointsRequireRouter` seam (`monkeypatch.setattr(main,
    "router_instance", None)`), plus the coordinator wiring this ticket
    adds."""

    AUTH = {"authorization": "Bearer pytest-fake-token"}

    def test_request_after_startup_failure_triggers_reconnect_and_health_recovers(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "router_instance", None)

        fake_router = MagicMock(name="ReconnectedRouter")
        fake_router.dhcp.active_leases.return_value = []
        fake_router.system.board_info.return_value = {"model": "test"}

        monkeypatch.setattr(
            main,
            "reconnect_coordinator",
            ReconnectCoordinator(
                connect_fn=lambda: fake_router,
                on_connected=main._set_router_instance,
                is_connected=main._router_is_connected,
                cooldown_seconds=0.0,
            ),
        )

        client = TestClient(main.app)

        # Before recovery: matches the live WARP-1510 evidence exactly.
        health_before = client.get("/health", headers=self.AUTH).json()
        assert health_before["connected"] is False
        assert health_before["status"] == "disconnected"

        # A route needing the router triggers the on-demand reconnect
        # instead of insta-503ing forever.
        resp = client.get("/dhcp/leases", headers=self.AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"leases": []}

        # /health now reports recovery honestly, with NO container restart.
        health_after = client.get("/health", headers=self.AUTH).json()
        assert health_after["connected"] is True
        assert health_after["status"] == "ok"
        assert health_after.get("error") is None

    def test_disconnected_request_still_503s_when_reconnect_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Preserves the existing API shape (WARP-1510 AC #4): if the
        on-demand attempt also fails, the caller still gets the same 503
        it always got — just with a real retry behind it, not a silent
        skip."""
        monkeypatch.setattr(main, "router_instance", None)
        monkeypatch.setattr(
            main,
            "reconnect_coordinator",
            ReconnectCoordinator(
                connect_fn=_always_fails,
                on_connected=main._set_router_instance,
                is_connected=main._router_is_connected,
                cooldown_seconds=0.0,
            ),
        )
        resp = TestClient(main.app).get("/dhcp/leases", headers=self.AUTH)
        assert resp.status_code == 503
        assert resp.json()["detail"] == "Router not connected"
