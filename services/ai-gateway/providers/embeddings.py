"""Local embedding provider using sentence-transformers.

Loaded lazily on first call — the model (~130 MB for bge-small) is downloaded
once and cached in HuggingFace's default cache dir. Subsequent loads are
instant from disk.

Default model: bge-small-en-v1.5 (MIT, 384 dimensions, 512-token window,
~33M params, CPU-friendly).

WARP-2196 replaced all-MiniLM-L6-v2. MiniLM's `max_seq_length` is 256 while
the file-indexer builds 512-token chunks, so the back half of every full-size
chunk was dropped before the vector was computed — present in
`FileContentChunk.text`, absent from `FileContentChunk.embedding`. bge-small-
en-v1.5 has a 512-token window and the same 384 dimensions, so the pgvector
column and its index are untouched and only a re-embed is required.

THE MODEL ID IS NOT A REPO PATH. `EmbedRequest.model` carries a short,
org-less id (`bge-small-en-v1.5`). Handing that straight to
`SentenceTransformer` fails: with no org it falls back to
`sentence-transformers/<name>`, and `sentence-transformers/bge-small-en-v1.5`
does not exist. `SUPPORTED_MODELS` maps id -> fully-qualified repo, and it is
also the security boundary — see `repo_for`.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "bge-small-en-v1.5"

# GWV-009 / WARP-2196 — the closed set of embedding models this gateway will
# load, mapping the on-the-wire id to its fully-qualified Hub repo.
#
# This is a SECURITY control before it is a convenience. `SentenceTransformer`
# will fetch any repo id it is handed, so an unmapped caller-supplied string is
# unbounded egress, unbounded disk and unbounded resident memory from a single
# gRPC field.
#
# `all-MiniLM-L6-v2` is deliberately ABSENT rather than retained alongside bge.
# Both models are 384-dimensional, so Postgres accepts vectors from either into
# the same `vector(384)` column without complaint — while cosine distance
# BETWEEN the two spaces is noise. Allowing both would make silent, permanent,
# undetectable corpus poisoning a supported configuration, and the corpus is
# mid-re-embed exactly when that would happen. A stale caller now gets a loud
# INVALID_ARGUMENT and stops writing, which is the outcome we want.
SUPPORTED_MODELS: dict[str, str] = {
    "bge-small-en-v1.5": "BAAI/bge-small-en-v1.5",
}

MAX_BATCH_SIZE = 256  # Cap to prevent OOM on constrained devices

_model_cache: dict[str, object] = {}
_model_lock = threading.Lock()


def repo_for(model_name: str | None) -> str:
    """Resolve a wire model id to its Hub repo, or raise.

    ``None`` and ``""`` (the proto default — "no preference") resolve to
    ``DEFAULT_MODEL``. Anything not in ``SUPPORTED_MODELS`` raises ``ValueError``
    BEFORE any download is attempted.
    """
    name = model_name or DEFAULT_MODEL
    try:
        return SUPPORTED_MODELS[name]
    except KeyError:
        raise ValueError(
            f"Unsupported embedding model {name!r}. "
            f"Supported: {sorted(SUPPORTED_MODELS)}"
        ) from None


def _get_model(model_name: str | None = None):
    """Return the SentenceTransformer model, loading it on first call.

    Thread-safe: concurrent cold-start requests block on the lock rather
    than loading the model twice (which would double memory usage on a
    host with limited RAM).
    """
    name = model_name or DEFAULT_MODEL
    repo = repo_for(name)
    if name in _model_cache:
        return _model_cache[name]

    with _model_lock:
        # Double-check after acquiring the lock — another thread may have loaded it.
        if name in _model_cache:
            return _model_cache[name]

        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as e:
            logger.error(
                "sentence-transformers is not installed. "
                "Add it to requirements.txt and rebuild the ai-gateway image."
            )
            raise RuntimeError("sentence-transformers not available") from e

        logger.info("Loading embedding model: %s (%s)", name, repo)
        model = SentenceTransformer(repo)
        _model_cache[name] = model
        logger.info(
            "Embedding model loaded: %s (dim=%d)",
            name,
            model.get_sentence_embedding_dimension(),
        )
        return model


def embed_texts(
    texts: list[str],
    model: Optional[str] = None,
) -> list[list[float]]:
    """Embed a batch of texts and return a list of float vectors.

    Enforces MAX_BATCH_SIZE to prevent OOM on constrained hardware.
    Larger batches are rejected — the caller should chunk them.
    """
    if not texts:
        return []
    if len(texts) > MAX_BATCH_SIZE:
        raise ValueError(
            f"Batch size {len(texts)} exceeds maximum {MAX_BATCH_SIZE}. "
            "Split into smaller batches."
        )
    # GWV-009: resolve (and therefore validate) the id before anything is
    # loaded. The gRPC handler checks its own allow-list first; this second
    # check keeps the guarantee for any non-RPC caller.
    repo_for(model)
    m = _get_model(model)
    # batch_size=32 caps peak memory per forward pass even within a single call.
    embeddings = m.encode(
        texts,
        show_progress_bar=False,
        convert_to_numpy=True,
        batch_size=32,
    )
    return embeddings.tolist()


def embedding_dim(model: Optional[str] = None) -> int:
    """Return the output dimensionality of the loaded model."""
    return _get_model(model).get_sentence_embedding_dimension()
