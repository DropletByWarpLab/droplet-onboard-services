"""Shared types for the extractor family.

Every extractor produces an `ExtractedDoc` carrying a list of Spans.
Each Span owns its text and its positional anchor; the chunker uses
spans to scope chunking (no chunk crosses a span boundary).
"""
from __future__ import annotations

from typing import Optional, TypedDict

from extractors.spans import Span


class ExtractedDoc(TypedDict, total=False):
    spans: list[Span]            # required — non-empty list of Spans
    language: Optional[str]      # optional — detected via langdetect; None if unknown
    metadata: dict               # required — title, author, page_count, word_count, extractor_name, extractor_version
    warnings: list[str]          # required — e.g. ["low_confidence_ocr"]
