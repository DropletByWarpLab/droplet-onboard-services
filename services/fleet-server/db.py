"""asyncpg pool + idempotent startup migrations (mirrors email-indexer/db.py).

There is no alembic/SQLAlchemy in this codebase. Numbered ``.sql`` files
in ``migrations/`` are applied at startup, in filename order, each
recorded in a ``schema_migrations`` ledger so re-runs skip already-applied
files. Every statement in a migration is itself ``IF NOT EXISTS`` so even
a partially-applied file re-runs cleanly.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

import asyncpg

import config

logger = logging.getLogger(__name__)

_MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

# The ledger table must exist before we can consult it, so its DDL is
# inlined here (the 0001 file also defines it IF NOT EXISTS — harmless).
_LEDGER_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""

_pool: Optional[asyncpg.Pool] = None


async def init_pool() -> None:
    """Open the asyncpg pool. Idempotent."""
    global _pool
    if _pool is not None:
        return
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL not set")
    _pool = await asyncpg.create_pool(
        config.DATABASE_URL, min_size=1, max_size=8, command_timeout=30.0
    )


async def close_pool() -> None:
    global _pool
    if _pool is None:
        return
    await _pool.close()
    _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("db pool not initialized — call init_pool() first")
    return _pool


def _discover_migrations() -> list[Path]:
    if not _MIGRATIONS_DIR.is_dir():
        return []
    return sorted(_MIGRATIONS_DIR.glob("*.sql"))


async def run_migrations(conn: Any) -> list[str]:
    """Apply any not-yet-applied migration files against ``conn``.

    ``conn`` is anything with async ``execute`` / ``fetchval`` (a real
    asyncpg connection in production, a fake in tests). Returns the list
    of filenames applied this run (empty if all were already applied).
    """
    await conn.execute(_LEDGER_DDL)
    applied: list[str] = []
    for path in _discover_migrations():
        filename = path.name
        already = await conn.fetchval(
            "SELECT 1 FROM schema_migrations WHERE filename = $1", filename
        )
        if already:
            logger.debug("migration %s already applied; skipping", filename)
            continue
        sql = path.read_text(encoding="utf-8")
        await conn.execute(sql)
        await conn.execute(
            "INSERT INTO schema_migrations (filename) VALUES ($1) "
            "ON CONFLICT (filename) DO NOTHING",
            filename,
        )
        applied.append(filename)
        logger.info("applied migration %s", filename)
    return applied


async def run_migrations_on_pool() -> list[str]:
    """Convenience: acquire a connection from the pool and migrate."""
    pool = get_pool()
    async with pool.acquire() as conn:
        return await run_migrations(conn)
