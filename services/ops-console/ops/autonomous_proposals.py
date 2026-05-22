"""WARP-399 — autonomous-agent proposals inbox, proxied from orchestrator.

ops-console runs on the operator trust boundary; the orchestrator's
`/api/autonomous-proposals` lives on the customer dashboard boundary.
This module bridges them via a shared service-principal token:

    OPS_ORCHESTRATOR_TOKEN (env, this service)
        == SERVICE_TOKEN_OPS (env, orchestrator container)
        → orchestrator authMiddleware accepts the bearer as
          `_service:ops` with role=admin, which is exactly what the
          autonomous-proposals routes gate on (see
          apps/orchestrator/src/middleware/auth.ts SERVICE_PRINCIPALS).

If the token isn't configured, the proxy surfaces a 503 with a
descriptive body so the UI can render "orchestrator unauthenticated"
without 500ing.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger("ops.autonomous_proposals")

ORCHESTRATOR_URL = os.environ.get(
    "ORCHESTRATOR_URL", "http://orchestrator:3000"
).rstrip("/")
ORCHESTRATOR_TOKEN = (os.environ.get("OPS_ORCHESTRATOR_TOKEN") or "").strip()


class OrchestratorUnauthenticated(RuntimeError):
    """OPS_ORCHESTRATOR_TOKEN not set; the proxy cannot dial."""


def _auth_headers() -> dict[str, str]:
    if not ORCHESTRATOR_TOKEN:
        raise OrchestratorUnauthenticated(
            "OPS_ORCHESTRATOR_TOKEN env not set — operator must set it to the same value as "
            "orchestrator's SERVICE_TOKEN_OPS for the proxy to work"
        )
    return {"Authorization": f"Bearer {ORCHESTRATOR_TOKEN}"}


async def list_proposals(
    status: str = "pending",
    domain: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """GET /api/autonomous-proposals on the orchestrator."""
    headers = _auth_headers()
    params: dict[str, str | int] = {"status": status, "limit": limit}
    if domain:
        params["domain"] = domain
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{ORCHESTRATOR_URL}/api/autonomous-proposals",
            params=params,
            headers=headers,
        )
    if resp.status_code >= 400:
        logger.warning(
            "orchestrator GET /api/autonomous-proposals returned %d: %s",
            resp.status_code, resp.text[:200],
        )
        return {"proposals": [], "error": f"orchestrator HTTP {resp.status_code}"}
    return resp.json()


async def approve_proposal(proposal_id: str) -> dict[str, Any]:
    """POST /api/autonomous-proposals/:id/approve."""
    headers = _auth_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{ORCHESTRATOR_URL}/api/autonomous-proposals/{proposal_id}/approve",
            headers=headers,
        )
    return _envelope(resp)


async def reject_proposal(proposal_id: str) -> dict[str, Any]:
    """POST /api/autonomous-proposals/:id/reject."""
    headers = _auth_headers()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{ORCHESTRATOR_URL}/api/autonomous-proposals/{proposal_id}/reject",
            headers=headers,
        )
    return _envelope(resp)


def _envelope(resp: httpx.Response) -> dict[str, Any]:
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text[:500]}
    return {
        "status_code": resp.status_code,
        "ok": resp.is_success,
        "body": body,
    }
