"""WARP-963 — httpx client for the droplet-analytics agent API.

EGRESS AUDIT (ADR-012 discipline — every outbound destination this
service can dial, declared in one place; the README carries the full
cadence/payload table):

    POST {portal}/agents/register        one-time, X-Provisioning-Code
    POST {portal}/agents/heartbeat       30 s
    POST {portal}/agents/metrics         60 s
    POST {portal}/agents/errors          push (5 s flush tick)
    POST {portal}/agents/inventory       6 h + boot
    POST {portal}/agents/network         5 min
    GET  {portal}/agents/commands/poll   long-poll wait=25
    POST {portal}/agents/commands/{id}/result

``{portal}`` = DROPLET_TELEMETRY_PORTAL_URL (default the Warp Lab
analytics portal). NOTHING else is ever dialed by this client — the
service's only other egress is the opt-in WARP-1025 update-poll's
release-manifest fetch, declared in update_poll.py; every attempt on
either surface is logged on the ``fleet_agent.egress`` logger so the
box's own phone-home surface is auditable from its logs. Payloads carry
operational shape only — no file names, no user data, no customer LAN
IPs.

Wire contract (FROZEN): droplet-analytics
``docs/superpowers/agent-api.openapi.yaml`` v1.0.0. Headers per request:
``Authorization: Bearer dpl_<machineId>_<secret>``, ``X-Droplet-Id``,
``X-Droplet-FW`` and, on POSTs, a client-picked UUIDv4
``X-Idempotency-Key`` (portal dedups on ``(machine_id, key)`` for 24 h).
429 responses honor ``Retry-After`` via a per-endpoint backoff — the
client does not even dial while a window is open.

This client NEVER raises to its caller — network/HTTP failures come
back as a ``PortalResult`` so the agent stays fail-open by construction.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import httpx

logger = logging.getLogger("fleet_agent.egress")

_DEFAULT_TIMEOUT_S = 10.0
_FALLBACK_RETRY_AFTER_S = 60.0


@dataclass(frozen=True)
class PortalResult:
    ok: bool
    status: Optional[int] = None
    body: Optional[dict] = None
    transport_error: bool = False
    skipped: bool = False  # suppressed by an open Retry-After window
    retry_after_s: Optional[float] = None

    @property
    def should_spool(self) -> bool:
        """Transient failures are worth replaying (the portal dedups on
        (machine_id, ts)); validation/auth rejects are poison pills that
        must be dropped, not replayed forever."""
        if self.skipped or self.transport_error:
            return True
        return self.status is not None and (self.status == 429 or self.status >= 500)


@dataclass
class _Backoff:
    """Per-endpoint Retry-After windows (monotonic deadlines)."""

    deadlines: dict = field(default_factory=dict)

    def blocked(self, key: str) -> bool:
        deadline = self.deadlines.get(key)
        if deadline is None:
            return False
        if time.monotonic() >= deadline:
            del self.deadlines[key]
            return False
        return True

    def block(self, key: str, seconds: float) -> None:
        self.deadlines[key] = time.monotonic() + max(0.0, seconds)


class PortalClient:
    def __init__(
        self,
        base_url: str,
        firmware_version: str,
        machine_id: Optional[str] = None,
        ingest_token: Optional[str] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._firmware_version = firmware_version
        self._machine_id = machine_id
        self._ingest_token = ingest_token
        self._client = client or httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT_S)
        self._backoff = _Backoff()

    def adopt_identity(self, machine_id: str, ingest_token: str) -> None:
        self._machine_id = machine_id
        self._ingest_token = ingest_token

    @property
    def has_identity(self) -> bool:
        return bool(self._machine_id and self._ingest_token)

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def register(self, provisioning_code: str, payload: dict) -> PortalResult:
        """One-time registration. Auth is the X-Provisioning-Code header,
        NOT a bearer — the bearer is what this call mints."""
        headers = {
            "X-Provisioning-Code": provisioning_code,
            "X-Droplet-FW": self._firmware_version,
            "X-Idempotency-Key": str(uuid.uuid4()),
        }
        return await self._request(
            "POST", "/agents/register", json=payload, headers=headers
        )

    # ------------------------------------------------------------------
    # Telemetry + snapshots
    # ------------------------------------------------------------------

    async def heartbeat(self, payload: dict) -> PortalResult:
        return await self._authed_post("/agents/heartbeat", payload)

    async def metrics(self, payload: dict) -> PortalResult:
        return await self._authed_post("/agents/metrics", payload)

    async def errors(self, payload: dict) -> PortalResult:
        return await self._authed_post("/agents/errors", payload)

    async def inventory(self, payload: dict) -> PortalResult:
        return await self._authed_post("/agents/inventory", payload)

    async def network(self, payload: dict) -> PortalResult:
        return await self._authed_post("/agents/network", payload)

    # ------------------------------------------------------------------
    # Commands (pull model)
    # ------------------------------------------------------------------

    async def poll_commands(self, wait: int = 25) -> list[dict]:
        """Long-poll for pending commands. Returns [] on ANY failure —
        command handling is best-effort by design."""
        result = await self._request(
            "GET",
            "/agents/commands/poll",
            params={"wait": wait},
            headers=self._auth_headers(idempotency=False),
            timeout=wait + 10.0,
        )
        if not result.ok or not isinstance(result.body, dict):
            return []
        commands = result.body.get("commands")
        return [c for c in commands if isinstance(c, dict)] if isinstance(commands, list) else []

    async def post_command_result(self, command_id: str, payload: dict) -> PortalResult:
        return await self._authed_post(f"/agents/commands/{command_id}/result", payload)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _auth_headers(self, idempotency: bool) -> dict:
        headers = {"X-Droplet-FW": self._firmware_version}
        if self._ingest_token:
            headers["Authorization"] = f"Bearer {self._ingest_token}"
        if self._machine_id:
            headers["X-Droplet-Id"] = self._machine_id
        if idempotency:
            headers["X-Idempotency-Key"] = str(uuid.uuid4())
        return headers

    async def _authed_post(self, path: str, payload: dict) -> PortalResult:
        return await self._request(
            "POST", path, json=payload, headers=self._auth_headers(idempotency=True)
        )

    async def _request(
        self,
        method: str,
        path: str,
        json: Optional[dict] = None,
        params: Optional[dict] = None,
        headers: Optional[dict] = None,
        timeout: Optional[float] = None,
    ) -> PortalResult:
        if self._backoff.blocked(path):
            logger.debug("egress %s %s suppressed — Retry-After window open", method, path)
            return PortalResult(ok=False, skipped=True)
        url = f"{self._base_url}{path}"
        try:
            response = await self._client.request(
                method,
                url,
                json=json,
                params=params,
                headers=headers,
                timeout=timeout if timeout is not None else _DEFAULT_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            logger.warning("egress %s %s failed: %s", method, path, exc)
            return PortalResult(ok=False, transport_error=True)
        except Exception as exc:  # fail-open: NOTHING escapes this client
            logger.exception("egress %s %s unexpected error: %s", method, path, exc)
            return PortalResult(ok=False, transport_error=True)

        body: Optional[dict] = None
        try:
            parsed = response.json()
            if isinstance(parsed, dict):
                body = parsed
        except ValueError:
            body = None

        if response.status_code == 429:
            retry_after = _parse_retry_after(response.headers.get("Retry-After"))
            self._backoff.block(path, retry_after)
            logger.warning(
                "egress %s %s rate-limited — backing off %.0fs", method, path, retry_after
            )
            return PortalResult(
                ok=False, status=429, body=body, retry_after_s=retry_after
            )

        ok = 200 <= response.status_code < 300
        log = logger.debug if ok else logger.warning
        log("egress %s %s -> %d", method, path, response.status_code)
        return PortalResult(ok=ok, status=response.status_code, body=body)


def _parse_retry_after(raw: Optional[str]) -> float:
    if not raw:
        return _FALLBACK_RETRY_AFTER_S
    try:
        return max(0.0, float(raw.strip()))
    except ValueError:
        return _FALLBACK_RETRY_AFTER_S
