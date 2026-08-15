"""Span-aware, sentence-aware chunker (WARP-287 anchors + WARP-435 chunking).

Two designs converge here:

* **WARP-287** introduced span-scoped chunking: extractors emit `Span`s
  (text + positional anchor + section path), and the chunker chunks
  *within* each span and *never across* — crossing a span boundary would
  make the anchor ambiguous. The public entry point is
  ``chunk_spans(spans) -> list[Chunk]`` where each ``Chunk`` carries
  ``text``, ``anchor`` and ``section_path``.

* **WARP-435** replaced the legacy fixed-window word-split splitter with
  ``semantic-text-splitter`` driven by the embedder's HuggingFace
  tokenizer. Chunks now respect Unicode sentence + word boundaries and
  honour the embedder's true token budget (capacity in real tokens, not
  the 0.75-words/token approximation the old splitter used).

The unified design: ``chunk_spans`` runs the sentence-aware splitter
(``chunk_text``) on *each span's text* and emits one ``Chunk`` per
resulting string, inheriting the span's anchor and section path. The
word-window loop is gone from the chunking path — it survives only as
``_fallback_word_split`` for the offline-Hub degradation case.

Why sentence-awareness (WARP-435 §"Phase 1 — Ingest enrichment"):

* The old splitter cut mid-sentence on word boundaries with a hardcoded
  ``0.75 * words ≈ tokens`` heuristic. That over-counted on agglutinative
  / punctuation-dense passages and under-counted on short-word English
  prose, producing chunks anywhere from 60% to 110% of the intended
  ``CHUNK_SIZE_TOKENS`` budget.
* ``semantic-text-splitter`` (Rust-backed, ~8 MB wheel) walks the text
  with Unicode-aware sentence segmentation, then word boundaries, then
  character boundaries — only resorting to mid-sentence cuts when a
  single sentence overruns ``capacity``. That keeps semantically-coherent
  passages whole, which the embedder cares about more than exact token
  alignment.
* Capacity is the embedder tokenizer's real token count via
  ``TextSplitter.from_huggingface_tokenizer(tokenizer, capacity, overlap)``,
  so a chunk that fits at index time is guaranteed to fit at query time.

The contextual-header step (``format_chunk_with_header``) prepends the
document / section path to each chunk *outside* the splitter, applied by
``brain_ingest``/``watcher``/``transcription_worker`` just before the
embedder call, so this module stays purely about splitting.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Optional

from anchor_schema import Anchor
from config import CHUNK_OVERLAP_RATIO, CHUNK_SIZE_TOKENS, EMBEDDING_MODEL
from extractors.spans import Span

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
    # only invokes chunking when an item actually lands).
    from semantic_text_splitter import TextSplitter  # noqa: PLC0415
    from tokenizers import Tokenizer  # noqa: PLC0415

    tokenizer = Tokenizer.from_pretrained(_TOKENIZER_REPO)

    # WARP-2055 — the splitter measures a candidate chunk by asking this
    # tokenizer how many tokens it holds, so the tokenizer MUST report a
    # true count. `tokenizer.json` for all-MiniLM-L6-v2 ships
    # `truncation.max_length = 128`, which makes `encode()` return at most
    # 128 ids for *any* input. The splitter therefore measured every
    # candidate as <= 128 tokens, concluded it fit inside `capacity`, and
    # never split: chunking silently became a no-op that emitted one chunk
    # per Span regardless of length, and everything past the embedder's
    # window in each Span was unreachable by search. Measured on the live
    # corpus: a 462k-character spreadsheet produced exactly ONE chunk.
    #
    # Disabling truncation here affects only the measuring tokenizer, not
    # the embedder — the ai-gateway loads its own for the actual vectors.
    tokenizer.no_truncation()
    tokenizer.no_padding()

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


@dataclass(frozen=True)
class Chunk:
    text: str
    anchor: Anchor  # type: ignore[valid-type]  # discriminated union, see anchor_schema
    section_path: list[str] = field(default_factory=list)  # WARP-435 breadcrumb


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

    Used internally by ``chunk_spans`` (one call per span). Still public
    for direct callers / tests that exercise the sentence-aware contract.
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


def chunk_spans(
    spans: list[Span],
    chunk_size: int = CHUNK_SIZE_TOKENS,
    overlap_ratio: float = CHUNK_OVERLAP_RATIO,
) -> list[Chunk]:
    """Chunk each span independently; chunks inherit their span's anchor.

    For each span, the sentence-aware splitter (``chunk_text``) runs over
    ``span.text``; every resulting string becomes a ``Chunk`` carrying the
    span's ``anchor`` and ``section_path``. A chunk never spans two source
    spans — that would make the anchor ambiguous.
    """
    if not spans:
        return []

    out: list[Chunk] = []
    for span in spans:
        for chunk_str in chunk_text(span.text, chunk_size, overlap_ratio):
            out.append(
                Chunk(
                    text=chunk_str,
                    anchor=span.anchor,
                    section_path=list(span.section_path),
                )
            )
    return out


def chunk_text_with_offsets(
    text: str,
    chunk_size: int = CHUNK_SIZE_TOKENS,
    overlap_ratio: float = CHUNK_OVERLAP_RATIO,
) -> list[tuple[int, str]]:
    """Sentence-aware chunker that also returns each chunk's start offset.

    Returns ``(start_char_offset, chunk_text)`` tuples. The offset is the
    byte index into the original ``text`` where the chunk begins.

    Retained from WARP-435 for any caller that still works in global-offset
    terms. The span-scoped ingest path (``chunk_spans``) no longer needs
    this — section_path now rides on the span — but the function is kept
    (it's exercised by ``test_chunker``) and is harmless.

    Uses ``TextSplitter.chunk_indices`` (returns ``(offset, chunk)``
    pairs) when the splitter is available; otherwise falls back to the
    word-split chunker and reconstructs offsets by scanning.
    """
    if not text or not text.strip():
        return []

    overlap_tokens = max(0, int(chunk_size * overlap_ratio))

    try:
        splitter = _get_splitter(chunk_size, overlap_tokens)
        # ``chunk_indices`` returns (byte_offset, chunk_str) pairs.
        pairs = list(splitter.chunk_indices(text))
    except Exception as e:  # pragma: no cover - degradation path
        logger.warning(
            "chunker: chunk_indices unavailable (%s); falling back to "
            "scan-reconstruction. Quality may regress.",
            e,
        )
        chunks = _fallback_word_split(text, chunk_size, overlap_ratio)
        # Reconstruct offsets by sequential scan — accurate when chunks
        # are contiguous (legacy chunker emits non-overlapping windows
        # in word terms but our reconstruction is character-based).
        out: list[tuple[int, str]] = []
        cursor = 0
        for chunk in chunks:
            idx = text.find(chunk[:80], cursor)
            if idx < 0:
                idx = cursor
            out.append((idx, chunk))
            cursor = max(cursor, idx + 1)
        return out

    return [(int(off), c.strip()) for off, c in pairs if c and c.strip()]


def section_path_for_offset(
    offset: int, section_paths: list[tuple[int, list[str]]] | None
) -> list[str]:
    """Look up the section path covering ``offset`` via linear scan.

    ``section_paths`` is the ``(char_offset, path)`` tuple list emitted
    by the extractors. Returns the path of the most recent entry whose
    offset is <= the chunk's offset. Empty list when no entry applies
    (caller falls back to ``[filename]``).

    Retained from WARP-435. The span-scoped ingest path no longer calls
    this (section_path is carried per-span on the Chunk), but it stays for
    the offset-based helpers above and is exercised by ``test_chunker``.
    """
    if not section_paths:
        return []
    # Linear scan is fine — N is typically <100 (headings per document).
    # Binary search is a micro-opt; not worth the readability tax.
    current: list[str] = []
    for entry_offset, entry_path in section_paths:
        if entry_offset <= offset:
            current = entry_path
        else:
            break
    return current


# Per-token caps for the contextual-header sanitizer. The filename gets a
# generous 256-char budget (real filenames rarely approach this; the cap is
# a defence-in-depth bound, not a fit-to-screen rule). Section-path entries
# get the tighter 80-char cap because path entries stack ``a > b > c`` and
# we don't want a single 1 KB bookmark name to dominate the embedder's
# context window.
_HEADER_FILENAME_MAX = 256
_HEADER_SECTION_MAX = 80


def _sanitize_header_token(s: str, max_len: int = _HEADER_FILENAME_MAX) -> str:
    """Normalise one header token (filename or section-path entry).

    Strips ASCII control characters (everything ``< 0x20``, including
    newlines, carriage returns, and tabs), removes the literal ``Document:``
    / ``Section:`` substrings (so a bookmark named exactly ``Document: foo``
    can't impersonate the genuine header prefix), collapses runs of
    whitespace to a single space, and truncates to ``max_len`` characters.
    Returns the literal ``(empty)`` when the cleaned result is empty so the
    header still carries structure.

    WARP-435 reviewer finding 1: PDF outlines (and other extractor
    metadata) are attacker-controlled text. Interpolating raw into the
    header gives a prompt-injection vector at the retrieval surface — the
    sanitized chunk text is what later gets persisted to
    ``FileContentChunk.text`` and stitched into LLM prompts.
    """
    if not s:
        return "(empty)"
    # Replace ASCII control chars (< 0x20) with a single space so adjacent
    # words don't fuse together (``foo\tbar`` → ``foo bar``, not ``foobar``).
    # Keep everything else, including high-bit Unicode — bookmark names
    # legitimately contain accented characters, CJK, emoji, etc. The
    # whitespace-collapse step below then folds those spaces with any
    # neighbouring ASCII spaces back down to a single separator.
    cleaned = "".join(ch if ord(ch) >= 0x20 else " " for ch in s)
    # Drop literal header-prefix tokens to defeat impersonation.
    cleaned = cleaned.replace("Document:", "").replace("Section:", "")
    # Collapse internal whitespace runs to a single space.
    cleaned = " ".join(cleaned.split())
    # Truncate to the cap; we don't add an ellipsis (keeps the cap exact).
    cleaned = cleaned[:max_len]
    if not cleaned:
        return "(empty)"
    return cleaned


def format_chunk_with_header(
    chunk: str, filename: str, section_path: list[str]
) -> str:
    """Prepend the WARP-435 contextual header to a chunk.

    Header format (WARP-435):
        Document: {filename} / Section: {a > b > c}

        {chunk_text}

    Both the filename and each section-path entry are run through
    ``_sanitize_header_token`` first — extractor metadata (especially PDF
    bookmarks) is attacker-controlled and would otherwise allow header
    impersonation / control-char injection into the persisted chunk text.

    When ``section_path`` is empty we still emit the document header so
    every chunk carries at least the filename — that alone is a useful
    signal for the embedder when the same body sentence appears in
    multiple documents (cross-doc disambiguation).
    """
    safe_filename = _sanitize_header_token(filename, _HEADER_FILENAME_MAX)
    if section_path:
        safe_entries = [
            _sanitize_header_token(s, _HEADER_SECTION_MAX) for s in section_path
        ]
        section_str = " > ".join(safe_entries)
        header = f"Document: {safe_filename} / Section: {section_str}"
    else:
        header = f"Document: {safe_filename}"
    return f"{header}\n\n{chunk}"


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
