"""Brain-memory ingest pipeline (WARP-203).

Consumes `droplet/files/brain/uploaded` events the orchestrator publishes
when a chat-attached file lands, and runs the same extract → chunk →
embed → upsert pipeline as the Nextcloud watcher — but writes
FileContentChunk rows with `source=brain` and `brainItemId=<id>` so the
single cosine search hits both surfaces.

The handler is invoked on the paho MQTT network thread. It MUST stay
fast and never raise (the wrapper in `mqtt_client._on_message` swallows
exceptions, but we publish a `failed` status here on errors so the
dashboard chip can flip its state).

Side effects per successful upload:
  - N FileContentChunk rows inserted (source=brain, brainItemId=<id>).
  - BrainMemoryItem.indexedAt = NOW(), extractorWarnings populated.
  - extracted.txt + manifest.json written under the item directory.
  - droplet/files/brain/indexed published with status=ready.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
from pathlib import Path

from chunker import chunk_text
from db import (
    delete_chunks_for_brain_item,
    mark_brain_item_indexed,
    upsert_chunk,
)
from embedder import embed_texts
from extractors.registry import dispatch
from mqtt_client import publish, subscribe

logger = logging.getLogger(__name__)

BRAIN_UPLOADED_TOPIC = "droplet/files/brain/uploaded"


def _fetch_item_status(item_id: str) -> str | None:
    """Look up BrainMemoryItem.status. Returns None if the row is missing.

    WARP-218: brain_ingest is the synchronous fallback path; audio + video
    rows now land with status='queued_for_transcription' and MUST NOT
    dispatch here — the daily ASR worker (transcription_worker) owns
    them. Documents stay on the inline path with status='indexing'.
    """
    import db

    conn = db.get_conn()
    with conn.cursor() as cur:
        cur.execute(
            'SELECT "status" FROM "BrainMemoryItem" WHERE "id" = %s',
            (item_id,),
        )
        row = cur.fetchone()
    return row[0] if row else None


def _indexed_topic(user_id: str) -> str:
    """Per-user topic for the dashboard's WebSocket bridge.

    Spec §7 names the topic `droplet/files/brain/indexed`, but the
    orchestrator's WS bridge subscribes per-user to
    `droplet/files/<user>/#`. Publishing under the per-user namespace
    routes status flips straight to that user's open browser
    sessions without expanding the bridge's subscription set.
    """
    return f"droplet/files/{user_id}/brain/indexed"


def _publish_status(
    user_id: str,
    item_id: str,
    status: str,
    reason: str | None = None,
) -> None:
    payload: dict[str, object] = {"itemId": item_id, "status": status}
    if reason:
        payload["reason"] = reason
    publish(_indexed_topic(user_id), payload)


def _extract_text_path(storage_path: str) -> Path:
    """Sibling extracted.txt to the original. Storage path is
    `<userId>/<itemId>/original.<ext>`; we drop the basename."""
    return Path(storage_path).parent / "extracted.txt"


def _manifest_path(storage_path: str) -> Path:
    return Path(storage_path).parent / "manifest.json"


def handle_brain_uploaded(payload: dict) -> None:
    """Process one `droplet/files/brain/uploaded` event end-to-end.

    Defensive against malformed payloads (logs + drops); idempotent
    against duplicate deliveries (deletes any existing chunks for the
    item before inserting fresh ones).
    """
    item_id = payload.get("itemId")
    user_id = payload.get("userId")
    path = payload.get("path")
    mime = payload.get("mimeType")
    if not (
        isinstance(item_id, str)
        and isinstance(user_id, str)
        and isinstance(path, str)
    ):
        logger.warning(
            "brain_ingest: ignoring malformed payload missing itemId/userId/path"
        )
        return
    if not isinstance(mime, str) or not mime:
        # Fall back to extension-based detection so a missing MIME
        # doesn't drop the file silently.
        guessed, _ = mimetypes.guess_type(path)
        mime = guessed or "application/octet-stream"

    if not os.path.exists(path):
        logger.warning("brain_ingest: file missing on disk: %s", path)
        _publish_status(user_id, item_id, "failed", reason="file_missing")
        return

    # WARP-218: defer audio/video to the daily ASR worker. The orchestrator
    # marks those rows status='queued_for_transcription' on insert; this
    # synchronous path must NOT dispatch them. The daily run (or the
    # transcribe-now MQTT subscriber) drives them through `_dispatch_and_index`
    # in `transcription_worker.py` instead.
    try:
        status = _fetch_item_status(item_id)
    except Exception:
        # If the status lookup fails (e.g. transient DB hiccup), fall through
        # to the normal path rather than dropping the file silently. The
        # daily worker will reconcile any duplicates via delete-then-insert.
        logger.exception("brain_ingest: status lookup failed for %s", item_id)
        status = None
    if status == "queued_for_transcription":
        logger.info(
            "brain_ingest: itemId=%s is queued_for_transcription, "
            "skipping inline dispatch",
            item_id,
        )
        return

    logger.info(
        "brain_ingest: indexing item=%s user=%s mime=%s", item_id, user_id, mime
    )

    # Extract.
    doc = dispatch(path, mime)
    if doc is None:
        logger.info(
            "brain_ingest: dispatch returned None (unsupported / oversized) for %s",
            path,
        )
        _publish_status(user_id, item_id, "failed", reason="extractor_unavailable")
        # Mark indexed=NOW with no chunks so the chip doesn't spin
        # forever; the failed status flips the chip to ⚠.
        try:
            mark_brain_item_indexed(item_id, warnings=["extractor_unavailable"])
        except Exception:
            logger.exception("brain_ingest: failed to mark item failed")
        return

    text = doc.get("text", "")
    warnings = list(doc.get("warnings", []))
    if not text or len(text.strip()) < 10:
        logger.info("brain_ingest: extracted text too small for %s", path)
        warnings.append("empty_extraction")
        _publish_status(user_id, item_id, "failed", reason="empty_extraction")
        try:
            mark_brain_item_indexed(item_id, warnings=warnings)
        except Exception:
            logger.exception("brain_ingest: failed to mark item failed")
        return

    # Chunk + embed.
    chunks = chunk_text(text)
    if not chunks:
        logger.info("brain_ingest: chunker produced 0 chunks for %s", path)
        warnings.append("no_chunks")
        _publish_status(user_id, item_id, "failed", reason="no_chunks")
        try:
            mark_brain_item_indexed(item_id, warnings=warnings)
        except Exception:
            logger.exception("brain_ingest: failed to mark item failed")
        return

    try:
        vectors = embed_texts(chunks)
    except Exception as e:
        logger.warning("brain_ingest: embedding failed for %s: %s", path, e)
        _publish_status(user_id, item_id, "failed", reason="embed_failed")
        return
    if len(vectors) != len(chunks):
        logger.warning(
            "brain_ingest: embedding count mismatch for %s (%d vs %d)",
            path,
            len(vectors),
            len(chunks),
        )
        _publish_status(user_id, item_id, "failed", reason="embed_failed")
        return

    # WARP-214: surface the extractor's metadata (chain[], subtitle_source) so
    # the dashboard can render breadcrumbs + source-channel badges from
    # /api/files/knowledge/{recent,search}.
    doc_metadata = doc.get("metadata") if isinstance(doc, dict) else None

    # Upsert (delete-then-insert to keep brain rows independent of the
    # ncFileId-based unique constraint that the watcher relies on).
    try:
        delete_chunks_for_brain_item(item_id)
        for idx, (chunk, vec) in enumerate(zip(chunks, vectors)):
            upsert_chunk(
                user_id=user_id,
                # Use a deterministic synthetic ncFileId so the existing
                # `(ncFileId, chunkIdx)` unique constraint doesn't
                # collide across brain items. We hash the cuid into a
                # stable 31-bit int — Postgres INTEGER range — and use
                # negative space (>2^30) to avoid colliding with real
                # Nextcloud fileids.
                nc_file_id=_synthetic_nc_file_id(item_id),
                path=path,
                chunk_idx=idx,
                text=chunk,
                embedding=vec,
                source="brain",
                brain_item_id=item_id,
                warnings=warnings,
                metadata=doc_metadata,
            )
        mark_brain_item_indexed(item_id, warnings=warnings)
    except Exception as e:
        logger.exception("brain_ingest: db write failed for %s: %s", item_id, e)
        _publish_status(user_id, item_id, "failed", reason="db_failed")
        return

    # Persist extracted.txt + updated manifest so backups + the
    # WARP-205 export route can reconstruct without DB access.
    try:
        _extract_text_path(path).write_text(text, encoding="utf-8")
        manifest_p = _manifest_path(path)
        manifest = {
            "itemId": item_id,
            "userId": user_id,
            "filename": payload.get("filename"),
            "mimeType": mime,
            "originatingChatId": payload.get("originatingChatId"),
            "storagePath": path,
            "chunks": len(chunks),
            "extractorWarnings": warnings,
        }
        manifest_p.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    except OSError as e:
        # Non-fatal: chunks are already in pgvector — the side files are
        # for backup convenience, not retrieval correctness.
        logger.warning("brain_ingest: failed to write side files: %s", e)

    _publish_status(user_id, item_id, "ready")
    logger.info(
        "brain_ingest: indexed %s -> %d chunks (warnings=%s)",
        item_id,
        len(chunks),
        warnings,
    )


def _synthetic_nc_file_id(item_id: str) -> int:
    """Stable synthetic INTEGER for a brain item.

    The FileContentChunk schema uses `(ncFileId, chunkIdx)` as a unique
    constraint, which the existing watcher relies on for upsert. Brain
    items don't have a Nextcloud fileid — we hash the cuid (md5 truncated
    to 30 bits) into a deterministic non-negative int, then offset into
    the upper half (>= 2^30) so we don't collide with real Nextcloud
    fileids (which start at 1 and grow modestly).

    md5 (not Python's per-process-randomized `hash()`) so the same item
    produces the same synthetic id across restarts — `delete_chunks_for_brain_item`
    by `brainItemId` is the actual idempotency key, but predictability of
    the synthetic id keeps post-mortem queries by `ncFileId` sane.
    """
    import hashlib

    digest = hashlib.md5(item_id.encode("utf-8")).digest()
    h = int.from_bytes(digest[:4], "big") % (1 << 30)
    return (1 << 30) + h


def start_brain_ingest() -> None:
    """Wire the MQTT subscription. Idempotent."""
    subscribe(BRAIN_UPLOADED_TOPIC, handle_brain_uploaded)
    logger.info("brain_ingest: subscribed to %s", BRAIN_UPLOADED_TOPIC)
