"""WARP-468 — 60 s apscheduler tick: read the cumulative DNS-blocked-query
counter via ubus, diff against the previous reading to derive a per-tick
delta, and POST `{ blockedCount }` to the orchestrator's
/api/network/dns-block-sample.

Structural clone of `egress_meter.py` (prime / diff / clamp / post,
overlay-warning-once, token-warning-once, `_reset_state_for_tests`). The
only shape difference: off-LAN tracks a dict of per-channel counters,
whereas DNS-blocked is a single cumulative scalar — so the snapshot,
delta and POST body are all single integers.

Read path — UNCONFIRMED ubus method:
  dnsmasq itself does NOT expose a per-policy "blocked query" counter
  via ubus (it counts cache hits / misses / insertions, not blocks).
  The real source is the OpenWrt `adblock` package (its status JSON) or
  a custom `droplet.dnsblock` rpcd overlay returning a cumulative
  `{ blocked: <int> }`. The exact ubus object/method has NOT been
  confirmed against the lab box yet, so this module DOES NOT invent one:
  `read_counters_via_ubus` returns None and logs a one-time warning
  until the overlay lands. The scheduler keeps ticking (zero samples)
  so the orchestrator side can be exercised in isolation — identical
  degradation posture to egress_meter's nftables-chains dependency.

  >>> FLAG FOR TEAM: pin the real ubus method (adblock status vs. a
  >>> droplet.dnsblock rpcd counter) against the lab box, then replace
  >>> the NotImplemented stub below. Do NOT guess a method name. <<<

Honors the architecture-guard rules:
  - apscheduler.AsyncIOScheduler — no `while True` (rule 9).
  - Non-fatal startup: if the WAN router isn't connected (mock mode,
    boot race) the meter no-ops cleanly.
  - Service-principal POST gated by ORCHESTRATOR_SAMPLER_TOKEN — the
    SAME bearer shared by scheduler.py + egress_meter.py. NO new env var.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from droplet_openwrt_sdk import DropletRouter, ConnectionLost, UbusError

logger = logging.getLogger(__name__)

DNS_BLOCK_SAMPLE_INTERVAL_SECONDS = int(
    os.environ.get("DNS_BLOCK_SAMPLE_SEC", "60")
)
ORCHESTRATOR_URL = os.environ.get(
    "ORCHESTRATOR_URL", "http://orchestrator:3000"
).rstrip("/")
ORCHESTRATOR_SAMPLER_TOKEN = (
    os.environ.get("ORCHESTRATOR_SAMPLER_TOKEN") or ""
).strip()


@dataclass
class _CounterSnapshot:
    """Cumulative blocked-query count at a given tick."""
    blocked: int


# Module-level cache so successive scheduler ticks can diff. Cleared
# when the scheduler restarts; the next tick re-primes.
_previous: Optional[_CounterSnapshot] = None
_overlay_warning_logged = False
_token_warning_logged = False


def read_counters_via_ubus(router: DropletRouter) -> Optional[int]:
    """Return the cumulative count of DNS queries blocked by the OpenWrt
    adblock / blocklist layer. Returns None on any error OR until the
    overlay that exposes the metric is pinned (see module docstring).

    Pluggable for tests (monkeypatch this fn directly).

    >>> The real ubus object/method is UNCONFIRMED. Once pinned against
    >>> the lab box, replace the `return None` below with the real
    >>> `router._call("droplet.dnsblock", "counters", {})`-style read,
    >>> parsing a single cumulative int out of the result. Do NOT invent
    >>> a method name here — a wrong name would 500 or silently mis-read.
    """
    global _overlay_warning_logged
    try:
        # FAIL-SOFT: the blocked-query ubus method is not confirmed yet,
        # so we deliberately do NOT call any ubus method. Mirrors
        # egress_meter's overlay-not-installed degradation: warn once,
        # return None, keep the scheduler ticking. The `router` arg and
        # the ubus exception imports stay wired so swapping in the real
        # `router._call(...)` here is a one-line change once the overlay
        # / adblock method name is confirmed.
        raise NotImplementedError(
            "DNS blocked-query ubus method not confirmed"
        )
    except (ConnectionLost, UbusError, AttributeError, NotImplementedError) as exc:
        if not _overlay_warning_logged:
            logger.warning(
                "DNS blocked-query counter unavailable (%s). The OpenWrt "
                "adblock/blocklist ubus method has not been pinned against "
                "the lab box yet — the scheduler keeps ticking with zero "
                "samples until the overlay lands. See WARP-468.",
                exc,
            )
            _overlay_warning_logged = True
        return None


def _derive_delta(
    previous: Optional[_CounterSnapshot],
    current: int,
) -> Optional[int]:
    """Compute the blocked-query delta since the previous tick. Returns
    None when there is no baseline yet (first tick primes the cache).
    Negative deltas (counter reset on adblock reload) clamp to 0 —
    honest "I don't know" over a fake spike."""
    if previous is None:
        return None
    delta = current - previous.blocked
    if delta < 0:
        delta = 0
    return delta


async def _post_sample(blocked_count: int) -> None:
    """POST the per-tick delta to the orchestrator. Logs + swallows
    transport errors; the scheduler keeps ticking."""
    global _token_warning_logged
    if not ORCHESTRATOR_SAMPLER_TOKEN:
        if not _token_warning_logged:
            logger.warning(
                "ORCHESTRATOR_SAMPLER_TOKEN unset — DNS-block samples "
                "will not be POSTed until secrets.sh provisions the "
                "bearer (shared with the throughput + off-LAN samplers).",
            )
            _token_warning_logged = True
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{ORCHESTRATOR_URL}/api/network/dns-block-sample",
                headers={"Authorization": f"Bearer {ORCHESTRATOR_SAMPLER_TOKEN}"},
                json={"blockedCount": blocked_count},
            )
        if resp.status_code >= 400:
            logger.warning(
                "dns-block-sample POST returned %d: %s",
                resp.status_code, resp.text[:200],
            )
    except httpx.HTTPError as exc:
        logger.warning("dns-block-sample POST failed: %s", exc)


async def _tick(router: DropletRouter) -> None:
    """One scheduler tick: read counter → derive delta → POST.
    First successful read primes the cache and emits nothing; subsequent
    ticks POST the per-tick delta."""
    global _previous
    current = read_counters_via_ubus(router)
    if current is None:
        return
    delta = _derive_delta(_previous, current)
    # Refresh cache for the next tick regardless of POST outcome — the
    # delta-since-last-tick semantics is the contract.
    _previous = _CounterSnapshot(blocked=current)
    if delta is None:
        logger.info("DNS-block meter primed (blocked=%d)", current)
        return
    await _post_sample(delta)


def start_dns_block_meter(router: DropletRouter) -> AsyncIOScheduler:
    """Schedule the 60 s DNS-block meter. Returns the scheduler so the
    caller can `.shutdown()` on lifespan teardown.

    Honors the architecture-guard rule 9 — apscheduler owns the loop,
    no `while True`.
    """
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        _tick,
        "interval",
        seconds=DNS_BLOCK_SAMPLE_INTERVAL_SECONDS,
        args=[router],
        id="warp-468-dns-block-meter",
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    logger.info(
        "DNS-block meter started: interval=%ds orchestrator=%s",
        DNS_BLOCK_SAMPLE_INTERVAL_SECONDS, ORCHESTRATOR_URL,
    )
    return scheduler


def _reset_state_for_tests() -> None:
    """Test-only: clear all module-level caches between runs."""
    global _previous, _overlay_warning_logged, _token_warning_logged
    _previous = None
    _overlay_warning_logged = False
    _token_warning_logged = False
