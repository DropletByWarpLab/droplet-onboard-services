"""resolve_wake_threshold (main.py) — the engine-aware threshold default.

The defaults differ per engine because the score SEMANTICS differ: Vosk
scores are min-per-word confidences (real acoustic evidence) while
openWakeWord scores are sigmoid outputs. The resolver keys off the
actual detector instance — not the WAKE_ENGINE env string — because
build_detector_from_env has fallbacks (unknown engine → vosk,
vosk-without-model → openWakeWord) that make the env string unreliable.
"""
from __future__ import annotations

import main
from voice.pipeline import DEFAULT_THRESHOLD
from voice.wake import (
    VOSK_DEFAULT_THRESHOLD,
    MockWakeWordDetector,
    VoskWakeWordDetector,
)


class TestResolveWakeThreshold:
    def test_explicit_env_wins_over_any_detector(self, monkeypatch):
        monkeypatch.setenv("WAKE_THRESHOLD", "0.42")
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path="/nonexistent")
        assert main.resolve_wake_threshold(det) == 0.42
        assert main.resolve_wake_threshold(MockWakeWordDetector()) == 0.42

    def test_empty_env_treated_as_unset(self, monkeypatch):
        # Compose passes WAKE_THRESHOLD through as "" when the operator
        # didn't set one — that must select the engine default, not
        # crash float("").
        monkeypatch.setenv("WAKE_THRESHOLD", "  ")
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path="/nonexistent")
        assert main.resolve_wake_threshold(det) == VOSK_DEFAULT_THRESHOLD

    def test_vosk_detector_defaults_to_vosk_threshold(self, monkeypatch):
        monkeypatch.delenv("WAKE_THRESHOLD", raising=False)
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path="/nonexistent")
        assert main.resolve_wake_threshold(det) == VOSK_DEFAULT_THRESHOLD

    def test_non_vosk_detector_defaults_to_generic_threshold(self, monkeypatch):
        # The openWakeWord fallback path (vosk model missing) must keep
        # the sigmoid-score default — a 0.7 gate would mute it entirely.
        monkeypatch.delenv("WAKE_THRESHOLD", raising=False)
        assert (
            main.resolve_wake_threshold(MockWakeWordDetector())
            == DEFAULT_THRESHOLD
        )
