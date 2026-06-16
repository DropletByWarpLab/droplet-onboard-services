"""Data access for the issuance service (asyncpg, raw SQL).

Mirrors services/email-indexer/db.py's raw-asyncpg posture — no
alembic/SQLAlchemy. The route + flow layers depend on the
``IssuanceRepository`` Protocol, so they can be tested against an
in-memory fake while production uses ``PgIssuanceRepository`` over the
asyncpg pool. The Postgres-backed implementation is exercised by the
env-gated integration test (see tests/test_repository_pg.py).
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Protocol

import asyncpg

from schemas import CertStatus


@dataclass
class DeviceRow:
    device_id: str
    public_key_pem: str
    key_fingerprint: str


@dataclass
class ChallengeRow:
    nonce: str
    device_id: str
    expires_at: datetime
    consumed_at: Optional[datetime]


@dataclass
class CertRow:
    device_id: str
    public_label: str
    fqdn: str
    status: CertStatus
    order_id: Optional[str] = None
    csr_pem: Optional[str] = None
    fullchain_pem: Optional[str] = None
    cert_serial: Optional[str] = None
    not_before: Optional[datetime] = None
    not_after: Optional[datetime] = None
    last_renewed_at: Optional[datetime] = None
    csr_fingerprint: Optional[str] = None
    last_error: Optional[str] = None


def new_nonce() -> str:
    """A URL-safe single-use nonce."""
    return secrets.token_urlsafe(32)


def new_order_id() -> str:
    return "ord_" + secrets.token_urlsafe(16)


class IssuanceRepository(Protocol):
    # registry
    async def get_device(self, device_id: str) -> Optional[DeviceRow]: ...

    # challenges
    async def create_challenge(
        self, *, nonce: str, device_id: str, expires_at: datetime
    ) -> None: ...
    async def get_challenge(self, nonce: str) -> Optional[ChallengeRow]: ...
    async def consume_challenge(self, nonce: str, *, now: datetime) -> bool: ...
    async def count_recent_challenges(
        self, device_id: str, *, since: datetime
    ) -> int: ...

    # certificates
    async def get_cert(self, device_id: str) -> Optional[CertRow]: ...
    async def get_cert_by_order(self, order_id: str) -> Optional[CertRow]: ...
    async def upsert_cert_pending(
        self,
        *,
        device_id: str,
        public_label: str,
        fqdn: str,
        order_id: str,
        csr_fingerprint: str,
        csr_pem: str,
    ) -> None: ...
    async def mark_cert_active(
        self,
        *,
        device_id: str,
        fullchain_pem: str,
        cert_serial: str,
        not_before: datetime,
        not_after: datetime,
    ) -> None: ...
    async def mark_cert_failed(self, *, device_id: str, last_error: str) -> None: ...
    async def mark_cert_renewing(self, *, device_id: str) -> None: ...
    async def mark_cert_revoked(self, *, device_id: str) -> None: ...
    async def list_renewable(self, *, before: datetime) -> list[CertRow]: ...


def _row_to_cert(r: asyncpg.Record) -> CertRow:
    return CertRow(
        device_id=r["device_id"],
        public_label=r["public_label"],
        fqdn=r["fqdn"],
        status=CertStatus(r["status"]),
        order_id=r["order_id"],
        csr_pem=r["csr_pem"],
        fullchain_pem=r["fullchain_pem"],
        cert_serial=r["cert_serial"],
        not_before=r["not_before"],
        not_after=r["not_after"],
        last_renewed_at=r["last_renewed_at"],
        csr_fingerprint=r["csr_fingerprint"],
        last_error=r["last_error"],
    )


class PgIssuanceRepository:
    """asyncpg-backed repository."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get_device(self, device_id: str) -> Optional[DeviceRow]:
        r = await self._pool.fetchrow(
            "SELECT device_id, public_key_pem, key_fingerprint "
            "FROM devices WHERE device_id = $1",
            device_id,
        )
        if r is None:
            return None
        return DeviceRow(
            device_id=r["device_id"],
            public_key_pem=r["public_key_pem"],
            key_fingerprint=r["key_fingerprint"],
        )

    async def create_challenge(
        self, *, nonce: str, device_id: str, expires_at: datetime
    ) -> None:
        await self._pool.execute(
            "INSERT INTO challenges (nonce, device_id, expires_at) "
            "VALUES ($1, $2, $3)",
            nonce, device_id, expires_at,
        )

    async def get_challenge(self, nonce: str) -> Optional[ChallengeRow]:
        r = await self._pool.fetchrow(
            "SELECT nonce, device_id, expires_at, consumed_at "
            "FROM challenges WHERE nonce = $1",
            nonce,
        )
        if r is None:
            return None
        return ChallengeRow(
            nonce=r["nonce"],
            device_id=r["device_id"],
            expires_at=r["expires_at"],
            consumed_at=r["consumed_at"],
        )

    async def consume_challenge(self, nonce: str, *, now: datetime) -> bool:
        """Atomically consume a still-valid, unconsumed nonce. Returns True
        iff this call consumed it (single-use guarantee under concurrency:
        the UPDATE ... WHERE consumed_at IS NULL only matches once)."""
        r = await self._pool.fetchrow(
            "UPDATE challenges SET consumed_at = $2 "
            "WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > $2 "
            "RETURNING nonce",
            nonce, now,
        )
        return r is not None

    async def count_recent_challenges(self, device_id: str, *, since: datetime) -> int:
        return await self._pool.fetchval(
            "SELECT count(*) FROM challenges "
            "WHERE device_id = $1 AND created_at > $2",
            device_id, since,
        )

    async def get_cert(self, device_id: str) -> Optional[CertRow]:
        r = await self._pool.fetchrow(
            "SELECT * FROM device_certificates WHERE device_id = $1", device_id
        )
        return _row_to_cert(r) if r else None

    async def get_cert_by_order(self, order_id: str) -> Optional[CertRow]:
        r = await self._pool.fetchrow(
            "SELECT * FROM device_certificates WHERE order_id = $1", order_id
        )
        return _row_to_cert(r) if r else None

    async def upsert_cert_pending(
        self,
        *,
        device_id: str,
        public_label: str,
        fqdn: str,
        order_id: str,
        csr_fingerprint: str,
        csr_pem: str,
    ) -> None:
        await self._pool.execute(
            """
            INSERT INTO device_certificates
                (device_id, public_label, fqdn, status, order_id,
                 csr_fingerprint, csr_pem, last_error, updated_at)
            VALUES ($1, $2, $3, 'pending', $4, $5, $6, NULL, now())
            ON CONFLICT (device_id) DO UPDATE SET
                status = 'pending',
                order_id = EXCLUDED.order_id,
                csr_fingerprint = EXCLUDED.csr_fingerprint,
                csr_pem = EXCLUDED.csr_pem,
                last_error = NULL,
                updated_at = now()
            """,
            device_id, public_label, fqdn, order_id, csr_fingerprint, csr_pem,
        )

    async def mark_cert_active(
        self,
        *,
        device_id: str,
        fullchain_pem: str,
        cert_serial: str,
        not_before: datetime,
        not_after: datetime,
    ) -> None:
        await self._pool.execute(
            """
            UPDATE device_certificates SET
                status = 'active',
                fullchain_pem = $2,
                cert_serial = $3,
                not_before = $4,
                not_after = $5,
                last_renewed_at = now(),
                last_error = NULL,
                updated_at = now()
            WHERE device_id = $1
            """,
            device_id, fullchain_pem, cert_serial, not_before, not_after,
        )

    async def mark_cert_failed(self, *, device_id: str, last_error: str) -> None:
        await self._pool.execute(
            "UPDATE device_certificates SET status = 'failed', "
            "last_error = $2, updated_at = now() WHERE device_id = $1",
            device_id, last_error[:1000],
        )

    async def mark_cert_renewing(self, *, device_id: str) -> None:
        await self._pool.execute(
            "UPDATE device_certificates SET status = 'renewing', "
            "updated_at = now() WHERE device_id = $1",
            device_id,
        )

    async def mark_cert_revoked(self, *, device_id: str) -> None:
        await self._pool.execute(
            "UPDATE device_certificates SET status = 'revoked', "
            "updated_at = now() WHERE device_id = $1",
            device_id,
        )

    async def list_renewable(self, *, before: datetime) -> list[CertRow]:
        rows = await self._pool.fetch(
            "SELECT * FROM device_certificates "
            "WHERE status = 'active' AND not_after IS NOT NULL "
            "AND not_after <= $1",
            before,
        )
        return [_row_to_cert(r) for r in rows]
