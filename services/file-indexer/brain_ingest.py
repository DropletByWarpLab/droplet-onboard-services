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

from chunker import (
    chunk_text,
    chunk_text_with_offsets,
    format_chunk_with_header,
    section_path_for_offset,
)
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
    # WARP-225: piggyback a context-stats cache-invalidate publish so
    # the orchestrator drops the per-user `context-stats:<userId>:*`
    # keys within the next round-trip. Best-effort — if MQTT is down
    # we keep the TTL, and the dashboard eats up to one cache window
    # of staleness. Done from `_publish_status` (rather than the
    # individual call sites) so every status transition fans out one
    # invalidate without per-callsite plumbing.
    publish("droplet/context-stats/invalidate", {"userId": user_id})


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
        # WARP-330: the MQTT publish alone is not enough — the dashboard's
        # pipeline-health query reads BrainMemoryItem.status. Persist the
        # failure so the row stops looking like it's still indexing.
        try:
            mark_brain_item_indexed(
                item_id, status="failed", failure_reason="file_missing"
            )
        except Exception:
            logger.exception("brain_ingest: failed to mark item file_missing")
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

    # WARP-305: image-only attachments. There's no text to extract from a
    # bare PNG/JPEG/HEIC, so running the extractor → "< 10 chars" check
    # used to mark the chip as `failed` with reason=`empty_extraction`.
    # That bubbled up as the "Something went wrong on this turn" toast in
    # the chat surface because `empty_extraction` had no friendly mapping.
    #
    # The image IS successfully stored (the bytes live under the item dir
    # for future retrieval and the row is in BrainMemoryItem) — it just
    # isn't searchable by text content. Mark it `ready` with an
    # `image_only` warning so the dashboard chip renders ✓ Ready with a
    # softer subtitle instead of ⚠ Failed. Multimodal chat (sending
    # images straight to the model as content_parts) is a separate
    # follow-up; this fix is about not lying to the user.
    if isinstance(mime, str) and mime.startswith("image/"):
        logger.info(
            "brain_ingest: image-only attachment, skipping text extraction for %s",
            path,
        )
        try:
            mark_brain_item_indexed(
                item_id, status="ready", warnings=["image_only"]
            )
        except Exception:
            logger.exception(
                "brain_ingest: failed to mark image-only item ready"
            )
        _publish_status(user_id, item_id, "ready", reason="image_only")
        # Persist a tiny manifest so the export route can still surface
        # the attachment metadata — no extracted.txt because there's no
        # text to write.
        try:
            manifest_p = _manifest_path(path)
            manifest = {
                "itemId": item_id,
                "userId": user_id,
                "filename": payload.get("filename"),
                "mimeType": mime,
                "originatingChatId": payload.get("originatingChatId"),
                "storagePath": path,
                "chunks": 0,
                "extractorWarnings": ["image_only"],
            }
            manifest_p.write_text(
                json.dumps(manifest, indent=2), encoding="utf-8"
            )
        except OSError as e:
            logger.warning(
                "brain_ingest: failed to write image-only manifest: %s", e
            )
        return

    # Extract.
    doc = dispatch(path, mime)
    if doc is None:
        logger.info(
            "brain_ingest: dispatch returned None (unsupported / oversized) for %s",
            path,
        )
        _publish_status(user_id, item_id, "failed", reason="extractor_unavailable")
        # Mark indexed=NOW with no chunks so the chip doesn't spin
        # forever; status='failed' flips the chip to ⚠ AND keeps the
        # dashboard's failed-count aggregate honest (WARP-330).
        try:
            mark_brain_item_indexed(
                item_id,
                status="failed",
                failure_reason="extractor_unavailable",
                warnings=["extractor_unavailable"],
            )
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
            mark_brain_item_indexed(
                item_id,
                status="failed",
                failure_reason="empty_extraction",
                warnings=warnings,
            )
        except Exception:
            logger.exception("brain_ingest: failed to mark item failed")
        return

    # Chunk + embed. WARP-435 (ADR-003 Phase 1): chunk_text_with_offsets
    # returns (start_offset, chunk_text) tuples so we can look up each
    # chunk's enclosing sectionPath from the extractor's
    # metadata.section_paths and prepend a contextual header
    # ("Document: foo / Section: bar > baz\n\n...") before embedding.
    # The same prefixed text is what we persist on FileContentChunk.text
    # so search results carry the path string the embedder saw — no
    # divergence between embedding input and stored representation.
    chunk_pairs = chunk_text_with_offsets(text)
    chunks = [c for _off, c in chunk_pairs]
    if not chunks:
        logger.info("brain_ingest: chunker produced 0 chunks for %s", path)
        warnings.append("no_chunks")
        _publish_status(user_id, item_id, "failed", reason="no_chunks")
        try:
            mark_brain_item_indexed(
                item_id,
                status="failed",
                failure_reason="no_chunks",
                warnings=warnings,
            )
        except Exception:
            logger.exception("brain_ingest: failed to mark item failed")
        return

    # WARP-435: build prefixed chunk texts. Filename resolution priority:
    # MQTT payload's `filename` field (user-friendly), falling back to
    # the storage-path basename. The section_paths lookup is best-effort
    # — empty list → header is just "Document: filename".
    doc_metadata_pre = doc.get("metadata") if isinstance(doc, dict) else None
    section_paths_meta = (
        doc_metadata_pre.get("section_paths") if doc_metadata_pre else None
    )
    display_filename = payload.get("filename") or os.path.basename(path) or "document"
    prefixed_chunks: list[str] = []
    for offset, chunk_str in chunk_pairs:
        sp = section_path_for_offset(offset, section_paths_meta)
        prefixed_chunks.append(
            format_chunk_with_header(chunk_str, display_filename, sp)
        )

    try:
        vectors = embed_texts(prefixed_chunks)
    except Exception as e:
        logger.warning("brain_ingest: embedding failed for %s: %s", path, e)
        # WARP-330: persist the failure on the row so the dashboard's
        # status-derived aggregates (pipeline-health, failed-count) stay
        # in sync with what we just emitted over MQTT.
        try:
            mark_brain_item_indexed(
                item_id, status="failed", failure_reason="embed_failed"
            )
        except Exception:
            logger.exception(
                "brain_ingest: failed to mark item embed_failed"
            )
        _publish_status(user_id, item_id, "failed", reason="embed_failed")
        return
    if len(vectors) != len(prefixed_chunks):
        logger.warning(
            "brain_ingest: embedding count mismatch for %s (%d vs %d)",
            path,
            len(vectors),
            len(prefixed_chunks),
        )
        try:
            mark_brain_item_indexed(
                item_id, status="failed", failure_reason="embed_failed"
            )
        except Exception:
            logger.exception(
                "brain_ingest: failed to mark item embed_failed (count mismatch)"
            )
        _publish_status(user_id, item_id, "failed", reason="embed_failed")
        return

    # WARP-214: surface the extractor's metadata (chain[], subtitle_source) so
    # the dashboard can render breadcrumbs + source-channel badges from
    # /api/files/knowledge/{recent,search}.
    doc_metadata = doc.get("metadata") if isinstance(doc, dict) else None

    # Upsert (delete-then-insert to keep brain rows independent of the
    # ncFileId-based unique constraint that the watcher relies on).
    # WARP-435: persist the prefixed text — the exact string the
    # embedder saw — so searchHybrid's lexical arm and the LLM's
    # citation surface both reflect the contextual header.
    try:
        delete_chunks_for_brain_item(item_id)
        for idx, (chunk, vec) in enumerate(zip(prefixed_chunks, vectors)):
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
        mark_brain_item_indexed(item_id, status="ready", warnings=warnings)
    except Exception as e:
        logger.exception("brain_ingest: db write failed for %s: %s", item_id, e)
        # Best-effort persist of the failure status. If this second write
        # also fails the row stays at status='indexing' — the daily
        # reconciler (`reconcile_stuck_items`) will eventually surface it.
        try:
            mark_brain_item_indexed(
                item_id, status="failed", failure_reason="db_failed"
            )
        except Exception:
            logger.exception(
                "brain_ingest: failed to mark item db_failed after upsert error"
            )
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
    items don't have a Nextcloud fileid — we hash the cuid (SHA-256
    truncated to 30 bits) into a deterministic non-negative int, then
    offset into the upper half (>= 2^30) so we don't collide with real
    Nextcloud fileids (which start at 1 and grow modestly).

    SHA-256 (not Python's per-process-randomized `hash()`) so the same
    item produces the same synthetic id across restarts —
    `delete_chunks_for_brain_item` by `brainItemId` is the actual
    idempotency key, but predictability of the synthetic id keeps
    post-mortem queries by `ncFileId` sane.

    Previously used MD5; switched to SHA-256 under WARP-229 (FIPS 140-3
    provider). The function contract — deterministic 30-bit hash mapped
    into the upper INTEGER half — is unchanged. The exact output value
    for any given item_id changes between MD5 and SHA-256, which means
    BrainMemoryItem rows already ingested under the MD5 scheme will get
    a different `ncFileId` next time they're re-ingested. That's fine:
    `delete_chunks_for_brain_item` keys off `brainItemId`, not
    `ncFileId`, so the upsert path stays consistent. Post-mortem queries
    that depend on the legacy MD5 value would need to re-derive, but no
    such tooling exists today.
    """
    import hashlib

    digest = hashlib.sha256(item_id.encode("utf-8")).digest()
    h = int.from_bytes(digest[:4], "big") % (1 << 30)
    return (1 << 30) + h


def start_brain_ingest() -> None:
    """Wire the MQTT subscription. Idempotent."""
    subscribe(BRAIN_UPLOADED_TOPIC, handle_brain_uploaded)
    logger.info("brain_ingest: subscribed to %s", BRAIN_UPLOADED_TOPIC)
