"""WARP-437 — Deberta zero-shot query classifier singleton.

Mirrors the lazy-init pattern of `reranker.RerankerSingleton`. Model is
~110 MB int8 ONNX, cached to /var/cache/droplet/models/. First call
pays the load cost; subsequent calls are CPU-bound NLI scoring (~50 ms
on x86_64 / the inference host).

Returns one of QUERY_CLASSES, or "unknown" when top-1 confidence is
below CLASSIFIER_CONFIDENCE_FLOOR (we don't route on noise — CLAUDE.md
"no guessing").
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

CLASSIFIER_MODEL_ID = "MoritzLaurer/deberta-v3-base-zeroshot-v2.0"
CLASSIFIER_CACHE_DIR = Path("/var/cache/droplet/models/query-classifier")

QUERY_CLASSES: Tuple[str, ...] = (
    "factual",
    "analytical",
    "conversational",
    "navigational",
)
# Below this top-1 confidence we return 'unknown' and let the caller use defaults.
CLASSIFIER_CONFIDENCE_FLOOR = 0.40


@dataclass(frozen=True)
class ClassifyResult:
    cls: str
    confidence: float


class QueryClassifierSingleton:
    _instance: Optional["QueryClassifierSingleton"] = None

    def __init__(self) -> None:
        from transformers import pipeline

        CLASSIFIER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        logger.info("Loading query classifier from %s", CLASSIFIER_MODEL_ID)
        self._pipeline = pipeline(
            "zero-shot-classification",
            model=CLASSIFIER_MODEL_ID,
            device=-1,  # CPU
            # WARP-437: explicit cache_dir — relying on HF_HOME would collide
            # with RerankerSingleton's os.environ.setdefault on the same env var.
            model_kwargs={"cache_dir": str(CLASSIFIER_CACHE_DIR)},
        )
        logger.info("Query classifier loaded")

    @classmethod
    def instance(cls) -> "QueryClassifierSingleton":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _run_pipeline(self, query: str) -> dict:
        return self._pipeline(
            query,
            candidate_labels=list(QUERY_CLASSES),
            multi_label=False,
        )

    def classify(self, query: str) -> ClassifyResult:
        if not query or len(query.strip()) < 2:
            return ClassifyResult(cls="unknown", confidence=0.0)
        out = self._run_pipeline(query)
        top_label = out["labels"][0]
        top_score = float(out["scores"][0])
        if top_score < CLASSIFIER_CONFIDENCE_FLOOR:
            return ClassifyResult(cls="unknown", confidence=top_score)
        return ClassifyResult(cls=top_label, confidence=top_score)
