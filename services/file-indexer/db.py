"""Database operations for the file content index (pgvector)."""

from __future__ import annotations

import json
import logging
from typing import Optional

import psycopg2
import psycopg2.extras
from pgvector.psycopg2 import register_vector

from config import DATABASE_URL

logger = logging.getLogger(__name__)

_conn: Optional[psycopg2.extensions.connection] = None


def get_conn() -> psycopg2.extensions.connection:
    """Get the module-level DB connection, reconnecting if needed.

    Auto-reconnects on broken connections (e.g. PG restart) so a transient
    failure doesn't permanently break the daemon.
    """
    global _conn
    if _conn is not None:
        try:
            # Quick liveness probe — raises if the connection is dead.
            with _conn.cursor() as cur:
                cur.execute("SELECT 1")
            return _conn
        except Exception:
            logger.warning("Database connection lost, reconnecting...")
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None

    _conn = psycopg2.connect(DATABASE_URL)
    _conn.autocommit = True
    register_vector(_conn)
    logger.info("Connected to PostgreSQL (pgvector registered)")
    return _conn


def upsert_chunk(
    user_id: str,
    nc_file_id: int,
    path: str,
    chunk_idx: int,
    text: str,
    embedding: list[float],
    source: str = "nextcloud",
    brain_item_id: Optional[str] = None,
    page_number: Optional[int] = None,
    warnings: Optional[list[str]] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Insert or update a single chunk + embedding.

    For Nextcloud watcher chunks the `(ncFileId, chunkIdx)` unique
    constraint provides upsert semantics. For brain-memory chunks the
    upload route hands us a fresh BrainMemoryItem row, so we delete the
    item's existing chunks first (see `delete_chunks_for_brain_item`)
    rather than trying to multi-key upsert through the same constraint.

    WARP-203 adds the `source`, `brain_item_id`, `page_number`, and
    `warnings` columns. Default `source="nextcloud"` keeps the existing
    watcher path untouched. The `nc_file_id` for brain rows is 0 (the
    column is non-null in the schema; the row's identity comes from
    `brainItemId` instead).

    WARP-214 adds the optional `metadata` jsonb column carrying free-form
    per-chunk metadata: today the `chain[]` recursion breadcrumb (email +
    archive) and `subtitle_source` (video). Future extractors extend the
    dict without needing a schema change.
    """
    metadata_value = json.dumps(metadata) if metadata is not None else None
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "FileContentChunk"
                ("userId", "ncFileId", "path", "chunkIdx", "text", "embedding",
                 "indexedAt", "source", "brainItemId", "pageNumber", "warnings",
                 "metadata")
            VALUES (%s, %s, %s, %s, %s, %s::vector, NOW(), %s::"FileContentSource",
                    %s, %s, %s, %s::jsonb)
            ON CONFLICT ("ncFileId", "chunkIdx")
            DO UPDATE SET
                "path"        = EXCLUDED."path",
                "text"        = EXCLUDED."text",
                "embedding"   = EXCLUDED."embedding",
                "indexedAt"   = NOW(),
                "source"      = EXCLUDED."source",
                "brainItemId" = EXCLUDED."brainItemId",
                "pageNumber"  = EXCLUDED."pageNumber",
                "warnings"    = EXCLUDED."warnings",
                "metadata"    = EXCLUDED."metadata"
            """,
            (
                user_id,
                nc_file_id,
                path,
                chunk_idx,
                text,
                embedding,
                source,
                brain_item_id,
                page_number,
                warnings or [],
                metadata_value,
            ),
        )


def delete_chunks_for_brain_item(brain_item_id: str) -> None:
    """Remove all chunks for a single BrainMemoryItem.

    Used before re-indexing a brain item so the chunkIdx unique
    constraint doesn't collide on the second pass (brain items don't
    use ncFileId as a stable identity, so we can't lean on the existing
    unique constraint for upsert).
    """
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            'DELETE FROM "FileContentChunk" WHERE "brainItemId" = %s',
            (brain_item_id,),
        )


def mark_brain_item_indexed(brain_item_id: str, warnings: Optional[list[str]] = None) -> None:
    """Set BrainMemoryItem.indexedAt = NOW() and merge extractor warnings.

    Idempotent — safe to call on items that are already marked indexed.
    """
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "BrainMemoryItem"
            SET "indexedAt"         = NOW(),
                "extractorWarnings" = %s
            WHERE "id" = %s
            """,
            (warnings or [], brain_item_id),
        )


def delete_chunks_for_file(nc_file_id: int) -> None:
    """Remove all chunks for a file (e.g. when it's deleted or re-indexed)."""
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            'DELETE FROM "FileContentChunk" WHERE "ncFileId" = %s',
            (nc_file_id,),
        )


def prune_excess_chunks(nc_file_id: int, max_chunk_idx: int) -> None:
    """Remove chunks beyond the current file's chunk count (file shrunk).

    `max_chunk_idx` is the 0-based index of the last valid chunk. Chunks
    with index > max_chunk_idx are deleted. If max_chunk_idx < 0, all
    chunks are deleted (should not happen in normal flow due to guards).
    """
    if max_chunk_idx < 0:
        delete_chunks_for_file(nc_file_id)
        return
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            'DELETE FROM "FileContentChunk" WHERE "ncFileId" = %s AND "chunkIdx" > %s',
            (nc_file_id, max_chunk_idx),
        )
