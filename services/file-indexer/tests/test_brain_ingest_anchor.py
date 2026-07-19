"""brain_ingest persists chunk.anchor into FileContentChunk.metadata.anchor.

The chunker now yields `Chunk(text, anchor)` rather than raw strings, and
the brain-memory ingest path must forward each chunk's anchor into the
per-chunk metadata payload it hands to `upsert_chunk`. The dashboard's
breadcrumb / citation surfaces read `metadata.anchor.{kind,page,…}` to
render "Page 4 of report.pdf" rather than a bare chunk index.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


@pytest.fixture
def fake_io(monkeypatch, tmp_path):
    """Capture upsert kwargs — same shape as tests/test_brain_ingest.py but
    here we care specifically about the per-chunk `metadata` payload."""
    import brain_ingest

    upserts: list[dict[str, Any]] = []

    def _upsert(**kwargs: Any) -> None:
        upserts.append(kwargs)

    def _delete(_item_id: str) -> None:
        pass

    def _mark(
        _item_id: str,
        *,
        status: str = "ready",
        failure_reason: str | None = None,
        warnings: list[str] | None = None,
    ) -> None:
        # WARP-330: mark_brain_item_indexed writes status + failure_reason
        # atomically; the stub must accept them (the unified ingest path
        # always passes status=).
        pass

    def _publish(_topic: str, _payload: dict) -> None:
        pass

    def _embed(chunks: list[str]) -> list[list[float]]:
        return [[float(i)] * 4 for i in range(len(chunks))]

    monkeypatch.setattr(brain_ingest, "upsert_chunk", _upsert)
    monkeypatch.setattr(brain_ingest, "delete_chunks_for_brain_item", _delete)
    monkeypatch.setattr(brain_ingest, "mark_brain_item_indexed", _mark)
    monkeypatch.setattr(brain_ingest, "publish", _publish)
    monkeypatch.setattr(brain_ingest, "embed_texts", _embed)
    # WARP-242: deterministic DEK so the handler can encrypt without a
    # doc-KEK keyfile or DB (this suite asserts on metadata, not text).
    import doc_keys

    monkeypatch.setattr(
        doc_keys, "get_or_create_dek", lambda _key_id: bytes([9] * 32)
    )

    return upserts


def _write_payload(tmp_path: Path, item_id: str, text: str) -> Path:
    item_dir = tmp_path / "alice" / item_id
    item_dir.mkdir(parents=True, exist_ok=True)
    p = item_dir / "original.txt"
    p.write_text(text, encoding="utf-8")
    return p


def test_brain_ingest_writes_anchor_into_metadata(fake_io, tmp_path, monkeypatch):
    """When the chunker yields Chunks with PdfPageAnchor, each upsert row
    must carry metadata.anchor = {"kind": "pdf-page", "page": N}."""
    import brain_ingest
    from anchor_schema import PdfPageAnchor
    from chunker import Chunk

    fake_chunks = [
        Chunk(text="content one", anchor=PdfPageAnchor(page=4)),
        Chunk(text="content two", anchor=PdfPageAnchor(page=4)),
    ]

    # Bypass the real chunker; we want to assert the wiring from Chunk →
    # upsert kwargs, not re-test the chunker itself.
    monkeypatch.setattr(brain_ingest, "_chunk_spans_from_doc", lambda _doc: fake_chunks)
    # Bypass the empty-extraction guard for the same reason — the guard's
    # behavior is covered separately in tests/test_brain_ingest.py.
    monkeypatch.setattr(
        brain_ingest, "_full_text_from_doc", lambda _doc: "real-enough text content"
    )

    # Stub dispatch so we don't need a real extractor on disk; doc just
    # needs to be a non-None dict.
    monkeypatch.setattr(
        brain_ingest,
        "dispatch",
        lambda *_a, **_k: {"spans": [], "metadata": {}, "warnings": []},
    )

    text_path = _write_payload(tmp_path, "item-pdf", "irrelevant")
    brain_ingest.handle_brain_uploaded(
        {
            "itemId": "item-pdf",
            "userId": "alice",
            "path": str(text_path),
            "mimeType": "application/pdf",
        }
    )

    assert len(fake_io) == 2
    for row in fake_io:
        meta = row["metadata"]
        if isinstance(meta, str):
            meta = json.loads(meta)
        assert meta is not None
        assert meta.get("anchor") == {"kind": "pdf-page", "page": 4}
