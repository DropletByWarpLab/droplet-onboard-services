"""WARP-286 — BGE-reranker-base singleton.

Loads the model lazily on first use. Cached on disk at
`/var/cache/droplet/models/bge-reranker-base/` so subsequent
container starts skip the ~280 MB download.

Inference runs via optimum.onnxruntime on CPU. Future tickets may
add a TensorRT backend for Jetson GPU acceleration.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

# Model identifier on Hugging Face. The int8 ONNX weights are published
# under `model_quantized.onnx` in the same repo as the fp32 PyTorch
# weights — `optimum.onnxruntime` picks the file via `file_name`.
RERANKER_MODEL_ID = "BAAI/bge-reranker-base"
RERANKER_CACHE_DIR = Path("/var/cache/droplet/models/bge-reranker-base")

# Hard caps used by the gRPC handler + this module. Documented as named
# constants per CLAUDE.md no-guessing rule.
#   - RERANKER_MAX_LENGTH: BGE-reranker-base's tokenizer max_length.
#     Anything longer gets truncated.
#   - RERANKER_BATCH_SIZE: forward-pass batch size. 8 keeps memory
#     bounded on CPU while still saturating int8 throughput on x86_64
#     / the inference host.
RERANKER_MAX_LENGTH = 512
RERANKER_BATCH_SIZE = 8


class RerankerSingleton:
    """Lazy-init singleton; not thread-safe at first init but the async
    gRPC server serializes Rerank calls through one Python interpreter
    so this is fine — first concurrent request wins the init race and
    blocks the others on the import path's GIL hold.
    """

    _instance: Optional["RerankerSingleton"] = None

    def __init__(self) -> None:
        from optimum.onnxruntime import ORTModelForSequenceClassification
        from transformers import AutoTokenizer

        RERANKER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(RERANKER_CACHE_DIR))
        logger.info("Loading BGE-reranker-base from %s", RERANKER_CACHE_DIR)
        self._tokenizer = AutoTokenizer.from_pretrained(
            RERANKER_MODEL_ID, cache_dir=RERANKER_CACHE_DIR
        )
        self._model = ORTModelForSequenceClassification.from_pretrained(
            RERANKER_MODEL_ID,
            cache_dir=RERANKER_CACHE_DIR,
            file_name="model_quantized.onnx",
        )
        logger.info("Reranker model loaded")

    @classmethod
    def instance(cls) -> "RerankerSingleton":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

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
