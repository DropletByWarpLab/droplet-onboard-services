"""WARP-468 — 60 s apscheduler tick: read off-LAN nftables byte counters,
diff per channel, POST batch to orchestrator's /api/network/off-lan-sample-batch.

Chain naming (set up by the OpenWrt overlay — Chunk 4, separate landing
once lab box is available): one nftables counter chain per
OffLanChannelKey, prefixed `droplet_offlan_`:

  droplet_offlan_software_updates
  droplet_offlan_cloud_model_escape
  droplet_offlan_outbound_email
  droplet_offlan_telemetry
  droplet_offlan_web_fetch

Each chain has a single rule that counts bytes leaving the WAN
interface tagged with the corresponding firewall mark (set upstream
by the orchestrator's outbound proxy / by ai-gateway when a cloud
provider is invoked / by the email sender / by the telemetry uploader
/ by the web.fetch tool).

Read path: a ubus method exposed by the openwrt overlay returns
`{ chain_name: cumulative_bytes }` for the `inet droplet_offlan` table.
This service NEVER uses `file.exec` to invoke `nft` directly (rpcd
ACL discipline — same posture as the wireguard keygen avoidance in
requirements.txt).

Until the openwrt overlay lands: `read_counters_via_ubus` returns an
empty dict and logs a one-time warning. The scheduler keeps ticking
so the orchestrator side can be exercised in isolation; once the
overlay drops the chains in place, real counters flow without any
code change here.

Honors the architecture-guard rules:
  - apscheduler.AsyncIOScheduler — no `while True` (rule 9).
  - Non-fatal startup: if the WAN router isn't connected (mock mode,
    boot race) the meter no-ops cleanly.
  - Service-principal POST gated by ORCHESTRATOR_SAMPLER_TOKEN (shared
    with the WARP-470 throughput sampler).
"""
from __future__ import annotations
import asyncio

import logging
import os
from dataclasses import dataclass
from typing import Optional

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from droplet_openwrt_sdk import DropletRouter, ConnectionLost, UbusError
from middleware import with_fresh_request_id
from request_context import get_request_id

# WARP-1061 — internal mTLS: rewrite the orchestrator base URL to https:// and
# present routing's client cert when DROPLET_INTERNAL_TLS=1 (identity when
# off). Mirrors scheduler.py (the WARP-470 throughput sampler).
from _shared.internal_tls import base_url as _internal_base_url, httpx_client_kwargs

logger = logging.getLogger(__name__)

EGRESS_SAMPLE_INTERVAL_SECONDS = int(
    os.environ.get("OFF_LAN_EGRESS_SAMPLE_SEC", "60")
)
# `routing` runs with network_mode: host in docker-compose, so Docker compose
# service DNS names ("orchestrator") DON'T resolve here — the orchestrator is
# reachable on the loopback interface via its host port mapping. Default to
# localhost to match scheduler.py (same process, same host-network constraint);
# a compose-service-name default silently fails DNS and drops every off-LAN
# sample when ORCHESTRATOR_URL isn't explicitly set (NET-08).
ORCHESTRATOR_URL = _internal_base_url(
    os.environ.get("ORCHESTRATOR_URL", "http://localhost:3000").rstrip("/")
)
ORCHESTRATOR_SAMPLER_TOKEN = (
    os.environ.get("ORCHESTRATOR_SAMPLER_TOKEN") or ""
).strip()

# Closed enum mirrored from prisma/schema.prisma OffLanChannelKey. Adding
# a channel here without a schema migration silently drops the sample on
# the orchestrator side (zod rejects unknown enum values) — that's the
# behaviour we want.
CHANNEL_KEYS = (
    "software_updates",
    "cloud_model_escape",
    "outbound_email",
    "telemetry",
    "web_fetch",
)
CHAIN_PREFIX = "droplet_offlan_"


@dataclass
class _CounterSnapshot:
    """Cumulative byte count for one chain at a given monotonic time."""
    bytes_: int


# Module-level cache so successive scheduler ticks can diff. Cleared
# when the scheduler restarts; the next tick re-primes.
_previous: dict[str, _CounterSnapshot] = {}
_overlay_warning_logged = False
_token_warning_logged = False


def _channel_for_chain(chain_name: str) -> Optional[str]:
    """Map `droplet_offlan_<channel>` → `<channel>`. Returns None for
    chains outside the prefix."""
    if not chain_name.startswith(CHAIN_PREFIX):
        return None
    key = chain_name[len(CHAIN_PREFIX):]
    if key not in CHANNEL_KEYS:
        return None
    return key


def read_counters_via_ubus(router: DropletRouter) -> dict[str, int]:
    """Return {chain_name: cumulative_bytes} for the off-LAN counter
    chains. Empty dict on any error or when the openwrt overlay
    hasn't installed the chains yet.

    Pluggable for tests (monkeypatch this fn directly).
    """
    global _overlay_warning_logged
    try:
        # Custom ubus method exposed by the openwrt overlay's
        # /usr/libexec/rpcd/droplet_offlan script. Until the overlay
        # lands the call raises UbusError("method not found") which
        # we catch below.
        result = router._call("droplet.offlan", "counters", {})
    except (ConnectionLost, UbusError, AttributeError) as exc:
        if not _overlay_warning_logged:
            logger.warning(
                "off-LAN nftables counters unavailable (%s). The openwrt "
                "overlay hasn't been installed yet — the scheduler keeps "
                "ticking with zero samples. See Chunk 4 / WARP-468.",
                exc,
            )
            _overlay_warning_logged = True
        return {}
    if not isinstance(result, dict):
        return {}
    out: dict[str, int] = {}
    for chain, bytes_ in result.items():
        if isinstance(chain, str) and isinstance(bytes_, int):
            out[chain] = bytes_
    return out


def _derive_deltas(
    previous: dict[str, _CounterSnapshot],
    current: dict[str, int],
) -> dict[str, int]:
    """Compute per-channel byte deltas. Negative deltas (counter
    reset on chain reload) clamp to 0 — honest "I don't know" rather
    than a spike."""
    deltas: dict[str, int] = {}
    for chain_name, cur_bytes in current.items():
        channel = _channel_for_chain(chain_name)
        if channel is None:
            continue
        prev = previous.get(chain_name)
        if prev is None:
            continue
        delta = cur_bytes - prev.bytes_
        if delta < 0:
            delta = 0
        deltas[channel] = delta
    return deltas


async def _post_batch(deltas: dict[str, int]) -> None:
    """POST the per-channel deltas to the orchestrator. Logs +
    swallows transport errors; the scheduler keeps ticking."""
    global _token_warning_logged
    if not deltas:
        return
    if not ORCHESTRATOR_SAMPLER_TOKEN:
        if not _token_warning_logged:
            logger.warning(
                "ORCHESTRATOR_SAMPLER_TOKEN unset — off-LAN egress "
                "samples will not be POSTed until secrets.sh "
                "provisions the bearer (follow-up after WARP-468 lands).",
            )
            _token_warning_logged = True
        return
    samples = [
        {"channel": channel, "bytes": bytes_}
        for channel, bytes_ in deltas.items()
    ]
    headers = {"Authorization": f"Bearer {ORCHESTRATOR_SAMPLER_TOKEN}"}
    _rid = get_request_id()
    if _rid:
        headers["x-request-id"] = _rid
    try:
        async with httpx.AsyncClient(timeout=5.0, **httpx_client_kwargs()) as client:
            resp = await client.post(
                f"{ORCHESTRATOR_URL}/api/network/off-lan-sample-batch",
                headers=headers,
                json={"samples": samples},
            )
        if resp.status_code >= 400:
            logger.warning(
                "off-lan-sample-batch POST returned %d: %s",
                resp.status_code, resp.text[:200],
            )
    except httpx.HTTPError as exc:
        logger.warning("off-lan-sample-batch POST failed: %s", exc)


@with_fresh_request_id
async def _tick(router: DropletRouter) -> None:
    """One scheduler tick: read counters → derive deltas → POST.
    First successful read primes the cache; subsequent ticks emit a
    batch of samples (one per channel that moved)."""
    global _previous
    current = await asyncio.to_thread(read_counters_via_ubus, router)  # PYNET-007: blocking urllib off the event loop
    if not current:
        return
    if not _previous:
        _previous = {
            chain: _CounterSnapshot(bytes_=bytes_)
            for chain, bytes_ in current.items()
        }
        logger.info(
            "off-LAN egress meter primed (chains=%d)", len(current),
        )
        return
    deltas = _derive_deltas(_previous, current)
    # Refresh cache for the next tick regardless of POST outcome —
    # the deltas-since-last-tick semantics is the contract.
    _previous = {
        chain: _CounterSnapshot(bytes_=bytes_)
        for chain, bytes_ in current.items()
    }
    await _post_batch(deltas)


def start_egress_meter(router: DropletRouter) -> AsyncIOScheduler:
    """Schedule the 60 s off-LAN egress meter. Returns the scheduler so
    the caller can `.shutdown()` on lifespan teardown.

    Honors the architecture-guard rule 9 — apscheduler owns the loop,
    no `while True`.
    """
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        _tick,
        "interval",
        seconds=EGRESS_SAMPLE_INTERVAL_SECONDS,
        args=[router],
        id="warp-468-off-lan-egress-meter",
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    logger.info(
        "off-LAN egress meter started: interval=%ds orchestrator=%s",
        EGRESS_SAMPLE_INTERVAL_SECONDS, ORCHESTRATOR_URL,
    )
    return scheduler


def _reset_state_for_tests() -> None:
    """Test-only: clear all module-level caches between runs."""
    global _previous, _overlay_warning_logged, _token_warning_logged
    _previous = {}
    _overlay_warning_logged = False
    _token_warning_logged = False
