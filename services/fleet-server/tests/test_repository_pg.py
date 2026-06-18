"""Env-gated Postgres integration test for PgIssuanceRepository.

Skipped by default. To run against a real (throwaway) Postgres:

    FLEET_PG_TESTS=1 FLEET_TEST_DATABASE_URL=postgresql://u:p@host/db \
        pytest tests/test_repository_pg.py

It applies the real migrations TWICE to prove idempotency, then exercises
the actual SQL (single-use nonce under the atomic UPDATE, status
transitions, renewal selection).
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("FLEET_PG_TESTS") != "1",
    reason="set FLEET_PG_TESTS=1 (+ FLEET_TEST_DATABASE_URL) to run PG integration tests",
)


def _now():
    return datetime.now(timezone.utc)


@pytest.fixture
async def pool():
    import asyncpg
    dsn = os.environ["FLEET_TEST_DATABASE_URL"]
    p = await asyncpg.create_pool(dsn, min_size=1, max_size=4)
    # Clean slate.
    async with p.acquire() as conn:
        await conn.execute(
            "DROP TABLE IF EXISTS device_certificates, challenges, devices, "
            "schema_migrations CASCADE"
        )
    yield p
    await p.close()


@pytest.mark.asyncio
async def test_migrations_are_idempotent(pool):
    import db
    async with pool.acquire() as conn:
        first = await db.run_migrations(conn)
        second = await db.run_migrations(conn)
    assert "0001_device_certificates.sql" in first
    assert second == []  # second run applies nothing


@pytest.mark.asyncio
async def test_single_use_nonce_atomic(pool):
    import db
    from repository import PgIssuanceRepository
    async with pool.acquire() as conn:
        await db.run_migrations(conn)
        await conn.execute(
            "INSERT INTO devices (device_id, public_key_pem, key_fingerprint) "
            "VALUES ('d1', 'pk', 'fp')"
        )
    repo = PgIssuanceRepository(pool)
    await repo.create_challenge(
        nonce="n1", device_id="d1", expires_at=_now() + timedelta(seconds=60)
    )
    assert await repo.consume_challenge("n1", now=_now()) is True
    # Second consume of the same nonce fails — single use.
    assert await repo.consume_challenge("n1", now=_now()) is False


@pytest.mark.asyncio
async def test_renewable_selection_sql(pool):
    import db
    from repository import PgIssuanceRepository
    async with pool.acquire() as conn:
        await db.run_migrations(conn)
        await conn.execute(
            "INSERT INTO devices (device_id, public_key_pem, key_fingerprint) "
            "VALUES ('d1','pk','fp'),('d2','pk','fp')"
        )
    repo = PgIssuanceRepository(pool)
    for did, label, fq in [("d1", "d-1", "d-1.x"), ("d2", "d-2", "d-2.x")]:
        await repo.upsert_cert_pending(
            device_id=did, public_label=label, fqdn=fq,
            order_id="o-" + did, csr_fingerprint="fp", csr_pem="CSR",
        )
    await repo.mark_cert_active(
        device_id="d1", fullchain_pem="fc", cert_serial="01",
        not_before=_now() - timedelta(days=80),
        not_after=_now() + timedelta(days=10),  # due
    )
    await repo.mark_cert_active(
        device_id="d2", fullchain_pem="fc", cert_serial="02",
        not_before=_now(), not_after=_now() + timedelta(days=80),  # not due
    )
    due = await repo.list_renewable(before=_now() + timedelta(days=30))
    assert {c.device_id for c in due} == {"d1"}
