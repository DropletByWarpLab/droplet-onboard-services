"""Span-aware chunker.

Replaces the old `chunk_text(str)` — every caller now passes spans, and
the chunker chunks *within* each span (anchor stays attached) and *never
across* (which would make the anchor ambiguous).

Token counting is approximated as whitespace-split words; same as the
prior implementation. The output is a list of `Chunk(text, anchor)`
tuples; downstream the DB writer serializes `anchor` into the existing
FileContentChunk.metadata JSONB column under the `anchor` key.
"""
from __future__ import annotations

from dataclasses import dataclass

from anchor_schema import Anchor
from config import CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_RATIO
from extractors.spans import Span


@dataclass(frozen=True)
class Chunk:
    text: str
    anchor: Anchor  # type: ignore[valid-type]


def chunk_spans(
    spans: list[Span],
    chunk_size: int = CHUNK_SIZE_TOKENS,
    overlap_ratio: float = CHUNK_OVERLAP_RATIO,
) -> list[Chunk]:
    """Chunk each span independently; chunks inherit their span's anchor.

    A chunk never spans two source spans — that would make the anchor
    ambiguous.
    """
    if not spans:
        return []

    word_chunk = max(1, int(chunk_size * 0.75))
    word_overlap = max(0, int(word_chunk * overlap_ratio))
    step = max(1, word_chunk - word_overlap)

    out: list[Chunk] = []
    for span in spans:
        words = span.text.split()
        if not words:
            continue
        i = 0
        while i < len(words):
            window = words[i : i + word_chunk]
            chunk_text_value = " ".join(window).strip()
            if chunk_text_value:
                out.append(Chunk(text=chunk_text_value, anchor=span.anchor))
            i += step
    return out
