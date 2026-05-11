"""Span — text + anchor, produced by extractors and consumed by the chunker.

A Span represents a contiguous slice of extracted text that shares a single
positional anchor (one PDF page, one transcript segment, one MIME part,
one archive member). The chunker may emit multiple Chunks per Span when
the Span is long, but a Chunk never crosses Span boundaries — that would
make the anchor ambiguous.
"""
from __future__ import annotations

from dataclasses import dataclass

from anchor_schema import Anchor


@dataclass(frozen=True)
class Span:
    text: str
    anchor: Anchor  # type: ignore[valid-type]  # discriminated union, see anchor_schema

    def __post_init__(self) -> None:
        if not self.text or not self.text.strip():
            raise ValueError("Span rejects empty text")
