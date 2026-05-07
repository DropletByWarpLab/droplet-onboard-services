"""DOCX extractor using python-docx.

Flattens paragraphs and table rows into a single document body. Tables
are joined with `" | "` between cells so column structure survives the
chunker.
"""
from __future__ import annotations

from typing import cast

from docx import Document

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

    return cast(
        ExtractedDoc,
        {
            "text": full_text,
            "page_breaks": [],  # python-docx doesn't track page breaks reliably
            "language": None,
            "metadata": {
                "extractor_name": "docx",
                "extractor_version": "1.0",
                "paragraph_count": len(document.paragraphs),
                "word_count": len(full_text.split()),
            },
            "warnings": [],
        },
    )
