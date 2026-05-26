"""Unit tests for QueryClassifierSingleton (WARP-437)."""
import os

import pytest

from query_classifier import (
    QueryClassifierSingleton,
    QUERY_CLASSES,
    CLASSIFIER_CONFIDENCE_FLOOR,
)


@pytest.mark.skipif(
    not os.environ.get("HF_HUB_ONLINE"),
    reason="Requires HF Hub connectivity to download the deberta model (~110 MB). "
           "Set HF_HUB_ONLINE=1 to run in CI.",
)
def test_classifier_returns_known_class():
    c = QueryClassifierSingleton.instance()
    result = c.classify("What is the capital of France?")
    assert result.cls in QUERY_CLASSES
    assert 0.0 <= result.confidence <= 1.0


def test_classifier_returns_unknown_below_floor(monkeypatch):
    """When the top-1 score falls below CLASSIFIER_CONFIDENCE_FLOOR,
    we return 'unknown' rather than guessing."""
    # Build an instance without invoking __init__ (avoids the HF model load).
    c = QueryClassifierSingleton.__new__(QueryClassifierSingleton)
    # Simulate a low-confidence return from the underlying pipeline.
    monkeypatch.setattr(
        c, "_run_pipeline",
        lambda q: {"labels": ["factual"], "scores": [CLASSIFIER_CONFIDENCE_FLOOR - 0.01]},
    )
    result = c.classify("a real query string")
    assert result.cls == "unknown"
    assert result.confidence == pytest.approx(CLASSIFIER_CONFIDENCE_FLOOR - 0.01)
