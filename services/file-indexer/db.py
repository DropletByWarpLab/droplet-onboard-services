"""Database operations for the file content index (pgvector)."""

from __future__ import annotations

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
) -> None:
    """Insert or update a single chunk + embedding.

    Uses the (ncFileId, chunkIdx) unique constraint for upsert semantics.
    """
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "FileContentChunk"
                ("userId", "ncFileId", "path", "chunkIdx", "text", "embedding", "indexedAt")
            VALUES (%s, %s, %s, %s, %s, %s::vector, NOW())
            ON CONFLICT ("ncFileId", "chunkIdx")
            DO UPDATE SET
                "path"      = EXCLUDED."path",
                "text"      = EXCLUDED."text",
                "embedding" = EXCLUDED."embedding",
                "indexedAt"  = NOW()
            """,
            (user_id, nc_file_id, path, chunk_idx, text, embedding),
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
