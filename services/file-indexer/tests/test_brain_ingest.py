"""Unit tests for the brain-memory MQTT ingest pipeline (WARP-203).

We exercise `handle_brain_uploaded` in isolation by monkeypatching the
db / embedder / publish surface so the test runs without Postgres,
gRPC, or a live MQTT broker. Each test asserts on side-effect calls
the production handler is contracted to make.

WARP-218 adds a status check at the top of the handler: rows with
status='queued_for_transcription' are deferred to the daily ASR worker
and the inline dispatch path skips them entirely.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest


@pytest.fixture
def fake_io(monkeypatch, tmp_path):
    """Capture chunks, marks, publishes; return the call recorders."""
    import brain_ingest

    upserts: list[dict[str, Any]] = []
    marked: list[dict[str, Any]] = []
    deleted: list[str] = []
    published: list[tuple[str, dict[str, Any]]] = []
    embed_calls: list[list[str]] = []

    def _upsert(**kwargs: Any) -> None:
        upserts.append(kwargs)

    def _delete(item_id: str) -> None:
        deleted.append(item_id)

    def _mark(
        item_id: str,
        *,
        status: str = "ready",
        failure_reason: str | None = None,
        warnings: list[str] | None = None,
    ) -> None:
        # WARP-330: the production helper now writes BrainMemoryItem.status
        # atomically with indexedAt. Capture status + failure_reason so
        # tests can assert the row's persistent state matches the MQTT
        # publish (was previously divergent).
        marked.append(
            {
                "item_id": item_id,
                "status": status,
                "failure_reason": failure_reason,
                "warnings": warnings or [],
            }
        )

    def _publish(topic: str, payload: dict) -> None:
        published.append((topic, payload))

    def _embed(chunks: list[str]) -> list[list[float]]:
        embed_calls.append(chunks)
        return [[float(i)] * 384 for i in range(len(chunks))]

    monkeypatch.setattr(brain_ingest, "upsert_chunk", _upsert)
    monkeypatch.setattr(brain_ingest, "delete_chunks_for_brain_item", _delete)
    monkeypatch.setattr(brain_ingest, "mark_brain_item_indexed", _mark)
    monkeypatch.setattr(brain_ingest, "publish", _publish)
    monkeypatch.setattr(brain_ingest, "embed_texts", _embed)

    return {
        "upserts": upserts,
        "marked": marked,
        "deleted": deleted,
        "published": published,
        "embed_calls": embed_calls,
    }


def _write_text_payload(tmp_path: Path, item_id: str, text: str) -> Path:
    item_dir = tmp_path / "alice" / item_id
    item_dir.mkdir(parents=True, exist_ok=True)
    p = item_dir / "original.txt"
    p.write_text(text, encoding="utf-8")
    return p


def test_handle_uploaded_indexes_text_file(fake_io, tmp_path):
    from brain_ingest import handle_brain_uploaded

    text_path = _write_text_payload(
        tmp_path, "item-A", "alpha beta gamma delta epsilon"
    )

    handle_brain_uploaded(
        {
            "itemId": "item-A",
            "userId": "alice",
            "path": str(text_path),
            "mimeType": "text/plain",
            "filename": "notes.txt",
            "originatingChatId": "chat-1",
        }
    )

    # delete-then-insert idempotency.
    assert fake_io["deleted"] == ["item-A"]

    # At least one chunk written, with source=brain + brainItemId set.
    assert len(fake_io["upserts"]) >= 1
    for u in fake_io["upserts"]:
        assert u["source"] == "brain"
        assert u["brain_item_id"] == "item-A"
        assert u["user_id"] == "alice"
        assert u["nc_file_id"] >= (1 << 30)  # synthetic, not real

    # BrainMemoryItem marked indexed with status='ready' (WARP-330) —
    # the dashboard's pipeline-health aggregate filters on status='ready',
    # so the row's persistent state must match the MQTT publish.
    assert len(fake_io["marked"]) == 1
    assert fake_io["marked"][0]["item_id"] == "item-A"
    assert fake_io["marked"][0]["status"] == "ready"
    assert fake_io["marked"][0]["failure_reason"] is None

    # Published ready status — per-user topic so the orchestrator's
    # WS bridge (subscribed to `droplet/files/<user>/#`) forwards it
    # to the dashboard's open browser sessions.
    assert (
        "droplet/files/alice/brain/indexed",
        {"itemId": "item-A", "status": "ready"},
    ) in fake_io["published"]

    # Side files written.
    extracted = text_path.parent / "extracted.txt"
    manifest = text_path.parent / "manifest.json"
    assert extracted.exists()
    assert "alpha beta" in extracted.read_text(encoding="utf-8")
    m = json.loads(manifest.read_text(encoding="utf-8"))
    assert m["itemId"] == "item-A"
    assert m["userId"] == "alice"
    assert m["originatingChatId"] == "chat-1"


def test_handle_uploaded_drops_malformed_payload(fake_io):
    from brain_ingest import handle_brain_uploaded

    handle_brain_uploaded({"itemId": "x"})  # missing userId, path
    assert fake_io["upserts"] == []
    assert fake_io["published"] == []


def test_handle_uploaded_publishes_failed_when_file_missing(fake_io, tmp_path):
    from brain_ingest import handle_brain_uploaded

    handle_brain_uploaded(
        {
            "itemId": "item-missing",
            "userId": "alice",
            "path": str(tmp_path / "does-not-exist"),
            "mimeType": "text/plain",
        }
    )
    statuses = [(t, p) for t, p in fake_io["published"] if "status" in p]
    assert any(p.get("status") == "failed" for _, p in statuses)
    assert fake_io["upserts"] == []
    # WARP-330: the row's status column must be flipped to 'failed' too,
    # not just the MQTT publish. Otherwise file_missing rows show as
    # "still indexing" on /context until the daily reconciler picks them up.
    assert any(
        m["item_id"] == "item-missing"
        and m["status"] == "failed"
        and m["failure_reason"] == "file_missing"
        for m in fake_io["marked"]
    ), fake_io["marked"]


def test_handle_uploaded_marks_failed_when_extractor_unavailable(
    fake_io, tmp_path, monkeypatch
):
    """Unsupported MIME → dispatch returns None → marked failed, no chunks."""
    from brain_ingest import handle_brain_uploaded
    import brain_ingest

    # Force dispatch to None — simulates "no extractor for this MIME".
    monkeypatch.setattr(brain_ingest, "dispatch", lambda *a, **k: None)

    text_path = _write_text_payload(tmp_path, "item-B", "x")
    handle_brain_uploaded(
        {
            "itemId": "item-B",
            "userId": "alice",
            "path": str(text_path),
            "mimeType": "application/x-weird",
        }
    )
    assert fake_io["upserts"] == []
    # The handler still marks the item indexed=NOW with a warning, so
    # the chip flips from "indexing…" to ⚠. WARP-330: status='failed'
    # is now persisted explicitly, not just published over MQTT.
    assert any(
        m["item_id"] == "item-B"
        and m["status"] == "failed"
        and m["failure_reason"] == "extractor_unavailable"
        for m in fake_io["marked"]
    ), fake_io["marked"]
    assert any(p.get("status") == "failed" for _, p in fake_io["published"])


def test_synthetic_nc_file_id_is_deterministic():
    from brain_ingest import _synthetic_nc_file_id

    a = _synthetic_nc_file_id("abc-123")
    b = _synthetic_nc_file_id("abc-123")
    c = _synthetic_nc_file_id("xyz-789")
    assert a == b
    assert a != c
    # Lives in the upper half of INTEGER range so it can't collide
    # with real Nextcloud fileids (which start at 1 and grow modestly).
    assert a >= (1 << 30)
    assert a < (1 << 31)


def test_handle_uploaded_image_only_is_ready_not_failed(
    fake_io, tmp_path, monkeypatch
):
    """WARP-305 → WARP-844: a photo with no OCR-able text must land as
    ✓ Ready with the `image_only` warning (NOT ⚠ Failed). Since WARP-844
    the handler tries OCR first (screenshots are worth indexing) and only
    falls back to this outcome when the extractor finds nothing — here the
    stubbed dispatch returns None, the "OCR backend unavailable /
    nothing extractable" case.
    """
    import brain_ingest

    # Drop a fake "image" file at the expected path. The stubbed dispatch
    # below answers None, so the handler records the manifest and marks
    # the row ready without touching the bytes.
    item_dir = tmp_path / "alice" / "item-img"
    item_dir.mkdir(parents=True, exist_ok=True)
    fake_image = item_dir / "original.png"
    fake_image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)

    # WARP-844: OCR IS attempted now — record the call and answer None
    # (no text found / backend unavailable).
    dispatch_calls: list[tuple] = []
    monkeypatch.setattr(
        brain_ingest,
        "dispatch",
        lambda *a, **k: dispatch_calls.append((a, k)) or None,
    )
    # Bypass the status lookup so we don't need Postgres.
    monkeypatch.setattr(brain_ingest, "_fetch_item_status", lambda _i: None)

    brain_ingest.handle_brain_uploaded(
        {
            "itemId": "item-img",
            "userId": "alice",
            "path": str(fake_image),
            "mimeType": "image/png",
            "filename": "screenshot.png",
        }
    )

    # OCR was attempted (WARP-844) but produced nothing…
    assert len(dispatch_calls) == 1
    # …so no chunks were upserted.
    assert fake_io["upserts"] == []
    # Row IS marked indexed with the image_only warning so the chip stops
    # spinning. WARP-330: status='ready' is now persisted explicitly so
    # the dashboard's pipeline-health aggregate counts it.
    assert any(
        m["item_id"] == "item-img"
        and m["status"] == "ready"
        and "image_only" in m["warnings"]
        for m in fake_io["marked"]
    ), fake_io["marked"]
    # The published status is "ready", NOT "failed".
    indexed_topics = [
        (t, p)
        for t, p in fake_io["published"]
        if t.endswith("/brain/indexed")
    ]
    assert indexed_topics, "expected an /brain/indexed publish"
    assert all(
        p["status"] == "ready" for _, p in indexed_topics
    ), indexed_topics
    # Manifest landed on disk for the export route.
    manifest = item_dir / "manifest.json"
    assert manifest.exists()
    parsed = json.loads(manifest.read_text(encoding="utf-8"))
    assert parsed["mimeType"] == "image/png"
    assert parsed["chunks"] == 0
    assert "image_only" in parsed["extractorWarnings"]


def test_handle_uploaded_image_writes_vision_render(
    fake_io, tmp_path, monkeypatch
):
    """Image vision: a valid image gets a normalized vision.jpg render written
    next to its original bytes and `hasVisionRender` set — regardless of OCR
    outcome (here dispatch returns None → the image_only path)."""
    import io as _io

    import brain_ingest
    from PIL import Image

    item_dir = tmp_path / "alice" / "item-vis"
    item_dir.mkdir(parents=True, exist_ok=True)
    img_path = item_dir / "original.png"
    buf = _io.BytesIO()
    Image.new("RGB", (1600, 1200), (10, 120, 200)).save(buf, "PNG")
    img_path.write_bytes(buf.getvalue())

    monkeypatch.setattr(brain_ingest, "dispatch", lambda *a, **k: None)
    monkeypatch.setattr(brain_ingest, "_fetch_item_status", lambda _i: None)
    render_flags: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        brain_ingest,
        "set_vision_render",
        lambda item_id, has=True: render_flags.append((item_id, has)),
    )

    brain_ingest.handle_brain_uploaded(
        {
            "itemId": "item-vis",
            "userId": "alice",
            "path": str(img_path),
            "mimeType": "image/png",
            "filename": "photo.png",
        }
    )

    vision = item_dir / "vision.jpg"
    assert vision.exists(), "expected a vision.jpg render"
    r = Image.open(vision)
    assert r.format == "JPEG" and max(r.size) <= 1024
    assert ("item-vis", True) in render_flags


def test_handle_uploaded_image_with_text_is_ocr_indexed(
    fake_io, tmp_path, monkeypatch
):
    """WARP-844: a screenshot / scanned document carries OCR-able text —
    it goes through the NORMAL pipeline (chunks upserted, embedded,
    status='ready' with no image_only warning), exactly like a text file.
    """
    import brain_ingest
    from extractors.spans import Span
    from anchor_schema import NoneAnchor

    item_dir = tmp_path / "alice" / "item-shot"
    item_dir.mkdir(parents=True, exist_ok=True)
    fake_image = item_dir / "original.png"
    fake_image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)

    ocr_text = "Quarterly revenue rose twelve percent compared to last year."
    monkeypatch.setattr(
        brain_ingest,
        "dispatch",
        lambda *_a, **_k: {
            "spans": [
                Span(text=ocr_text, anchor=NoneAnchor(), section_path=["original.png"])
            ],
            "warnings": [],
        },
    )
    monkeypatch.setattr(brain_ingest, "_fetch_item_status", lambda _i: None)

    brain_ingest.handle_brain_uploaded(
        {
            "itemId": "item-shot",
            "userId": "alice",
            "path": str(fake_image),
            "mimeType": "image/png",
            "filename": "screenshot.png",
        }
    )

    # Chunks landed with the brain tagging — the screenshot is searchable.
    assert len(fake_io["upserts"]) >= 1
    for u in fake_io["upserts"]:
        assert u["source"] == "brain"
        assert u["brain_item_id"] == "item-shot"
    # Embedded like any document.
    assert fake_io["embed_calls"], "expected the OCR text to be embedded"
    # Ready WITHOUT the image_only warning — this is a real indexed doc.
    assert any(
        m["item_id"] == "item-shot"
        and m["status"] == "ready"
        and "image_only" not in m["warnings"]
        for m in fake_io["marked"]
    ), fake_io["marked"]


def test_handle_uploaded_skips_when_status_is_queued_for_transcription(
    fake_io, tmp_path, monkeypatch
):
    """WARP-218: when the BrainMemoryItem row's status is
    'queued_for_transcription' (audio/video uploads), the handler logs and
    returns without dispatching the extractor or publishing a status flip.
    The daily ASR worker (or transcribe-now MQTT) drives those items.
    """
    import brain_ingest

    text_path = _write_text_payload(tmp_path, "item-Q", "anything")

    # Stub the db status fetch so we don't need Postgres.
    monkeypatch.setattr(
        brain_ingest, "_fetch_item_status", lambda _i: "queued_for_transcription"
    )

    dispatch_calls: list[tuple] = []
    monkeypatch.setattr(
        brain_ingest,
        "dispatch",
        lambda *a, **k: dispatch_calls.append((a, k)) or None,
    )

    brain_ingest.handle_brain_uploaded(
        {
            "itemId": "item-Q",
            "userId": "alice",
            "path": str(text_path),
            "mimeType": "audio/wav",
        }
    )

    assert dispatch_calls == [], "dispatch must NOT run for queued items"
    # No "indexed"/"failed" status publish — the daily worker fires one later.
    assert fake_io["published"] == []
    # No mark + no chunk upserts — leaves the row in queued state.
    assert fake_io["marked"] == []
    assert fake_io["upserts"] == []


# ── WARP-330: every failure path must persist status='failed' ──
#
# These regressions are pinned because the original bug was that several
# failure paths only emitted MQTT and left BrainMemoryItem.status at
# 'indexing'. The dashboard reads status, not MQTT history, so under-
# reporting was silent.


def test_handle_uploaded_persists_failed_on_empty_extraction(
    fake_io, tmp_path, monkeypatch
):
    """A doc whose extractor returns < 10 chars of text should land at
    status='failed' with reason='empty_extraction'."""
    import brain_ingest

    monkeypatch.setattr(
        brain_ingest, "dispatch", lambda *a, **k: {"text": "x", "warnings": []}
    )
    text_path = _write_text_payload(tmp_path, "item-empty", "x")

    brain_ingest.handle_brain_uploaded(
        {
            "itemId": "item-empty",
            "userId": "alice",
            "path": str(text_path),
            "mimeType": "text/plain",
        }
    )

    assert any(
        m["item_id"] == "item-empty"
        and m["status"] == "failed"
        and m["failure_reason"] == "empty_extraction"
        for m in fake_io["marked"]
    ), fake_io["marked"]


def test_handle_uploaded_persists_failed_on_embed_failure(
    fake_io, tmp_path, monkeypatch
):
    """Embedding throws → row must be marked failed; previously only
    published over MQTT and the row stayed at status='indexing'."""
    import brain_ingest

    def _boom(_chunks):
        raise RuntimeError("ai-gateway 503")

    monkeypatch.setattr(brain_ingest, "embed_texts", _boom)
    text_path = _write_text_payload(
        tmp_path, "item-embed", "alpha beta gamma delta epsilon zeta eta theta"
    )

    brain_ingest.handle_brain_uploaded(
        {
            "itemId": "item-embed",
            "userId": "alice",
            "path": str(text_path),
            "mimeType": "text/plain",
        }
    )

    assert any(
        m["item_id"] == "item-embed"
        and m["status"] == "failed"
        and m["failure_reason"] == "embed_failed"
        for m in fake_io["marked"]
    ), fake_io["marked"]
    # No chunks should have been upserted.
    assert fake_io["upserts"] == []


def test_handle_uploaded_persists_failed_on_db_write_failure(
    fake_io, tmp_path, monkeypatch
):
    """upsert_chunk raises → mark row failed with reason='db_failed'."""
    import brain_ingest

    def _boom(**_kwargs):
        raise RuntimeError("connection reset by peer")

    monkeypatch.setattr(brain_ingest, "upsert_chunk", _boom)
    text_path = _write_text_payload(
        tmp_path, "item-db", "alpha beta gamma delta epsilon zeta eta theta"
    )

    brain_ingest.handle_brain_uploaded(
        {
            "itemId": "item-db",
            "userId": "alice",
            "path": str(text_path),
            "mimeType": "text/plain",
        }
    )

    assert any(
        m["item_id"] == "item-db"
        and m["status"] == "failed"
        and m["failure_reason"] == "db_failed"
        for m in fake_io["marked"]
    ), fake_io["marked"]


# ── WARP-435 QA: PDF section_paths shape regression ──
#
# The first round of WARP-435 shipped PDF extractor metadata as
# ``list[list[str]]`` indexed by page, while every downstream caller
# (brain_ingest, watcher, transcription_worker) feeds it into
# ``chunker.section_path_for_offset`` which expects
# ``list[tuple[int, list[str]]]``. The mismatch raised
# ``ValueError: not enough values to unpack`` on the first chunk of any
# PDF with an empty-outline page (i.e. virtually every PDF — the leading
# pages always carry ``[]``). Without try/except in the brain-ingest
# handler the exception was swallowed by ``mqtt_client._on_message`` and
# the row sat at status='indexing' forever. This test pins the full
# extract → chunk_with_offsets → section_path_for_offset →
# format_chunk_with_header chain so the bug can't drift back in.


def test_handle_uploaded_pdf_end_to_end_no_section_path_exception(
    fake_io, tmp_path
):
    """Full chain against the real sample.pdf fixture must not raise.

    The fixture has no PDF outline so ``section_paths`` lands as the
    extractor's "no outline" case for every page — exactly the input
    shape the QA bug exploded on. Chunks must still be produced and the
    contextual-header prefix must land on each stored text.
    """
    from brain_ingest import handle_brain_uploaded
    from pathlib import Path as _Path

    # Place the fixture under the canonical <user>/<item> layout that
    # the handler reads side files from.
    fixture_pdf = (
        _Path(__file__).parent / "fixtures" / "sample.pdf"
    )
    assert fixture_pdf.exists(), f"missing fixture {fixture_pdf}"

    item_dir = tmp_path / "alice" / "item-pdf"
    item_dir.mkdir(parents=True, exist_ok=True)
    target = item_dir / "original.pdf"
    target.write_bytes(fixture_pdf.read_bytes())

    handle_brain_uploaded(
        {
            "itemId": "item-pdf",
            "userId": "alice",
            "path": str(target),
            "mimeType": "application/pdf",
            "filename": "sample.pdf",
            "originatingChatId": "chat-pdf",
        }
    )

    # No swallowed ValueError — the row landed at status='ready'.
    assert len(fake_io["marked"]) == 1, fake_io["marked"]
    assert fake_io["marked"][0]["item_id"] == "item-pdf"
    assert fake_io["marked"][0]["status"] == "ready", fake_io["marked"]
    assert fake_io["marked"][0]["failure_reason"] is None

    # Chunks were created.
    assert len(fake_io["upserts"]) >= 1, "expected ≥1 chunk from sample.pdf"

    # Every stored chunk carries the WARP-435 contextual header prefix.
    for upsert in fake_io["upserts"]:
        assert upsert["source"] == "brain"
        assert upsert["brain_item_id"] == "item-pdf"
        text = upsert["text"]
        assert text.startswith("Document: sample.pdf"), text[:80]

    # Ready publish under the per-user namespace.
    assert (
        "droplet/files/alice/brain/indexed",
        {"itemId": "item-pdf", "status": "ready"},
    ) in fake_io["published"]


# ── IDX-05: admin re-index must apply the WARP-435 contextual header ──
#
# `reindex_one` (the orchestrator's /api/admin/files/:id/reindex target)
# historically embedded + stored the RAW chunk text, dropping the WARP-435
# "Document: {name} / Section: {a > b}" header that all three primary
# ingest paths (handle_brain_uploaded, watcher, transcription_worker)
# apply. That silently produced different embeddings AND different stored
# text for an admin-re-indexed file vs a watcher-indexed one, degrading
# retrieval and breaking cross-path consistency. This test pins the parity:
# the embedder must see the prefixed text, the stored `text` column must be
# the prefixed text, and metadata must carry `sectionPath`.


class _FakeCursor:
    """Captures execute() args; supports the `with conn.cursor() as cur` form."""

    def __init__(self, store):
        self._store = store

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._store.append((sql, params))


class _FakeConn:
    def __init__(self, store):
        self._store = store
        self.autocommit = True
        self.committed = False

    def cursor(self):
        return _FakeCursor(self._store)

    def commit(self):
        self.committed = True

    def rollback(self):  # pragma: no cover - not exercised in happy path
        pass

    def close(self):
        pass


def test_reindex_one_applies_warp435_contextual_header(monkeypatch, tmp_path):
    import brain_ingest
    import db as db_mod

    # Real text file so the production chunker runs and yields real chunks.
    item_dir = tmp_path / "alice" / "bmi-reindex"
    item_dir.mkdir(parents=True, exist_ok=True)
    target = item_dir / "original.txt"
    target.write_text(
        "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        encoding="utf-8",
    )

    # fetch_item / get_conn are re-imported from `db` inside reindex_one.
    monkeypatch.setattr(
        db_mod,
        "fetch_item",
        lambda conn, *, item_id: {
            "id": item_id,
            "userId": "alice",
            "storagePath": str(target),
            "mimeType": "text/plain",
        },
    )
    monkeypatch.setattr(db_mod, "get_conn", lambda: object())
    monkeypatch.setattr(
        db_mod, "mark_brain_item_indexed", lambda *a, **k: None
    )

    # Capture what the embedder is handed (must be the PREFIXED text).
    embed_inputs: list[list[str]] = []

    def _embed(texts):
        embed_inputs.append(list(texts))
        return [[float(i)] * 384 for i in range(len(texts))]

    monkeypatch.setattr(brain_ingest, "embed_texts", _embed)

    # Capture the INSERT rows via a fake psycopg2 connection. reindex_one
    # does a *function-local* `import psycopg2`, so we patch connect() on
    # the real module object in sys.modules (a module-attr on brain_ingest
    # would be ignored by the local import).
    executed: list[tuple] = []
    import psycopg2 as _p2

    monkeypatch.setattr(
        _p2, "connect", lambda *a, **k: _FakeConn(executed)
    )
    # register_vector is imported as `from pgvector.psycopg2 import
    # register_vector` inside the function — stub the module attr.
    import pgvector.psycopg2 as _pgv

    monkeypatch.setattr(_pgv, "register_vector", lambda conn: None)

    result = brain_ingest.reindex_one("bmi-reindex")

    assert result["chunksWritten"] >= 1

    # 1) The embedder saw the prefixed text on every chunk.
    assert embed_inputs, "embed_texts was never called"
    for txt in embed_inputs[0]:
        assert txt.startswith("Document: original.txt"), txt[:80]

    # 2) Stored `text` column carries the prefix, and metadata has
    #    sectionPath — parity with the primary ingest paths.
    inserts = [
        params
        for (sql, params) in executed
        if 'INSERT INTO "FileContentChunk"' in sql
    ]
    assert inserts, "no INSERT executed"
    for params in inserts:
        # Column order: userId, ncFileId, path, chunkIdx, text, embedding,
        # source, brainItemId, pageNumber, warnings, metadata(json str).
        stored_text = params[4]
        metadata_json = params[10]
        assert stored_text.startswith("Document: original.txt"), stored_text[:80]
        assert '"sectionPath"' in metadata_json, metadata_json

    # 3) The embedded strings and the stored strings are identical
    #    (the embedder saw exactly what we persisted).
    stored_texts = [params[4] for params in inserts]
    assert stored_texts == embed_inputs[0]


def test_reindex_one_malformed_anchor_falls_back_to_null(monkeypatch, tmp_path):
    """IDX-05: a chunk whose ``anchor.model_dump()`` raises must NOT abort the
    whole re-index transaction (which would roll back and drop every chunk for
    the file). The chunk still lands with ``anchor=null`` and a
    ``malformed_anchor`` warning — parity with handle_brain_uploaded (WARP-287).
    """
    import brain_ingest
    import db as db_mod

    item_dir = tmp_path / "alice" / "bmi-bad-anchor"
    item_dir.mkdir(parents=True, exist_ok=True)
    target = item_dir / "original.txt"
    target.write_text(
        "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        db_mod,
        "fetch_item",
        lambda conn, *, item_id: {
            "id": item_id,
            "userId": "alice",
            "storagePath": str(target),
            "mimeType": "text/plain",
        },
    )
    monkeypatch.setattr(db_mod, "get_conn", lambda: object())
    monkeypatch.setattr(db_mod, "mark_brain_item_indexed", lambda *a, **k: None)
    monkeypatch.setattr(
        brain_ingest, "embed_texts", lambda texts: [[0.0] * 384 for _ in texts]
    )

    # Force a chunk whose anchor serialization blows up.
    class _BadAnchor:
        def model_dump(self):
            raise ValueError("boom")

    class _FakeChunk:
        text = "alpha beta gamma delta"
        section_path = ("Intro",)
        anchor = _BadAnchor()

    monkeypatch.setattr(
        brain_ingest, "_chunk_spans_from_doc", lambda doc: [_FakeChunk()]
    )

    executed: list[tuple] = []
    import psycopg2 as _p2

    monkeypatch.setattr(_p2, "connect", lambda *a, **k: _FakeConn(executed))
    import pgvector.psycopg2 as _pgv

    monkeypatch.setattr(_pgv, "register_vector", lambda conn: None)

    # Must NOT raise — the whole point of the guard.
    result = brain_ingest.reindex_one("bmi-bad-anchor")
    assert result["chunksWritten"] == 1

    inserts = [
        params
        for (sql, params) in executed
        if 'INSERT INTO "FileContentChunk"' in sql
    ]
    assert inserts, "no INSERT executed — the malformed anchor aborted the txn"
    params = inserts[0]
    # warnings column (index 9) carries the fallback marker.
    assert "malformed_anchor" in params[9]
    # metadata (index 10) stored anchor as null rather than crashing.
    assert '"anchor": null' in params[10]
