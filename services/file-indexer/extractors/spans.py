"""Span — text + anchor, produced by extractors and consumed by the chunker.

A Span represents a contiguous slice of extracted text that shares a single
positional anchor (one PDF page, one transcript segment, one MIME part,
one archive member). The chunker may emit multiple Chunks per Span when
the Span is long, but a Chunk never crosses Span boundaries — that would
make the anchor ambiguous.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from anchor_schema import Anchor


@dataclass(frozen=True)
class Span:
    text: str
    anchor: Anchor  # type: ignore[valid-type]  # discriminated union, see anchor_schema
    section_path: list[str] = field(default_factory=list)  # WARP-435 breadcrumb

    def __post_init__(self) -> None:
        # Strip NUL (0x00) before the emptiness check. Postgres TEXT cannot
        # hold a NUL, so psycopg2 raises "A string literal cannot contain NUL
        # (0x00) characters" at INSERT time — after extraction, chunking and
        # embedding have all already run. That surfaced as a whole-file
        # `failed` row for a PDF whose text layer carried stray NULs. Cleaning
        # here covers every extractor at once, since they all emit Spans.
        if self.text and "\x00" in self.text:
            object.__setattr__(self, "text", self.text.replace("\x00", ""))
        if not self.text or not self.text.strip():
            raise ValueError("Span rejects empty text")
