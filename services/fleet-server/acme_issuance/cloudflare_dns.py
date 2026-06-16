"""Cloudflare DNS-01 worker (ADR-023 §Decision 3 / §Decision 6).

Creates the transient ``_acme-challenge.<fqdn>`` TXT record needed for an
ACME DNS-01 challenge, waits for propagation, and DELETES it in a finally
block — even when the ACME finalize that runs in between raises. The
Cloudflare token (Zone:DNS:Edit, scoped to the issuance zone) is HQ-only.

Hard rule: this worker creates ONLY TXT records. It NEVER creates an
A/AAAA record — the box's home IP is never published; the FQDN is
NXDOMAIN from the public Internet (split-horizon dnsmasq on the box
answers it on-LAN / over the tunnel).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

import httpx

logger = logging.getLogger(__name__)

#: TTL for the transient challenge TXT — minimum Cloudflare accepts via
#: "1" (auto). Short because the record lives only for one order.
_TXT_TTL = 60


class CloudflareError(RuntimeError):
    """A Cloudflare API call failed (maps to a 502 upstream at the route)."""


class CloudflareDns:
    """Thin async client over the Cloudflare DNS records API."""

    def __init__(
        self,
        *,
        api_token: str,
        zone_id: str,
        api_base: str,
        propagation_timeout_sec: int,
        poll_sec: int,
    ) -> None:
        self._zone_id = zone_id
        self._api_base = api_base.rstrip("/")
        self._propagation_timeout = propagation_timeout_sec
        self._poll = poll_sec
        self._headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        }

    def _records_url(self, record_id: Optional[str] = None) -> str:
        base = f"{self._api_base}/zones/{self._zone_id}/dns_records"
        return f"{base}/{record_id}" if record_id else base

    @staticmethod
    def _raise_unless_ok(resp: httpx.Response, action: str) -> dict:
        try:
            payload = resp.json()
        except Exception:  # noqa: BLE001
            payload = {}
        if resp.status_code >= 400 or not payload.get("success", False):
            errors = payload.get("errors") if isinstance(payload, dict) else None
            raise CloudflareError(
                f"Cloudflare {action} failed (HTTP {resp.status_code}): {errors}"
            )
        return payload

    async def create_txt_record(self, name: str, value: str) -> str:
        """Create a TXT record and return its Cloudflare record id."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                self._records_url(),
                headers=self._headers,
                json={
                    "type": "TXT",  # TXT ONLY — never A/AAAA.
                    "name": name,
                    "content": value,
                    "ttl": _TXT_TTL,
                },
            )
        payload = self._raise_unless_ok(resp, "create TXT")
        record_id = payload["result"]["id"]
        logger.info("cloudflare: created TXT %s (id=%s)", name, record_id)
        return record_id

    async def delete_txt_record(self, record_id: str) -> None:
        """Delete a TXT record by id. Swallows nothing — the caller's
        finally block decides whether a delete failure is fatal."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.delete(
                self._records_url(record_id), headers=self._headers
            )
        self._raise_unless_ok(resp, "delete TXT")
        logger.info("cloudflare: deleted TXT id=%s", record_id)

    async def _await_propagation(self) -> None:
        """Best-effort wait for the TXT to propagate before answering the
        ACME challenge. We sleep up to the propagation timeout in poll-sized
        steps; LE re-checks authoritative NS directly so a fixed wait is the
        pragmatic choice (and is 0 in tests)."""
        if self._propagation_timeout <= 0:
            return
        waited = 0
        step = max(self._poll, 1)
        while waited < self._propagation_timeout:
            await asyncio.sleep(step)
            waited += step

    async def publish_challenge(
        self,
        name: str,
        value: str,
        body: Callable[[], Awaitable[None]],
    ) -> None:
        """Create the TXT, await propagation, run ``body`` (the ACME
        answer+finalize), and ALWAYS delete the TXT afterward — even if
        ``body`` raises. No orphan record is ever left in public DNS.
        """
        record_id = await self.create_txt_record(name, value)
        try:
            await self._await_propagation()
            await body()
        finally:
            try:
                await self.delete_txt_record(record_id)
            except Exception as exc:  # noqa: BLE001
                # A failed cleanup must not mask the original outcome, but it
                # MUST be loud — an orphaned TXT is a (minor) leak.
                logger.error(
                    "cloudflare: FAILED to delete challenge TXT id=%s (%s) — "
                    "orphaned record, manual cleanup needed",
                    record_id, exc,
                )
