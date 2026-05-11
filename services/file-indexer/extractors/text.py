"""Text extractor: txt, md, csv, code, html.

HTML uses readability-lxml to strip nav/ads/boilerplate before chunking;
falls back to a crude tag-strip if readability is missing or chokes.

WARP-287: emits a single `Span` with `NoneAnchor` — text/markdown/etc.
don't carry positional info, so the whole body lives in one span.
"""
from __future__ import annotations

import os
import re

from anchor_schema import NoneAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc


_HTML_EXT = {".html", ".htm", ".xhtml"}


def _read_text(path: str) -> str:
    # Try utf-8 first, fall back to latin-1 with replace so we never crash.
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except UnicodeDecodeError:
        with open(path, "r", encoding="latin-1", errors="replace") as fh:
            return fh.read()


def _strip_html(raw: str) -> str:
    try:
        from readability import Document  # readability-lxml
        from lxml import html  # type: ignore[import-not-found]

        doc = Document(raw)
        tree = html.fromstring(doc.summary())
        text = tree.text_content().strip()
        if text:
            return text
    except Exception:  # pragma: no cover - falls through to crude strip
        pass
    # Last-resort: very crude tag strip.
    return re.sub(r"<[^>]+>", " ", raw)


def extract(path: str) -> ExtractedDoc:
    ext = os.path.splitext(path)[1].lower()
    raw = _read_text(path)
    head = raw.lstrip().lower()
    is_html = ext in _HTML_EXT or head.startswith("<!doctype html") or head.startswith("<html")
    if is_html:
        text = _strip_html(raw)
    else:
        text = raw

    text = text.strip()
    word_count = len(text.split())

    metadata = {
        "extractor_name": "text",
        "extractor_version": "2",
        "word_count": word_count,
    }

    if not text:
        return ExtractedDoc(
            spans=[],
            language=None,
            metadata=metadata,
            warnings=[],
        )

    return ExtractedDoc(
        spans=[Span(text=text, anchor=NoneAnchor())],
        language=None,
        metadata=metadata,
        warnings=[],
    )
