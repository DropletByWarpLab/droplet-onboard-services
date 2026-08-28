"""WARP-2196 / WARP-2191 — the chunk budget and the embedder window must agree.

THE BUG THIS EXISTS TO PREVENT
------------------------------
`all-MiniLM-L6-v2` declares `max_seq_length = 256`. The chunker has built
512-token chunks since WARP-435. Every full-size chunk therefore had its back
half silently dropped by the embedder before a vector was produced: the text
was in `FileContentChunk.text` (so it rendered in the UI and matched lexically)
but was absent from `FileContentChunk.embedding`, so vector search could never
find it. Nothing in the codebase asserted that the two numbers agreed, which is
why the defect survived WARP-2055's chunking fix and went unnoticed for months.

The contextual header (`Document: … / Section: …`, WARP-435) makes it worse: it
is prepended AFTER splitting, so it consumes window the splitter had already
handed out to body text.

These tests pin the invariant:

    body_capacity + header_budget <= embedder max_seq_length

and they must FAIL for any model whose window is smaller than the chunk budget.
"""
from __future__ import annotations

import pytest

import embedding_models as em
from config import CHUNK_HEADER_BUDGET_TOKENS, CHUNK_SIZE_TOKENS, EMBEDDING_MODEL


# ---------------------------------------------------------------------------
# The registry: explicit model -> HF repo, never string concatenation
# ---------------------------------------------------------------------------


def test_shipped_default_is_bge_small_en_v1_5():
    """The box ships bge-small-en-v1.5 (MIT, 512-token window, 384 dims)."""
    assert EMBEDDING_MODEL == "bge-small-en-v1.5"


def test_repo_org_is_explicit_not_derived_from_the_short_id():
    """bge lives under BAAI/, MiniLM under sentence-transformers/.

    `f"sentence-transformers/{EMBEDDING_MODEL}"` (the pre-WARP-2196 chunker)
    resolves bge to a repo that does not exist. The mapping is data, not a
    prefix, so a future model cannot silently land on the wrong org.
    """
    assert em.tokenizer_repo("bge-small-en-v1.5") == "BAAI/bge-small-en-v1.5"
    assert (
        em.tokenizer_repo("all-MiniLM-L6-v2")
        == "sentence-transformers/all-MiniLM-L6-v2"
    )


def test_unknown_model_is_a_hard_failure_not_a_guessed_repo():
    """An unregistered id must raise, not get a prefix stapled onto it."""
    with pytest.raises(em.UnknownEmbeddingModelError) as exc:
        em.tokenizer_repo("some-model-nobody-registered")
    assert "some-model-nobody-registered" in str(exc.value)


def test_every_registered_model_is_384_dim():
    """`FileContentChunk.embedding` is `vector(384)`; the column is the contract.

    A registered model with a different width would be accepted by the config
    and then rejected by Postgres at INSERT time, per-row, forever.
    """
    for spec in em.EMBEDDING_MODELS.values():
        assert spec.dimensions == 384, spec.model_id


def test_declared_windows_match_the_model_cards():
    """Pinned from each model's `sentence_bert_config.json` on the Hub."""
    assert em.spec_for("bge-small-en-v1.5").max_seq_length == 512
    assert em.spec_for("all-MiniLM-L6-v2").max_seq_length == 256


# ---------------------------------------------------------------------------
# THE GUARD (WARP-2191): chunk budget vs embedder window
# ---------------------------------------------------------------------------


def test_shipped_configuration_fits_the_shipped_embedder_window():
    """The live invariant, evaluated against the real config values.

    Fails the build if anyone raises CHUNK_SIZE_TOKENS, raises the header
    allowance, or points EMBEDDING_MODEL at a narrower model.
    """
    em.assert_chunk_budget_fits(
        model_id=EMBEDDING_MODEL,
        chunk_size=CHUNK_SIZE_TOKENS,
        header_budget=CHUNK_HEADER_BUDGET_TOKENS,
    )

    spec = em.spec_for(EMBEDDING_MODEL)
    body = em.body_capacity(CHUNK_SIZE_TOKENS, CHUNK_HEADER_BUDGET_TOKENS)
    assert body + CHUNK_HEADER_BUDGET_TOKENS <= spec.max_seq_length


def test_guard_rejects_a_model_whose_window_is_smaller_than_the_budget():
    """The WARP-2196 regression itself: 512-token chunks into MiniLM's 256.

    This is the assertion that would have caught the original defect.
    """
    with pytest.raises(em.ChunkBudgetError) as exc:
        em.assert_chunk_budget_fits(
            model_id="all-MiniLM-L6-v2", chunk_size=512, header_budget=64
        )
    msg = str(exc.value)
    assert "all-MiniLM-L6-v2" in msg
    assert "256" in msg


def test_guard_rejects_raising_the_chunk_size_past_the_window():
    """Same invariant approached from the other side — a bigger CHUNK_SIZE."""
    with pytest.raises(em.ChunkBudgetError):
        em.assert_chunk_budget_fits(
            model_id="bge-small-en-v1.5", chunk_size=513, header_budget=64
        )


def test_guard_rejects_a_header_allowance_that_eats_the_whole_window():
    """Reserving >= the chunk size leaves no body capacity at all."""
    with pytest.raises(em.ChunkBudgetError):
        em.assert_chunk_budget_fits(
            model_id="bge-small-en-v1.5", chunk_size=512, header_budget=512
        )


def test_guard_accepts_the_exact_boundary():
    """body + header == max_seq_length is legal; one more token is not."""
    em.assert_chunk_budget_fits(
        model_id="bge-small-en-v1.5", chunk_size=512, header_budget=64
    )


def test_body_capacity_subtracts_the_header_allowance():
    """WARP-2191: the splitter's capacity is the window MINUS the header."""
    assert em.body_capacity(512, 64) == 448


@pytest.mark.network
def test_declared_window_matches_the_hub_artifact():
    """The registry is hand-written; this proves it still matches the Hub.

    Marked `network` — it downloads each model's `sentence_bert_config.json`
    (a few hundred bytes, no weights). Skipped when the Hub is unreachable so
    an offline dev box doesn't see a red suite.
    """
    import json
    import urllib.error
    import urllib.request

    for model_id, spec in em.EMBEDDING_MODELS.items():
        url = (
            f"https://huggingface.co/{spec.hf_repo}"
            "/resolve/main/sentence_bert_config.json"
        )
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                declared = json.loads(r.read())["max_seq_length"]
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            pytest.skip(f"Hub unreachable for {spec.hf_repo}: {e}")
        assert declared == spec.max_seq_length, (
            f"{model_id}: registry says {spec.max_seq_length}, "
            f"{spec.hf_repo} declares {declared}"
        )
