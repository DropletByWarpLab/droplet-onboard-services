"""Idempotent startup migration runner (db.run_migrations).

There is no alembic/SQLAlchemy here — numbered .sql files are applied at
startup and recorded in a ledger so re-runs skip already-applied files.
We test the runner against a fake asyncpg connection (records SQL,
tracks the ledger) so it's hermetic — no live Postgres.
"""

from __future__ import annotations

import pytest

import db


class _FakeConn:
    """Minimal asyncpg-connection stand-in for the migration runner."""

    def __init__(self):
        self.executed: list[str] = []
        self._applied: set[str] = set()

    async def execute(self, sql: str, *args):
        self.executed.append(sql)
        return "OK"

    async def fetchval(self, sql: str, *args):
        # Emulates: SELECT 1 FROM schema_migrations WHERE filename = $1
        if "schema_migrations" in sql and args:
            return 1 if args[0] in self._applied else None
        return None

    def _mark_applied(self, filename: str):
        self._applied.add(filename)


@pytest.mark.asyncio
async def test_runs_all_migrations_on_fresh_db():
    conn = _FakeConn()
    applied = await db.run_migrations(conn)
    # The 0001 file exists on disk and should be applied.
    assert "0001_device_certificates.sql" in applied
    # The actual table DDL ran.
    joined = "\n".join(conn.executed)
    assert "CREATE TABLE IF NOT EXISTS devices" in joined
    assert "device_certificates" in joined
    assert "challenges" in joined


@pytest.mark.asyncio
async def test_skips_already_applied_migrations():
    conn = _FakeConn()
    conn._mark_applied("0001_device_certificates.sql")
    applied = await db.run_migrations(conn)
    # Already in the ledger -> not re-applied.
    assert "0001_device_certificates.sql" not in applied
    # The DDL for devices must NOT have been re-run.
    joined = "\n".join(conn.executed)
    assert "CREATE TABLE IF NOT EXISTS devices" not in joined


@pytest.mark.asyncio
async def test_records_applied_migration_in_ledger():
    conn = _FakeConn()
    await db.run_migrations(conn)
    joined = "\n".join(conn.executed)
    # The runner inserts the filename into the ledger after applying.
    assert "INSERT INTO schema_migrations" in joined
