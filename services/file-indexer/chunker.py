"""Fixed-window text chunker with overlap.

Splits text into chunks of approximately `chunk_size` tokens with
`overlap_ratio` overlap between consecutive chunks. "Tokens" are
approximated as whitespace-split words (1 token ≈ 0.75 words for
English text), which is close enough for the purpose of embedding-window
sizing without importing a real tokenizer.
"""

from __future__ import annotations

from config import CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_RATIO


def chunk_text(
    text: str,
    chunk_size: int = CHUNK_SIZE_TOKENS,
    overlap_ratio: float = CHUNK_OVERLAP_RATIO,
) -> list[str]:
    """Split text into overlapping chunks.

    Returns a list of non-empty strings, each roughly `chunk_size` tokens
    long. The last chunk may be shorter.
    """
    if not text or not text.strip():
        return []

    words = text.split()
    if not words:
        return []

    # Approximate tokens ≈ words * 1.33 (inverse of 0.75 words/token)
    word_chunk = max(1, int(chunk_size * 0.75))
    word_overlap = max(0, int(word_chunk * overlap_ratio))
    step = max(1, word_chunk - word_overlap)

    chunks: list[str] = []
    i = 0
    while i < len(words):
        window = words[i : i + word_chunk]
        chunk = " ".join(window).strip()
        if chunk:
            chunks.append(chunk)
        i += step

    return chunks
