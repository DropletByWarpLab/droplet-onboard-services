"""Brain-memory ingest pipeline (WARP-203).

Consumes `droplet/files/brain/uploaded` events the orchestrator publishes
when a chat-attached file lands, and runs the same extract → chunk →
embed → upsert pipeline as the Nextcloud watcher — but writes
FileContentChunk rows with `source=brain` and `brainItemId=<id>` so the
single cosine search hits both surfaces.

The payload's `userId` (and therefore every row and per-user topic this
writer keys) is the local `User.id` UUID since WARP-493 — the
orchestrator's publisher flipped from Nextcloud username to UUID in the
same deploy as the DB backfill and the BRAIN_ROOT directory migrator.
The watcher path, by contrast, stays username-keyed.

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

import column_crypto
import doc_keys
from chunker import Chunk, chunk_spans, format_chunk_with_header
from db import (
    delete_chunks_for_brain_item,
    mark_brain_item_indexed,
    set_vision_render,
    upsert_chunk,
)
from embedder import embed_texts
from extractors.image import make_vision_render
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

    # IDX-01: this raw-cursor read runs on the shared module connection, so it
    # must take the same lock db.py's helpers use to avoid concurrent execute()
    # on one psycopg2 connection.
    with db._db_lock, db.get_conn().cursor() as cur:
        cur.execute(
            'SELECT "status" FROM "BrainMemoryItem" WHERE "id" = %s',
            (item_id,),
        )
        row = cur.fetchone()
    return row[0] if row else None


def _fetch_item_policy(item_id: str) -> str | None:
    """Look up BrainMemoryItem.ingestPolicy. Returns None if the row is missing.

    WARP-905: an item uploaded with ingestPolicy='await_approval' is HELD —
    the inline document path must NOT embed it until a human releases it via
    POST /api/files/brain/:id/approve (which flips the policy to 'auto_embed'
    and re-publishes the uploaded event). None (missing row / DB hiccup) is
    treated as not-held so a transient read failure never silently swallows a
    file.
    """
    import db

    # IDX-01: same shared-connection lock discipline as _fetch_item_status.
    with db._db_lock, db.get_conn().cursor() as cur:
        cur.execute(
            'SELECT "ingestPolicy" FROM "BrainMemoryItem" WHERE "id" = %s',
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

    WARP-493: `user_id` is the local `User.id` UUID (from the MQTT
    payload; pre-493 it was the Nextcloud username). The WS bridge
    subscribes `droplet/files/<user.id>/#` in addition to its
    username-keyed set, so these flips still reach the browser.
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


def _vision_render_path(storage_path: str) -> Path:
    """Sibling vision.jpg — the normalized render fed to a vision model."""
    return Path(storage_path).parent / "vision.jpg"


_VISION_RENDER_MAX_PX = int(os.environ.get("VISION_RENDER_MAX_PX", "1024"))


def _write_vision_render(storage_path: str, item_id: str) -> None:
    """Best-effort: write a normalized vision.jpg next to an image's original
    bytes and flag the item ``hasVisionRender``.

    Non-fatal — on any failure the flag stays false and the chat route simply
    falls back to OCR text for this image (no vision). Runs for every image
    regardless of OCR outcome, so photos (no OCR text) still become viewable.
    """
    try:
        raw = Path(storage_path).read_bytes()
        render = make_vision_render(raw, max_px=_VISION_RENDER_MAX_PX)
        _vision_render_path(storage_path).write_bytes(render)
        set_vision_render(item_id, True)
    except Exception as e:  # noqa: BLE001 — render is best-effort
        logger.warning(
            "brain_ingest: vision render failed for item=%s: %s", item_id, e
        )


def _full_text_from_doc(doc: dict) -> str:
    """Concatenate every span's text for the empty-extraction guard +
    extracted.txt side file. Spans are joined with blank lines so the
    output stays human-readable when re-read from the side file."""
    spans = doc.get("spans") if isinstance(doc, dict) else None
    if not spans:
        return ""
    return "\n\n".join(s.text for s in spans if getattr(s, "text", ""))


def _chunk_spans_from_doc(doc: dict) -> list[Chunk]:
    """Test seam: lets `tests/test_brain_ingest_anchor.py` substitute a
    fixed list of `Chunk`s without standing up a real extractor."""
    spans = doc.get("spans") if isinstance(doc, dict) else None
    return chunk_spans(spans or [])


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

    # WARP-905: respect the per-item ingest policy. An upload created with
    # ingestPolicy='await_approval' is HELD — no extraction, no embedding, no
    # status flip — until a human approves it (the approve route flips the
    # policy to 'auto_embed' and re-publishes this event). A DB read failure
    # falls through as not-held so a transient hiccup never drops the file.
    try:
        policy = _fetch_item_policy(item_id)
    except Exception:
        logger.exception("brain_ingest: policy lookup failed for %s", item_id)
        policy = None
    if policy == "await_approval":
        logger.info(
            "brain_ingest: itemId=%s is await_approval, holding for approval",
            item_id,
        )
        return

    logger.info(
        "brain_ingest: indexing item=%s user=%s mime=%s", item_id, user_id, mime
    )

    # WARP-305 → WARP-844: chat-attached images take an OCR-FIRST path.
    #
    # WARP-305 skipped extraction for image/* entirely because a photo
    # with no text used to land as ⚠ Failed (`empty_extraction`) — but
    # that also threw away the text in screenshots and scanned documents,
    # which is exactly what users attach to a chat. WARP-844 runs the
    # image OCR extractor like any other MIME and only falls back to the
    # WARP-305 "✓ Ready (image_only)" outcome when OCR finds nothing —
    # photos keep the friendly chip, screenshots become searchable and
    # get inlined into the chat turn like every other attachment.
    # Multimodal chat (image bytes to a vision model) remains a separate
    # follow-up.
    is_image = isinstance(mime, str) and mime.startswith("image/")

    def _finish_image_only() -> None:
        logger.info(
            "brain_ingest: image attachment with no OCR-able text for %s",
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

    # Image vision: write the normalized render before extraction so even a
    # textless photo (which takes the image_only path below) is viewable by a
    # vision model. Best-effort; never blocks indexing.
    if is_image:
        _write_vision_render(path, item_id)

    # Extract.
    doc = dispatch(path, mime)
    if doc is None:
        if is_image:
            # OCR backend unavailable / unsupported variant — same
            # user-facing outcome as "no text in the image".
            _finish_image_only()
            return
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

    warnings = list(doc.get("warnings", []))
    # WARP-287: extractors emit `spans: list[Span]` rather than a flat
    # `text` blob. Derive the full text from the spans for the
    # empty-extraction guard + extracted.txt side file; the chunker
    # consumes spans directly so it can attach each chunk's anchor.
    full_text = _full_text_from_doc(doc)
    if not full_text or len(full_text.strip()) < 10:
        if is_image:
            # A photo, not a document — the WARP-305 friendly outcome.
            _finish_image_only()
            return
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

    # Chunk + embed. Chunks are `Chunk(text, anchor, section_path)`:
    #  * WARP-287 — the anchor flows into per-chunk metadata so the
    #    dashboard can cite "Page N of foo.pdf" rather than a bare index.
    #  * WARP-435 — the section_path (sentence-aware splitter runs per
    #    span, so each chunk keeps its span's breadcrumb) drives the
    #    contextual header prepended before embedding.
    chunks = _chunk_spans_from_doc(doc)
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
    # the storage-path basename. The section_path rides on each Chunk
    # (set by its source span) — empty → header is just "Document: name".
    display_filename = payload.get("filename") or os.path.basename(path) or "document"
    prefixed_chunks: list[str] = [
        format_chunk_with_header(chunk.text, display_filename, chunk.section_path)
        for chunk in chunks
    ]

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
    # WARP-287: also overlay each chunk's anchor under metadata.anchor so the
    # dashboard's citation surfaces can show "Page N of foo.pdf" rather than
    # a bare chunk index.
    doc_metadata = doc.get("metadata") if isinstance(doc, dict) else None

    # WARP-242: mint (or fetch) the item's per-document DEK — generated at
    # first chunk-write — and encrypt every chunk's text under it before it
    # lands (AAD = the DEK's keyId). sensitivity='sensitive' marks the policy;
    # the generated text_tsv NULLs itself for these rows. Fails closed: a
    # missing doc-KEK keyfile must never silently index plaintext.
    key_id = f"brain:{item_id}"
    try:
        dek = doc_keys.get_or_create_dek(key_id)
    except Exception as e:
        logger.exception(
            "brain_ingest: per-document DEK unavailable for %s: %s", item_id, e
        )
        try:
            mark_brain_item_indexed(
                item_id, status="failed", failure_reason="encryption_unavailable"
            )
        except Exception:
            logger.exception(
                "brain_ingest: failed to mark item encryption_unavailable"
            )
        _publish_status(user_id, item_id, "failed", reason="encryption_unavailable")
        return

    # Upsert (delete-then-insert to keep brain rows independent of the
    # ncFileId-based unique constraint that the watcher relies on).
    # WARP-435: persist the prefixed text — the exact string the
    # embedder saw — so searchHybrid's lexical arm and the LLM's
    # citation surface both reflect the contextual header.
    try:
        delete_chunks_for_brain_item(item_id)
        for idx, (chunk, prefixed_text, vec) in enumerate(
            zip(chunks, prefixed_chunks, vectors)
        ):
            chunk_metadata = dict(doc_metadata or {})
            # WARP-287: serialize the chunk's anchor for citation surfaces.
            # A malformed anchor must not abort the whole file — fall back
            # to null + warn so the chunk still lands (searchable, just
            # without a deep-link target).
            try:
                chunk_metadata["anchor"] = chunk.anchor.model_dump()
            except Exception as e:  # pragma: no cover - defensive
                logger.warning(
                    "brain_ingest: anchor serialize failed for %s chunk %d: %s",
                    item_id,
                    idx,
                    e,
                )
                chunk_metadata["anchor"] = None
                warnings.append("malformed_anchor")
            # WARP-435: persist the section breadcrumb alongside the anchor.
            chunk_metadata["sectionPath"] = list(chunk.section_path)
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
                # WARP-242: the stored text is the dcv1 ciphertext of the
                # WARP-435 prefixed text (the exact string the embedder
                # saw); the orchestrator/mcp-server decrypt on read.
                text=column_crypto.encrypt_text(dek, prefixed_text, aad=key_id),
                embedding=vec,
                source="brain",
                brain_item_id=item_id,
                warnings=warnings,
                metadata=chunk_metadata,
                sensitivity="sensitive",
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
        _extract_text_path(path).write_text(full_text, encoding="utf-8")
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


def reindex_one(nc_file_id: str) -> dict:
    """WARP-287 — re-extract + re-chunk a single file (BrainMemoryItem).

    Atomic chunk replacement: DELETE + N×INSERT runs inside a single
    Postgres transaction on a private (non-autocommit) connection.
    Either every new chunk lands together with the old ones gone, or
    nothing changes. Mid-flight failure ROLLBACKs.

    Why a private connection rather than `db.get_conn()`: the module-
    level connection is set to `autocommit=True` for the existing
    watcher/MQTT path, which would commit each INSERT individually and
    leave partial rows on failure. We open a fresh psycopg2 connection
    here so we can BEGIN/COMMIT/ROLLBACK explicitly.

    Looks up the file by BrainMemoryItem.id (the orchestrator's
    `/api/admin/files/:id/reindex` route passes that id through). Files
    indexed exclusively via the Nextcloud watcher (no BrainMemoryItem
    row) aren't reachable here — those go through the watcher's normal
    rescan path and aren't a v1 admin-reindex target.

    Returns: {"chunksWritten": int}
    Raises:
        ValueError: item not found / file missing / dispatch returned None.
        RuntimeError: extractor produced no text or no chunks.
        Any psycopg2 / extractor / embedder error propagates (rolled back).
    """
    import json as _json

    import psycopg2

    from config import DATABASE_URL
    from db import fetch_item

    # Reuse the autocommit conn just for the item lookup (read-only).
    from db import get_conn as _get_conn

    # WARP-2196: this path opens its OWN connection and INSERTs directly, so
    # it bypasses db.upsert_chunk's gate. Same guard, applied explicitly —
    # an admin re-index must not be a way to slip vectors from a second
    # embedding model into the corpus. See corpus_state.py.
    from corpus_state import raise_if_write_blocked  # noqa: PLC0415

    raise_if_write_blocked()

    info = fetch_item(_get_conn(), item_id=nc_file_id)
    if info is None:
        raise ValueError(f"reindex_one: BrainMemoryItem {nc_file_id} not found")
    user_id = info["userId"]
    path = info["storagePath"]
    mime = info["mimeType"] or "application/octet-stream"

    if not os.path.exists(path):
        raise ValueError(f"reindex_one: file missing on disk: {path}")

    logger.info(
        "reindex_one: re-indexing item=%s user=%s mime=%s",
        nc_file_id,
        user_id,
        mime,
    )

    # Re-run extractor → spans → chunks → embeddings. These steps are
    # idempotent (no DB side effects), so doing them BEFORE the
    # transaction keeps the lock window small.
    doc = dispatch(path, mime)
    if doc is None:
        raise ValueError(
            f"reindex_one: extractor returned None for {path} ({mime})"
        )
    full_text = _full_text_from_doc(doc)
    if not full_text or len(full_text.strip()) < 10:
        raise RuntimeError(f"reindex_one: empty extraction for {path}")
    chunks = _chunk_spans_from_doc(doc)
    if not chunks:
        raise RuntimeError(f"reindex_one: chunker produced 0 chunks for {path}")
    # WARP-435: embed (and below, persist) the *prefixed* chunk text — the
    # contextual "Document: {name} / Section: {a > b}" header — exactly like
    # the three primary ingest paths (handle_brain_uploaded, watcher,
    # transcription_worker). Re-indexing must produce the same embeddings
    # and stored text as a normal ingest, otherwise admin re-index silently
    # diverges from watcher-indexed rows for identical content. fetch_item
    # carries no friendly filename, so fall back to the storage-path
    # basename (the same fallback the other paths use when no payload
    # filename is present).
    display_filename = os.path.basename(path) or "document"
    prefixed_chunks = [
        format_chunk_with_header(chunk.text, display_filename, chunk.section_path)
        for chunk in chunks
    ]
    vectors = embed_texts(prefixed_chunks)
    if len(vectors) != len(chunks):
        raise RuntimeError(
            f"reindex_one: embedding count mismatch ({len(vectors)} vs {len(chunks)})"
        )

    doc_metadata = doc.get("metadata") if isinstance(doc, dict) else None
    warnings = list(doc.get("warnings", []))
    synthetic_nc_file_id = _synthetic_nc_file_id(nc_file_id)

    # WARP-242: re-indexed chunks are encrypted exactly like a fresh ingest
    # (same DEK — the item keeps its identity, so its key is reused). Uses
    # the shared module connection (autocommit) for the mint; an orphan DEK
    # row from a rolled-back chunk transaction is harmless and reused later.
    key_id = f"brain:{nc_file_id}"
    dek = doc_keys.get_or_create_dek(key_id)

    # Atomic DELETE + INSERT inside a single private transaction. A
    # mid-flight failure rolls everything back, including the DELETE,
    # leaving the file's pre-reindex chunks intact — strictly better
    # than the watcher/MQTT path's per-chunk autocommit.
    from pgvector.psycopg2 import register_vector

    conn = psycopg2.connect(DATABASE_URL)
    try:
        conn.autocommit = False
        register_vector(conn)
        with conn.cursor() as cur:
            cur.execute(
                'DELETE FROM "FileContentChunk" WHERE "brainItemId" = %s',
                (nc_file_id,),
            )
            for idx, (chunk, prefixed_text, vec) in enumerate(
                zip(chunks, prefixed_chunks, vectors)
            ):
                chunk_metadata = dict(doc_metadata or {})
                # WARP-287: a malformed anchor must not abort the whole
                # re-index transaction — fall back to null + warn so the
                # chunk still lands (searchable, just without a deep-link
                # target). Mirrors handle_brain_uploaded and the watcher path.
                try:
                    chunk_metadata["anchor"] = chunk.anchor.model_dump()
                except Exception as e:  # pragma: no cover - defensive
                    logger.warning(
                        "reindex_one: anchor serialize failed for %s chunk %d: %s",
                        nc_file_id,
                        idx,
                        e,
                    )
                    chunk_metadata["anchor"] = None
                    warnings.append("malformed_anchor")
                # WARP-435: persist the section breadcrumb alongside the
                # anchor, matching the primary ingest paths.
                chunk_metadata["sectionPath"] = list(chunk.section_path)
                cur.execute(
                    """
                    INSERT INTO "FileContentChunk"
                        ("userId", "ncFileId", "path", "chunkIdx", "text",
                         "embedding", "indexedAt", "source", "brainItemId",
                         "pageNumber", "warnings", "metadata", "sensitivity")
                    VALUES (%s, %s, %s, %s, %s, %s::vector, NOW(),
                            %s::"FileContentSource", %s, %s, %s, %s::jsonb,
                            %s::"ChunkSensitivity")
                    """,
                    (
                        user_id,
                        synthetic_nc_file_id,
                        path,
                        idx,
                        # WARP-242: dcv1 ciphertext of the WARP-435 prefixed
                        # text (the exact string the embedder saw) — parity
                        # with normal ingest; decrypt happens on read.
                        column_crypto.encrypt_text(dek, prefixed_text, aad=key_id),
                        vec,
                        "brain",
                        nc_file_id,
                        None,
                        warnings,
                        _json.dumps(chunk_metadata),
                        "sensitive",
                    ),
                )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # mark_brain_item_indexed uses the autocommit module conn — safe to
    # call OUTSIDE the private transaction. A failure here leaves the
    # new chunks in place but doesn't bump indexedAt, which is the
    # benign direction (a follow-up reindex / watcher pass will retry).
    try:
        from db import mark_brain_item_indexed

        mark_brain_item_indexed(nc_file_id, warnings=warnings)
    except Exception:
        logger.exception(
            "reindex_one: mark_brain_item_indexed failed for %s", nc_file_id
        )

    logger.info(
        "reindex_one: indexed item=%s -> %d chunks", nc_file_id, len(chunks)
    )
    return {"chunksWritten": len(chunks)}
