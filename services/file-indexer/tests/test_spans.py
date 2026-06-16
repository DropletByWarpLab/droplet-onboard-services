"""Tests for the Span dataclass + anchor validation."""
from __future__ import annotations

import pytest

from anchor_schema import (
    PdfPageAnchor,
    MediaTimestampAnchor,
    NoneAnchor,
)
from extractors.spans import Span


def test_span_carries_text_and_anchor():
    span = Span(text="page 1 content", anchor=PdfPageAnchor(page=1))
    assert span.text == "page 1 content"
    assert span.anchor.kind == "pdf-page"
    assert span.anchor.page == 1


def test_span_rejects_empty_text():
    with pytest.raises(ValueError, match="empty text"):
        Span(text="", anchor=NoneAnchor())


def test_span_rejects_whitespace_only_text():
    with pytest.raises(ValueError, match="empty text"):
        Span(text="   \n  ", anchor=NoneAnchor())


def test_span_none_anchor_is_valid():
    span = Span(text="legacy content", anchor=NoneAnchor())
    assert span.anchor.kind == "none"


def test_span_media_timestamp_validates_at_anchor_level():
    # The Anchor model itself rejects endMs <= startMs.
    with pytest.raises(Exception):  # pydantic.ValidationError
        MediaTimestampAnchor(startMs=1000, endMs=500)
