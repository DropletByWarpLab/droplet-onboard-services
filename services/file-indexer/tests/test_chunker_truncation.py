"""The measuring tokenizer must report true token counts.

semantic-text-splitter sizes a candidate chunk by asking the tokenizer how
many tokens it holds. `tokenizer.json` for all-MiniLM-L6-v2 ships
`truncation.max_length = 128`, so an un-neutered tokenizer answers "128" for
any input of any length — the splitter concludes everything fits inside
`capacity` and never splits. Chunking silently degrades to one chunk per
Span, and every token past the embedder's window becomes unreachable.

These tests are marked `network` only where they need the real Hub artifact;
the contract test below fakes it so it runs everywhere.
"""
from __future__ import annotations

import pytest

import chunker
from config import CHUNK_HEADER_BUDGET_TOKENS, CHUNK_OVERLAP_RATIO, CHUNK_SIZE_TOKENS

# WARP-2191: `_build_splitter` takes the BODY capacity, which is the whole
# per-chunk budget minus the reservation the contextual header is paid out of.
# Passing the full CHUNK_SIZE_TOKENS here would describe a chunk of
# CHUNK_SIZE_TOKENS + header that overruns the embedder window — and the guard
# in `_build_splitter` now rejects exactly that.
_BODY_CAPACITY = CHUNK_SIZE_TOKENS - CHUNK_HEADER_BUDGET_TOKENS
_OVERLAP = int(_BODY_CAPACITY * CHUNK_OVERLAP_RATIO)


class _FakeEncoding:
    def __init__(self, n):
        self.ids = list(range(n))


class _TruncatingTokenizer:
    """Mimics the shipped tokenizer: caps every count at max_length."""

    def __init__(self, max_length=128):
        self.truncation = {"max_length": max_length}
        self.max_length = max_length
        # Starts SET, not None. A fake that begins unpadded would let
        # `test_padding_is_disabled_on_the_measuring_tokenizer` pass whether or
        # not `no_padding()` is ever called — a test that cannot fail.
        self.padding = {"strategy": "BatchLongest"}

    def encode(self, text, *a, **kw):
        # 1 token per whitespace word, capped while truncation is active.
        n = len(text.split())
        if self.truncation is not None:
            n = min(n, self.max_length)
        return _FakeEncoding(n)

    def no_truncation(self):
        self.truncation = None

    def no_padding(self):
        self.padding = None


@pytest.fixture
def captured(monkeypatch):
    """Capture the tokenizer handed to TextSplitter by _build_splitter."""
    seen = {}
    fake_tokenizer = _TruncatingTokenizer()

    class _FakeTokenizerClass:
        @staticmethod
        def from_pretrained(repo):
            seen["repo"] = repo
            return fake_tokenizer

    class _FakeSplitter:
        @staticmethod
        def from_huggingface_tokenizer(tokenizer, capacity, overlap):
            seen["tokenizer"] = tokenizer
            seen["capacity"] = capacity
            return object()

    import sys
    import types

    sts = types.ModuleType("semantic_text_splitter")
    sts.TextSplitter = _FakeSplitter
    toks = types.ModuleType("tokenizers")
    toks.Tokenizer = _FakeTokenizerClass
    monkeypatch.setitem(sys.modules, "semantic_text_splitter", sts)
    monkeypatch.setitem(sys.modules, "tokenizers", toks)

    # The splitter is memoised at module level; clear it so _build_splitter runs.
    # WARP-2191 moved the measuring tokenizer into its own module-level cache
    # (it is now shared with the header sizer), so that has to be cleared too —
    # otherwise the second test in this module reuses the FIRST test's fake and
    # never exercises `no_truncation()` on its own.
    monkeypatch.setattr(chunker, "_measuring_tokenizer", None)
    monkeypatch.setattr(chunker, "_splitter", None)
    monkeypatch.setattr(chunker, "_splitter_capacity", None)
    monkeypatch.setattr(chunker, "_splitter_overlap", None)
    return seen, fake_tokenizer


def test_truncation_is_disabled_on_the_measuring_tokenizer(captured):
    seen, tokenizer = captured

    chunker._build_splitter(_BODY_CAPACITY, _OVERLAP)

    assert seen["tokenizer"] is tokenizer
    assert tokenizer.truncation is None, (
        "truncation left active — the splitter would measure every chunk as "
        "<= max_length and never split"
    )


def test_padding_is_disabled_on_the_measuring_tokenizer(captured):
    """Sibling of the truncation assertion above.

    Lower impact than truncation — padding inflates rather than deflates, and
    only for batched input, so a single-sequence `encode()` is unaffected in
    practice. But `_get_measuring_tokenizer` calls both and only one was
    defended, so the untested call was free to be dropped by a future edit.
    """
    _seen, tokenizer = captured

    chunker._build_splitter(_BODY_CAPACITY, _OVERLAP)

    assert tokenizer.padding is None


def test_a_long_text_measures_past_the_truncation_cap(captured):
    _seen, tokenizer = captured

    chunker._build_splitter(_BODY_CAPACITY, _OVERLAP)

    long_text = " ".join(f"w{i}" for i in range(5000))
    assert len(tokenizer.encode(long_text).ids) == 5000


@pytest.mark.skipif(
    not pytest.importorskip(
        "semantic_text_splitter", reason="splitter not installed"
    ),
    reason="needs the real splitter",
)
def test_real_splitter_splits_a_long_document():
    """End-to-end against the real tokenizer + splitter (needs the HF cache)."""
    pytest.importorskip("tokenizers")

    text = ("The quick brown fox jumps over the lazy dog. " * 2000).strip()
    chunks = chunker.chunk_text(text, chunk_size=512, overlap_ratio=0.2)

    assert len(chunks) > 10, f"expected many chunks, got {len(chunks)}"
    assert max(len(c) for c in chunks) < len(text) / 5
