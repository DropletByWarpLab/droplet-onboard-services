"""PDF extractor using pypdf.

Emits one Span per non-empty page with `Anchor(kind="pdf-page", page=N)`.
Blank pages are skipped (the Span dataclass rejects empty text).
"""
from __future__ import annotations

import logging

from pypdf import PdfReader

from anchor_schema import PdfPageAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)


def extract(path: str) -> ExtractedDoc:
    reader = PdfReader(path)
    spans: list[Span] = []
    warnings: list[str] = []

    for idx, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001 — per-page failure must not abort the file
            logger.warning(
                "extractor.span.failed",
                extra={"extractor": "pdf", "page": idx, "error": str(exc)},
            )
            warnings.append(f"page_{idx}_extract_failed")
            continue

        if not text or not text.strip():
            continue
        spans.append(Span(text=text, anchor=PdfPageAnchor(page=idx)))

    return ExtractedDoc(
        spans=spans,
        language=None,
        metadata={
            "extractor_name": "pdf",
            "extractor_version": "2",
            "page_count": len(reader.pages),
        },
        warnings=warnings,
    )
