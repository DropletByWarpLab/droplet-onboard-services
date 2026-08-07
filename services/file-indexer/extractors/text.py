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

# WARP-1790: RTF is a *markup* format that carries a `text/*` MIME
# (`mimetypes.guess_type("x.rtf")` -> "text/rtf"), so the registry routes it
# here on the `mime.startswith("text/")` branch and it used to fall through to
# the raw-passthrough `else` below. The whole control-word stream was then
# indexed as if it were prose: QA saw chunk snippets reading
# "Section: Adler Essay 2.4 IVC.rtf \lsdpriority46 \lsdlocked0 List Ta…" in
# Knowledge -> Recently indexed. That also silently poisons retrieval for the
# document, because queries match style-table markup rather than the text.
# Same situation HTML is already in, so it gets the same treatment.
_RTF_EXT = {".rtf"}


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


def _strip_rtf(raw: str) -> str:
    """RTF control words -> readable text, mirroring `_strip_html`'s contract:
    a best-effort library pass, then a crude fallback so a missing or unhappy
    dependency degrades instead of indexing raw markup."""
    try:
        from striprtf.striprtf import rtf_to_text  # noqa: PLC0415

        text = rtf_to_text(raw, errors="ignore").strip()
        if text:
            return text
    except Exception:  # pragma: no cover - falls through to crude strip
        pass
    # Last-resort: drop the group delimiters and control words
    # (`\lsdpriority46`, `\par`, `\'e9`, …) and keep whatever plain runs remain.
    stripped = re.sub(r"\\'[0-9a-fA-F]{2}", "", raw)
    stripped = re.sub(r"\\[a-zA-Z]+-?\d* ?", " ", stripped)
    stripped = re.sub(r"[{}]", " ", stripped)
    return re.sub(r"[ \t]+", " ", stripped)


def extract(path: str) -> ExtractedDoc:
    ext = os.path.splitext(path)[1].lower()
    raw = _read_text(path)
    head = raw.lstrip().lower()
    is_html = ext in _HTML_EXT or head.startswith("<!doctype html") or head.startswith("<html")
    # Sniff the magic as well as the extension: RTF always opens `{\rtf`, and a
    # mis-extensioned file should still not reach the index as markup.
    is_rtf = ext in _RTF_EXT or head.startswith("{\\rtf")
    if is_html:
        text = _strip_html(raw)
    elif is_rtf:
        text = _strip_rtf(raw)
    else:
        text = raw

    text = text.strip()
    word_count = len(text.split())

    metadata = {
        "extractor_name": "text",
        # WARP-1790 bumped this to 3: .rtf now yields prose instead of raw
        # control words, so chunks written by version 2 for an RTF document
        # are wrong and need re-indexing to be corrected.
        "extractor_version": "3",
        "word_count": word_count,
    }

    if not text:
        return ExtractedDoc(
            spans=[],
            language=None,
            metadata=metadata,
            warnings=[],
        )

    # WARP-435: flat-text formats have no in-file structure, so the
    # "section" is just the filename. Every chunk derived from this span
    # inherits ``[filename]`` as its contextual-header section path.
    filename = os.path.basename(path) or "document"

    return ExtractedDoc(
        spans=[Span(text=text, anchor=NoneAnchor(), section_path=[filename])],
        language=None,
        metadata=metadata,
        warnings=[],
    )
