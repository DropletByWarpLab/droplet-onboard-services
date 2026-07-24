"""WARP-1510 — resilient reconnect to the OpenWrt bridge.

Root cause: main.py's `lifespan` made exactly ONE connect attempt at
process startup. If that attempt lost the boot-order race (router
container/interface not up yet), `router_instance` stayed `None` forever —
nothing ever tried again. `/health` reported "disconnected" honestly, but
every route needing the router 503'd continuously until a container
restart, even once the router was reachable again.

This module owns *when* to retry; it never reaches into `main`'s globals
directly (dependency-injection seam — `connect_fn` / `on_connected` /
`is_connected` — same style as this service's sampler modules taking an
already-connected `router` argument instead of importing `main`, and
email-indexer's `IdleDeps`). `main.py` wires the seams to its
`router_instance` global.

Two independent retry paths, both funnelling through the same
`connect_fn`:

  * `maybe_reconnect_on_demand()` — called synchronously from `get_router()`
    when a request needs the router while disconnected. Bounded by a short
    cooldown so a burst of concurrent/rapid requests can't each trigger
    their own real (blocking) connect attempt against a backend that just
    failed.
  * `start_background_retry()` — registers a self-rescheduling apscheduler
    job (droplet-architecture-guard rule 9: no `while True` / `time.sleep`
    polling) that retries with capped exponential backoff
    (`backoff.BackoffState` — same shape as services/email-indexer's IDLE
    reconnect and services/routing's own throughput/egress/dns-block
    samplers) until connected, then removes itself. If the on-demand path
    reconnects first, the next background tick notices and stops too — no
    redundant attempt, no spin.

PYNET-007 discipline: the connect attempt is blocking SDK I/O (real HTTP,
up to the transport's timeout on a dead router). The on-demand path is
called from FastAPI's plain `def` route handlers, which Starlette already
runs off the event loop in a threadpool — safe to block directly. The
background path runs as an apscheduler `AsyncIOScheduler` tick, which DOES
share the event loop with everything else the service serves (including
`/health`), so it offloads the attempt via `asyncio.to_thread` — same
discipline scheduler.py's throughput tick already follows.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

from backoff import BackoffState, INITIAL_DELAY_SECONDS, MAX_DELAY_SECONDS
from droplet_openwrt_sdk import ConnectionLost, UbusError

logger = logging.getLogger(__name__)

# A "few seconds" cooldown between on-demand reconnect attempts triggered by
# incoming requests while disconnected — bounds how often a burst of
# concurrent/rapid requests can each trigger a real connect attempt against
# a backend that just failed, instead of insta-503ing every single one.
ON_DEMAND_COOLDOWN_SECONDS = 5.0

DEFAULT_JOB_ID = "warp-1510-router-reconnect"

ConnectFn = Callable[[], Any]
OnConnectedFn = Callable[[Any], None]
IsConnectedFn = Callable[[], bool]


class ReconnectCoordinator:
    """Owns *when* to retry connecting to the OpenWrt bridge.

    `connect_fn` is called with no arguments and must either return a
    connected client object or raise (`ConnectionLost` / `UbusError` — the
    same two SDK exceptions main.py's lifespan already treats as "startup
    connect failed"; anything else is a genuine bug and is NOT swallowed).
    """

    def __init__(
        self,
        connect_fn: ConnectFn,
        on_connected: OnConnectedFn,
        is_connected: IsConnectedFn,
        cooldown_seconds: float = ON_DEMAND_COOLDOWN_SECONDS,
        now_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        self._connect_fn = connect_fn
        self._on_connected = on_connected
        self._is_connected = is_connected
        self._cooldown_seconds = cooldown_seconds
        self._now_fn = now_fn
        self._last_attempt_monotonic: float = 0.0
        self._background_backoff = BackoffState()

    def is_connected(self) -> bool:
        return self._is_connected()

    def _attempt(self, *, reason: str) -> bool:
        self._last_attempt_monotonic = self._now_fn()
        try:
            router = self._connect_fn()
        except (ConnectionLost, UbusError) as exc:
            logger.warning("OpenWrt reconnect attempt (%s) failed: %s", reason, exc)
            return False
        logger.info("OpenWrt reconnect attempt (%s) succeeded", reason)
        self._on_connected(router)
        return True

    def maybe_reconnect_on_demand(self) -> bool:
        """Try to reconnect if disconnected and the cooldown has elapsed.

        Returns the connected state after the attempt (or lack of one, if
        the cooldown gated it) — always safe to call on every request; it
        never raises, and it's a no-op once already connected.
        """
        if self._is_connected():
            return True
        elapsed = self._now_fn() - self._last_attempt_monotonic
        if elapsed < self._cooldown_seconds:
            return False
        self._attempt(reason="on-demand")
        return self._is_connected()

    def start_background_retry(self, scheduler: Any, job_id: str = DEFAULT_JOB_ID) -> None:
        """Register a self-rescheduling apscheduler job that retries with
        capped exponential backoff until connected, then removes itself.

        No-op if already connected — nothing to retry.
        """
        if self._is_connected():
            return

        def _stop() -> None:
            try:
                scheduler.remove_job(job_id)
            except Exception:  # noqa: BLE001 — best-effort cleanup
                logger.debug("reconnect scheduler: remove_job(%s) failed", job_id)

        async def _tick() -> None:
            if self._is_connected():
                # Something else (the on-demand path) already reconnected —
                # stop retrying, no redundant attempt.
                _stop()
                return
            # PYNET-007: the connect attempt is blocking SDK I/O — offload
            # so a dead router can't stall /health and every other route
            # sharing this event loop.
            ok = await asyncio.to_thread(self._attempt, reason="background")
            if ok:
                self._background_backoff.on_success()
                _stop()
                return
            delay = self._background_backoff.on_failure()
            scheduler.reschedule_job(job_id, trigger="interval", seconds=delay)

        scheduler.add_job(
            _tick,
            "interval",
            seconds=self._background_backoff.delay_seconds,
            id=job_id,
            max_instances=1,
            coalesce=True,
            replace_existing=True,
        )


def start_reconnect_scheduler(coordinator: ReconnectCoordinator):
    """Mirrors scheduler.py's `start_throughput_scheduler` shape: create a
    dedicated AsyncIOScheduler, register the backoff-driven retry job,
    start it, and return the scheduler so `lifespan` can `.shutdown()` it
    at teardown. Returns None (starts nothing) if already connected.

    apscheduler is imported lazily here (not at module top) so importing
    `ReconnectCoordinator` — needed at `main.py` module-import time for the
    `get_router()` on-demand path — never pulls it in as a hard
    dependency; only actually starting the background job does, same as
    the throughput/egress/dns-block schedulers' own deferred imports in
    `lifespan`.
    """
    if coordinator.is_connected():
        return None
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    scheduler = AsyncIOScheduler()
    coordinator.start_background_retry(scheduler)
    scheduler.start()
    logger.info(
        "OpenWrt reconnect: background retry started (initial=%.1fs cap=%.1fs)",
        INITIAL_DELAY_SECONDS,
        MAX_DELAY_SECONDS,
    )
    return scheduler
