"""PostgreSQL database operations for file sync."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

import psycopg2
import psycopg2.extras

from config import DATABASE_URL

logger = logging.getLogger(__name__)

_conn = None


@dataclass
class SyncTarget:
    id: str
    path: str
    label: str
    interval_min: int
    enabled: bool
    last_sync: datetime | None


@dataclass
class FileEntryRecord:
    id: str
    target_id: str
    path: str
    name: str
    is_directory: bool
    size: int
    hash: str | None
    modified_at: datetime


def get_connection():
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg2.connect(DATABASE_URL)
        _conn.autocommit = True
    return _conn


def get_sync_targets() -> list[SyncTarget]:
    """Fetch all enabled sync targets."""
    conn = get_connection()
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT id, path, label, "intervalMin" as interval_min, enabled, "lastSync" as last_sync '
            'FROM "SyncTarget" WHERE enabled = true'
        )
        rows = cur.fetchall()
    return [
        SyncTarget(
            id=r["id"],
            path=r["path"],
            label=r["label"],
            interval_min=r["interval_min"],
            enabled=r["enabled"],
            last_sync=r["last_sync"],
        )
        for r in rows
    ]


def get_file_entries(target_id: str) -> dict[str, FileEntryRecord]:
    """Get all file entries for a target, keyed by path."""
    conn = get_connection()
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT id, "targetId" as target_id, path, name, "isDirectory" as is_directory, '
            'size, hash, "modifiedAt" as modified_at '
            'FROM "FileEntry" WHERE "targetId" = %s',
            (target_id,),
        )
        rows = cur.fetchall()
    return {
        r["path"]: FileEntryRecord(
            id=r["id"],
            target_id=r["target_id"],
            path=r["path"],
            name=r["name"],
            is_directory=r["is_directory"],
            size=r["size"],
            hash=r["hash"],
            modified_at=r["modified_at"],
        )
        for r in rows
    }


def upsert_file_entry(
    target_id: str,
    path: str,
    name: str,
    is_directory: bool,
    size: int,
    mime_type: str | None,
    file_hash: str | None,
    modified_at: datetime,
) -> None:
    """Insert or update a file entry."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "FileEntry" (id, "targetId", path, name, "isDirectory", size, "mimeType", hash, "modifiedAt", "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
            ON CONFLICT ("targetId", path) DO UPDATE SET
                name = EXCLUDED.name,
                "isDirectory" = EXCLUDED."isDirectory",
                size = EXCLUDED.size,
                "mimeType" = EXCLUDED."mimeType",
                hash = EXCLUDED.hash,
                "modifiedAt" = EXCLUDED."modifiedAt",
                "updatedAt" = NOW()
            """,
            (target_id, path, name, is_directory, size, mime_type, file_hash, modified_at),
        )


def delete_file_entry(target_id: str, path: str) -> None:
    """Remove a file entry."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            'DELETE FROM "FileEntry" WHERE "targetId" = %s AND path = %s',
            (target_id, path),
        )


def mark_sync_complete(target_id: str) -> None:
    """Update the lastSync timestamp on a sync target."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE "SyncTarget" SET "lastSync" = NOW(), "updatedAt" = NOW() WHERE id = %s',
            (target_id,),
        )
