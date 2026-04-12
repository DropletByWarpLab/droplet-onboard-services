"""Local embedding provider using sentence-transformers.

Loaded lazily on first call — the model (~80 MB for MiniLM) is downloaded
once and cached in HuggingFace's default cache dir. Subsequent loads are
instant from disk.

Default model: all-MiniLM-L6-v2 (384 dimensions, CPU-friendly, ~22M params).
Override via the `model` field in EmbedRequest for experiments, but keep in
mind the orchestrator's pgvector column is typed to `vector(384)` — switching
models mid-deployment requires re-indexing.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "all-MiniLM-L6-v2"

# Lazy singleton — avoids importing torch at module import time (which
# takes several seconds and blocks the gRPC startup if done eagerly).
_model_cache: dict[str, object] = {}


def _get_model(model_name: str | None = None):
    """Return the SentenceTransformer model, loading it on first call."""
    name = model_name or DEFAULT_MODEL
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
    logger.info("Embedding model loaded: %s (dim=%d)", name, model.get_sentence_embedding_dimension())
    return model


def embed_texts(
    texts: list[str],
    model: Optional[str] = None,
) -> list[list[float]]:
    """Embed a batch of texts and return a list of float vectors.

    Each inner list has `dim` floats where `dim` depends on the model
    (384 for the default MiniLM).
    """
    if not texts:
        return []
    m = _get_model(model)
    # show_progress_bar=False avoids tqdm noise in Docker logs
    embeddings = m.encode(texts, show_progress_bar=False, convert_to_numpy=True)
    return embeddings.tolist()


def embedding_dim(model: Optional[str] = None) -> int:
    """Return the output dimensionality of the loaded model."""
    return _get_model(model).get_sentence_embedding_dimension()
