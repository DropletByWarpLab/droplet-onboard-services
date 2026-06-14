"""Local embedding provider using sentence-transformers.

Loaded lazily on first call — the model (~80 MB for MiniLM) is downloaded
once and cached in HuggingFace's default cache dir. Subsequent loads are
instant from disk.

Default model: all-MiniLM-L6-v2 (384 dimensions, CPU-friendly, ~22M params).
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "all-MiniLM-L6-v2"
MAX_BATCH_SIZE = 256  # Cap to prevent OOM on constrained devices

_model_cache: dict[str, object] = {}
_model_lock = threading.Lock()


def _get_model(model_name: str | None = None):
    """Return the SentenceTransformer model, loading it on first call.

    Thread-safe: concurrent cold-start requests block on the lock rather
    than loading the model twice (which would double memory usage on a
    host with limited RAM).
    """
    name = model_name or DEFAULT_MODEL
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

        logger.info("Loading embedding model: %s", name)
        model = SentenceTransformer(name)
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
