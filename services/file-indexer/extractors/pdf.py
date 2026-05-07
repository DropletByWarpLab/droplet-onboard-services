"""PDF extractor using pypdf.

Records per-page text plus the cumulative character offset where each
page ended, so chunkers / citation rendering can deep-link to a page
number.
"""
from __future__ import annotations

from typing import cast

from pypdf import PdfReader

from extractors.types import ExtractedDoc


def extract(path: str) -> ExtractedDoc:
    reader = PdfReader(path)
    parts: list[str] = []
    page_breaks: list[int] = []
    cum = 0
    for page in reader.pages:
        text = (page.extract_text() or "").strip()
        if text:
            parts.append(text)
            cum += len(text) + 2  # +2 for "\n\n" join below
        page_breaks.append(cum)

    full_text = "\n\n".join(parts)

    return cast(
        ExtractedDoc,
        {
            "text": full_text,
            "page_breaks": page_breaks,
            "language": None,
            "metadata": {
                "extractor_name": "pdf",
                "extractor_version": "1.0",
                "page_count": len(reader.pages),
                "word_count": len(full_text.split()),
            },
            "warnings": [],
        },
    )
