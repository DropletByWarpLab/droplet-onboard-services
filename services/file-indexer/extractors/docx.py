"""DOCX extractor using python-docx.

Flattens paragraphs and table rows into a single document body. Tables
are joined with `" | "` between cells so column structure survives the
chunker.

WARP-287: emits a single `Span` with `NoneAnchor` — python-docx doesn't
track page breaks reliably, so the whole body lives in one span.
"""
from __future__ import annotations

from docx import Document

from anchor_schema import NoneAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc


def extract(path: str) -> ExtractedDoc:
    document = Document(path)
    parts: list[str] = []
    for para in document.paragraphs:
        text = para.text.strip()
        if text:
            parts.append(text)

    # Tables go too — flatten cell text.
    for table in document.tables:
        for row in table.rows:
            row_text = " | ".join(
                cell.text.strip() for cell in row.cells if cell.text.strip()
            )
            if row_text:
                parts.append(row_text)

    full_text = "\n\n".join(parts)

    metadata = {
        "extractor_name": "docx",
        "extractor_version": "2",
        "paragraph_count": len(document.paragraphs),
        "word_count": len(full_text.split()),
    }

    if not full_text or not full_text.strip():
        return ExtractedDoc(
            spans=[],
            language=None,
            metadata=metadata,
            warnings=[],
        )

    return ExtractedDoc(
        spans=[Span(text=full_text, anchor=NoneAnchor())],
        language=None,
        metadata=metadata,
        warnings=[],
    )
