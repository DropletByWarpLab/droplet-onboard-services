"""Database operations for the file content index (pgvector)."""

from __future__ import annotations

import json
import logging
import threading
from typing import Optional

import psycopg2
import psycopg2.extras
from pgvector.psycopg2 import register_vector

from config import DATABASE_URL

logger = logging.getLogger(__name__)

_conn: Optional[psycopg2.extensions.connection] = None

# IDX-01: a single module-global psycopg2 connection is shared across several
# threads — the watcher's per-file ``threading.Timer`` workers, the paho MQTT
# network thread (brain-ingest), the apscheduler thread (daily ASR pass), and
# the uvicorn ``/reindex`` request thread. A psycopg2 connection is NOT safe
# for concurrent use: two threads issuing ``execute`` on the same connection
# corrupt its protocol state ("another command is already in progress"), which
# under concurrent uploads manifests as dropped/failed indexing.
#
# We serialise *every* access to the shared connection — both the helpers that
# fetch it via ``get_conn()`` internally and the ``conn``-parameter helpers
# that callers invoke with ``get_conn()`` (transcription_worker) — behind this
# lock. It is an ``RLock`` because some operations are nested
# (``prune_excess_chunks`` → ``delete_chunks_for_file``).
#
# Scope note: this guards only the shared module connection. Paths that open
# their *own* private connection (``reindex_one`` in brain_ingest) are
# unaffected and never contend on this lock. Throughput here is low (indexing),
# so coarse serialisation is the right trade-off over a connection pool.
_db_lock = threading.RLock()


def get_conn() -> psycopg2.extensions.connection:
    """Get the module-level DB connection, reconnecting if needed.

    Auto-reconnects on broken connections (e.g. PG restart) so a transient
    failure doesn't permanently break the daemon.

    IDX-01: callers MUST hold ``_db_lock`` while using the returned connection.
    Every helper in this module does so; the liveness probe + reconnect below
    also runs under the lock (callers already hold it) so a reconnect can't
    race a concurrent ``execute`` on the old connection.
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
    sensitivity: str = "standard",
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

    WARP-242 adds `sensitivity`: brain writers pass "sensitive" together
    with a dcv1-encrypted `text` (the column is the POLICY marker; the
    dcv1: prefix is the FORMAT marker). The generated text_tsv column
    auto-NULLs for sensitive rows, keeping ciphertext out of the lexical
    index. Default "standard" keeps the Nextcloud watcher path untouched.
    """
    metadata_value = json.dumps(metadata) if metadata is not None else None
    # IDX-01: hold _db_lock for the cursor's lifetime so concurrent threads
    # never execute on the shared connection at once.
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            """
            INSERT INTO "FileContentChunk"
                ("userId", "ncFileId", "path", "chunkIdx", "text", "embedding",
                 "indexedAt", "source", "brainItemId", "pageNumber", "warnings",
                 "metadata", "sensitivity")
            VALUES (%s, %s, %s, %s, %s, %s::vector, NOW(), %s::"FileContentSource",
                    %s, %s, %s, %s::jsonb, %s::"ChunkSensitivity")
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
                "metadata"    = EXCLUDED."metadata",
                "sensitivity" = EXCLUDED."sensitivity"
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
                sensitivity,
            ),
        )


# ── WARP-1139/WARP-1140: explicit per-file index status ──
#
# Search UIs must distinguish "not indexed yet / skipped / failed" from
# "no match", which is impossible when indexing state is derived from
# FileContentChunk row ABSENCE (the CLAUDE.md no-guessing rule; WARP-218
# is the pattern). The watcher upserts one row per watched file at each
# pipeline stage; the orchestrator's GET /api/files/search/status reads
# the pending/failed counts.
#
# All three helpers are best-effort at the CALL SITE (watcher wraps them
# in try/except): a deployment where the FileIndexStatus migration has
# not run yet must degrade to the old behaviour, never break indexing.


def set_index_status(
    user_id: str,
    path: str,
    status: str,
    *,
    nc_file_id: Optional[int] = None,
    reason: Optional[str] = None,
) -> None:
    """Upsert the explicit index status for one (userId, path).

    `status` is one of 'indexing' | 'ready' | 'skipped' | 'failed'
    (the FileIndexState enum). `reason` is persisted only for
    skipped/failed rows (truncated to 200 chars, mirroring
    BrainMemoryItem.failureReason).
    """
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            """
            INSERT INTO "FileIndexStatus"
                ("userId", "path", "ncFileId", "status", "reason", "updatedAt")
            VALUES (%s, %s, %s, %s::"FileIndexState", %s, NOW())
            ON CONFLICT ("userId", "path")
            DO UPDATE SET
                "ncFileId"  = EXCLUDED."ncFileId",
                "status"    = EXCLUDED."status",
                "reason"    = EXCLUDED."reason",
                "updatedAt" = NOW()
            """,
            (
                user_id,
                path,
                nc_file_id,
                status,
                (reason or "")[:200] if reason else None,
            ),
        )


def delete_index_status(user_id: str, path: str) -> None:
    """Drop the status row for a deleted file (its state is 'gone', not a
    lingering 'ready')."""
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            'DELETE FROM "FileIndexStatus" WHERE "userId" = %s AND "path" = %s',
            (user_id, path),
        )


def fetch_index_status_map() -> dict[tuple[str, str], tuple[str, float, Optional[str]]]:
    """Return {(userId, path): (status, updatedAt-epoch-seconds, reason)}
    for every row. Used by the startup reconcile scan to decide which
    on-disk files still need indexing without a per-file query.

    WARP-1842: `reason` rides along so the scan can retry `skipped` rows
    selectively (only reasons the current code genuinely resolves, e.g.
    `unknown_type` after the Office/ODF MIME registration) — never the
    whole skipped corpus."""
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            'SELECT "userId", "path", "status"::text, '
            'EXTRACT(EPOCH FROM "updatedAt"), "reason" FROM "FileIndexStatus"'
        )
        rows = cur.fetchall()
    return {(r[0], r[1]): (r[2], float(r[3]), r[4]) for r in rows}


def delete_chunks_for_brain_item(brain_item_id: str) -> None:
    """Remove all chunks for a single BrainMemoryItem.

    Used before re-indexing a brain item so the chunkIdx unique
    constraint doesn't collide on the second pass (brain items don't
    use ncFileId as a stable identity, so we can't lean on the existing
    unique constraint for upsert).
    """
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            'DELETE FROM "FileContentChunk" WHERE "brainItemId" = %s',
            (brain_item_id,),
        )


def mark_brain_item_indexed(
    brain_item_id: str,
    *,
    status: str = "ready",
    failure_reason: Optional[str] = None,
    warnings: Optional[list[str]] = None,
) -> None:
    """Mark a BrainMemoryItem as finished — atomically writes indexedAt,
    status, extractorWarnings, and (for status='failed') failureReason.

    Idempotent — safe to call repeatedly on the same row.

    WARP-330: previously this helper only set ``indexedAt`` + warnings, which
    left the row at ``status='indexing'`` (the default) forever. The
    dashboard's pipeline-health aggregate filters on ``status='ready'``,
    so all chat-attached items showed "never reached ready" on /context
    even though they were fully indexed. The CLAUDE.md "no guessing"
    rule applies: persistent state lives in explicit columns, not in
    "indexedAt is set so it must be ready" inference.

    Side effects per status (mirrors ``update_item_status`` for parity):

    - ``status='ready'``  → indexedAt=NOW, failureReason=NULL, retry-window
      cleared (recentAttemptCount=0, recentAttemptWindowStartedAt=NULL),
      extractorWarnings replaced with the supplied list.
    - ``status='failed'`` → indexedAt=NOW, failureReason set (truncated to
      200 chars to match ``update_item_status``), extractorWarnings
      replaced. Retry-window left alone — claim_attempt owns those.
    """
    if status == "ready":
        with _db_lock, get_conn().cursor() as cur:
            cur.execute(
                """
                UPDATE "BrainMemoryItem"
                   SET "indexedAt" = NOW(),
                       "status" = 'ready',
                       "failureReason" = NULL,
                       "recentAttemptCount" = 0,
                       "recentAttemptWindowStartedAt" = NULL,
                       "extractorWarnings" = %s
                 WHERE "id" = %s
                """,
                (warnings or [], brain_item_id),
            )
    elif status == "failed":
        with _db_lock, get_conn().cursor() as cur:
            cur.execute(
                """
                UPDATE "BrainMemoryItem"
                   SET "indexedAt" = NOW(),
                       "status" = 'failed',
                       "failureReason" = %s,
                       "extractorWarnings" = %s
                 WHERE "id" = %s
                """,
                (
                    (failure_reason or "")[:200],
                    warnings or [],
                    brain_item_id,
                ),
            )
    else:
        # Defensive fallback. No production caller should land here —
        # raises so a typo'd status='Ready' surfaces in tests instead of
        # silently leaving the row stuck.
        raise ValueError(
            f"mark_brain_item_indexed: unsupported status={status!r}; "
            "expected 'ready' or 'failed'"
        )


def set_vision_render(brain_item_id: str, has_render: bool = True) -> None:
    """Flag that a normalized ``vision.jpg`` render exists on disk for this item.

    Image vision: the chat route reads ``hasVisionRender`` to decide whether an
    image attachment can be forwarded to a vision-capable model. Explicit
    column (no guessing). Idempotent.
    """
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            'UPDATE "BrainMemoryItem" SET "hasVisionRender" = %s WHERE "id" = %s',
            (has_render, brain_item_id),
        )


def delete_chunks_for_file(nc_file_id: int) -> None:
    """Remove all chunks for a file (e.g. when it's deleted or re-indexed)."""
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            'DELETE FROM "FileContentChunk" WHERE "ncFileId" = %s',
            (nc_file_id,),
        )


def fetch_department_for_groupfolder(gf_id: int) -> Optional[dict]:
    """WARP-1264: resolve a groupfolder id to its owning Department.

    Returns ``{"id": ..., "kind": ..., "name": ...}`` or None when no
    Department row references this groupfolder id — the caller (the
    watcher's ``_lookup_department_for_groupfolder``) must skip the file
    rather than guess a corpus for an unrecognized groupfolder.
    """
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            'SELECT "id", "kind"::text, "name" FROM "Department" '
            'WHERE "ncGroupfolderId" = %s',
            (gf_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {"id": row[0], "kind": row[1], "name": row[2]}


def delete_chunks_for_path(user_id: str, path: str) -> int:
    """Remove all chunks for a (userId, path) pair; returns rows deleted.

    IDX-09 fallback for deletes where the Nextcloud `oc_filecache` row has
    already been purged (so `ncFileId` can't be resolved). The watcher stores
    `path` as `"/<relpath>"` and `userId` as the Nextcloud user, so a delete
    keyed on those drops the orphaned vectors that would otherwise linger in
    search. Scoped to a single user's own path — never a cross-user wildcard.
    """
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            'DELETE FROM "FileContentChunk" WHERE "userId" = %s AND "path" = %s',
            (user_id, path),
        )
        return cur.rowcount


# ── WARP-218: BrainMemoryItem status helpers ──
#
# These helpers run plain psycopg parametrised SQL — same style as
# upsert_chunk above. Unlike the older helpers that pull `get_conn()`
# internally, these accept the conn explicitly so the worker can hold a
# single connection across a SELECT-then-UPDATE inside `claim_attempt`.
# That matches the spec's "atomic read+write within a single conn
# transaction" requirement for the rolling-hour retry cap.


def select_queued_items(conn, *, limit: int = 50) -> list[dict]:
    """Return BrainMemoryItem rows with status='queued_for_transcription',
    oldest-first by uploadedAt. Each dict has id, userId, storagePath, mimeType.

    WARP-905: the daily ASR pass must respect the per-item ingest policy —
    audio/video uploaded with ingestPolicy='await_approval' are HELD, so they
    are filtered out here and never auto-transcribed. The explicit approve
    action (POST /files/brain/:id/approve → publishRunOne → run_one) is the
    only path that drives a held item, and it flips the policy to auto_embed
    first, so a later reconcile→retry through this query picks it up normally.

    IDX-01: the ``conn``-parameter helpers run against the same shared
    connection the worker obtains from ``get_conn()``, so they take ``_db_lock``
    too. For multi-statement helpers (``claim_attempt``, ``update_item_status``,
    ``reconcile_stuck_items``) the lock is held across the SELECT/UPDATE +
    ``commit()`` so the read-modify-write stays atomic against other threads.
    """
    with _db_lock, conn.cursor() as cur:
        cur.execute(
            """
            SELECT "id", "userId", "storagePath", "mimeType"
              FROM "BrainMemoryItem"
             WHERE "status" = 'queued_for_transcription'
               AND "ingestPolicy" = 'auto_embed'
             ORDER BY "uploadedAt" ASC
             LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {"id": r[0], "userId": r[1], "storagePath": r[2], "mimeType": r[3]}
        for r in rows
    ]


def update_item_status(
    conn,
    *,
    item_id: str,
    status: str,
    failure_reason: Optional[str] = None,
) -> None:
    """Update BrainMemoryItem.status (+ side-effects per the state machine).

    Side effects:
      - status='ready'  → indexedAt = NOW(), failureReason = NULL,
                          recentAttemptCount = 0,
                          recentAttemptWindowStartedAt = NULL
      - status='failed' → failureReason set
      - other transitions → just status (no side effects)
    """
    # IDX-01: hold _db_lock across the UPDATE + commit (see select_queued_items).
    with _db_lock:
        if status == "ready":
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE "BrainMemoryItem"
                       SET "status" = %s,
                           "indexedAt" = NOW(),
                           "failureReason" = NULL,
                           "recentAttemptCount" = 0,
                           "recentAttemptWindowStartedAt" = NULL
                     WHERE "id" = %s
                    """,
                    (status, item_id),
                )
        elif status == "failed":
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE "BrainMemoryItem"
                       SET "status" = %s,
                           "failureReason" = %s
                     WHERE "id" = %s
                    """,
                    (status, (failure_reason or "")[:200], item_id),
                )
        else:
            with conn.cursor() as cur:
                cur.execute(
                    'UPDATE "BrainMemoryItem" SET "status" = %s WHERE "id" = %s',
                    (status, item_id),
                )
        # The module-level `_conn` is autocommit (see get_conn), so commit is a
        # no-op there. Calling it explicitly stays correct for fresh
        # non-autocommit connections too.
        try:
            conn.commit()
        except Exception:
            pass


def claim_attempt(conn, *, item_id: str) -> bool:
    """Apply the rolling-hour retry cap (max 3 / 60 min). Returns True if
    we may proceed (and bumps the counter); False if cap is hit.
    Atomically reads + writes within a single conn transaction.
    """
    from datetime import datetime, timedelta, timezone

    # IDX-01: hold _db_lock for the whole SELECT→decide→UPDATE→commit so the
    # rolling-hour counter can't race another thread's interleaved write.
    with _db_lock, conn.cursor() as cur:
        cur.execute(
            """
            SELECT "recentAttemptWindowStartedAt", "recentAttemptCount"
              FROM "BrainMemoryItem"
             WHERE "id" = %s
            """,
            (item_id,),
        )
        row = cur.fetchone()
        if row is None:
            return False
        window_started_at, count = row
        now = datetime.now(tz=timezone.utc)
        # Normalise naive datetimes to UTC so the timedelta math doesn't
        # explode when Postgres hands back a tz-naive timestamp.
        if window_started_at is not None and window_started_at.tzinfo is None:
            window_started_at = window_started_at.replace(tzinfo=timezone.utc)
        # If window expired (>1h since opened) OR never opened → fresh slot.
        if window_started_at is None or (now - window_started_at) > timedelta(hours=1):
            cur.execute(
                """
                UPDATE "BrainMemoryItem"
                   SET "recentAttemptCount" = 1,
                       "recentAttemptWindowStartedAt" = %s,
                       "lastAttemptedAt" = %s
                 WHERE "id" = %s
                """,
                (now, now, item_id),
            )
            try:
                conn.commit()
            except Exception:
                pass
            return True
        # Window open + count < 3 → bump.
        if count < 3:
            cur.execute(
                """
                UPDATE "BrainMemoryItem"
                   SET "recentAttemptCount" = "recentAttemptCount" + 1,
                       "lastAttemptedAt" = %s
                 WHERE "id" = %s
                """,
                (now, item_id),
            )
            try:
                conn.commit()
            except Exception:
                pass
            return True
        # Cap hit.
        return False


def reconcile_stuck_items(conn, *, stuck_after_hours: int = 6) -> int:
    """Flip rows stuck in 'indexing' (presumably crashed mid-transcription)
    back to 'queued_for_transcription' so the next run picks them up.
    Returns the number of rows updated.
    """
    # IDX-01: hold _db_lock across the UPDATE + rowcount read + commit.
    with _db_lock:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "BrainMemoryItem"
                   SET "status" = 'queued_for_transcription'
                 WHERE "status" = 'indexing'
                   AND "lastAttemptedAt" < NOW() - (%s || ' hours')::interval
                """,
                (str(stuck_after_hours),),
            )
            n = cur.rowcount
        try:
            conn.commit()
        except Exception:
            pass
    return n


def fetch_item(conn, *, item_id: str) -> Optional[dict]:
    """Return BrainMemoryItem fields the worker needs, or None.

    Mirrors the projection returned by select_queued_items so callers
    can treat both as the same shape.
    """
    with _db_lock, conn.cursor() as cur:
        cur.execute(
            """
            SELECT "id", "userId", "storagePath", "mimeType"
              FROM "BrainMemoryItem"
             WHERE "id" = %s
            """,
            (item_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {
        "id": row[0],
        "userId": row[1],
        "storagePath": row[2],
        "mimeType": row[3],
    }


def prune_excess_chunks(nc_file_id: int, max_chunk_idx: int) -> None:
    """Remove chunks beyond the current file's chunk count (file shrunk).

    `max_chunk_idx` is the 0-based index of the last valid chunk. Chunks
    with index > max_chunk_idx are deleted. If max_chunk_idx < 0, all
    chunks are deleted (should not happen in normal flow due to guards).
    """
    if max_chunk_idx < 0:
        delete_chunks_for_file(nc_file_id)
        return
    with _db_lock, get_conn().cursor() as cur:
        cur.execute(
            'DELETE FROM "FileContentChunk" WHERE "ncFileId" = %s AND "chunkIdx" > %s',
            (nc_file_id, max_chunk_idx),
        )
