"""WARP-470 — apscheduler tick that samples WAN throughput → orchestrator.

A single asyncio-scheduler task fires every SAMPLE_INTERVAL_SECONDS
(default 60s), reads cumulative rx/tx byte counts from the OpenWrt WAN
device via ubus, diffs against the previous reading to derive bps, and
POSTs the sample to the orchestrator's /api/network/throughput-sample.

Sample emission deliberately uses HTTP (not MQTT) to keep the storage
write path atomic and to surface failures via 4xx/5xx that the
scheduler can log. MQTT is fire-and-forget and would mask write errors.

The first tick after startup just primes the previous-counter cache —
no sample emitted because there's nothing to diff against yet. A
subsequent restart with the same WAN interface gets the same priming
behaviour. A counter rollover (32-bit overflow on long-lived links)
or a routing-service restart that drops the cache shows as a zero
sample — that's honest, not a spike.

Auth model: the orchestrator's `/api/network/throughput-sample`
endpoint requires `requireRole("service")`. The scheduler presents a
Bearer token from `ORCHESTRATOR_SAMPLER_TOKEN` env. When the token is
unset (no secrets.sh entry yet), the scheduler logs a one-time warning
and skips POSTing — keeps the routing service running cleanly until
the secret lands in a follow-up.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from droplet_openwrt_sdk import DropletRouter, ConnectionLost, UbusError
from middleware import with_fresh_request_id
from request_context import get_request_id

# WARP-236 — internal mTLS: rewrite the orchestrator base URL to https:// and
# present routing's client cert when DROPLET_INTERNAL_TLS=1.
from _shared.internal_tls import base_url as _internal_base_url, httpx_client_kwargs

logger = logging.getLogger(__name__)

SAMPLE_INTERVAL_SECONDS = int(os.environ.get("NETWORK_THROUGHPUT_SAMPLE_SEC", "60"))
# `routing` runs with network_mode: host in docker-compose, so Docker
# compose service DNS names ("orchestrator") DON'T resolve here. The
# orchestrator is reachable on the loopback interface via its host port
# mapping. This is the inverse of the pattern documented in CLAUDE.md
# for routing-from-orchestrator (ROUTING_SERVICE_URL uses
# host.docker.internal because routing is host-network).
ORCHESTRATOR_URL = _internal_base_url(
    os.environ.get("ORCHESTRATOR_URL", "http://localhost:3000").rstrip("/")
)
ORCHESTRATOR_SAMPLER_TOKEN = (os.environ.get("ORCHESTRATOR_SAMPLER_TOKEN") or "").strip()
WAN_DEVICE_NAME = os.environ.get("WAN_DEVICE_NAME", "")


@dataclass
class _CounterSnapshot:
    """rx/tx byte counters captured at a specific monotonic time."""
    ts: float
    rx_bytes: int
    tx_bytes: int


# Module-level cache so successive scheduler ticks can diff. Cleared
# when the scheduler restarts; the next tick re-primes.
_previous: Optional[_CounterSnapshot] = None
_token_warning_logged = False


def _resolve_wan_device(router: DropletRouter) -> Optional[str]:
    """Find the WAN device name (e.g. `eth1`, `wan`, …) by asking ubus.

    `network.interface.wan status` surfaces an `l3_device` field whose
    value is the underlying kernel netdev. We prefer that over a
    hardcoded `eth1` because the device varies by hardware.
    """
    if WAN_DEVICE_NAME:
        return WAN_DEVICE_NAME
    try:
        status = router.network.interface_status("wan")
    except (ConnectionLost, UbusError) as exc:
        logger.debug("resolve_wan_device: interface_status failed: %s", exc)
        return None
    dev = status.get("l3_device") or status.get("device")
    if isinstance(dev, str) and dev:
        return dev
    return None


def _read_counters(router: DropletRouter, device: str) -> Optional[_CounterSnapshot]:
    """Read cumulative rx/tx byte counters for `device` via ubus."""
    try:
        status = router._call("network.device", "status", {"name": device})
    except (ConnectionLost, UbusError, AttributeError) as exc:
        logger.debug("read_counters(%s): %s", device, exc)
        return None
    stats = status.get("statistics", {})
    rx = stats.get("rx_bytes")
    tx = stats.get("tx_bytes")
    if not isinstance(rx, int) or not isinstance(tx, int):
        return None
    return _CounterSnapshot(ts=time.monotonic(), rx_bytes=rx, tx_bytes=tx)


def _derive_bps(
    previous: _CounterSnapshot,
    current: _CounterSnapshot,
) -> tuple[int, int]:
    """Compute bits-per-second from two counter snapshots.

    Returns (down_bps, up_bps). Negative deltas (counter rollover or
    rx/tx reset) clamp to 0 — honest "I don't know" rather than a
    spike.
    """
    elapsed = current.ts - previous.ts
    if elapsed <= 0:
        return (0, 0)
    rx_delta = max(0, current.rx_bytes - previous.rx_bytes)
    tx_delta = max(0, current.tx_bytes - previous.tx_bytes)
    return (int((rx_delta * 8) / elapsed), int((tx_delta * 8) / elapsed))


async def _post_sample(wan_down_bps: int, wan_up_bps: int) -> None:
    """POST the derived bps to the orchestrator. Logs + swallows
    transport errors; the scheduler keeps ticking."""
    global _token_warning_logged
    if not ORCHESTRATOR_SAMPLER_TOKEN:
        if not _token_warning_logged:
            logger.warning(
                "ORCHESTRATOR_SAMPLER_TOKEN unset — throughput samples will "
                "not be POSTed until secrets.sh provisions the bearer "
                "(follow-up after WARP-470 lands).",
            )
            _token_warning_logged = True
        return
    headers = {"Authorization": f"Bearer {ORCHESTRATOR_SAMPLER_TOKEN}"}
    _rid = get_request_id()
    if _rid:
        headers["x-request-id"] = _rid
    try:
        async with httpx.AsyncClient(timeout=5.0, **httpx_client_kwargs()) as client:
            resp = await client.post(
                f"{ORCHESTRATOR_URL}/api/network/throughput-sample",
                headers=headers,
                json={"wanDownBps": wan_down_bps, "wanUpBps": wan_up_bps},
            )
        if resp.status_code >= 400:
            logger.warning(
                "throughput-sample POST returned %d: %s",
                resp.status_code, resp.text[:200],
            )
    except httpx.HTTPError as exc:
        logger.warning("throughput-sample POST failed: %s", exc)


@with_fresh_request_id
async def _tick(router: DropletRouter) -> None:
    """One scheduler tick: resolve device → read counters → derive →
    POST. First successful read primes the cache; subsequent ticks
    emit a sample."""
    global _previous
    device = _resolve_wan_device(router)
    if device is None:
        return
    current = _read_counters(router, device)
    if current is None:
        return
    if _previous is None:
        _previous = current
        logger.info("throughput sampler primed on device=%s", device)
        return
    down_bps, up_bps = _derive_bps(_previous, current)
    _previous = current
    await _post_sample(down_bps, up_bps)


def start_throughput_scheduler(router: DropletRouter) -> AsyncIOScheduler:
    """Schedule the 60 s throughput tick. The handbook's no-`while True`
    rule (CLAUDE.md / droplet-architecture-guard rule 9) is honored —
    apscheduler owns the loop.

    Returns the scheduler so the caller can `.shutdown()` on lifespan
    teardown.
    """
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        _tick,
        "interval",
        seconds=SAMPLE_INTERVAL_SECONDS,
        args=[router],
        id="warp-470-throughput-sampler",
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    logger.info(
        "throughput sampler started: interval=%ds orchestrator=%s",
        SAMPLE_INTERVAL_SECONDS, ORCHESTRATOR_URL,
    )
    return scheduler
