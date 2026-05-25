"""Sentence-aware tokenizer-driven chunker (ADR-003 Phase 1 / WARP-435).

Replaces the legacy fixed-window word-split chunker with
``semantic-text-splitter`` driven by the embedder's actual HuggingFace
tokenizer. Chunks now respect Unicode sentence + word boundaries and
honour the embedder's true token budget (capacity in real tokens, not
the 0.75-words/token approximation the old splitter used).

Why this change (ADR-003 §"Phase 1 — Ingest enrichment"):

* The old splitter cut mid-sentence on word boundaries with a hardcoded
  ``0.75 * words ≈ tokens`` heuristic. That over-counted on agglutinative
  / punctuation-dense passages and under-counted on short-word English
  prose, producing chunks that were anywhere from 60% to 110% of the
  intended ``CHUNK_SIZE_TOKENS`` budget.
* ``semantic-text-splitter`` (Rust-backed, ~8 MB wheel) walks the text
  with Unicode-aware sentence segmentation, then with word boundaries,
  then with character boundaries — only resorting to mid-sentence cuts
  when a single sentence overruns ``capacity``. That keeps semantically-
  coherent passages whole, which the embedder cares about more than
  exact token alignment.
* Capacity is the embedder tokenizer's real token count via
  ``TextSplitter.from_huggingface_tokenizer(tokenizer, capacity, overlap)``,
  so a chunk that fits at index time is guaranteed to fit at query time —
  no more "ai-gateway returned 512-token-truncated embeddings" warnings
  from the gRPC side.

Public signature ``chunk_text(text: str) -> list[str]`` is preserved so
``watcher.py``, ``brain_ingest.py``, and ``transcription_worker.py`` keep
working without per-caller changes. The hierarchical-prefix step (1.7)
prepends the document / section path to each chunk *outside* this module,
in ``db.upsert_chunk``'s caller, so this file stays purely about
splitting.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from config import CHUNK_OVERLAP_RATIO, CHUNK_SIZE_TOKENS, EMBEDDING_MODEL

logger = logging.getLogger(__name__)

# Tokenizer ID — full HF repo path. The embedder model in config is the
# short name (``all-MiniLM-L6-v2``); the tokenizer lives under the
# canonical ``sentence-transformers/`` org on the Hub.
_TOKENIZER_REPO = f"sentence-transformers/{EMBEDDING_MODEL}"

# Module-level cached splitter. ``TextSplitter.from_huggingface_tokenizer``
# does a model-config download on first call (~1 MB JSON, no model
# weights), so we memoise. Threading lock keeps the lazy-init safe under
# the watcher's IndexHandler thread + the transcription worker thread.
_splitter_lock = threading.Lock()
_splitter = None  # type: ignore[var-annotated]
_splitter_capacity: Optional[int] = None
_splitter_overlap: Optional[int] = None


def _build_splitter(capacity: int, overlap: int):
    """Construct a ``TextSplitter`` keyed on the embedder tokenizer.

    Kept separate so tests can monkeypatch the construction path
    without exercising the HF-Hub download.
    """
    # Local imports keep module load cheap for callers that don't chunk
    # (e.g. the brain-ingest worker imports chunker.py at startup but
    # only invokes chunk_text when an item actually lands).
    from semantic_text_splitter import TextSplitter  # noqa: PLC0415
    from tokenizers import Tokenizer  # noqa: PLC0415

    tokenizer = Tokenizer.from_pretrained(_TOKENIZER_REPO)
    return TextSplitter.from_huggingface_tokenizer(
        tokenizer, capacity=capacity, overlap=overlap
    )


def _get_splitter(capacity: int, overlap: int):
    """Return the cached splitter, rebuilding if capacity/overlap changed.

    Tests that override ``chunk_size`` / ``overlap_ratio`` end up here;
    in production both come from config and stay constant for the life
    of the process, so the rebuild path is exercised only by tests.
    """
    global _splitter, _splitter_capacity, _splitter_overlap
    with _splitter_lock:
        if (
            _splitter is None
            or _splitter_capacity != capacity
            or _splitter_overlap != overlap
        ):
            _splitter = _build_splitter(capacity, overlap)
            _splitter_capacity = capacity
            _splitter_overlap = overlap
        return _splitter


def chunk_text(
    text: str,
    chunk_size: int = CHUNK_SIZE_TOKENS,
    overlap_ratio: float = CHUNK_OVERLAP_RATIO,
) -> list[str]:
    """Split ``text`` into sentence-aware chunks sized to the embedder.

    Returns a list of non-empty UTF-8 strings, each fitting inside the
    embedder's ``chunk_size`` token budget with a ``overlap_ratio``
    overlap between consecutive chunks. The last chunk may be shorter.

    Behaviour notes:
      * Empty / whitespace-only input → empty list (matches the legacy
        contract; callers depend on this to skip the embedder call).
      * If the HF tokenizer / splitter can't be constructed (offline
        Hub, network failure during dev), we fall back to the legacy
        whitespace-split chunker so indexing degrades gracefully rather
        than failing the row. The fallback emits a one-shot warning so
        operators see the degradation.
    """
    if not text or not text.strip():
        return []

    overlap_tokens = max(0, int(chunk_size * overlap_ratio))

    try:
        splitter = _get_splitter(chunk_size, overlap_tokens)
        chunks = splitter.chunks(text)
    except Exception as e:  # pragma: no cover - network/IO degradation path
        logger.warning(
            "chunker: semantic-text-splitter unavailable (%s); "
            "falling back to word-split. Quality may regress.",
            e,
        )
        return _fallback_word_split(text, chunk_size, overlap_ratio)

    # Defensive strip — semantic-text-splitter trims whitespace already
    # but we drop any empties just in case (e.g. all-whitespace tail).
    return [c.strip() for c in chunks if c and c.strip()]


def _fallback_word_split(
    text: str, chunk_size: int, overlap_ratio: float
) -> list[str]:
    """Legacy word-split chunker, retained as a degradation path.

    Approximates tokens as ``0.75 * words`` and walks a sliding window
    over whitespace-split tokens. Lower quality than the sentence-aware
    path — only used when the HF tokenizer can't be loaded.
    """
    words = text.split()
    if not words:
        return []

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
