"""Chunker contract: chunks within a span inherit anchor; never cross spans."""
from __future__ import annotations

import pytest

from anchor_schema import NoneAnchor, PdfPageAnchor
from chunker import chunk_spans, Chunk
from extractors.spans import Span


def test_chunk_inherits_span_anchor():
    spans = [
        Span(text="page one content " * 5, anchor=PdfPageAnchor(page=1)),
        Span(text="page two content " * 5, anchor=PdfPageAnchor(page=2)),
    ]
    chunks = chunk_spans(spans, chunk_size=20, overlap_ratio=0.2)
    by_page: dict[int, list[Chunk]] = {}
    for c in chunks:
        by_page.setdefault(c.anchor.page, []).append(c)
    assert set(by_page.keys()) == {1, 2}


def test_chunks_never_cross_spans():
    """Two adjacent spans with different anchors → no chunk should contain text from both."""
    spans = [
        Span(text="alpha alpha alpha", anchor=PdfPageAnchor(page=1)),
        Span(text="beta beta beta", anchor=PdfPageAnchor(page=2)),
    ]
    chunks = chunk_spans(spans, chunk_size=20, overlap_ratio=0.2)
    for c in chunks:
        # Each chunk's text must come from exactly one span.
        assert ("alpha" in c.text) != ("beta" in c.text)


def test_long_span_produces_multiple_chunks_with_same_anchor():
    spans = [
        Span(text=" ".join(["word"] * 200), anchor=PdfPageAnchor(page=7)),
    ]
    chunks = chunk_spans(spans, chunk_size=20, overlap_ratio=0.2)
    assert len(chunks) > 1
    assert all(c.anchor.page == 7 for c in chunks)


def test_none_anchor_propagates():
    spans = [Span(text="legacy doc text", anchor=NoneAnchor())]
    chunks = chunk_spans(spans, chunk_size=20, overlap_ratio=0.2)
    assert all(c.anchor.kind == "none" for c in chunks)


def test_empty_span_list_returns_empty_chunks():
    assert chunk_spans([]) == []
