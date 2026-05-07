"""Unit tests for the brain-memory MQTT ingest pipeline (WARP-203).

We exercise `handle_brain_uploaded` in isolation by monkeypatching the
db / embedder / publish surface so the test runs without Postgres,
gRPC, or a live MQTT broker. Each test asserts on side-effect calls
the production handler is contracted to make.
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

    def _mark(item_id: str, warnings: list[str] | None = None) -> None:
        marked.append({"item_id": item_id, "warnings": warnings or []})

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

    # BrainMemoryItem marked indexed.
    assert len(fake_io["marked"]) == 1
    assert fake_io["marked"][0]["item_id"] == "item-A"

    # Published ready status.
    assert ("droplet/files/brain/indexed", {"itemId": "item-A", "status": "ready"}) in fake_io["published"]

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
    # the chip flips from "indexing…" to ⚠.
    assert any(m["item_id"] == "item-B" for m in fake_io["marked"])
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
