"""WARP-218 — daily / manual transcription worker for queued
BrainMemoryItem rows (audio + video).

Two entry points:

  - run_pass()      — iterates ALL items where status='queued_for_transcription'.
                      Called by the AsyncIOScheduler in scheduler_service.py
                      once per day at TRANSCRIPTION_RUN_LOCAL_TIME.
  - run_one(itemId) — single-item promotion. Called from the MQTT subscriber
                      on `droplet/transcription/run-one` (orchestrator's
                      transcribe-now route publishes there).

Both go through the same per-item path:

  1. fetch_item() — resolve the row; missing → log + return
  2. claim_attempt() — applies the rolling-hour retry cap. False → skip.
  3. update_item_status('indexing') + publish MQTT
  4. dispatch through extractors.registry → chunker → embedder → upsert
  5. on success: update_item_status('ready')
     on exception: update_item_status('failed', failure_reason=<exc>[:200])
  6. publish final status

Single-worker — sequential. The audio extractor's threading.Lock still
serializes the actual ASR call within the dispatcher.

reconcile_at_startup() runs once before the scheduler ticks — it flips any
row stuck in 'indexing' for >6h back to 'queued_for_transcription' so a
crashed mid-transcription doesn't sit forever.
"""
from __future__ import annotations

import logging

import db
import mqtt_client
from db import (
    claim_attempt,
    fetch_item,
    reconcile_stuck_items,
    select_queued_items,
    update_item_status,
)

logger = logging.getLogger(__name__)


def _get_conn():
    """Returns a fresh psycopg connection. Test seam — patched in unit tests."""
    return db.get_conn()


def _publish_status(
    user_id: str, item_id: str, status: str, reason: str | None = None
) -> None:
    """Publish to the per-user WS bridge so the dashboard's useBrainStatus
    hook flips the chip without waiting for a poll."""
    payload: dict[str, object] = {"itemId": item_id, "status": status}
    if reason is not None:
        payload["reason"] = reason
    mqtt_client.publish(f"droplet/files/{user_id}/brain/indexed", payload)


def _dispatch_and_index(item: dict) -> None:
    """Run the full extractor → chunker → embedder → upsert pipeline.

    Imports lazily so the module is cheap to load in tests that mock it
    (faster-whisper + grpcio are heavy; we don't want them imported at
    test collection time).
    """
    from extractors.registry import dispatch
    from chunker import chunk_text
    from embedder import embed_texts
    from brain_ingest import _synthetic_nc_file_id

    storage_path = item["storagePath"]
    mime = item["mimeType"]
    user_id = item["userId"]
    item_id = item["id"]

    doc = dispatch(storage_path, mime)
    if doc is None:
        raise RuntimeError(f"extractor refused mime={mime}")

    text = doc.get("text", "") if isinstance(doc, dict) else ""
    chunks = chunk_text(text)
    if not chunks:
        # Empty transcript is fine — extractor succeeded but produced no text.
        # Caller transitions to 'ready' so the chip stops spinning.
        return

    vectors = embed_texts(chunks)
    if len(vectors) != len(chunks):
        raise RuntimeError(
            f"embedding count mismatch: {len(vectors)} vs {len(chunks)}"
        )

    # Wipe any stale chunks for this item, then upsert fresh ones. Mirrors
    # brain_ingest's idempotency pattern.
    db.delete_chunks_for_brain_item(item_id)
    warnings = list(doc.get("warnings", [])) if isinstance(doc, dict) else []
    metadata = doc.get("metadata") if isinstance(doc, dict) else None
    for idx, (chunk, vec) in enumerate(zip(chunks, vectors)):
        db.upsert_chunk(
            user_id=user_id,
            nc_file_id=_synthetic_nc_file_id(item_id),
            path=storage_path,
            chunk_idx=idx,
            text=chunk,
            embedding=vec,
            source="brain",
            brain_item_id=item_id,
            warnings=warnings,
            metadata=metadata,
        )


def run_one(item_id: str) -> None:
    """Process a single item end-to-end. Catches all exceptions and
    transitions status accordingly — never raises out."""
    conn = _get_conn()
    try:
        item = fetch_item(conn, item_id=item_id)
        if item is None:
            logger.info(
                "transcription_worker.run_one: item %s not found, skipping",
                item_id,
            )
            return
        if not claim_attempt(conn, item_id=item_id):
            logger.info(
                "transcription_worker.run_one: cap hit for %s "
                "(3 attempts in last hour) — skipping",
                item_id,
            )
            return

        update_item_status(conn, item_id=item_id, status="indexing")
        _publish_status(item["userId"], item_id, "indexing")
    except Exception:
        # Defensive — any failure here happens before dispatch. Log + bail
        # rather than progressing into the long-running call with a bad row.
        logger.exception(
            "transcription_worker.run_one: pre-dispatch failure for %s", item_id
        )
        return

    # Dispatch outside the conn block — this is the long-running ASR call.
    try:
        _dispatch_and_index(item)
    except Exception as exc:  # noqa: BLE001 — every failure path → 'failed'
        logger.exception("transcription_worker: %s failed", item_id)
        c2 = _get_conn()
        update_item_status(
            c2, item_id=item_id, status="failed", failure_reason=str(exc)
        )
        _publish_status(item["userId"], item_id, "failed", reason=str(exc))
        return

    c2 = _get_conn()
    update_item_status(c2, item_id=item_id, status="ready")
    _publish_status(item["userId"], item_id, "ready")


def run_pass() -> None:
    """Process every queued item. Called once daily by the scheduler."""
    conn = _get_conn()
    items = select_queued_items(conn, limit=100)

    if not items:
        logger.info("transcription_worker.run_pass: no queued items")
        return

    logger.info("transcription_worker.run_pass: processing %d items", len(items))
    for item in items:
        run_one(item["id"])


def reconcile_at_startup() -> None:
    """Flip 'indexing' rows stuck >6h back to queued. Called from main.py
    once before the scheduler starts ticking."""
    conn = _get_conn()
    n = reconcile_stuck_items(conn, stuck_after_hours=6)
    if n > 0:
        logger.warning(
            "transcription_worker.reconcile: flipped %d stuck rows back to queued",
            n,
        )
