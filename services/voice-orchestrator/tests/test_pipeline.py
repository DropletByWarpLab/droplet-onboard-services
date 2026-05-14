"""WARP-154 — wake pipeline state machine + decision logic.

The contract these tests pin:

  - Construction is cheap and produces state='idle'.
  - start() with no input device → 'no_mic'; worker thread never spawns.
  - status() is atomic — readable from any thread without lock contention
    surfacing to the caller.
  - _on_frame() below threshold → no state change, no callback fire.
  - _on_frame() above threshold → 'wake_detected' + callback fires once.
  - Debounce: a flurry of above-threshold frames fires the callback
    exactly once within debounce_s, then again after the window passes.
  - Visual decay: once `visual_decay_s` passes since the last wake,
    status().state decays from 'wake_detected' back to 'listening'
    automatically (read-time computation, no timer thread).
  - Detector exceptions land in state='error' with error_message set —
    they DO NOT crash the worker thread.
  - stop() is idempotent and clears the state to 'idle'.
  - _loop() with a fake sounddevice module pumps frames through and
    fires wake events end-to-end.

We don't test against real PortAudio here — sd_module is injected via
the constructor so the worker thread can run on a Windows dev box
without a soundcard.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Optional

import numpy as np
import pytest

from voice.pipeline import (
    DEFAULT_DEBOUNCE_S,
    DEFAULT_THRESHOLD,
    DEFAULT_VISUAL_DECAY_S,
    PipelineStatus,
    WakePipeline,
)
from voice.wake import (
    WAKE_FRAME_SAMPLES,
    DisabledWakeWordDetector,
    MockWakeWordDetector,
    WakeEvent,
    WakeWordDetector,
)


def _silence_frame() -> np.ndarray:
    return np.zeros(WAKE_FRAME_SAMPLES, dtype=np.int16)


# ────────────────────────────────────────────────────────────────────
# Fake sounddevice — minimal stub for _loop() integration tests
# ────────────────────────────────────────────────────────────────────

class _FakeStream:
    """Context-manager stub matching sounddevice.InputStream's API.

    Yields a scripted list of frames on .read(), then signals EOF by
    setting the pipeline's shutdown event (so _loop exits cleanly).
    """

    def __init__(self, frames, shutdown_event):
        self._frames = list(frames)
        self._shutdown = shutdown_event

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, n):
        if not self._frames:
            # Out of scripted frames — tell the pipeline to wind down.
            self._shutdown.set()
            return _silence_frame().reshape(-1, 1), False
        frame = self._frames.pop(0)
        return frame.reshape(-1, 1), False


class _FakeSoundDevice:
    """Module-level stub. _loop() calls sd.InputStream(...) once."""

    def __init__(self, frames, shutdown_event):
        self._frames = frames
        self._shutdown = shutdown_event
        self.opened_with: dict = {}

    def InputStream(self, **kwargs):  # noqa: N802 — matches real API
        self.opened_with = kwargs
        return _FakeStream(self._frames, self._shutdown)


class _ScriptedDetector(WakeWordDetector):
    """Replays a list of score dicts. Like MockWakeWordDetector but
    cycles to the last value (instead of dropping to 0.0) — handy for
    "constant high score" frames that drive debounce tests.
    """

    def __init__(self, scripts, model_name="hey_jarvis", loaded=True):
        self._scripts = scripts
        self._idx = 0
        self._name = model_name
        self._loaded = loaded

    @property
    def model_name(self) -> str:
        return self._name

    @property
    def loaded(self) -> bool:
        return self._loaded

    def predict(self, audio_frame: np.ndarray) -> dict[str, float]:
        if not self._scripts:
            return {self._name: 0.0}
        if self._idx >= len(self._scripts):
            return dict(self._scripts[-1])  # hold last
        r = self._scripts[self._idx]
        self._idx += 1
        return dict(r)


class _RaisingDetector(WakeWordDetector):
    """Throws on every predict — drives the error-recovery path."""

    @property
    def model_name(self) -> str:
        return "raising"

    @property
    def loaded(self) -> bool:
        return True

    def predict(self, audio_frame: np.ndarray) -> dict[str, float]:
        raise RuntimeError("predict failed (test)")


# ────────────────────────────────────────────────────────────────────
# Construction + idle state
# ────────────────────────────────────────────────────────────────────

class TestConstruction:
    def test_starts_in_idle_state(self):
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
        )
        s = pipe.status()
        assert s.state == "idle"
        assert s.listening is False
        assert s.wake_loaded is True  # MockWakeWordDetector.loaded == True
        assert s.last_wake_at is None
        assert s.last_wake_score is None
        assert s.error_message is None

    def test_threshold_reflected_in_status(self):
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            threshold=0.75,
        )
        assert pipe.status().threshold == 0.75

    def test_disabled_detector_surfaces_wake_loaded_false(self):
        # When openwakeword failed to load, status should be honest about it.
        pipe = WakePipeline(
            detector=DisabledWakeWordDetector(),
            input_device_index=0,
        )
        assert pipe.status().wake_loaded is False

    def test_default_threshold_constant_matches_module(self):
        # If someone retunes DEFAULT_THRESHOLD in pipeline.py without
        # checking main.py, this catches the drift.
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
        )
        assert pipe.status().threshold == DEFAULT_THRESHOLD


# ────────────────────────────────────────────────────────────────────
# start() / stop() lifecycle
# ────────────────────────────────────────────────────────────────────

class TestLifecycle:
    def test_start_with_no_mic_transitions_to_no_mic_state(self):
        # input_device_index=None is the signal that resolve_devices
        # found no mic. The pipeline must NOT spawn a worker (would
        # crash on stream.read()) — instead pin state='no_mic' so the
        # dashboard can surface "plug in a mic" cleanly.
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,
        )
        pipe.start()
        s = pipe.status()
        assert s.state == "no_mic"
        assert s.listening is False

    def test_start_no_mic_idempotent(self):
        # Calling start() twice when there's no mic must not double-spawn.
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,
        )
        pipe.start()
        pipe.start()  # no-op; no worker thread to double up
        assert pipe.status().state == "no_mic"

    def test_stop_is_idempotent(self):
        # Compose's shutdown flow can deliver SIGTERM mid-startup — the
        # second stop() call (from FastAPI's shutdown event handler)
        # must not raise.
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,
        )
        pipe.start()
        pipe.stop()
        pipe.stop()  # idempotent
        assert pipe.status().state == "idle"

    def test_stop_without_start_is_safe(self):
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
        )
        # Never started — stop() should just no-op.
        pipe.stop()
        assert pipe.status().state == "idle"


# ────────────────────────────────────────────────────────────────────
# _on_frame decision logic — threshold + callback
# ────────────────────────────────────────────────────────────────────

class TestOnFrameDecision:
    def test_below_threshold_does_not_fire_callback(self):
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.3}]),
            input_device_index=0,
            threshold=0.5,
            on_wake=fires.append,
        )
        pipe._on_frame(_silence_frame())
        assert fires == []
        # State stays at the construction default — _on_frame doesn't
        # touch state for sub-threshold frames.
        assert pipe.status().state == "idle"

    def test_above_threshold_fires_callback_and_records_event(self):
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            on_wake=fires.append,
        )
        pipe._on_frame(_silence_frame())
        assert len(fires) == 1
        evt = fires[0]
        assert evt.model_name == "hey_jarvis"
        assert evt.score == pytest.approx(0.9)
        assert evt.detected_at > 0
        s = pipe.status()
        assert s.state == "wake_detected"
        assert s.last_wake_score == pytest.approx(0.9)
        assert s.last_wake_model == "hey_jarvis"

    def test_listening_flag_true_for_wake_detected(self):
        # 'wake_detected' is a sub-state of "the pipeline is listening";
        # the dashboard binds the green dot to `listening`, not `state`.
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
        )
        pipe._on_frame(_silence_frame())
        assert pipe.status().listening is True

    def test_max_score_model_wins_when_multiple_detectors(self):
        # Multi-model detectors (e.g. "hey_jarvis" + "alexa" loaded at
        # once) are out of scope today but the data shape supports it.
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.3, "alexa": 0.85}]),
            input_device_index=0,
            threshold=0.5,
            on_wake=fires.append,
        )
        pipe._on_frame(_silence_frame())
        assert fires[0].model_name == "alexa"
        assert fires[0].score == pytest.approx(0.85)

    def test_empty_scores_dict_is_no_op(self):
        # DisabledWakeWordDetector returns {} forever — pipeline must
        # handle that without firing or erroring.
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=DisabledWakeWordDetector(),
            input_device_index=0,
            on_wake=fires.append,
        )
        pipe._on_frame(_silence_frame())
        assert fires == []
        assert pipe.status().state == "idle"

    def test_detector_exception_lands_in_error_state(self):
        # The detector crashing mid-stream must NOT take the worker
        # down. We catch into state='error' so /voice/status surfaces
        # it and the operator can restart.
        pipe = WakePipeline(
            detector=_RaisingDetector(),
            input_device_index=0,
        )
        pipe._on_frame(_silence_frame())
        s = pipe.status()
        assert s.state == "error"
        assert "predict failed" in (s.error_message or "")

    def test_callback_exception_does_not_propagate(self):
        # The on_wake hook is operator-supplied (commit 7 wires it to
        # the LLM bridge). A bug there must not crash the loop.
        def bad_callback(evt: WakeEvent) -> None:
            raise RuntimeError("callback bug")

        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            on_wake=bad_callback,
        )
        # Should not raise:
        pipe._on_frame(_silence_frame())
        # Wake was still recorded in status — only the callback failed.
        assert pipe.status().last_wake_score == pytest.approx(0.9)


# ────────────────────────────────────────────────────────────────────
# Debounce
# ────────────────────────────────────────────────────────────────────

class TestDebounce:
    def test_rapid_above_threshold_frames_fire_once(self):
        # The wake word audio spans ~600 ms; that's ~7 frames at 80 ms
        # each, all above threshold. We want exactly one WakeEvent.
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            debounce_s=2.0,
            on_wake=fires.append,
        )
        for _ in range(8):
            pipe._on_frame(_silence_frame())
        assert len(fires) == 1

    def test_fires_again_after_debounce_window_passes(self):
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            debounce_s=0.1,  # short window for the test
            on_wake=fires.append,
        )
        pipe._on_frame(_silence_frame())
        assert len(fires) == 1
        time.sleep(0.15)  # pass the debounce window
        pipe._on_frame(_silence_frame())
        assert len(fires) == 2

    def test_default_debounce_is_documented_value(self):
        # Drift detector — if someone changes the default in pipeline.py
        # without updating the README's "2-second cooldown" claim,
        # this catches it.
        assert DEFAULT_DEBOUNCE_S == 2.0


# ────────────────────────────────────────────────────────────────────
# Visual decay — wake_detected → listening
# ────────────────────────────────────────────────────────────────────

class TestVisualDecay:
    def test_wake_detected_decays_to_listening_after_visual_window(self):
        # The 'wake_detected' state is a transient flag for the
        # dashboard's pulse animation. It must auto-clear or the
        # pulse animation never settles.
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            visual_decay_s=0.05,
        )
        # Move into 'listening' first — the worker thread normally
        # does this. Without it, the decay path returns 'listening'
        # but we want to verify the read-time decay is correct.
        pipe._set_state("listening")
        pipe._on_frame(_silence_frame())
        assert pipe.status().state == "wake_detected"
        time.sleep(0.1)
        assert pipe.status().state == "listening"

    def test_default_visual_decay_constant(self):
        assert DEFAULT_VISUAL_DECAY_S == 2.0


# ────────────────────────────────────────────────────────────────────
# Status atomicity
# ────────────────────────────────────────────────────────────────────

class TestStatusAtomicity:
    def test_status_returns_a_pipeline_status_instance(self):
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
        )
        assert isinstance(pipe.status(), PipelineStatus)

    def test_status_to_dict_is_json_safe(self):
        # /voice/status returns this dict directly. Floats must NOT be
        # numpy floats (would break Pydantic on response_model).
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
        )
        pipe._on_frame(_silence_frame())
        d = pipe.status().to_dict()
        assert isinstance(d["last_wake_score"], float)
        assert isinstance(d["threshold"], float)
        # to_dict is dataclasses.asdict — should be plain Python types
        import json
        json.dumps(d)  # MUST NOT raise

    def test_status_under_concurrent_reads_does_not_crash(self):
        # The worker mutates _last_wake_at + _state under the lock;
        # the FastAPI request thread reads status() under the same
        # lock. Smoke-test parallel readers don't observe a half-updated
        # snapshot.
        pipe = WakePipeline(
            detector=_ScriptedDetector(
                [{"hey_jarvis": 0.9}] * 100,
                model_name="hey_jarvis",
            ),
            input_device_index=0,
            threshold=0.5,
            debounce_s=0.0,
        )
        observed_errors: list[Exception] = []

        def reader():
            try:
                for _ in range(200):
                    s = pipe.status()
                    # Every field must be coherent — if last_wake_score
                    # is set, last_wake_model must be too (set under
                    # the same lock acquire).
                    if s.last_wake_score is not None:
                        assert s.last_wake_model is not None
                        assert s.last_wake_at is not None
            except Exception as e:  # noqa: BLE001
                observed_errors.append(e)

        def writer():
            try:
                for _ in range(200):
                    pipe._on_frame(_silence_frame())
            except Exception as e:  # noqa: BLE001
                observed_errors.append(e)

        threads = [threading.Thread(target=reader) for _ in range(3)]
        threads.append(threading.Thread(target=writer))
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not observed_errors


# ────────────────────────────────────────────────────────────────────
# _loop integration — fake sounddevice end-to-end
# ────────────────────────────────────────────────────────────────────

class TestLoopIntegration:
    def test_loop_pumps_frames_through_and_fires_wake(self):
        # 5 frames: 3 quiet + 2 wake-strength. The pipeline should fire
        # exactly once (one wake event) and then run dry → exit cleanly.
        frames = [_silence_frame()] * 3 + [_silence_frame()] * 2
        fires: list[WakeEvent] = []
        shutdown_event = threading.Event()
        # Scripted detector with matching sequence: 3 low, 2 high.
        det = _ScriptedDetector(
            [
                {"hey_jarvis": 0.1},
                {"hey_jarvis": 0.2},
                {"hey_jarvis": 0.1},
                {"hey_jarvis": 0.9},   # wake
                {"hey_jarvis": 0.95},  # debounced — same event
            ],
        )
        fake_sd = _FakeSoundDevice(frames, shutdown_event)
        pipe = WakePipeline(
            detector=det,
            input_device_index=7,
            threshold=0.5,
            debounce_s=10.0,  # ensure rapid frames coalesce
            on_wake=fires.append,
            sd_module=fake_sd,
        )
        # Wire the shutdown event through so the fake stream can flip it.
        pipe._shutdown = shutdown_event
        pipe._loop()  # runs in the test thread, synchronous
        assert len(fires) == 1
        assert fires[0].model_name == "hey_jarvis"
        # InputStream was opened with the right wiring:
        assert fake_sd.opened_with["device"] == 7
        assert fake_sd.opened_with["channels"] == 1
        assert fake_sd.opened_with["dtype"] == "int16"

    def test_loop_records_error_when_stream_raises(self):
        class _ExplodingSd:
            def InputStream(self, **kwargs):  # noqa: N802
                raise OSError("PortAudio: device disappeared")

        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            sd_module=_ExplodingSd(),
        )
        pipe._loop()
        s = pipe.status()
        assert s.state == "error"
        assert "PortAudio" in (s.error_message or "")
