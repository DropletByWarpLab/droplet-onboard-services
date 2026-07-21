"""WARP-1434 — VAD + visual-decay knobs are env-wired into WakePipeline.

Before this ticket main.py never read VAD_SILENCE_S / VAD_SPEECH_RMS /
VAD_MIN_SPEECH_S or WAKE_VISUAL_DECAY_S, so the "tune per-room via
VAD_SPEECH_RMS" comment in pipeline.py was unfollowable and the
visual-decay window was pinned to the constructor default — documented
knobs that did nothing. `resolve_vad_config()` reads all four from env
(tolerating the compose empty-string passthrough) into the exact kwargs
WakePipeline accepts.
"""
from __future__ import annotations

import main
from voice.pipeline import (
    DEFAULT_VAD_MIN_SPEECH_S,
    DEFAULT_VAD_SILENCE_S,
    DEFAULT_VAD_SPEECH_RMS,
    DEFAULT_VISUAL_DECAY_S,
    WakePipeline,
)
from voice.wake import MockWakeWordDetector

_VAD_ENV = ("VAD_SILENCE_S", "VAD_SPEECH_RMS", "VAD_MIN_SPEECH_S", "WAKE_VISUAL_DECAY_S")


def _clear_vad_env(monkeypatch) -> None:
    for k in _VAD_ENV:
        monkeypatch.delenv(k, raising=False)


class TestResolveVadConfig:
    def test_defaults_when_unset(self, monkeypatch):
        _clear_vad_env(monkeypatch)
        cfg = main.resolve_vad_config()
        assert cfg == {
            "vad_silence_s": DEFAULT_VAD_SILENCE_S,
            "vad_speech_rms": DEFAULT_VAD_SPEECH_RMS,
            "vad_min_speech_s": DEFAULT_VAD_MIN_SPEECH_S,
            "visual_decay_s": DEFAULT_VISUAL_DECAY_S,
        }

    def test_env_values_parsed(self, monkeypatch):
        monkeypatch.setenv("VAD_SILENCE_S", "0.4")
        monkeypatch.setenv("VAD_SPEECH_RMS", "850")
        monkeypatch.setenv("VAD_MIN_SPEECH_S", "0.5")
        monkeypatch.setenv("WAKE_VISUAL_DECAY_S", "3.0")
        cfg = main.resolve_vad_config()
        assert cfg["vad_silence_s"] == 0.4
        assert cfg["vad_speech_rms"] == 850.0
        assert cfg["vad_min_speech_s"] == 0.5
        assert cfg["visual_decay_s"] == 3.0

    def test_empty_string_passthrough_falls_back_to_defaults(self, monkeypatch):
        # Compose passes `VAD_SILENCE_S=${VAD_SILENCE_S:-}` → the container
        # sees an empty string; float("") would crash, so empty must select
        # the default (same posture as WAKE_THRESHOLD / VOICE_INPUT_GAIN).
        for k in _VAD_ENV:
            monkeypatch.setenv(k, "")
        cfg = main.resolve_vad_config()
        assert cfg["vad_silence_s"] == DEFAULT_VAD_SILENCE_S
        assert cfg["vad_speech_rms"] == DEFAULT_VAD_SPEECH_RMS
        assert cfg["vad_min_speech_s"] == DEFAULT_VAD_MIN_SPEECH_S
        assert cfg["visual_decay_s"] == DEFAULT_VISUAL_DECAY_S

    def test_whitespace_only_falls_back_to_defaults(self, monkeypatch):
        for k in _VAD_ENV:
            monkeypatch.setenv(k, "   ")
        cfg = main.resolve_vad_config()
        assert cfg["vad_silence_s"] == DEFAULT_VAD_SILENCE_S
        assert cfg["visual_decay_s"] == DEFAULT_VISUAL_DECAY_S

    def test_explicit_zero_is_honored_not_treated_as_empty(self, monkeypatch):
        # "0" is a real value (disable min-speech), NOT the empty passthrough.
        monkeypatch.setenv("VAD_MIN_SPEECH_S", "0")
        assert main.resolve_vad_config()["vad_min_speech_s"] == 0.0


class TestVadConfigReachesWakePipeline:
    """The resolved dict must be keyed EXACTLY as WakePipeline expects, so
    spreading it actually tunes the running pipeline — proving 'parsed +
    passed to WakePipeline' end-to-end with the real class (no mocks)."""

    def test_resolved_values_land_on_the_pipeline(self, monkeypatch):
        monkeypatch.setenv("VAD_SILENCE_S", "0.42")
        monkeypatch.setenv("VAD_SPEECH_RMS", "820")
        monkeypatch.setenv("VAD_MIN_SPEECH_S", "0.33")
        monkeypatch.setenv("WAKE_VISUAL_DECAY_S", "2.5")
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,
            **main.resolve_vad_config(),
        )
        assert pipe._vad_silence_s == 0.42
        assert pipe._vad_speech_rms == 820.0
        assert pipe._vad_min_speech_s == 0.33
        assert pipe._visual_decay_s == 2.5

    def test_visual_decay_env_honored(self, monkeypatch):
        _clear_vad_env(monkeypatch)
        monkeypatch.setenv("WAKE_VISUAL_DECAY_S", "5.0")
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,
            **main.resolve_vad_config(),
        )
        assert pipe._visual_decay_s == 5.0
