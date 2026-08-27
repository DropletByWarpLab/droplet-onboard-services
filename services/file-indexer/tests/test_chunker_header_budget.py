"""WARP-2191 — the contextual header must be paid for out of the chunk budget.

`format_chunk_with_header` prepends `Document: … / Section: …` AFTER the
splitter has already spent the whole budget on body text, so pre-WARP-2191
every header was pure overrun past the embedder's window. The fix has two
halves and both are pinned here:

  1. the splitter's capacity is `CHUNK_SIZE_TOKENS - CHUNK_HEADER_BUDGET_TOKENS`
  2. the header is truncated to fit that reservation, so the overrun is bounded
     rather than merely smaller

The measured worst case for (2) matters: a 300-character CJK filename plus
three 100-character CJK section entries — all legal under the existing
sanitizer's 256/80 char caps — tokenizes to 505 tokens, which alone would
consume the entire 512-token window and leave no room for body text at all.
"""
from __future__ import annotations

import pytest

import chunker
import embedding_models as em
from chunker import format_chunk_with_header
from config import CHUNK_HEADER_BUDGET_TOKENS, CHUNK_SIZE_TOKENS


class _WordTokenizer:
    """1 token per whitespace-separated word. Enough to test the accounting."""

    def __init__(self):
        self.truncation = None
        self.padding = None

    def encode(self, text, *a, **kw):
        class _E:
            ids = list(range(len(text.split())))

        return _E()

    def no_truncation(self):
        self.truncation = None

    def no_padding(self):
        self.padding = None


@pytest.fixture
def word_tokenizer(monkeypatch):
    """Swap the measuring tokenizer for a deterministic offline one."""
    tok = _WordTokenizer()
    monkeypatch.setattr(chunker, "_measuring_tokenizer", tok)
    return tok


# ---------------------------------------------------------------------------
# 1. The splitter's capacity reserves the header
# ---------------------------------------------------------------------------


def test_splitter_capacity_reserves_the_header_allowance(monkeypatch):
    """`chunk_text(…, chunk_size=512)` must build a 448-capacity splitter."""
    seen = {}

    def _fake_get_splitter(capacity, overlap):
        seen["capacity"] = capacity
        seen["overlap"] = overlap

        class _S:
            @staticmethod
            def chunks(text):
                return [text]

        return _S()

    monkeypatch.setattr(chunker, "_get_splitter", _fake_get_splitter)
    chunker.chunk_text("hello world", chunk_size=512, overlap_ratio=0.2)

    assert seen["capacity"] == em.body_capacity(512, CHUNK_HEADER_BUDGET_TOKENS)
    assert seen["capacity"] == 512 - CHUNK_HEADER_BUDGET_TOKENS
    # Overlap is a ratio OF THE BODY capacity — an overlap computed off the
    # full budget could exceed the capacity the splitter was handed.
    assert seen["overlap"] == int(seen["capacity"] * 0.2)
    assert seen["overlap"] < seen["capacity"]


def test_offset_variant_reserves_the_same_allowance(monkeypatch):
    """`chunk_text_with_offsets` must not drift from `chunk_text`."""
    seen = {}

    def _fake_get_splitter(capacity, overlap):
        seen["capacity"] = capacity

        class _S:
            @staticmethod
            def chunk_indices(text):
                return [(0, text)]

        return _S()

    monkeypatch.setattr(chunker, "_get_splitter", _fake_get_splitter)
    chunker.chunk_text_with_offsets("hello world", chunk_size=512, overlap_ratio=0.2)
    assert seen["capacity"] == 512 - CHUNK_HEADER_BUDGET_TOKENS


# ---------------------------------------------------------------------------
# 2. The header is bounded by that reservation
# ---------------------------------------------------------------------------


def test_short_header_is_untouched(word_tokenizer):
    """The common case must be byte-identical to pre-WARP-2191 output."""
    out = format_chunk_with_header("body text", "notes.md", ["Intro"])
    assert out == "Document: notes.md / Section: Intro\n\nbody text"


def test_overlong_breadcrumb_drops_its_deepest_entries(word_tokenizer):
    """Depth is shed from the tail; the document name is never sacrificed."""
    deep = [f"section{i} word word word word word word word" for i in range(20)]
    out = format_chunk_with_header("body", "notes.md", deep, budget_tokens=16)
    header, _, body = out.partition("\n\n")

    assert body == "body"
    assert header.startswith("Document: notes.md")
    assert len(word_tokenizer.encode(header).ids) <= 16
    # Shallow context survives, deep context is what got dropped.
    assert "section0" in header
    assert "section19" not in header


def test_header_is_truncated_even_with_no_section_path(word_tokenizer):
    """A pathological filename alone must not overrun the reservation.

    Measured: a 300-char CJK filename tokenizes to 260 tokens under the bge
    tokenizer — over half the embedder window, from the header alone.
    """
    out = format_chunk_with_header("body", "w " * 500, [], budget_tokens=16)
    header, _, body = out.partition("\n\n")

    assert body == "body"
    assert len(word_tokenizer.encode(header).ids) <= 16
    assert header.startswith("Document: ")


def test_truncation_never_empties_the_document_prefix(word_tokenizer):
    """Even at an absurdly tight budget the header stays structural."""
    out = format_chunk_with_header("body", "w " * 500, [], budget_tokens=2)
    header, _, _ = out.partition("\n\n")
    assert header.startswith("Document:")


def test_bounded_header_plus_body_fits_the_embedder_window(word_tokenizer):
    """The end-to-end invariant, stated as the assertion that matters."""
    body_tokens = em.body_capacity(CHUNK_SIZE_TOKENS, CHUNK_HEADER_BUDGET_TOKENS)
    body = " ".join(f"w{i}" for i in range(body_tokens))
    out = format_chunk_with_header("x " * 400, "n.md", ["a b c"] * 50)
    header, _, _ = out.partition("\n\n")

    header_tokens = len(word_tokenizer.encode(header).ids)
    assert header_tokens <= CHUNK_HEADER_BUDGET_TOKENS
    assert header_tokens + len(body.split()) <= em.spec_for(
        "bge-small-en-v1.5"
    ).max_seq_length


def test_header_falls_back_to_a_char_cap_without_a_tokenizer(monkeypatch):
    """Offline Hub: bound the header by characters instead of tokens.

    WordPiece never emits more than one token per character, so a character
    cap at the token budget can only ever under-spend it. Conservative by
    construction — the degraded path must not be the one that overruns.
    """
    def _boom():
        raise RuntimeError("hub unreachable")

    monkeypatch.setattr(chunker, "_measuring_tokenizer", None)
    monkeypatch.setattr(chunker, "_get_measuring_tokenizer", _boom)

    out = format_chunk_with_header("body", "w" * 5000, [], budget_tokens=32)
    header, _, body = out.partition("\n\n")
    assert body == "body"
    assert len(header) <= 32
    assert header.startswith("Document:")


# ---------------------------------------------------------------------------
# 3. The guard is enforced at runtime, not only in the test suite
# ---------------------------------------------------------------------------


def test_build_splitter_refuses_a_budget_that_overruns_the_window(monkeypatch):
    """Misconfiguration must fail loudly at tokenizer load."""
    monkeypatch.setattr(chunker, "EMBEDDING_MODEL", "all-MiniLM-L6-v2")
    with pytest.raises(em.ChunkBudgetError):
        chunker._build_splitter(512 - CHUNK_HEADER_BUDGET_TOKENS, 89)


def test_budget_error_is_not_swallowed_by_the_word_split_fallback(monkeypatch):
    """`chunk_text` degrades to word-split on network failure — but NOT here.

    A misconfigured budget is not a transient outage. Swallowing it would
    reinstate exactly the silent degradation WARP-2196 exists to end.
    """
    def _boom(capacity, overlap):
        raise em.ChunkBudgetError("budget overrun")

    monkeypatch.setattr(chunker, "_get_splitter", _boom)
    with pytest.raises(em.ChunkBudgetError):
        chunker.chunk_text("some text here", chunk_size=512, overlap_ratio=0.2)


def test_network_failure_still_degrades_to_word_split(monkeypatch):
    """The pre-existing degradation path must survive the new guard."""
    def _boom(capacity, overlap):
        raise RuntimeError("hub unreachable")

    monkeypatch.setattr(chunker, "_get_splitter", _boom)
    chunks = chunker.chunk_text(
        "a b c d e f", chunk_size=8, overlap_ratio=0.2, header_budget=0
    )
    assert chunks and all(c.strip() for c in chunks)


# ---------------------------------------------------------------------------
# 4. The tokenizer repo comes from the registry, not a prefix
# ---------------------------------------------------------------------------


def test_tokenizer_repo_is_resolved_through_the_registry():
    """Pre-WARP-2196 this was `f"sentence-transformers/{EMBEDDING_MODEL}"`."""
    assert chunker._tokenizer_repo() == "BAAI/bge-small-en-v1.5"
