"""Shared types for the extractor family.

Every extractor produces an `ExtractedDoc` so the chunker + db layer
don't need per-format conditional logic.
"""
from __future__ import annotations

from typing import Optional, TypedDict


class ExtractedDoc(TypedDict, total=False):
    text: str                    # required — canonical UTF-8 text fed to the chunker
    page_breaks: list[int]       # optional — char offsets where source pages break
    language: Optional[str]      # optional — detected via langdetect; None if unknown
    metadata: dict               # required — title, author, page_count, word_count, extractor_name, extractor_version
    warnings: list[str]          # required — e.g. ["low_confidence_ocr"]
