"""WARP-286 / WARP-644 — BGE-reranker-base singleton.

Loads the model lazily on first use. Cached on disk at
`/var/cache/droplet/models/bge-reranker-base/` so subsequent
container starts skip the model download.

Inference runs via optimum.onnxruntime on CPU. Future tickets may
add a TensorRT backend for inference-host GPU acceleration.

WARP-644: init now fails closed. If the optimum/onnxruntime import or the
model load raises, the singleton stays unavailable and `compute_score`
returns empty scores instead of crashing the gRPC handler. The failure is
logged once at WARNING so an inoperable reranker is a visible-but-graceful
degrade (the orchestrator falls back to unranked retrieval) rather than a
500 on every Rerank call.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

# Model identifier on Hugging Face.
#
# WARP-644: BAAI/bge-reranker-base ships its ONNX graph at `onnx/model.onnx`
# (there is no top-level `model_quantized.onnx` — the older code's assumption
# was stale and was the second half of the import/load failure). optimum 2.x
# resolves it via subfolder + file_name below.
RERANKER_MODEL_ID = "BAAI/bge-reranker-base"
RERANKER_MODEL_SUBFOLDER = "onnx"
RERANKER_MODEL_FILE = "model.onnx"
RERANKER_CACHE_DIR = Path("/var/cache/droplet/models/bge-reranker-base")

# Hard caps used by the gRPC handler + this module. Documented as named
# constants per CLAUDE.md no-guessing rule.
#   - RERANKER_MAX_LENGTH: BGE-reranker-base's tokenizer max_length.
#     Anything longer gets truncated.
#   - RERANKER_BATCH_SIZE: forward-pass batch size. 8 keeps memory
#     bounded on CPU while still saturating fp32 throughput on x86_64
#     / the inference host.
RERANKER_MAX_LENGTH = 512
RERANKER_BATCH_SIZE = 8


class RerankerUnavailable(RuntimeError):
    """Raised when the reranker model could not be imported or loaded.

    The gRPC handler treats this as a graceful degrade (returns empty
    scores) rather than a 500 — the orchestrator falls back to unranked
    retrieval.
    """


class RerankerSingleton:
    """Lazy-init singleton; not thread-safe at first init but the async
    gRPC server serializes Rerank calls through one Python interpreter
    so this is fine — first concurrent request wins the init race and
    blocks the others on the import path's GIL hold.
    """

    _instance: Optional["RerankerSingleton"] = None
    # WARP-644: remembers a failed init so we don't re-attempt (and re-log)
    # the heavy import/load on every Rerank call once it's known-broken.
    # Intentionally never reset at runtime — a fixed optimum/onnxruntime
    # install requires a container restart to recover (correct for a
    # process-lifetime singleton cache).
    _unavailable_reason: Optional[str] = None

    def __init__(self) -> None:
        # Import inside __init__ so an environment with a broken optimum /
        # onnxruntime install surfaces as RerankerUnavailable rather than an
        # ImportError at module import time (which would take down the whole
        # gRPC server). optimum masks the real cause as "Could not import
        # module 'ORTModelForSequenceClassification'"; see WARP-644.
        try:
            from optimum.onnxruntime import ORTModelForSequenceClassification
            from transformers import AutoTokenizer
        except Exception as e:  # noqa: BLE001 — surface any import failure
            raise RerankerUnavailable(
                f"optimum/onnxruntime import failed: {e!r}"
            ) from e

        try:
            RERANKER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            os.environ.setdefault("HF_HOME", str(RERANKER_CACHE_DIR))
            logger.info("Loading BGE-reranker-base from %s", RERANKER_CACHE_DIR)
            self._tokenizer = AutoTokenizer.from_pretrained(
                RERANKER_MODEL_ID, cache_dir=RERANKER_CACHE_DIR
            )
            self._model = ORTModelForSequenceClassification.from_pretrained(
                RERANKER_MODEL_ID,
                cache_dir=RERANKER_CACHE_DIR,
                subfolder=RERANKER_MODEL_SUBFOLDER,
                file_name=RERANKER_MODEL_FILE,
            )
        except Exception as e:  # noqa: BLE001 — download/load failure
            raise RerankerUnavailable(
                f"BGE-reranker-base load failed: {e!r}"
            ) from e
        logger.info("Reranker model loaded")

    @classmethod
    def instance(cls) -> "RerankerSingleton":
        """Return the loaded singleton, or raise RerankerUnavailable.

        A previous failed init is remembered (`_unavailable_reason`) so we
        don't re-attempt the expensive import/load on every call; the cause
        is logged once at WARNING on first failure.
        """
        if cls._unavailable_reason is not None:
            raise RerankerUnavailable(cls._unavailable_reason)
        if cls._instance is None:
            try:
                cls._instance = cls()
            except RerankerUnavailable as e:
                cls._unavailable_reason = str(e)
                logger.warning(
                    "Reranker unavailable; Rerank calls will return empty "
                    "scores (orchestrator falls back to unranked retrieval): %s",
                    e,
                )
                raise
        return cls._instance

    @classmethod
    def available(cls) -> bool:
        """Best-effort startup self-check: attempt to load the model and
        report whether the reranker is usable. Logs once at WARNING on
        failure (via `instance()`). Safe to call at server startup to make
        an inoperable reranker visible before the first request."""
        try:
            cls.instance()
            return True
        except RerankerUnavailable:
            return False

    def compute_score(
        self,
        pairs: List[List[str]],
        batch_size: int = RERANKER_BATCH_SIZE,
    ) -> List[float]:
        """Return one score per (query, passage) pair. Higher is more relevant."""
        if not pairs:
            return []
        scores: List[float] = []
        for i in range(0, len(pairs), batch_size):
            batch = pairs[i : i + batch_size]
            inputs = self._tokenizer(
                [p[0] for p in batch],
                [p[1] for p in batch],
                padding=True,
                truncation=True,
                max_length=RERANKER_MAX_LENGTH,
                return_tensors="np",
            )
            outputs = self._model(**inputs)
            scores.extend([float(s) for s in outputs.logits.reshape(-1)])
        return scores
