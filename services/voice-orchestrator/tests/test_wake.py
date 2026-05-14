"""WARP-154 — wake-word detector contract + factory.

The contract these tests pin:

  - MockWakeWordDetector replays scripted scores in order, then
    returns a steady 0.0 once exhausted.
  - DisabledWakeWordDetector is loaded=False and predict() returns {};
    the pipeline can run against it without crashing.
  - OpenWakeWordDetector lazy-loads — construction never imports
    openwakeword, the first predict() does. When the import fails
    (no wheel, no model file) the detector stays loaded=False and
    predict() returns {} rather than raising.
  - build_detector_from_env honours WAKE_WORD=__mock__ as the
    "force mock" lever; anything else routes to OpenWakeWordDetector.

OpenWakeWord's real ONNX inference is NOT tested here — that's
integration territory (needs the model bytes + onnxruntime). We pin
the lazy-load + error-isolation contract instead.
"""
from __future__ import annotations

import numpy as np

from voice.wake import (
    WAKE_FRAME_SAMPLES,
    DisabledWakeWordDetector,
    MockWakeWordDetector,
    OpenWakeWordDetector,
    WakeEvent,
    build_detector_from_env,
)


# Test fixture: a single 80 ms frame of silence (the shape every
# detector expects regardless of backend).
def _silence_frame() -> np.ndarray:
    return np.zeros(WAKE_FRAME_SAMPLES, dtype=np.int16)


# ────────────────────────────────────────────────────────────────────
# WakeEvent
# ────────────────────────────────────────────────────────────────────

class TestWakeEvent:
    def test_is_frozen_dataclass(self):
        # WakeEvents are passed across thread boundaries — freezing them
        # documents that callbacks shouldn't mutate the event.
        evt = WakeEvent(model_name="hey_jarvis", score=0.87, detected_at=1234.5)
        try:
            evt.score = 0.0  # type: ignore[misc]
        except Exception:
            return  # frozen — expected
        assert False, "WakeEvent should be frozen"


# ────────────────────────────────────────────────────────────────────
# MockWakeWordDetector
# ────────────────────────────────────────────────────────────────────

class TestMockWakeWordDetector:
    def test_loaded_is_true(self):
        # The mock never has a loading phase — it's always ready.
        assert MockWakeWordDetector().loaded is True

    def test_default_model_name(self):
        assert MockWakeWordDetector().model_name == "mock_wake"

    def test_custom_model_name(self):
        assert MockWakeWordDetector(model_name="hey_droplet").model_name == "hey_droplet"

    def test_replays_scripted_scores_in_order(self):
        # The mock is the "press the button to wake" shim — tests
        # construct it with a sequence of scores to walk the pipeline
        # through wake / no-wake transitions deterministically.
        mock = MockWakeWordDetector(
            scripted_scores=[
                {"hey_jarvis": 0.1},
                {"hey_jarvis": 0.8},   # wake!
                {"hey_jarvis": 0.2},
            ],
        )
        assert mock.predict(_silence_frame()) == {"hey_jarvis": 0.1}
        assert mock.predict(_silence_frame()) == {"hey_jarvis": 0.8}
        assert mock.predict(_silence_frame()) == {"hey_jarvis": 0.2}

    def test_returns_zero_score_after_script_exhausted(self):
        # Once the test's script ends, the pipeline should see a steady
        # "nothing detected" signal — not a crash, not an exception.
        mock = MockWakeWordDetector(
            model_name="hey_droplet",
            scripted_scores=[{"hey_droplet": 0.9}],
        )
        mock.predict(_silence_frame())  # consume the one entry
        for _ in range(3):
            assert mock.predict(_silence_frame()) == {"hey_droplet": 0.0}

    def test_no_scripted_scores_returns_zero_immediately(self):
        # Constructed without a script — useful as a "wake-word
        # disabled but loaded" stand-in in dev mode.
        mock = MockWakeWordDetector()
        assert mock.predict(_silence_frame()) == {"mock_wake": 0.0}


# ────────────────────────────────────────────────────────────────────
# DisabledWakeWordDetector
# ────────────────────────────────────────────────────────────────────

class TestDisabledWakeWordDetector:
    def test_loaded_is_false(self):
        # The dashboard surfaces "Voice assistant is degraded" off this.
        assert DisabledWakeWordDetector().loaded is False

    def test_model_name_is_disabled(self):
        assert DisabledWakeWordDetector().model_name == "disabled"

    def test_predict_returns_empty_dict(self):
        # Empty dict is the "no models scored" signal the pipeline
        # already handles — disabled is just the permanent case of it.
        assert DisabledWakeWordDetector().predict(_silence_frame()) == {}


# ────────────────────────────────────────────────────────────────────
# OpenWakeWordDetector
# ────────────────────────────────────────────────────────────────────

class TestOpenWakeWordDetector:
    def test_construction_never_imports_openwakeword(self, monkeypatch):
        # Lazy-load contract: building the detector must NOT touch the
        # openwakeword module. The pipeline's startup() constructs the
        # detector synchronously on the FastAPI event loop — pulling in
        # ONNX runtimes there would block /health for ~1 s.
        import sys
        before = "openwakeword.model" in sys.modules
        OpenWakeWordDetector(wake_word="hey_jarvis", models_dir="/nonexistent")
        after = "openwakeword.model" in sys.modules
        # We don't require the module to be absent (CI may have it
        # cached from a previous import) — we just require we didn't
        # import it ourselves. Loosest sound check: nothing newly added.
        assert before == after

    def test_predict_returns_empty_when_load_fails(self, monkeypatch):
        # When openwakeword isn't installed (the dev-box case), the
        # detector must NOT raise from predict() — the pipeline catches
        # exceptions into the 'error' state, but more usefully a
        # graceful return-empty leaves the loop running so /audio
        # endpoints keep working.
        import builtins
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name.startswith("openwakeword"):
                raise ImportError("openwakeword not installed (test stub)")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        det = OpenWakeWordDetector(wake_word="hey_jarvis", models_dir="/nonexistent")
        assert det.predict(_silence_frame()) == {}
        assert det.loaded is False

    def test_predict_does_not_retry_after_load_failure(self, monkeypatch):
        # Trying to import openwakeword on every predict() would spam
        # ~80 ImportErrors per second. The _load_attempted flag pins
        # one-shot semantics.
        import builtins
        call_count = {"n": 0}
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name.startswith("openwakeword"):
                call_count["n"] += 1
                raise ImportError("openwakeword not installed (test stub)")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        det = OpenWakeWordDetector(wake_word="hey_jarvis", models_dir="/nonexistent")
        for _ in range(5):
            det.predict(_silence_frame())
        assert call_count["n"] == 1, "openwakeword import retried — _load_attempted broken"

    def test_model_name_reflects_wake_word(self):
        det = OpenWakeWordDetector(wake_word="hey_droplet")
        assert det.model_name == "hey_droplet"


# ────────────────────────────────────────────────────────────────────
# build_detector_from_env
# ────────────────────────────────────────────────────────────────────

class TestBuildDetectorFromEnv:
    def test_default_is_openwakeword(self, monkeypatch):
        monkeypatch.delenv("WAKE_WORD", raising=False)
        det = build_detector_from_env()
        assert isinstance(det, OpenWakeWordDetector)
        assert det.model_name == "hey_jarvis"

    def test_mock_when_wake_word_is_double_underscore_mock(self, monkeypatch):
        monkeypatch.setenv("WAKE_WORD", "__mock__")
        det = build_detector_from_env()
        assert isinstance(det, MockWakeWordDetector)

    def test_custom_wake_word_routes_to_openwakeword(self, monkeypatch):
        # "Hey Droplet" once Stefan ships the trained model.
        monkeypatch.setenv("WAKE_WORD", "hey_droplet")
        det = build_detector_from_env()
        assert isinstance(det, OpenWakeWordDetector)
        assert det.model_name == "hey_droplet"

    def test_whitespace_stripped(self, monkeypatch):
        # Env vars from systemd units / docker-compose often arrive
        # with trailing newlines. Strip them defensively.
        monkeypatch.setenv("WAKE_WORD", "  hey_droplet  \n")
        det = build_detector_from_env()
        assert det.model_name == "hey_droplet"
