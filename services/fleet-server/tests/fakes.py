"""In-memory fakes for hermetic route/flow tests.

A :class:`FakeRepository` implements the IssuanceRepository Protocol over
plain dicts, with the SAME single-use/expiry semantics as the Postgres
implementation (consume_challenge only succeeds once, only while
unconsumed + unexpired). A :class:`FakeAcmeIssuer` stands in for the real
ACME dance.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from repository import CertRow, ChallengeRow, DeviceRow
from schemas import CertStatus


class FakeRepository:
    def __init__(self) -> None:
        self.devices: dict[str, DeviceRow] = {}
        self.challenges: dict[str, ChallengeRow] = {}
        self.certs: dict[str, CertRow] = {}

    # --- registry ---
    def seed_device(self, device_id: str, public_key_pem: str, key_fingerprint: str):
        self.devices[device_id] = DeviceRow(device_id, public_key_pem, key_fingerprint)

    async def get_device(self, device_id: str) -> Optional[DeviceRow]:
        return self.devices.get(device_id)

    # --- challenges ---
    async def create_challenge(self, *, nonce, device_id, expires_at) -> None:
        row = ChallengeRow(
            nonce=nonce, device_id=device_id, expires_at=expires_at, consumed_at=None
        )
        row._created_at = datetime.now(timezone.utc)
        self.challenges[nonce] = row

    async def get_challenge(self, nonce) -> Optional[ChallengeRow]:
        return self.challenges.get(nonce)

    async def consume_challenge(self, nonce, *, now) -> bool:
        c = self.challenges.get(nonce)
        if c is None or c.consumed_at is not None or now >= c.expires_at:
            return False
        c.consumed_at = now
        return True

    async def count_recent_challenges(self, device_id, *, since) -> int:
        return sum(
            1
            for c in self.challenges.values()
            if c.device_id == device_id and _created(c) > since
        )

    # --- certificates ---
    async def get_cert(self, device_id) -> Optional[CertRow]:
        return self.certs.get(device_id)

    async def get_cert_by_order(self, order_id) -> Optional[CertRow]:
        for c in self.certs.values():
            if c.order_id == order_id:
                return c
        return None

    async def upsert_cert_pending(
        self, *, device_id, public_label, fqdn, order_id, csr_fingerprint, csr_pem
    ) -> None:
        self.certs[device_id] = CertRow(
            device_id=device_id,
            public_label=public_label,
            fqdn=fqdn,
            status=CertStatus.PENDING,
            order_id=order_id,
            csr_pem=csr_pem,
            csr_fingerprint=csr_fingerprint,
            last_error=None,
        )

    async def mark_cert_active(
        self, *, device_id, fullchain_pem, cert_serial, not_before, not_after
    ) -> None:
        c = self.certs[device_id]
        c.status = CertStatus.ACTIVE
        c.fullchain_pem = fullchain_pem
        c.cert_serial = cert_serial
        c.not_before = not_before
        c.not_after = not_after
        c.last_renewed_at = datetime.now(timezone.utc)
        c.last_error = None

    async def mark_cert_failed(self, *, device_id, last_error) -> None:
        c = self.certs[device_id]
        c.status = CertStatus.FAILED
        c.last_error = last_error

    async def mark_cert_renewing(self, *, device_id) -> None:
        self.certs[device_id].status = CertStatus.RENEWING

    async def mark_cert_revoked(self, *, device_id) -> None:
        self.certs[device_id].status = CertStatus.REVOKED

    async def list_renewable(self, *, before) -> list[CertRow]:
        return [
            c
            for c in self.certs.values()
            if c.status == CertStatus.ACTIVE
            and c.not_after is not None
            and c.not_after <= before
        ]


# challenges in the fake don't track created_at separately; treat the
# challenge as "created now" for rate-limit counting (tests set their own
# windows). We stash a created_at on the row lazily.
def _created(c: ChallengeRow) -> datetime:
    return getattr(c, "_created_at", c.expires_at)


class FakeAcmeIssuer:
    """Stand-in for AcmeIssuer used by route/flow tests."""

    def __init__(self, *, fullchain: str = "FULLCHAIN-PEM", fail: bool = False):
        self.fullchain = fullchain
        self.fail = fail
        self.ordered: list[tuple[str, str]] = []
        self.revoked: list[str] = []

    async def order_certificate(self, *, csr_pem, fqdn):
        self.ordered.append((csr_pem, fqdn))
        if self.fail:
            raise RuntimeError("simulated ACME failure")
        from types import SimpleNamespace
        return SimpleNamespace(fullchain_pem=self.fullchain)

    async def revoke_certificate(self, fullchain_pem, *, reason=0):
        self.revoked.append(fullchain_pem)
