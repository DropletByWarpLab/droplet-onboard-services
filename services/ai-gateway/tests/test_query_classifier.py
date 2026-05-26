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


def test_classifier_short_circuits_empty_query():
    """Empty / whitespace-only / single-char queries return ('unknown', 0.0)
    without touching the underlying pipeline. We assert by ensuring no
    pipeline call happens."""
    c = QueryClassifierSingleton.__new__(QueryClassifierSingleton)
    called = []
    c._run_pipeline = lambda q: called.append(q)  # type: ignore[attr-defined]

    for empty in ["", "   ", "\t\n", "a"]:
        result = c.classify(empty)
        assert result.cls == "unknown"
        assert result.confidence == 0.0
    assert called == [], "pipeline should never run for short queries"


def test_classifier_at_threshold_is_accepted(monkeypatch):
    """Boundary case: confidence == CLASSIFIER_CONFIDENCE_FLOOR returns the
    label (the floor is an exclusive lower bound; `<` rather than `<=`)."""
    c = QueryClassifierSingleton.__new__(QueryClassifierSingleton)
    monkeypatch.setattr(
        c, "_run_pipeline",
        lambda q: {
            "labels": ["analytical"],
            "scores": [CLASSIFIER_CONFIDENCE_FLOOR],
        },
    )
    result = c.classify("query at the floor")
    assert result.cls == "analytical"
    assert result.confidence == pytest.approx(CLASSIFIER_CONFIDENCE_FLOOR)


def test_classifier_picks_top_label(monkeypatch):
    """The pipeline returns labels sorted descending; classify() must
    return labels[0], not iterate."""
    c = QueryClassifierSingleton.__new__(QueryClassifierSingleton)
    monkeypatch.setattr(
        c, "_run_pipeline",
        lambda q: {
            "labels": ["navigational", "factual", "analytical", "conversational"],
            "scores": [0.62, 0.20, 0.10, 0.08],
        },
    )
    result = c.classify("open camera-1 settings")
    assert result.cls == "navigational"
    assert result.confidence == pytest.approx(0.62)
