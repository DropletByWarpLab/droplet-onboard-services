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

import json

import numpy as np

from voice.pipeline import DEFAULT_THRESHOLD
from voice.wake import (
    VOSK_DEFAULT_THRESHOLD,
    WAKE_FRAME_SAMPLES,
    DisabledWakeWordDetector,
    MockWakeWordDetector,
    OpenWakeWordDetector,
    VoskWakeWordDetector,
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
    def test_default_is_hey_droplet(self, monkeypatch):
        # Branded wake word as the default. The actual model load
        # falls back to a bundled openwakeword model at runtime if the
        # trained .onnx isn't on disk yet — that's tested in
        # TestFallback below.
        monkeypatch.delenv("WAKE_WORD", raising=False)
        det = build_detector_from_env()
        assert isinstance(det, OpenWakeWordDetector)
        assert det.requested_wake_word == "hey_droplet"

    def test_mock_when_wake_word_is_double_underscore_mock(self, monkeypatch):
        monkeypatch.setenv("WAKE_WORD", "__mock__")
        det = build_detector_from_env()
        assert isinstance(det, MockWakeWordDetector)

    def test_custom_wake_word_propagates(self, monkeypatch):
        monkeypatch.setenv("WAKE_WORD", "my_custom_word")
        det = build_detector_from_env()
        assert isinstance(det, OpenWakeWordDetector)
        assert det.requested_wake_word == "my_custom_word"

    def test_whitespace_stripped(self, monkeypatch):
        # Env vars from systemd units / docker-compose often arrive
        # with trailing newlines. Strip them defensively.
        monkeypatch.setenv("WAKE_WORD", "  hey_droplet  \n")
        det = build_detector_from_env()
        assert det.requested_wake_word == "hey_droplet"


# ────────────────────────────────────────────────────────────────────
# Wake-word fallback — when WAKE_WORD has no on-disk .onnx + isn't bundled
# ────────────────────────────────────────────────────────────────────

class TestFallback:
    """The branded default 'hey_droplet' has no openwakeword bundled
    model AND no .onnx on disk until training data lands. The detector
    must NOT crash — it falls back to a bundled model so wake stays
    armed, and surfaces that via `using_fallback`.
    """

    def _install_fake_model(self, monkeypatch, accepts: set[str]):
        """Patch `openwakeword.model.Model` so that constructing with
        a model name in `accepts` succeeds, anything else raises.
        Returns a list of (kwargs, succeeded) for each attempted
        construction so tests can assert load order."""
        attempts: list[tuple[dict, bool]] = []

        class _FakeModel:
            def __init__(self, **kwargs):
                import os as _os
                models = kwargs.get("wakeword_models") or []
                def _accepts_one(m: str) -> bool:
                    if m in accepts:
                        return True
                    # Tolerate \\ on Windows + / on POSIX.
                    base = _os.path.basename(m)
                    stem = base[:-5] if base.endswith(".onnx") else base
                    return stem in accepts
                ok = bool(models) and all(_accepts_one(m) for m in models)
                attempts.append((kwargs, ok))
                if not ok:
                    raise ValueError(f"Unknown wake-word model: {models}")
            def predict(self, _audio):
                return {}

        # Provide a fake openwakeword.model module surface.
        import sys
        import types as _types
        fake_mod = _types.ModuleType("openwakeword.model")
        fake_mod.Model = _FakeModel  # type: ignore[attr-defined]
        # Make the parent package available too (the detector does
        # `from openwakeword.model import Model`, which triggers
        # `import openwakeword` first).
        fake_parent = _types.ModuleType("openwakeword")
        sys.modules["openwakeword"] = fake_parent
        sys.modules["openwakeword.model"] = fake_mod
        return attempts

    def test_falls_back_to_hey_jarvis_when_custom_missing(self, monkeypatch, tmp_path):
        # 'hey_droplet' isn't bundled and no .onnx on disk → fallback
        # to 'hey_jarvis' (bundled), wake stays armed.
        attempts = self._install_fake_model(monkeypatch, accepts={"hey_jarvis"})
        det = OpenWakeWordDetector(
            wake_word="hey_droplet", models_dir=str(tmp_path),
        )
        det._ensure_loaded()
        assert det.loaded is True
        assert det.using_fallback is True
        assert det.model_name == "hey_jarvis"
        assert det.requested_wake_word == "hey_droplet"
        # First attempt was hey_droplet (failed), second was hey_jarvis (succeeded)
        assert len(attempts) == 2
        assert "hey_droplet" in attempts[0][0]["wakeword_models"]
        assert attempts[0][1] is False
        assert "hey_jarvis" in attempts[1][0]["wakeword_models"]
        assert attempts[1][1] is True

    def test_no_fallback_when_custom_onnx_on_disk(self, monkeypatch, tmp_path):
        # Drop a (fake) hey_droplet.onnx on disk. Detector should use
        # that path, no bundled lookup, no fallback.
        (tmp_path / "hey_droplet.onnx").write_bytes(b"fake-onnx-bytes")
        attempts = self._install_fake_model(
            monkeypatch,
            # Accept the path-based load (any caller of the fake's
            # Model() with the .onnx path).
            accepts={"hey_droplet"},
        )
        det = OpenWakeWordDetector(
            wake_word="hey_droplet", models_dir=str(tmp_path),
        )
        det._ensure_loaded()
        assert det.loaded is True
        assert det.using_fallback is False
        assert det.model_name == "hey_droplet"
        # Only one attempt — the custom path load
        assert len(attempts) == 1

    def test_no_fallback_when_wake_word_is_bundled(self, monkeypatch, tmp_path):
        # If WAKE_WORD is one of the bundled names, no fallback needed.
        attempts = self._install_fake_model(monkeypatch, accepts={"alexa"})
        det = OpenWakeWordDetector(
            wake_word="alexa", models_dir=str(tmp_path),
        )
        det._ensure_loaded()
        assert det.loaded is True
        assert det.using_fallback is False
        assert det.model_name == "alexa"
        assert len(attempts) == 1

    def test_disabled_when_even_fallback_fails(self, monkeypatch, tmp_path):
        # Pathological: even hey_jarvis isn't loadable (e.g. corrupt
        # bundled cache). Detector goes to loaded=False, predict
        # returns {}, pipeline keeps running.
        self._install_fake_model(monkeypatch, accepts=set())
        det = OpenWakeWordDetector(
            wake_word="hey_droplet", models_dir=str(tmp_path),
        )
        det._ensure_loaded()
        assert det.loaded is False
        # predict() must not crash even after a failed load
        import numpy as np
        assert det.predict(np.zeros(WAKE_FRAME_SAMPLES, dtype=np.int16)) == {}


# ────────────────────────────────────────────────────────────────────
# VoskWakeWordDetector — the default engine
# ────────────────────────────────────────────────────────────────────

class TestVoskWakeWordDetector:
    """The default engine. Recognizes the configured phrase ("hey
    droplet") out of the box via a grammar-constrained model — no
    phrase fallback, no training. Vosk's real decode isn't exercised
    here (that needs the model bytes); we inject a fake `vosk` module
    and pin the frame→score contract the pipeline depends on.
    """

    def _install_fake_vosk(
        self, monkeypatch, accept_seq, result_obj=None, partial_obj=None,
        final_obj=None,
    ):
        """Fake the `vosk` module. `accept_seq` is the bool returned by
        AcceptWaveform on each call (was an utterance endpoint reached?);
        `result_obj` is what Result() returns at an endpoint; `partial_obj`
        is what PartialResult() returns between endpoints; `final_obj` is
        what FinalResult() returns when the detector flushes a
        partial-hypothesis match (defaults to `result_obj` so simple tests
        only configure one). Returns a state dict tracking call counts
        (accepts / models / resets / finals)."""
        import sys
        import types
        state = {"accepts": 0, "models": 0, "resets": 0, "finals": 0}
        _result = result_obj if result_obj is not None else {"text": ""}
        _partial = partial_obj if partial_obj is not None else {"partial": ""}
        _final = final_obj if final_obj is not None else _result

        class _FakeRec:
            def __init__(self, model, rate, grammar):
                self.grammar = grammar
                self.words = False

            def SetWords(self, on):
                self.words = on

            def AcceptWaveform(self, pcm):
                i = state["accepts"]
                state["accepts"] += 1
                return accept_seq[i] if i < len(accept_seq) else False

            def Result(self):
                return json.dumps(_result)

            def PartialResult(self):
                return json.dumps(_partial)

            def FinalResult(self):
                state["finals"] += 1
                return json.dumps(_final)

            def Reset(self):
                state["resets"] += 1

        class _FakeModel:
            def __init__(self, path):
                state["models"] += 1
                self.path = path

        fake = types.ModuleType("vosk")
        fake.Model = _FakeModel  # type: ignore[attr-defined]
        fake.KaldiRecognizer = _FakeRec  # type: ignore[attr-defined]
        # setitem so pytest auto-restores sys.modules after the test.
        monkeypatch.setitem(sys.modules, "vosk", fake)
        return state

    def test_fires_on_partial_after_finalize_confirms(self, monkeypatch, tmp_path):
        # A wake word must still fire from the in-progress partial
        # hypothesis (an utterance endpoint may never come in a noisy
        # room) — but a partial carries no per-word confidence, so the
        # detector flushes the decoder (FinalResult) and fires only when
        # the FINALIZED hypothesis still contains the phrase, scored on
        # its real per-word confidences. This is the TV false-accept fix:
        # the old path fired evidence-free partials at a fixed 0.5.
        state = self._install_fake_vosk(
            monkeypatch,
            accept_seq=[False],
            partial_obj={"partial": "hey droplet"},
            final_obj={
                "text": "hey droplet",
                "result": [
                    {"word": "hey", "conf": 0.95},
                    {"word": "droplet", "conf": 0.88},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        scores = det.predict(_silence_frame())
        assert state["finals"] == 1              # decoder flushed for evidence
        assert scores == {"hey_droplet": 0.88}   # min per-word conf
        assert state["resets"] == 1              # recognizer reset after a match

    def test_partial_match_revised_away_on_finalize_does_not_fire(
        self, monkeypatch, tmp_path,
    ):
        # The grammar bias regularly shoehorns ambient speech (TV,
        # podcast) into a momentary "hey droplet" PARTIAL; the finalized
        # best-path then resolves to [unk]. That must not fire — and the
        # decoder must be reset so the artifact doesn't linger.
        state = self._install_fake_vosk(
            monkeypatch,
            accept_seq=[False],
            partial_obj={"partial": "hey droplet"},
            final_obj={"text": "[unk]", "result": []},
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {}
        assert state["finals"] == 1
        assert state["resets"] == 1

    def test_does_not_fire_on_substring_only_match(self, monkeypatch, tmp_path):
        # Whole-word match (review item 6): "hey droplets" contains the
        # phrase as a substring but NOT as whole tokens — must NOT fire.
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={"text": "hey droplets", "result": []},
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {}

    def test_fires_on_phrase_with_surrounding_tokens(self, monkeypatch, tmp_path):
        # The phrase as a contiguous token run amid other tokens (e.g. a
        # leading "[unk]") still fires (whole-word, not anchored-to-start),
        # scored on the matched window's confidences only.
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={
                "text": "[unk] hey droplet",
                "result": [
                    {"word": "[unk]", "conf": 0.2},
                    {"word": "hey", "conf": 0.92},
                    {"word": "droplet", "conf": 0.9},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {"hey_droplet": 0.9}

    def test_recognizes_phrase_and_scores_min_confidence(self, monkeypatch, tmp_path):
        # First frame buffers (AcceptWaveform False), second hits the
        # endpoint (True) → Result() text matches → fire scored at the
        # MINIMUM per-word conf: one confidently decoded word must not
        # carry a weak one (the TV half-match shape).
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[False, True],
            partial_obj={"partial": ""},
            result_obj={
                "text": "hey droplet",
                "result": [
                    {"word": "hey", "conf": 0.9},
                    {"word": "droplet", "conf": 0.7},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {}          # buffering
        scores = det.predict(_silence_frame())              # endpoint → match
        assert set(scores) == {"hey_droplet"}
        assert abs(scores["hey_droplet"] - 0.7) < 1e-6      # min(0.9, 0.7)
        assert det.loaded is True
        assert det.using_fallback is False                  # never falls back
        assert det.model_name == "hey_droplet"
        assert det.requested_wake_word == "hey_droplet"

    def test_scores_best_contiguous_window_not_stray_duplicates(
        self, monkeypatch, tmp_path,
    ):
        # A stray earlier "hey" (low conf) outside the matched window must
        # not drag the score down — the window that actually spells the
        # phrase is what gets scored.
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={
                "text": "hey [unk] hey droplet",
                "result": [
                    {"word": "hey", "conf": 0.3},
                    {"word": "[unk]", "conf": 0.5},
                    {"word": "hey", "conf": 0.95},
                    {"word": "droplet", "conf": 0.91},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {"hey_droplet": 0.91}

    def test_no_score_when_phrase_absent(self, monkeypatch, tmp_path):
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={"text": "what time is it", "result": []},
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {}

    def test_no_fire_when_no_word_confidences(self, monkeypatch, tmp_path):
        # A final Result whose text matches but carries NO per-word `result`
        # confidence array must NOT fire at all. The old behaviour scored
        # these evidence-free matches at a fixed 0.5 — above the shipped
        # threshold — which is exactly how a living-room TV kept waking the
        # box. No acoustic evidence → no fire; the decoder is reset so the
        # stale match can't linger into the next frame.
        state = self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={"text": "hey droplet"},
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {}
        assert state["resets"] == 1

    def test_no_fire_when_window_conf_incomplete(self, monkeypatch, tmp_path):
        # Partial evidence isn't evidence: if any word in the matched
        # window lacks a conf value, the window doesn't count.
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={
                "text": "hey droplet",
                "result": [
                    {"word": "hey", "conf": 0.99},
                    {"word": "droplet"},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {}

    def test_vosk_default_threshold_is_sane(self):
        # The engine-aware default must be a real gate: strictly above the
        # generic openWakeWord default (vosk min-conf scores run hot for
        # genuine matches) and strictly below 1.0 (or nothing ever fires).
        assert DEFAULT_THRESHOLD < VOSK_DEFAULT_THRESHOLD < 1.0

    def test_no_fire_when_word_timing_implausible(self, monkeypatch, tmp_path):
        # Grammar-forced decoding can align the phrase over a stretch of
        # TV music/noise at FULL confidence — observed live (score=1.00
        # fire off broadcast audio). Word geometry is the independent
        # rejection signal: here "droplet" is smeared over 2.4 s, which
        # no human utterance produces → no fire.
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={
                "text": "hey droplet",
                "result": [
                    {"word": "hey", "conf": 1.0, "start": 0.1, "end": 0.3},
                    {"word": "droplet", "conf": 1.0, "start": 0.4, "end": 2.8},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {}

    def test_no_fire_when_inter_word_gap_implausible(self, monkeypatch, tmp_path):
        # "hey" … 1.5 s of music … "droplet" is two separate alignments,
        # not a wake phrase.
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={
                "text": "hey droplet",
                "result": [
                    {"word": "hey", "conf": 1.0, "start": 0.1, "end": 0.3},
                    {"word": "droplet", "conf": 1.0, "start": 1.8, "end": 2.3},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {}

    def test_fires_with_plausible_word_timings(self, monkeypatch, tmp_path):
        # A normally spoken "hey droplet" (~0.8 s end to end, small beat
        # between the words) passes the geometry gate and scores min-conf.
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={
                "text": "hey droplet",
                "result": [
                    {"word": "hey", "conf": 0.97, "start": 0.10, "end": 0.32},
                    {"word": "droplet", "conf": 0.93, "start": 0.45, "end": 0.92},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {"hey_droplet": 0.93}

    def test_fires_without_timing_data(self, monkeypatch, tmp_path):
        # Timing is an EXTRA rejection signal when present — a result
        # array without start/end keys must still fire on confidence
        # alone (older vosk builds omit timings).
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={
                "text": "hey droplet",
                "result": [
                    {"word": "hey", "conf": 0.95},
                    {"word": "droplet", "conf": 0.9},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {"hey_droplet": 0.9}

    def test_no_fire_when_partially_timed_word_is_implausible(
        self, monkeypatch, tmp_path,
    ):
        # One word missing timing must not void the whole geometry gate:
        # the words that DO carry timing are still validated. Here
        # "droplet" is smeared over 2.4 s — pre-fix code let this through
        # because "hey" lacked start/end (pr-reviewer finding, 2026-06-11).
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={
                "text": "hey droplet",
                "result": [
                    {"word": "hey", "conf": 1.0},
                    {"word": "droplet", "conf": 1.0, "start": 0.4, "end": 2.8},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {}

    def test_fires_with_partial_but_plausible_timing(self, monkeypatch, tmp_path):
        # Partial timing with plausible evidence still fires — checks
        # whose endpoints are missing (span, gap) are skipped, never
        # failed: timing stays an extra signal, not a new requirement.
        self._install_fake_vosk(
            monkeypatch,
            accept_seq=[True],
            result_obj={
                "text": "hey droplet",
                "result": [
                    {"word": "hey", "conf": 0.95},
                    {"word": "droplet", "conf": 0.9, "start": 0.45, "end": 0.92},
                ],
            },
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        assert det.predict(_silence_frame()) == {"hey_droplet": 0.9}

    def test_predict_empty_and_unloaded_when_model_dir_missing(self):
        # No fake vosk installed + a nonexistent dir → the cheap dir
        # check short-circuits before importing vosk. predict() returns
        # {} and never raises; the factory swaps in openWakeWord first
        # in the real flow.
        det = VoskWakeWordDetector(
            wake_word="hey_droplet", model_path="/nonexistent-vosk-xyz",
        )
        assert det.predict(_silence_frame()) == {}
        assert det.loaded is False

    def test_model_loaded_only_once(self, monkeypatch, tmp_path):
        # The recognizer is built once and reused — building a Vosk Model
        # per frame would be catastrophic (~hundreds of MB of work/sec).
        state = self._install_fake_vosk(
            monkeypatch, accept_seq=[False, False, False], result_obj={"text": ""},
        )
        det = VoskWakeWordDetector(wake_word="hey_droplet", model_path=str(tmp_path))
        for _ in range(3):
            det.predict(_silence_frame())
        assert state["models"] == 1
        assert state["accepts"] == 3
        assert det.loaded is True


# ────────────────────────────────────────────────────────────────────
# build_detector_from_env — WAKE_ENGINE selection + Vosk/oww fallback
# ────────────────────────────────────────────────────────────────────

class TestBuildDetectorVoskEngine:
    def test_default_engine_uses_vosk_when_model_present(self, monkeypatch, tmp_path):
        # No WAKE_ENGINE set → defaults to vosk. Model dir present → Vosk.
        model_dir = tmp_path / "vosk-model-small-en-us"
        model_dir.mkdir()
        monkeypatch.delenv("WAKE_WORD", raising=False)
        monkeypatch.delenv("WAKE_ENGINE", raising=False)
        monkeypatch.setenv("VOSK_MODEL_PATH", str(model_dir))
        det = build_detector_from_env()
        assert isinstance(det, VoskWakeWordDetector)
        assert det.requested_wake_word == "hey_droplet"
        assert det.using_fallback is False

    def test_vosk_engine_falls_back_to_openwakeword_when_model_absent(self, monkeypatch):
        # Vosk requested but no model on disk → openWakeWord so wake
        # stays armed (nothing regresses on a stripped image).
        monkeypatch.delenv("WAKE_WORD", raising=False)
        monkeypatch.setenv("WAKE_ENGINE", "vosk")
        monkeypatch.setenv("VOSK_MODEL_PATH", "/nonexistent-vosk-model-xyz")
        det = build_detector_from_env()
        assert isinstance(det, OpenWakeWordDetector)
        assert det.requested_wake_word == "hey_droplet"

    def test_openwakeword_engine_forced_even_with_vosk_model(self, monkeypatch, tmp_path):
        model_dir = tmp_path / "vosk-model-small-en-us"
        model_dir.mkdir()
        monkeypatch.setenv("WAKE_ENGINE", "openwakeword")
        monkeypatch.setenv("VOSK_MODEL_PATH", str(model_dir))
        det = build_detector_from_env()
        assert isinstance(det, OpenWakeWordDetector)

    def test_unknown_engine_defaults_to_vosk_path(self, monkeypatch, tmp_path):
        # An unsupported engine name routes to the vosk path (with its
        # own fallback) rather than crashing.
        model_dir = tmp_path / "vosk-model-small-en-us"
        model_dir.mkdir()
        monkeypatch.setenv("WAKE_ENGINE", "porcupine")
        monkeypatch.setenv("VOSK_MODEL_PATH", str(model_dir))
        det = build_detector_from_env()
        assert isinstance(det, VoskWakeWordDetector)
