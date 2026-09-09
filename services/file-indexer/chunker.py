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

WARP-2191 closed the hole that arrangement left. The header is added AFTER
the splitter has already spent the whole budget on body text, so it used to
be pure overrun past the embedder's window — silently truncated, along with
whatever body text it displaced. Now ``CHUNK_HEADER_BUDGET_TOKENS`` is
withheld from the splitter's capacity (``_split_params``) and the header is
bounded to that reservation (``_fit_header``), so body and header are
budgeted against the same window and a chunk that fits at split time still
fits once the header is on it.

WARP-2196 made the embedder itself explicit. The tokenizer repo comes from
``embedding_models``, not from prefixing the short model id, and
``_build_splitter`` asserts the chunk budget fits the configured embedder's
declared ``max_seq_length`` before it does anything else — the invariant that
went unchecked while ``all-MiniLM-L6-v2`` (256-token window) was fed
512-token chunks.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Optional

from anchor_schema import Anchor
from config import (
    CHUNK_HEADER_BUDGET_TOKENS,
    CHUNK_OVERLAP_RATIO,
    CHUNK_SIZE_TOKENS,
    EMBEDDING_MODEL,
)
from embedding_models import (
    ChunkBudgetError,
    assert_chunk_budget_fits,
    body_capacity,
    tokenizer_repo,
)
from extractors.spans import Span

logger = logging.getLogger(__name__)


def _tokenizer_repo() -> str:
    """Fully-qualified Hub repo for the configured embedder's tokenizer.

    WARP-2196: this used to be ``f"sentence-transformers/{EMBEDDING_MODEL}"``.
    That prefix is correct for MiniLM and wrong for bge, which lives under
    ``BAAI/`` — and the failure mode of a wrong org is a Hub 404 at chunk
    time, not a compile error. The mapping is now data in
    ``embedding_models``, and an unregistered id raises there rather than
    resolving to a plausible-looking repo that does not exist.

    Read through a function (not a module constant) so the model can be
    swapped in tests without reimporting the module.
    """
    return tokenizer_repo(EMBEDDING_MODEL)


# Module-level cached splitter. ``TextSplitter.from_huggingface_tokenizer``
# does a model-config download on first call (~1 MB JSON, no model
# weights), so we memoise. Threading lock keeps the lazy-init safe under
# the watcher's IndexHandler thread + the transcription worker thread.
_splitter_lock = threading.Lock()
_splitter = None  # type: ignore[var-annotated]
_splitter_capacity: Optional[int] = None
_splitter_overlap: Optional[int] = None

# The measuring tokenizer is shared by the splitter (which sizes candidate
# chunks with it) and ``format_chunk_with_header`` (which sizes the header
# against its reserved allowance). Separate lock from ``_splitter_lock``:
# ``_build_splitter`` runs while that one is held, and ``threading.Lock``
# is not reentrant.
_tokenizer_lock = threading.Lock()
_measuring_tokenizer = None  # type: ignore[var-annotated]


def _get_measuring_tokenizer():
    """Return the cached HF tokenizer for the configured embedder.

    Raises on Hub failure — callers decide whether that is fatal (the
    splitter) or a degradation to be absorbed (header sizing).
    """
    global _measuring_tokenizer
    with _tokenizer_lock:
        if _measuring_tokenizer is None:
            from tokenizers import Tokenizer  # noqa: PLC0415

            tokenizer = Tokenizer.from_pretrained(_tokenizer_repo())

            # WARP-2055 — the splitter measures a candidate chunk by asking
            # this tokenizer how many tokens it holds, so the tokenizer MUST
            # report a true count. `tokenizer.json` for all-MiniLM-L6-v2
            # ships `truncation.max_length = 128`, which makes `encode()`
            # return at most 128 ids for *any* input. The splitter therefore
            # measured every candidate as <= 128 tokens, concluded it fit
            # inside `capacity`, and never split: chunking silently became a
            # no-op that emitted one chunk per Span regardless of length, and
            # everything past the embedder's window in each Span was
            # unreachable by search. Measured on the live corpus: a 462k-
            # character spreadsheet produced exactly ONE chunk.
            #
            # bge-small-en-v1.5's `tokenizer.json` ships no truncation block
            # at all (verified against the Hub artifact), so this is belt-and-
            # braces for it — and stays because the next model may not be so
            # well behaved.
            #
            # Disabling truncation here affects only the measuring tokenizer,
            # not the embedder — the ai-gateway loads its own for the actual
            # vectors.
            tokenizer.no_truncation()
            tokenizer.no_padding()
            _measuring_tokenizer = tokenizer
        return _measuring_tokenizer


def _build_splitter(capacity: int, overlap: int):
    """Construct a ``TextSplitter`` keyed on the embedder tokenizer.

    ``capacity`` is the BODY budget — ``CHUNK_SIZE_TOKENS`` minus the header
    allowance — because the WARP-435 contextual header is prepended after
    splitting and has to be paid for out of the same window.

    Kept separate so tests can monkeypatch the construction path
    without exercising the HF-Hub download.
    """
    # WARP-2191 guard, enforced here rather than only in the test suite: a
    # chunk budget wider than the embedder's window truncates every full-size
    # chunk's vector, silently. Checked BEFORE the Hub call so a
    # misconfiguration fails offline and instantly.
    assert_chunk_budget_fits(
        model_id=EMBEDDING_MODEL,
        chunk_size=capacity + CHUNK_HEADER_BUDGET_TOKENS,
        header_budget=CHUNK_HEADER_BUDGET_TOKENS,
    )

    # Local import keeps module load cheap for callers that don't chunk
    # (e.g. the brain-ingest worker imports chunker.py at startup but
    # only invokes chunking when an item actually lands).
    from semantic_text_splitter import TextSplitter  # noqa: PLC0415

    tokenizer = _get_measuring_tokenizer()

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


def _split_params(
    chunk_size: int, overlap_ratio: float, header_budget: Optional[int] = None
) -> tuple[int, int]:
    """Translate the per-chunk embedder budget into splitter arguments.

    WARP-2191: ``chunk_size`` is the WHOLE budget for one chunk — body text
    plus the contextual header. The splitter only ever sees body text, so it
    gets the budget MINUS the header reservation. Before this, the header was
    pure overrun: the splitter spent the full 512 and the header pushed the
    result past the embedder's window, where it was silently truncated.

    ``header_budget`` defaults to the configured reservation. It is a
    parameter, not a constant read, because a caller that wants a specific
    BODY capacity (tests that force aggressive splitting on short text) has to
    be able to say ``header_budget=0`` and mean it. Clamping a large fixed
    reservation down to fit a small ``chunk_size`` would be the same class of
    silent adjustment this ticket exists to remove.

    Overlap is a ratio of the BODY capacity, not of the full budget. Taking it
    off the full budget could hand the splitter an overlap larger than the
    capacity it was given.
    """
    reserved = CHUNK_HEADER_BUDGET_TOKENS if header_budget is None else header_budget
    assert_chunk_budget_fits(
        model_id=EMBEDDING_MODEL, chunk_size=chunk_size, header_budget=reserved
    )
    capacity = body_capacity(chunk_size, reserved)
    overlap = max(0, int(capacity * overlap_ratio))
    return capacity, overlap


@dataclass(frozen=True)
class Chunk:
    text: str
    anchor: Anchor  # type: ignore[valid-type]  # discriminated union, see anchor_schema
    section_path: list[str] = field(default_factory=list)  # WARP-435 breadcrumb


def chunk_text(
    text: str,
    chunk_size: int = CHUNK_SIZE_TOKENS,
    overlap_ratio: float = CHUNK_OVERLAP_RATIO,
    header_budget: Optional[int] = None,
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

    capacity, overlap_tokens = _split_params(
        chunk_size, overlap_ratio, header_budget
    )

    try:
        splitter = _get_splitter(capacity, overlap_tokens)
        chunks = splitter.chunks(text)
    except ChunkBudgetError:
        # NOT a degradation case. The chunk budget overrunning the embedder's
        # window is a misconfiguration, and falling back to word-split would
        # paper over it with vectors that cover part of each chunk — exactly
        # the silent failure WARP-2196 exists to end. Fail the row loudly.
        raise
    except Exception as e:  # pragma: no cover - network/IO degradation path
        logger.warning(
            "chunker: semantic-text-splitter unavailable (%s); "
            "falling back to word-split. Quality may regress.",
            e,
        )
        return _fallback_word_split(text, capacity, overlap_ratio)

    # Defensive strip — semantic-text-splitter trims whitespace already
    # but we drop any empties just in case (e.g. all-whitespace tail).
    return [c.strip() for c in chunks if c and c.strip()]


def chunk_spans(
    spans: list[Span],
    chunk_size: int = CHUNK_SIZE_TOKENS,
    overlap_ratio: float = CHUNK_OVERLAP_RATIO,
    header_budget: Optional[int] = None,
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
        for chunk_str in chunk_text(
            span.text, chunk_size, overlap_ratio, header_budget
        ):
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
    header_budget: Optional[int] = None,
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

    capacity, overlap_tokens = _split_params(
        chunk_size, overlap_ratio, header_budget
    )

    try:
        splitter = _get_splitter(capacity, overlap_tokens)
        # ``chunk_indices`` returns (byte_offset, chunk_str) pairs.
        pairs = list(splitter.chunk_indices(text))
    except ChunkBudgetError:
        raise  # see chunk_text — misconfiguration, not degradation.
    except Exception as e:  # pragma: no cover - degradation path
        logger.warning(
            "chunker: chunk_indices unavailable (%s); falling back to "
            "scan-reconstruction. Quality may regress.",
            e,
        )
        chunks = _fallback_word_split(text, capacity, overlap_ratio)
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


def _compose_header(safe_filename: str, safe_entries: list[str]) -> str:
    """Assemble the header from already-sanitized tokens."""
    if safe_entries:
        return f"Document: {safe_filename} / Section: {' > '.join(safe_entries)}"
    return f"Document: {safe_filename}"


def _fit_header(safe_filename: str, safe_entries: list[str], budget: int) -> str:
    """Return the richest header that fits ``budget`` tokens.

    WARP-2191. The sanitizer's per-token caps (256 chars for the filename, 80
    per section entry) bound each PIECE but not the whole: section_path depth
    is unbounded, and character caps are not token caps. Measured against the
    bge tokenizer, a header legal under those caps — a 300-character CJK
    filename plus three 100-character CJK entries — is 505 tokens, which alone
    would consume a 512-token window and leave zero room for body text.

    Shedding order is deliberate: breadcrumb depth goes first, from the tail,
    because the deepest heading is the most disposable context; the document
    name is what disambiguates the same sentence across two files and is only
    trimmed when it alone overruns.

    Truncation is exact — no ellipsis — matching ``_sanitize_header_token``'s
    existing convention.
    """
    try:
        tokenizer = _get_measuring_tokenizer()
    except Exception as e:  # pragma: no cover - Hub/IO degradation path
        # semgrep's credential-disclosure rule keys off credential-ish words
        # in the message text, and "tokenizer" contains "token". `e` here is
        # the tokenizer-load failure, never a secret. The two sibling
        # logger.warning calls in this file (chunk_text, chunk_indices) are
        # the same shape and pass the same rule -- their messages just carry
        # no such word -- which is what identifies this as a wording match
        # rather than a real finding about passing the exception.
        logger.warning(  # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure
            "chunker: header tokenizer unavailable (%s); bounding the "
            "contextual header by characters instead.",
            e,
        )
        tokenizer = None

    if tokenizer is None:
        # WordPiece never emits more than one token per character, so a
        # character cap at the token budget can only under-spend it. The
        # degraded path must not be the one that overruns.
        entries = list(safe_entries)
        header = _compose_header(safe_filename, entries)
        while entries and len(header) > budget:
            entries.pop()
            header = _compose_header(safe_filename, entries)
        return header[:budget]

    def measure(s: str) -> int:
        return len(tokenizer.encode(s).ids)

    entries = list(safe_entries)
    header = _compose_header(safe_filename, entries)
    if measure(header) <= budget:
        return header

    while entries:
        entries.pop()
        header = _compose_header(safe_filename, entries)
        if measure(header) <= budget:
            return header

    # The filename alone still overruns. Binary-search the longest prefix that
    # fits. Only candidates that actually measured within budget are kept, so
    # a non-monotonic tokenizer can cost richness but never correctness.
    best: Optional[str] = None
    lo, hi = 0, len(safe_filename)
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = _compose_header(safe_filename[:mid].strip() or "(empty)", [])
        if measure(candidate) <= budget:
            best = candidate
            lo = mid + 1
        else:
            hi = mid - 1
    return best if best is not None else "Document:"


def format_chunk_with_header(
    chunk: str,
    filename: str,
    section_path: list[str],
    budget_tokens: Optional[int] = None,
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

    WARP-2191: the header is then bounded to ``CHUNK_HEADER_BUDGET_TOKENS``,
    the slice of the embedder window ``_split_params`` withheld from the
    splitter for exactly this purpose. Header and body are budgeted against
    the same window, so a chunk that fit at split time still fits once the
    header is on it. ``budget_tokens`` overrides the reservation for tests.
    """
    budget = CHUNK_HEADER_BUDGET_TOKENS if budget_tokens is None else budget_tokens
    safe_filename = _sanitize_header_token(filename, _HEADER_FILENAME_MAX)
    safe_entries = [
        _sanitize_header_token(s, _HEADER_SECTION_MAX) for s in section_path
    ]
    header = _fit_header(safe_filename, safe_entries, budget)
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
