"""WARP-468 — off-LAN cloud-model-escape gating for the AI gateway.

Reads `cloud_model_escape` from the orchestrator's
`/api/settings/off-lan` (WARP-467 / E1). When disabled, refuses any
chat request whose resolved provider is not `ollama_local` with HTTP
451 (Unavailable For Legal Reasons — the sovereignty signal).

Cache: in-process with a short TTL (default 30 s). Off-LAN posture
changes hourly at best; reading the orchestrator on every chat turn
would add ~5 ms of latency for no reason. Reads are best-effort:
when the orchestrator is unreachable we FAIL CLOSED (refuse cloud
calls) because the sovereignty contract is more load-bearing than
chat availability.

Architecture rules honored:
  - One model never swap: this middleware NEVER calls `ollama pull`
    or changes `LLM_MODEL`. It only gates which provider is allowed.
  - No `while True`: no background poller; reads happen on-demand.
  - apscheduler is not needed: cache invalidation is TTL-based.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from fastapi import HTTPException

# WARP-1061: the posture read is a first-party mesh hop. Without this, the
# gate's plaintext GET dies at the transport layer the moment the
# orchestrator's :3000 listener flips to mTLS — the read returns None, the
# gate (correctly) fails closed, and EVERY cloud-LLM call 451s. Present the
# gateway's own bundle + https:// when DROPLET_INTERNAL_TLS=1; identity when
# off. Fail-closed semantics for genuine outages are unchanged.
from _shared.internal_tls import base_url as _internal_base_url, httpx_client_kwargs

logger = logging.getLogger(__name__)

# Cache TTL — short enough that flipping the toggle in the dashboard
# takes effect within a single chat-burst; long enough that a typical
# multi-turn agent loop reads the orchestrator at most once.
OFF_LAN_CACHE_TTL_SECONDS = float(
    os.environ.get("OFF_LAN_CACHE_TTL_SECONDS", "30")
)
ORCHESTRATOR_URL = _internal_base_url(
    os.environ.get("ORCHESTRATOR_URL", "http://orchestrator:3000").rstrip("/")
)
AI_GATEWAY_SAMPLER_TOKEN = (
    os.environ.get("AI_GATEWAY_SAMPLER_TOKEN") or ""
).strip()

# Allowlist of providers that are considered "local" — never gated.
# Anything else is "off-LAN" and must clear cloud_model_escape=true.
#
# `local` is the canonical name (WARP-1926). The two `ollama*` spellings are
# LEGACY ALIASES and must stay: `provider` is a PERSISTED column
# (`ChatSession.provider`, `ChatMessage.provider`), so every turn recorded
# before the rename carries `ollama` on disk and still has to clear this gate
# when it is replayed. Dropping them 451s conversation history on a box that
# has been serving since before the rename.
#
# Widening this set is the safe direction (it exempts MORE traffic from the
# cloud gate); narrowing it is what causes an outage. Mirrored by
# `LOCAL_PROVIDERS` in apps/orchestrator/src/services/cloud-access.service.ts,
# pinned by a parity test that parses THIS line.
LOCAL_PROVIDERS = frozenset({"local", "ollama", "ollama_local"})


@dataclass
class _CachedPosture:
    cloud_model_escape: bool
    fetched_at: float


_cache: Optional[_CachedPosture] = None


def _now() -> float:
    return time.monotonic()


def _cache_is_fresh(c: _CachedPosture) -> bool:
    return (_now() - c.fetched_at) < OFF_LAN_CACHE_TTL_SECONDS


async def _fetch_off_lan_posture() -> Optional[bool]:
    """Read `cloud_model_escape` from the orchestrator. Returns None on
    transport failure so the caller can decide between fail-open and
    fail-closed. We fail CLOSED at the call site (see check_off_lan_gate).
    """
    if not AI_GATEWAY_SAMPLER_TOKEN:
        # Boot-time misconfiguration — log once, fail closed.
        logger.error(
            "AI_GATEWAY_SAMPLER_TOKEN unset; off-LAN gate cannot read "
            "orchestrator posture. Failing closed (no cloud providers).",
        )
        return None
    try:
        async with httpx.AsyncClient(timeout=3.0, **httpx_client_kwargs()) as client:
            resp = await client.get(
                f"{ORCHESTRATOR_URL}/api/settings/off-lan",
                headers={"Authorization": f"Bearer {AI_GATEWAY_SAMPLER_TOKEN}"},
            )
        if resp.status_code >= 400:
            logger.warning(
                "off-lan GET returned %d: %s",
                resp.status_code, resp.text[:200],
            )
            return None
        body = resp.json()
        for ch in body.get("channels", []):
            if ch.get("key") == "cloud_model_escape":
                return bool(ch.get("enabled"))
        # Channel missing — treat as not-provisioned, fail closed.
        return None
    except httpx.HTTPError as exc:
        logger.warning("off-lan GET failed: %s", exc)
        return None


async def get_cloud_model_escape() -> bool:
    """Return the current `cloud_model_escape` posture, hitting the
    orchestrator at most once per TTL. Caller treats a None inner
    result as "refuse" — see check_off_lan_gate.
    """
    global _cache
    if _cache is not None and _cache_is_fresh(_cache):
        return _cache.cloud_model_escape
    posture = await _fetch_off_lan_posture()
    if posture is None:
        # Don't poison the cache with a failed read — try again next
        # call. Refuse for this call (handled at call site).
        return False
    _cache = _CachedPosture(cloud_model_escape=posture, fetched_at=_now())
    return posture


def _invalidate_cache_for_tests() -> None:
    """Test-only: clear the cache between assertions."""
    global _cache
    _cache = None


def is_local_provider(provider_name: str) -> bool:
    """Return True if `provider_name` is exempt from the off-LAN gate."""
    return provider_name.lower() in LOCAL_PROVIDERS


async def check_off_lan_gate(provider_name: str) -> None:
    """Raise HTTPException(451) when the resolved provider is cloud
    AND `cloud_model_escape` is disabled. No-op for local providers.

    Call this from any code path that's about to dispatch a chat
    request to a non-local provider (router.chat, gRPC inference
    handler). The default posture from WARP-467's seeder is
    `cloud_model_escape = false`, so without an operator opt-in the
    gateway refuses every cloud call out of the box.
    """
    if is_local_provider(provider_name):
        return
    allowed = await get_cloud_model_escape()
    if allowed:
        return
    raise HTTPException(
        status_code=451,
        detail={
            "error": "off_lan_blocked",
            "channel": "cloud_model_escape",
            "provider": provider_name,
            "message": (
                "Cloud model providers are disabled by the off-LAN "
                "allowlist. An admin can enable cloud_model_escape "
                "from Settings → Off-LAN allowlist with a reason."
            ),
        },
    )
