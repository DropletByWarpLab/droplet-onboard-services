"""Registry of the embedding models this service knows how to use.

WARP-2196. Two things used to be implicit, and both were wrong in a way that
failed silently:

1. **The Hub org.** ``chunker.py`` built its tokenizer repo as
   ``f"sentence-transformers/{EMBEDDING_MODEL}"``. That is true for MiniLM and
   false for ``bge-small-en-v1.5``, which lives under ``BAAI/``. A prefix is
   not a mapping — the moment the default model changed, the string quietly
   pointed at a repo that does not exist. Here the org is DATA, and an
   unregistered id raises instead of getting a prefix stapled to it.

2. **The embedder's context window.** ``all-MiniLM-L6-v2`` declares
   ``max_seq_length = 256`` (``sentence_bert_config.json``), while the chunker
   has produced 512-token chunks since WARP-435. The embedder truncated every
   full-size chunk at 256 tokens, so the back half of each one was present in
   ``FileContentChunk.text`` — it rendered in the UI, it matched lexically —
   but absent from ``FileContentChunk.embedding``. Vector search could not
   reach it. Nothing asserted that the chunk budget and the embedder window
   agreed, which is exactly why the defect outlived WARP-2055's chunking fix.
   ``assert_chunk_budget_fits`` is that assertion, and ``_build_splitter``
   calls it, so a misconfigured box fails loudly at tokenizer load rather than
   embedding half-chunks for months.

Both registered models emit 384 dimensions, which is why WARP-2196 is a
re-embed rather than a migration: ``FileContentChunk.embedding`` stays
``vector(384)`` and its index is untouched. That dimensional coincidence is
also the hazard — MiniLM and bge vectors live in *different* spaces, so cosine
distance between them is noise that Postgres will happily compute. See
``docs/RAG_RE_EMBED_RUNBOOK.md``.
"""
from __future__ import annotations

from dataclasses import dataclass


class UnknownEmbeddingModelError(ValueError):
    """Raised for a model id that is not in ``EMBEDDING_MODELS``.

    Deliberately fatal. The alternative — guessing a Hub repo from the id —
    is what WARP-2196 came here to delete.
    """


class ChunkBudgetError(ValueError):
    """Raised when the chunk budget does not fit the embedder's window.

    Fatal for the same reason: the failure mode it replaces is a silent
    truncation that produces vectors covering only part of each chunk.
    """


@dataclass(frozen=True)
class EmbeddingModelSpec:
    """Everything about a model that this service has to agree with."""

    #: The id carried on the wire (``EmbedRequest.model``) and in
    #: ``EMBEDDING_MODEL``. Short, org-less, stable.
    model_id: str
    #: Fully-qualified HuggingFace repo. The org is NOT derivable from
    #: ``model_id`` — that assumption is the bug this registry replaces.
    hf_repo: str
    #: ``max_seq_length`` from the repo's ``sentence_bert_config.json``.
    #: Tokens past this are dropped by the embedder before pooling.
    max_seq_length: int
    #: Output width. Must equal ``FileContentChunk.embedding``'s ``vector(N)``.
    dimensions: int
    #: SPDX id. Permissive licences only — the appliance ships the weights.
    license: str


EMBEDDING_MODELS: dict[str, EmbeddingModelSpec] = {
    # WARP-2196 default. MIT, 512-token window (matches CHUNK_SIZE_TOKENS),
    # 384 dims (matches the existing pgvector column).
    "bge-small-en-v1.5": EmbeddingModelSpec(
        model_id="bge-small-en-v1.5",
        hf_repo="BAAI/bge-small-en-v1.5",
        max_seq_length=512,
        dimensions=384,
        license="MIT",
    ),
    # The pre-WARP-2196 default. Retained here — and ONLY here — so the guard
    # test can prove it is rejected by the budget check, and so an operator who
    # pins the old id in .env gets a named error naming the 256-token window
    # instead of a Hub 404. It is NOT in the ai-gateway's EmbedText allow-list:
    # writing MiniLM vectors into a column being filled with bge vectors is
    # undetectable corruption (same width, different space).
    "all-MiniLM-L6-v2": EmbeddingModelSpec(
        model_id="all-MiniLM-L6-v2",
        hf_repo="sentence-transformers/all-MiniLM-L6-v2",
        max_seq_length=256,
        dimensions=384,
        license="Apache-2.0",
    ),
}


def spec_for(model_id: str) -> EmbeddingModelSpec:
    """Look up ``model_id``. Raises ``UnknownEmbeddingModelError`` if absent."""
    try:
        return EMBEDDING_MODELS[model_id]
    except KeyError:
        raise UnknownEmbeddingModelError(
            f"Unknown embedding model {model_id!r}. "
            f"Registered: {sorted(EMBEDDING_MODELS)}. "
            "Add an EmbeddingModelSpec (repo, window, dimensions, licence) "
            "rather than relying on a name prefix."
        ) from None


def tokenizer_repo(model_id: str) -> str:
    """Fully-qualified Hub repo for ``model_id``'s tokenizer.

    The tokenizer ships in the same repo as the weights, so this is just the
    model repo — but callers read better naming what they want it for.
    """
    return spec_for(model_id).hf_repo


def body_capacity(chunk_size: int, header_budget: int) -> int:
    """Tokens the splitter may spend on BODY text.

    WARP-2191: ``format_chunk_with_header`` prepends the contextual header
    AFTER splitting, so the header spends window the splitter already handed
    out. Reserving it up-front is the fix — ``chunk_size`` is the whole
    embedder budget, and the splitter only ever gets what is left.
    """
    return chunk_size - header_budget


def assert_chunk_budget_fits(
    *, model_id: str, chunk_size: int, header_budget: int
) -> None:
    """Assert body + header fits the embedder's declared window.

    THE WARP-2191 GUARD. Raises ``ChunkBudgetError`` when a chunk built to
    ``chunk_size`` (body + reserved header) would be truncated by the embedder
    named by ``model_id``.

    Raises ``UnknownEmbeddingModelError`` for an unregistered model — an
    unknown window cannot be reasoned about, so it is not silently allowed.
    """
    spec = spec_for(model_id)

    if header_budget < 0:
        raise ChunkBudgetError(
            f"Header allowance must be >= 0, got {header_budget}."
        )
    body = body_capacity(chunk_size, header_budget)
    if body < 1:
        raise ChunkBudgetError(
            f"Header allowance {header_budget} leaves no body capacity in a "
            f"{chunk_size}-token budget (body would be {body}). Lower "
            "CHUNK_HEADER_BUDGET_TOKENS or raise CHUNK_SIZE_TOKENS."
        )
    total = body + header_budget
    if total > spec.max_seq_length:
        raise ChunkBudgetError(
            f"Chunk budget overruns the embedder window: body {body} + header "
            f"{header_budget} = {total} tokens, but {spec.model_id} "
            f"({spec.hf_repo}) declares max_seq_length={spec.max_seq_length}. "
            f"Everything past token {spec.max_seq_length} of each chunk would "
            "be absent from its vector while still present in "
            "FileContentChunk.text — searchable lexically, invisible to vector "
            "search. Lower CHUNK_SIZE_TOKENS or pick a model with a wider "
            "window."
        )
