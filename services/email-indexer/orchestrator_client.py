"""WARP-465 D1 follow-up — orchestrator HTTP client.

Thin wrapper around httpx for the two write paths this service uses:
  - POST /api/email/:accountId/messages-ingest (per inbound message)
  - PATCH /api/email/drafts/:id  (mark queued draft sent/failed)

Service-principal auth via ORCHESTRATOR_SERVICE_TOKEN bearer (same
shape as routing service's ORCHESTRATOR_SAMPLER_TOKEN per WARP-470/468).
Missing token → logs once + every call returns False so the IDLE
loop keeps ticking without poisoning the per-account state machine.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

ORCHESTRATOR_URL = os.environ.get(
    "ORCHESTRATOR_URL", "http://orchestrator:3000"
).rstrip("/")
SERVICE_TOKEN = (os.environ.get("ORCHESTRATOR_SERVICE_TOKEN") or "").strip()

_token_warning_logged = False


def _auth_headers() -> Optional[dict[str, str]]:
    global _token_warning_logged
    if not SERVICE_TOKEN:
        if not _token_warning_logged:
            logger.warning(
                "ORCHESTRATOR_SERVICE_TOKEN unset — email ingest will "
                "not be posted until secrets.sh provisions the bearer.",
            )
            _token_warning_logged = True
        return None
    return {"Authorization": f"Bearer {SERVICE_TOKEN}"}


async def ingest_message(account_id: str, payload: dict[str, Any]) -> bool:
    """POST a parsed message to the orchestrator. Returns True on
    201/200 (duplicate counts as success — the indexer's at-least-once
    delivery is OK). False on any failure."""
    headers = _auth_headers()
    if headers is None:
        return False
    url = f"{ORCHESTRATOR_URL}/api/email/{account_id}/messages-ingest"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        logger.warning("messages-ingest POST failed: %s", exc)
        return False
    if resp.status_code in (200, 201):
        return True
    logger.warning(
        "messages-ingest non-2xx: status=%d body=%s",
        resp.status_code, resp.text[:200],
    )
    return False


async def mark_draft_sent(draft_id: str) -> bool:
    """Notify the orchestrator that an outbound send succeeded.
    Mirrors what `POST /api/email/drafts/:id/send` would have flipped
    on a synchronous send; the indexer flips it here because the SMTP
    transaction happens asynchronously."""
    return await _patch_draft(draft_id, {"status": "sent"})


async def mark_draft_failed(draft_id: str, error: str) -> bool:
    """Notify the orchestrator that an outbound send failed."""
    return await _patch_draft(draft_id, {"status": "failed", "error": error[:1024]})


async def _patch_draft(draft_id: str, body: dict[str, Any]) -> bool:
    headers = _auth_headers()
    if headers is None:
        return False
    url = f"{ORCHESTRATOR_URL}/api/email/drafts/{draft_id}/status"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.patch(url, json=body, headers=headers)
    except httpx.HTTPError as exc:
        logger.warning("draft status PATCH failed: %s", exc)
        return False
    if resp.status_code in (200, 204):
        return True
    logger.warning(
        "draft status PATCH non-2xx: status=%d body=%s",
        resp.status_code, resp.text[:200],
    )
    return False


async def claim_draft(draft_id: str) -> bool:
    """WARP-890: atomically claim a queued draft (queued -> sending) before the
    SMTP send. Returns True only if THIS call won the claim (the draft was still
    queued); False if it was already in-flight/sent or on any error — the caller
    then skips the send, so a lost terminal callback can't cause a duplicate."""
    headers = _auth_headers()
    if headers is None:
        return False
    url = f"{ORCHESTRATOR_URL}/api/email/drafts/{draft_id}/claim"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, headers=headers)
    except httpx.HTTPError as exc:
        logger.warning("draft claim POST failed: %s", exc)
        return False
    if resp.status_code == 200:
        try:
            return bool(resp.json().get("claimed"))
        except Exception:  # noqa: BLE001
            return False
    logger.warning(
        "draft claim non-2xx: status=%d body=%s", resp.status_code, resp.text[:200]
    )
    return False


async def reconcile_stale_sending() -> int:
    """WARP-890: ask the orchestrator to fail-out drafts stranded in `sending`
    past the grace window (a claimed draft whose terminal callback never landed).
    Best-effort — returns the count reconciled, or 0 on error."""
    headers = _auth_headers()
    if headers is None:
        return 0
    url = f"{ORCHESTRATOR_URL}/api/email/drafts/reconcile-stale-sending"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, headers=headers)
    except httpx.HTTPError as exc:
        logger.warning("reconcile-stale-sending POST failed: %s", exc)
        return 0
    if resp.status_code == 200:
        try:
            return int(resp.json().get("reconciled", 0))
        except Exception:  # noqa: BLE001
            return 0
    logger.warning("reconcile-stale-sending non-2xx: status=%d", resp.status_code)
    return 0
