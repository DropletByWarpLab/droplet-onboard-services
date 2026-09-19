"""WARP-154 — wake pipeline state machine + decision logic.

The contract these tests pin:

  - Construction is cheap and produces state='idle'.
  - start() with no input device → spawns the supervising loop, which
    parks in 'no_mic' and keeps re-resolving until a mic appears
    (WARP-1092); it never gives up before spawning a worker.
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

from voice import audio_io, pipeline as pipeline_module
from voice.pipeline import (
    DEFAULT_DEBOUNCE_S,
    DEFAULT_FLATLINE_DBFS,
    DEFAULT_FLATLINE_WINDOW_S,
    DEFAULT_STT_MAX_RECORD_S,
    DEFAULT_THRESHOLD,
    DEFAULT_VAD_SILENCE_S,
    DEFAULT_VISUAL_DECAY_S,
    RMS_DBFS_FLOOR,
    DspRestartSkipped,
    MeasurementUnavailable,
    PipelineStatus,
    WakePipeline,
    classify_tool_choice,
    transcript_is_actionable,
)
from voice.activity import ActivityReporter
from voice.llm import LLMClient, LLMUnavailable, MockLLM
from voice.stt import MockSTT, STTUnavailable, StreamingSTT
from voice.tts import MockTTS, SynthesizedAudio, TextToSpeech, TTSUnavailable
from voice.wake import (
    WAKE_FRAME_SAMPLES,
    WAKE_SAMPLE_RATE,
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


class _ResetCountingDetector(_ScriptedDetector):
    """A scripted detector that also records reset() calls. Used to pin
    the contract that the pipeline resets the wake detector when it
    returns to 'listening' after a transcription cycle — so a stateful
    recognizer (Vosk's KaldiRecognizer) doesn't carry a stale utterance
    across the STT excursion. (WARP-154 review item 1)
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reset_calls = 0

    def reset(self) -> None:
        self.reset_calls += 1


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
    def test_start_with_no_mic_spawns_self_heal_loop(self):
        # WARP-1092 contract change: input_device_index=None at boot (the
        # reflash race where the ReSpeaker settles AFTER the container
        # starts) must NOT permanently park voice-io. start() now spawns
        # the supervising loop, which sits in no_mic and keeps re-resolving
        # until a mic appears — instead of the old "never spawn a worker".
        # sd_module=object() is never touched: a None index raises
        # _DeviceError before any InputStream open, so the loop parks in
        # no_mic deterministically.
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,
            sd_module=object(),
            resolve_input_device=lambda: None,
            recover_backoff_initial_s=0.01,
            recover_backoff_max_s=0.01,
        )
        pipe.start()
        try:
            # The worker thread WAS spawned (old code returned before this).
            assert pipe._thread is not None and pipe._thread.is_alive()
            # Converges to no_mic (loading → first _DeviceError → no_mic).
            deadline = time.time() + 2.0
            while pipe.status().state != "no_mic" and time.time() < deadline:
                time.sleep(0.01)
            assert pipe.status().state == "no_mic"
            assert pipe.status().listening is False
        finally:
            pipe.stop()
        assert pipe.status().state == "idle"

    def test_start_no_mic_idempotent(self):
        # Calling start() twice with no mic must not double-spawn the
        # supervising worker. WARP-1092 makes the loop run even with no mic,
        # so the idempotency guard has to actually hold (not rely on the old
        # early-return that never created a thread).
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,
            sd_module=object(),
            resolve_input_device=lambda: None,
            recover_backoff_initial_s=0.01,
            recover_backoff_max_s=0.01,
        )
        pipe.start()
        try:
            first = pipe._thread
            assert first is not None and first.is_alive()
            pipe.start()  # second call is a no-op while the worker is alive
            assert pipe._thread is first
        finally:
            pipe.stop()

    def test_stop_is_idempotent(self):
        # Compose's shutdown flow can deliver SIGTERM mid-startup — the
        # second stop() call (from FastAPI's shutdown event handler)
        # must not raise. Even with no mic, start() now spawns the self-heal
        # loop (WARP-1092), so stop() has a real worker + probe thread to
        # tear down; injected sd/resolver keep it off the real audio stack.
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,
            sd_module=object(),
            resolve_input_device=lambda: None,
            recover_backoff_initial_s=0.01,
            recover_backoff_max_s=0.01,
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

    def test_error_state_does_not_resume_wake_detection(self):
        # Once we're in 'error', a later frame must NOT silently resume
        # wake detection: a wake fire would overwrite _state with
        # 'wake_detected' while the stale _error_message lingered, masking
        # the fault on /voice/status. Pre-fix, 'error' hit the fall-through
        # to _run_wake_detect. Recovery from error is an explicit
        # transition, never an implicit one off the next mic frame.
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.99}]),
            input_device_index=0,
            threshold=0.5,
            on_wake=fires.append,
        )
        pipe._set_error("STT session failed (test)")
        pipe._on_frame(_silence_frame())  # high-scoring frame
        assert fires == []                       # no wake fired
        assert pipe._state == "error"            # still latched in error
        assert "STT session failed" in (pipe.status().error_message or "")

    def test_no_mic_state_does_not_resume_wake_detection(self):
        # Same contract for 'no_mic': the supervising loop owns the
        # recovery transition back to 'listening'; _on_frame must not
        # resume wake detection from a no_mic latch on its own.
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.99}]),
            input_device_index=0,
            threshold=0.5,
            on_wake=fires.append,
        )
        pipe._set_state("no_mic")
        pipe._on_frame(_silence_frame())
        assert fires == []
        assert pipe._state == "no_mic"

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
        # As of commit 5, re-firing wake requires BOTH the debounce
        # window AND the visual-decay window to pass — wake_detected
        # is now an actual pipeline state, not just a display flag,
        # so a re-wake while in wake_detected would compete with the
        # transcription path. Set both windows short for the test.
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            debounce_s=0.05,
            visual_decay_s=0.05,
            on_wake=fires.append,
        )
        pipe._on_frame(_silence_frame())
        assert len(fires) == 1
        time.sleep(0.1)  # pass both windows
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

    def test_loop_treats_open_oserror_as_recoverable_no_mic(self):
        # CONTRACT CHANGE (fix/voice-wake-loop-resilience): an OSError /
        # PortAudioError raised by InputStream() open is a RECOVERABLE
        # device error (the reSpeaker re-enumerated, the card index
        # shifted, PortAudio's cached device went invalid) — NOT a fatal
        # 'error'. The loop must pin state='no_mic' and keep retrying
        # with bounded backoff rather than exit. A device that NEVER
        # comes back keeps the loop alive in 'no_mic' until _shutdown.
        class _ExplodingSd:
            def InputStream(self, **kwargs):  # noqa: N802
                raise OSError("PortAudio: device disappeared")

        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            sd_module=_ExplodingSd(),
            recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
        )
        # Stop the supervising retry after a couple of failed attempts so
        # the synchronous _loop() call returns instead of looping forever
        # on a permanently-absent mic.
        calls = {"n": 0}
        real_wait = pipe._shutdown.wait

        def _wait(timeout=None):
            calls["n"] += 1
            if calls["n"] >= 2:
                pipe._shutdown.set()
            return real_wait(0)

        pipe._shutdown.wait = _wait  # type: ignore[assignment]
        pipe._loop()
        s = pipe.status()
        # Recoverable: ended parked in no_mic, NOT in fatal error.
        assert s.state == "no_mic"
        assert s.error_message is None
        # It actually retried (didn't just give up after one open).
        assert calls["n"] >= 2


# ────────────────────────────────────────────────────────────────────
# Device-disconnect self-heal (fix/voice-wake-loop-resilience)
# ────────────────────────────────────────────────────────────────────
#
# The reSpeaker XVF3800 USB mic re-enumerates under Docker: the open
# InputStream goes invalid and stream.read() raises PortAudioError, OR a
# subsequent open raises. The wake loop must self-heal — refresh
# PortAudio's enumeration, re-resolve the (possibly shifted) device
# index, reopen, and return to 'listening' — instead of exiting the
# worker thread permanently. These tests pin that recovery contract with
# a fully-mocked sounddevice (CI-importable; the real device is not).


class _PortAudioError(Exception):
    """Stand-in for sounddevice.PortAudioError for the mocked module."""


class _RecoveringStream:
    """A single InputStream 'session'. Reads scripted frames; a frame of
    the sentinel value RAISE makes .read() raise the supplied device
    error (simulating a mid-stream re-enumeration). When frames run out
    it sets the pipeline shutdown event so a synchronous _loop() returns.
    """

    RAISE = object()

    def __init__(self, frames, shutdown_event, error_factory):
        self._frames = list(frames)
        self._shutdown = shutdown_event
        self._error_factory = error_factory
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.closed = True
        return False

    def read(self, n):
        if not self._frames:
            self._shutdown.set()
            return _silence_frame().reshape(-1, 1), False
        item = self._frames.pop(0)
        if item is self.RAISE:
            raise self._error_factory()
        return item.reshape(-1, 1), False


class _RecoveringSoundDevice:
    """Mock sounddevice whose InputStream() yields a NEW _RecoveringStream
    per open, driven by a scripted list of 'sessions'. Each session is
    either a list of frames (possibly containing _RecoveringStream.RAISE)
    or an exception instance to raise from the open call itself.

    Records every device index it was opened with (to assert
    re-resolution picks up a shifted index) and counts _terminate /
    _initialize calls (to assert the enumeration cache was refreshed
    before re-resolving).
    """

    PortAudioError = _PortAudioError

    def __init__(self, sessions, shutdown_event):
        self._sessions = list(sessions)
        self._shutdown = shutdown_event
        self.opened_devices: list = []
        self.streams: list = []
        self.terminate_calls = 0
        self.initialize_calls = 0

    # PortAudio re-enumeration hooks the pipeline calls defensively.
    def _terminate(self):
        self.terminate_calls += 1

    def _initialize(self):
        self.initialize_calls += 1

    def query_devices(self, index=None):
        # 1-channel mono device — keeps the downmix path identical to a
        # healthy run.
        return {"max_input_channels": 1}

    def InputStream(self, **kwargs):  # noqa: N802 — matches real API
        self.opened_devices.append(kwargs.get("device"))
        if not self._sessions:
            # No more scripted sessions — wind the loop down cleanly.
            self._shutdown.set()
            return _RecoveringStream([], self._shutdown, _PortAudioError)
        session = self._sessions.pop(0)
        if isinstance(session, BaseException):
            raise session
        stream = _RecoveringStream(session, self._shutdown, _PortAudioError)
        self.streams.append(stream)
        return stream


class _FrameRecordingDetector(WakeWordDetector):
    """Records every mono frame the pipeline hands to predict()."""

    def __init__(self):
        self.frames: list[np.ndarray] = []

    @property
    def model_name(self) -> str:
        return "recorder"

    @property
    def loaded(self) -> bool:
        return True

    def predict(self, audio_frame: np.ndarray) -> dict[str, float]:
        self.frames.append(audio_frame.copy())
        return {}

    def reset(self) -> None:
        pass


class _StereoStream:
    """One stream session yielding scripted (1280, 2) int16 frames; sets
    shutdown when exhausted so a synchronous _loop() returns."""

    def __init__(self, frames, shutdown_event):
        self._frames = list(frames)
        self._shutdown = shutdown_event

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, n):
        if not self._frames:
            self._shutdown.set()
            return np.zeros((n, 2), dtype=np.int16), False
        return self._frames.pop(0), False


class _StereoSoundDevice:
    PortAudioError = _PortAudioError

    def __init__(self, frames, shutdown_event):
        self._frames = frames
        self._shutdown = shutdown_event

    def query_devices(self, index=None):
        return {"max_input_channels": 2}

    def InputStream(self, **kwargs):  # noqa: N802 — matches real API
        return _StereoStream(self._frames, self._shutdown)


class TestCaptureDownmix:
    """Multichannel→mono contract. The reSpeaker XVF3800 carries
    beamformed voice on channel 0 and AEC residual on channel 1 —
    averaging them halved the voice and mixed in junk (the "have to
    talk really loud" report). Default consumes channel 0; "mean" stays
    available for plain stereo mics; VOICE_INPUT_GAIN applies after."""

    def _run(self, frames, **pipe_kwargs):
        shutdown = threading.Event()
        det = _FrameRecordingDetector()
        pipe = WakePipeline(
            detector=det,
            input_device_index=4,
            threshold=0.5,
            sd_module=_StereoSoundDevice(frames, shutdown),
            **pipe_kwargs,
        )
        pipe._shutdown = shutdown
        pipe._loop()
        return det.frames

    @staticmethod
    def _stereo_frame(left: int, right: int) -> np.ndarray:
        f = np.zeros((1280, 2), dtype=np.int16)
        f[:, 0] = left
        f[:, 1] = right
        return f

    def test_default_consumes_primary_channel_only(self):
        frames = self._run([self._stereo_frame(left=1000, right=0)])
        # Old mean() behaviour would deliver 500 — half the voice.
        assert len(frames) >= 1
        assert int(frames[0][0]) == 1000

    def test_mean_downmix_available_via_config(self):
        frames = self._run(
            [self._stereo_frame(left=1000, right=0)],
            input_downmix="mean",
        )
        assert int(frames[0][0]) == 500

    def test_input_gain_scales_and_clips(self):
        frames = self._run(
            [self._stereo_frame(left=1000, right=0),
             self._stereo_frame(left=30000, right=0)],
            input_gain=2.0,
        )
        assert int(frames[0][0]) == 2000          # 1000 × 2.0
        assert int(frames[1][0]) == 32767         # 30000 × 2.0 clips, no wrap

    def test_unknown_downmix_falls_back_to_default(self):
        frames = self._run(
            [self._stereo_frame(left=1000, right=0)],
            input_downmix="bogus",
        )
        assert int(frames[0][0]) == 1000          # "first" semantics

    def test_nonpositive_gain_falls_back_to_unity(self):
        frames = self._run(
            [self._stereo_frame(left=1000, right=0)],
            input_gain=0.0,
        )
        assert int(frames[0][0]) == 1000


class TestLoopDeviceRecovery:
    """Self-heal contract for audio-device disconnects."""

    def _wake_script(self, n_low: int):
        # n_low quiet frames then a wake-strength frame.
        return _ScriptedDetector(
            [{"hey_jarvis": 0.05}] * n_low + [{"hey_jarvis": 0.9}],
        )

    def test_read_portaudioerror_recovers_and_resumes_dispatch(self):
        # Session 1: two quiet frames, then read() raises PortAudioError.
        # Session 2 (after recovery): a wake-strength frame → fires, then
        # runs dry. Asserts: loop does NOT exit, state goes
        # listening → no_mic → listening, frames dispatch again, worker
        # thread stays alive.
        shutdown = threading.Event()
        S = _RecoveringStream.RAISE
        sessions = [
            [_silence_frame(), _silence_frame(), S],  # then disconnect
            [_silence_frame()],                        # reopened → wake frame
        ]
        fake_sd = _RecoveringSoundDevice(sessions, shutdown)
        det = self._wake_script(2)  # 2 quiet then wake on the 3rd predict
        fires: list[WakeEvent] = []
        seen_states: list[str] = []

        pipe = WakePipeline(
            detector=det,
            input_device_index=4,
            threshold=0.5,
            on_wake=fires.append,
            sd_module=fake_sd,
            recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
        )
        pipe._shutdown = shutdown

        # Observe the state the moment we sit in the recovery wait.
        real_wait = shutdown.wait

        def _wait(timeout=None):
            seen_states.append(pipe.status().state)
            return real_wait(0)

        shutdown.wait = _wait  # type: ignore[assignment]

        t = threading.Thread(target=pipe._loop, daemon=True)
        t.start()
        t.join(timeout=5.0)

        assert not t.is_alive(), "worker thread must not hang"
        # Recovered far enough to reopen and fire the post-recovery wake.
        assert len(fires) == 1
        # While recovering, we reported no_mic.
        assert "no_mic" in seen_states
        # Reopened the stream (two opens: original + recovery).
        assert len(fake_sd.opened_devices) >= 2
        # Both stream sessions were entered/exited (proves we returned to
        # active listening after the disconnect).
        assert fake_sd.streams[0].closed is True

    def test_open_error_backs_off_then_recovers(self):
        # InputStream() open raises for the first 3 attempts, then the
        # 4th open succeeds and yields a frame. Asserts bounded backoff +
        # recovery, and that state is no_mic while retrying.
        shutdown = threading.Event()
        sessions = [
            _PortAudioError("open failed 1"),
            _PortAudioError("open failed 2"),
            OSError("open failed 3"),
            [_silence_frame()],  # 4th open succeeds
        ]
        fake_sd = _RecoveringSoundDevice(sessions, shutdown)
        waits: list[float] = []
        states_during_wait: list[str] = []

        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            sd_module=fake_sd,
            recover_backoff_initial_s=0.01,
            recover_backoff_max_s=0.04,
        )
        pipe._shutdown = shutdown
        real_wait = shutdown.wait

        def _wait(timeout=None):
            waits.append(timeout)
            states_during_wait.append(pipe.status().state)
            return real_wait(0)  # don't actually sleep in the test

        shutdown.wait = _wait  # type: ignore[assignment]

        pipe._loop()

        # 4 opens total (3 failed + 1 success).
        assert len(fake_sd.opened_devices) == 4
        # 3 backoff waits between the failures.
        assert len(waits) == 3
        # Bounded + capped exponential: 0.01, 0.02, 0.04 (<= max).
        assert waits[0] == pytest.approx(0.01)
        assert waits[1] == pytest.approx(0.02)
        assert waits[2] == pytest.approx(0.04)
        assert all(w <= 0.04 for w in waits)
        # State was no_mic throughout the retry window.
        assert states_during_wait and all(s == "no_mic" for s in states_during_wait)

    def test_reopen_uses_newly_resolved_index_after_card_shift(self):
        # The card index shifts on re-enumeration. The re-resolution hook
        # returns a DIFFERENT index; assert the reopen uses the new one
        # (proves we re-resolve via the injected path, not the stale
        # constructor value).
        shutdown = threading.Event()
        S = _RecoveringStream.RAISE
        sessions = [
            [_silence_frame(), S],  # disconnect after one frame
            [_silence_frame()],     # reopened on the new index
        ]
        fake_sd = _RecoveringSoundDevice(sessions, shutdown)
        resolutions = iter([11])  # next resolve() returns the shifted idx

        def _resolve_input():
            return next(resolutions, 11)

        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=10,  # original index
            sd_module=fake_sd,
            resolve_input_device=_resolve_input,
            recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
        )
        pipe._shutdown = shutdown
        pipe._loop()

        # First open used the original index, the reopen used the
        # re-resolved (shifted) index.
        assert fake_sd.opened_devices[0] == 10
        assert fake_sd.opened_devices[1] == 11
        # PortAudio enumeration was refreshed before re-resolving.
        assert fake_sd.terminate_calls >= 1
        assert fake_sd.initialize_calls >= 1

    def test_reresolution_to_none_stays_no_mic(self):
        # If re-resolution finds no device at all (mic genuinely gone),
        # the loop parks in no_mic and keeps retrying — it must not crash
        # or fall through to opening device=None.
        shutdown = threading.Event()
        S = _RecoveringStream.RAISE
        sessions = [[_silence_frame(), S]]  # disconnect, no further session
        fake_sd = _RecoveringSoundDevice(sessions, shutdown)

        def _resolve_input():
            return None  # nothing to pick now

        waits = {"n": 0}
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=3,
            sd_module=fake_sd,
            resolve_input_device=_resolve_input,
            recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
        )
        pipe._shutdown = shutdown
        real_wait = shutdown.wait

        def _wait(timeout=None):
            waits["n"] += 1
            if waits["n"] >= 2:
                shutdown.set()
            return real_wait(0)

        shutdown.wait = _wait  # type: ignore[assignment]
        pipe._loop()

        assert pipe.status().state == "no_mic"
        # Only the original device was ever opened; we never tried to open
        # device=None after re-resolution returned nothing.
        assert fake_sd.opened_devices == [3]
        assert waits["n"] >= 2

    def test_boot_with_no_mic_opens_when_mic_appears(self):
        # WARP-1092 end-to-end: constructed with input_device_index=None —
        # the reflash race where voice-io starts before the ReSpeaker's ALSA
        # nodes settle. The supervising loop must park in no_mic, keep
        # re-resolving, and open the mic the moment it enumerates — never
        # open device=None, never give up. (Previously start() bailed before
        # _loop ran, so this whole recovery never happened.)
        shutdown = threading.Event()
        # One successful capture session — reached only once the resolver
        # hands back a real index; the None-index iterations never open.
        sessions = [[_silence_frame()]]
        fake_sd = _RecoveringSoundDevice(sessions, shutdown)
        # Mic absent on the first re-resolve, then the XVF3800 shows up at 5.
        resolutions = iter([None, 5])

        def _resolve_input():
            return next(resolutions, 5)

        seen_states: list[str] = []
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,   # no mic at boot
            sd_module=fake_sd,
            resolve_input_device=_resolve_input,
            recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
        )
        pipe._shutdown = shutdown
        real_wait = shutdown.wait

        def _wait(timeout=None):
            seen_states.append(pipe.status().state)
            return real_wait(0)  # don't actually sleep in the test

        shutdown.wait = _wait  # type: ignore[assignment]
        pipe._loop()

        # Parked in no_mic while waiting for the mic to appear...
        assert "no_mic" in seen_states
        # ...then opened the ReSpeaker at its enumerated index — and ONLY
        # that index; it never tried to open device=None.
        assert fake_sd.opened_devices == [5]
        # PortAudio was re-enumerated before re-resolving.
        assert fake_sd.terminate_calls >= 1

    def test_backoff_exits_promptly_on_shutdown_mid_wait(self):
        # A genuinely-absent mic must not hot-loop, and must drop out the
        # instant _shutdown is set — even mid-backoff. We assert the loop
        # uses the interruptible _shutdown.wait (not time.sleep) for its
        # delay, and returns as soon as shutdown fires.
        shutdown = threading.Event()
        # Every open fails → permanently-absent mic.
        sessions = [OSError("gone") for _ in range(50)]
        fake_sd = _RecoveringSoundDevice(sessions, shutdown)

        used_shutdown_wait = {"v": False}
        real_wait = shutdown.wait

        def _wait(timeout=None):
            used_shutdown_wait["v"] = True
            shutdown.set()  # simulate stop() landing mid-backoff
            return real_wait(timeout if timeout else 0)

        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            sd_module=fake_sd,
            recover_backoff_initial_s=30.0,  # would hang if not interruptible
            recover_backoff_max_s=30.0,
        )
        pipe._shutdown = shutdown
        shutdown.wait = _wait  # type: ignore[assignment]

        t = threading.Thread(target=pipe._loop, daemon=True)
        t.start()
        t.join(timeout=5.0)

        assert not t.is_alive(), "loop must exit promptly on _shutdown mid-backoff"
        assert used_shutdown_wait["v"], "backoff must use interruptible _shutdown.wait"
        # We bailed after the first failed open — didn't burn all 50.
        assert len(fake_sd.opened_devices) <= 2

    def test_non_device_exception_surfaces_as_error_not_retried(self):
        # A bug in the frame-handling path (here: detector.predict raises
        # a non-device error) must surface as 'error' and be logged — NOT
        # silently retried forever. The device-recovery scope is tight: it
        # only catches PortAudio/OS device errors around open + read.
        shutdown = threading.Event()
        sessions = [[_silence_frame(), _silence_frame()]]  # healthy stream
        fake_sd = _RecoveringSoundDevice(sessions, shutdown)

        pipe = WakePipeline(
            detector=_RaisingDetector(),  # predict() raises RuntimeError
            input_device_index=0,
            sd_module=fake_sd,
            recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
        )
        pipe._shutdown = shutdown

        t = threading.Thread(target=pipe._loop, daemon=True)
        t.start()
        t.join(timeout=5.0)

        assert not t.is_alive()
        s = pipe.status()
        # _RaisingDetector errors are caught inside _run_wake_detect and
        # routed to 'error' (existing contract). The recovery supervisor
        # must NOT convert that into a no_mic retry loop.
        assert s.state == "error"
        assert "predict failed" in (s.error_message or "")
        # Did not reopen the stream chasing a non-device error.
        assert len(fake_sd.opened_devices) == 1


# ────────────────────────────────────────────────────────────────────
# STT — post-wake transcription flow (commit 5)
# ────────────────────────────────────────────────────────────────────

class _RecordingSTT(StreamingSTT):
    """MockSTT variant that exposes chunks-received counter + a hook to
    raise on a configurable call. Tests use this to verify the wire-up
    between pipeline and STT.
    """

    def __init__(
        self,
        scripted_transcripts: Optional[list[str]] = None,
        available: bool = True,
        raise_on_session: bool = False,
        raise_on_send_after: Optional[int] = None,
        raise_on_finish: bool = False,
    ):
        self._scripts = scripted_transcripts or []
        self._available = available
        self._raise_on_session = raise_on_session
        self._raise_on_send_after = raise_on_send_after
        self._raise_on_finish = raise_on_finish
        self.chunks_received: list[bytes] = []
        self.sessions_opened = 0
        self.finished = False

    @property
    def available(self) -> bool:
        return self._available

    def session(self):
        self.sessions_opened += 1
        if self._raise_on_session:
            raise STTUnavailable("session refused (test)")
        outer = self

        class _S:
            def __init__(self): self._closed = False
            def __enter__(self): return self
            def __exit__(self, *a): self.close()
            def send_chunk(self, b):
                if (
                    outer._raise_on_send_after is not None
                    and len(outer.chunks_received) >= outer._raise_on_send_after
                ):
                    raise STTUnavailable("send blew up (test)")
                outer.chunks_received.append(b)
            def finish(self):
                if outer._raise_on_finish:
                    raise STTUnavailable("finish blew up (test)")
                outer.finished = True
                return outer._scripts.pop(0) if outer._scripts else ""
            def close(self): self._closed = True
        return _S()


class TestSTTWiring:
    def test_stt_available_probe_flips_stt_loaded(self):
        """Pipeline.start() probes STT once; status reflects it."""
        stt = _RecordingSTT(available=True)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            stt=stt,
        )
        # Before start, stt_loaded is False (probe hasn't run).
        assert pipe.status().stt_loaded is False
        pipe.start()  # probes + spawns worker
        # The worker thread doesn't matter for this — we're checking
        # the synchronous probe.
        assert pipe.status().stt_loaded is True
        pipe.stop()

    def test_unreachable_stt_keeps_pipeline_running(self):
        # A degraded STT server must NOT kill wake detection. The wake
        # loop should keep going, just no transcripts.
        stt = _RecordingSTT(available=False)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            stt=stt,
        )
        pipe.start()
        assert pipe.status().stt_loaded is False
        pipe.stop()


class TestTranscribingFlow:
    def test_wake_then_next_frame_opens_stt_session(self):
        stt = _RecordingSTT(scripted_transcripts=["the answer"])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            stt_max_record_s=100.0,  # long window — we'll manually finish
        )
        # Pretend the start-up probe already ran (in real life, start() does this).
        pipe._stt_available = True

        # Frame 1: wake fires (state → wake_detected)
        pipe._on_frame(_silence_frame())
        assert pipe.status().state == "wake_detected"
        assert stt.sessions_opened == 0  # session opens on the NEXT frame

        # Frame 2: state is wake_detected → begin transcription, send first chunk
        pipe._on_frame(_silence_frame())
        s = pipe.status()
        assert s.state == "transcribing"
        assert stt.sessions_opened == 1
        assert len(stt.chunks_received) == 1

    def test_max_record_window_triggers_finish(self):
        stt = _RecordingSTT(scripted_transcripts=["seven o'clock"])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            stt_max_record_s=0.05,  # tiny window so test is fast
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())  # wake
        pipe._on_frame(_silence_frame())  # begin transcription, chunk #1
        # Wait past the window
        time.sleep(0.1)
        pipe._on_frame(_silence_frame())  # this frame triggers finish
        s = pipe.status()
        assert stt.finished is True
        assert s.last_transcript == "seven o'clock"
        assert s.last_transcript_at is not None
        assert s.state == "transcript_ready"

    def test_vad_ends_capture_on_trailing_silence(self):
        # Once the user has actually spoken, a short run of trailing
        # silence ends the capture EARLY — before the (long) max-record
        # window. This is "stop listening the moment they finish".
        stt = _RecordingSTT(scripted_transcripts=["turn on the lights"])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            stt_max_record_s=100.0,   # long — VAD must be what finishes it
            vad_silence_s=0.2,        # ~3 frames (0.08 s each) of silence
            vad_min_speech_s=0.0,     # don't gate on wall-clock in the test
            vad_speech_rms=300.0,
        )
        pipe._stt_available = True
        speech = np.full(WAKE_FRAME_SAMPLES, 6000, dtype=np.int16)

        pipe._on_frame(_silence_frame())   # wake (scripted; content irrelevant)
        pipe._on_frame(speech)             # begin transcription + first speech chunk
        assert pipe.status().state == "transcribing"
        pipe._on_frame(speech)             # more speech
        for _ in range(4):                 # trailing silence trips VAD
            pipe._on_frame(_silence_frame())
        s = pipe.status()
        assert stt.finished is True
        assert s.state == "transcript_ready"
        assert s.last_transcript == "turn on the lights"

    def test_vad_does_not_fire_before_any_speech(self):
        # Pure silence after wake must NOT trip VAD (no speech detected
        # yet) — otherwise a false wake would instantly "finish" on an
        # empty capture. Only the max-record cap ends a silent capture.
        stt = _RecordingSTT(scripted_transcripts=["x"])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            stt_max_record_s=100.0,
            vad_silence_s=0.2,
            vad_min_speech_s=0.0,
            vad_speech_rms=300.0,
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())   # wake
        pipe._on_frame(_silence_frame())   # begin transcription
        for _ in range(10):
            pipe._on_frame(_silence_frame())   # all silence, never any speech
        assert stt.finished is False
        assert pipe.status().state == "transcribing"

    def test_transcript_ready_decays_to_listening(self):
        stt = _RecordingSTT(scripted_transcripts=["test"])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            stt_max_record_s=0.01,
            visual_decay_s=0.05,
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())  # wake
        pipe._on_frame(_silence_frame())  # begin
        time.sleep(0.05)
        pipe._on_frame(_silence_frame())  # finish → transcript_ready
        assert pipe.status().state == "transcript_ready"
        time.sleep(0.1)
        # Read-time decay flips it back to listening
        assert pipe.status().state == "listening"

    def test_detector_reset_on_resume_to_listening_after_transcription(self):
        # WARP-154 review item 1: a stateful recognizer (Vosk) carries
        # decoder state across calls. After a wake fires, frames are routed
        # to STT and the recognizer is starved; when we return to 'listening'
        # the next AcceptWaveform would otherwise continue the STALE
        # utterance. The pipeline must reset() the detector on the
        # transcription → listening transition so each turn starts fresh.
        det = _ResetCountingDetector([{"hey_jarvis": 0.9}])
        stt = _RecordingSTT(scripted_transcripts=["what time is it"])
        pipe = WakePipeline(
            detector=det,
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            stt_max_record_s=0.01,
            visual_decay_s=0.05,
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())  # wake → wake_detected
        pipe._on_frame(_silence_frame())  # begin transcription
        time.sleep(0.05)
        pipe._on_frame(_silence_frame())  # finish → transcript_ready
        assert pipe.status().state == "transcript_ready"
        assert det.reset_calls == 0       # not yet — still in the wake cycle
        time.sleep(0.1)
        pipe._on_frame(_silence_frame())  # decays to listening → reset fires
        assert pipe.status().state == "listening"
        assert det.reset_calls == 1, "detector not reset on resume to listening"

    def test_detector_not_reset_while_merely_listening(self):
        # The reset is tied to the transcription → listening transition, not
        # to every frame. A detector that's just listening (no wake, no STT
        # excursion) must never be reset — that would throw away in-progress
        # partial recognition mid-phrase. (WARP-154 review item 1)
        det = _ResetCountingDetector([{"hey_jarvis": 0.1}])
        pipe = WakePipeline(
            detector=det,
            input_device_index=0,
            threshold=0.5,
        )
        pipe._set_state("listening")
        for _ in range(5):
            pipe._on_frame(_silence_frame())  # all below threshold, no wake
        assert det.reset_calls == 0

    def test_transcript_callback_fires_with_text(self):
        captured: list[str] = []
        stt = _RecordingSTT(scripted_transcripts=["turn the lights off"])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            on_transcript=captured.append,
            stt_max_record_s=0.05,
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())
        pipe._on_frame(_silence_frame())
        time.sleep(0.1)
        pipe._on_frame(_silence_frame())
        assert captured == ["turn the lights off"]

    def test_transcript_callback_exception_does_not_propagate(self):
        def bad_callback(_t: str) -> None:
            raise RuntimeError("callback bug")
        stt = _RecordingSTT(scripted_transcripts=["x"])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            on_transcript=bad_callback,
            stt_max_record_s=0.05,
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())
        pipe._on_frame(_silence_frame())
        time.sleep(0.1)
        # MUST NOT raise:
        pipe._on_frame(_silence_frame())
        # And the transcript was still saved:
        assert pipe.status().last_transcript == "x"

    def test_session_open_failure_lands_in_error_state(self):
        stt = _RecordingSTT(raise_on_session=True)
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())  # wake
        pipe._on_frame(_silence_frame())  # tries to open session → fails
        s = pipe.status()
        assert s.state == "error"
        assert "session refused" in (s.error_message or "")
        # And stt_available flipped to False so subsequent wakes don't
        # retry the same broken connection on every frame.
        assert s.stt_loaded is False

    def test_send_failure_aborts_transcription(self):
        # After a few chunks, send_chunk starts raising. Pipeline should
        # transition to error state, drop the session, and not crash.
        stt = _RecordingSTT(
            scripted_transcripts=["never reached"],
            raise_on_send_after=3,
        )
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            stt_max_record_s=100.0,
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())  # wake
        pipe._on_frame(_silence_frame())  # begin + chunk 1
        pipe._on_frame(_silence_frame())  # chunk 2
        pipe._on_frame(_silence_frame())  # chunk 3
        pipe._on_frame(_silence_frame())  # tries chunk 4 → raises → abort
        s = pipe.status()
        assert s.state == "error"
        assert "send blew up" in (s.error_message or "")

    def test_finish_failure_aborts_transcription(self):
        stt = _RecordingSTT(
            scripted_transcripts=["never used"],
            raise_on_finish=True,
        )
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            stt_max_record_s=0.05,
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())  # wake
        pipe._on_frame(_silence_frame())  # begin + chunk
        time.sleep(0.1)
        pipe._on_frame(_silence_frame())  # tries finish → raises
        s = pipe.status()
        assert s.state == "error"
        assert "finish blew up" in (s.error_message or "")

    def test_stt_none_keeps_pre_commit_4_behaviour(self):
        """No STT wired up → wake fires + state decays back without transcribing."""
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=None,  # explicit — same as before commit 5
            on_wake=fires.append,
            visual_decay_s=0.05,
        )
        pipe._on_frame(_silence_frame())  # wake fires
        assert pipe.status().state == "wake_detected"
        # Next frame: state is wake_detected, but stt is None — should NOT
        # transition to transcribing.
        pipe._on_frame(_silence_frame())
        assert pipe.status().state == "wake_detected"
        # And visual decay returns us to listening.
        time.sleep(0.1)
        assert pipe.status().state == "listening"

    def test_listening_flag_true_for_transcribing(self):
        # The dashboard's "listening" pulse animation should stay on during
        # transcription, not just for wake_detected.
        stt = _RecordingSTT(scripted_transcripts=["hi"])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            stt=stt,
            stt_max_record_s=100.0,
        )
        pipe._stt_available = True
        pipe._on_frame(_silence_frame())
        pipe._on_frame(_silence_frame())
        s = pipe.status()
        assert s.state == "transcribing"
        assert s.listening is True

    def test_default_stt_max_record_constant(self):
        # Drift detector — this is the HARD cap on capture length; the
        # end-of-speech VAD cuts sooner when the room goes quiet. WARP-1434:
        # reconciled to 5.0 as the SINGLE source of truth (code default +
        # compose + README + overview doc all say 5.0; the box runs 5.0).
        assert DEFAULT_STT_MAX_RECORD_S == 5.0

    def test_default_vad_silence_constant(self):
        # WARP-1434 — trimmed 1.0 → 0.6: a full second of trailing dead air
        # used to end every turn; 0.6 s ends it sooner once the room goes
        # quiet while still riding out a natural mid-sentence pause.
        assert DEFAULT_VAD_SILENCE_S == 0.6


# ────────────────────────────────────────────────────────────────────
# TTS — speak() flow (commit 6)
# ────────────────────────────────────────────────────────────────────

class _RecordingTTS(TextToSpeech):
    """MockTTS variant with knobs for failure injection + a counter for
    how many times synthesize was called (and with what)."""

    def __init__(
        self,
        scripted_audio: Optional[SynthesizedAudio] = None,
        available: bool = True,
        raise_on_synthesize: bool = False,
    ):
        self._scripted = scripted_audio or SynthesizedAudio(
            pcm=b"\x00" * 200, sample_rate=22050, sample_width=2, channels=1,
        )
        self._available = available
        self._raise_on_synthesize = raise_on_synthesize
        self.texts_received: list[str] = []
        self.voices_received: list[Optional[str]] = []

    @property
    def available(self) -> bool:
        return self._available

    def synthesize(self, text: str, voice: Optional[str] = None) -> SynthesizedAudio:
        self.texts_received.append(text)
        self.voices_received.append(voice)
        if self._raise_on_synthesize:
            raise TTSUnavailable("synth blew up (test)")
        return self._scripted


def _patch_play(monkeypatch):
    """Replace voice.audio_io.play with a recorder. The pipeline imports
    `play` inside `_play_pcm` (lazy import) so we patch the source
    module, and the recorder captures every call.
    """
    calls: list[dict[str, Any]] = []

    def _fake_play(audio, samplerate, device):
        calls.append(
            {"len": len(audio), "samplerate": samplerate, "device": device}
        )

    import voice.audio_io as _audio_io
    monkeypatch.setattr(_audio_io, "play", _fake_play)
    return calls


class TestSpeak:
    def test_speak_synthesizes_and_plays(self, monkeypatch):
        play_calls = _patch_play(monkeypatch)
        tts = _RecordingTTS(scripted_audio=SynthesizedAudio(
            pcm=b"\xaa\xbb" * 100, sample_rate=22050, sample_width=2, channels=1,
        ))
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            output_device_index=7,
            tts=tts,
        )
        pipe._tts_available = True  # simulate the start() probe

        result = pipe.speak("the time is 3 pm")
        assert result["ok"] is True
        assert result["sample_rate"] == 22050
        assert tts.texts_received == ["the time is 3 pm"]
        # Played to the right device
        assert play_calls[0]["device"] == 7
        assert play_calls[0]["samplerate"] == 22050

    def test_speak_records_last_response(self, monkeypatch):
        _patch_play(monkeypatch)
        tts = _RecordingTTS()
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            output_device_index=0,
            tts=tts,
        )
        pipe._tts_available = True
        pipe.speak("hello world")
        s = pipe.status()
        assert s.last_response == "hello world"
        assert s.last_response_at is not None

    def test_speak_with_voice_override_propagates(self, monkeypatch):
        _patch_play(monkeypatch)
        tts = _RecordingTTS()
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            output_device_index=0,
            tts=tts,
        )
        pipe._tts_available = True
        pipe.speak("hi", voice="en_GB-jenny-medium")
        assert tts.voices_received == ["en_GB-jenny-medium"]

    def test_speak_returns_error_when_tts_unavailable(self):
        # tts=None case — pipeline gracefully refuses speak.
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            tts=None,
        )
        result = pipe.speak("hello")
        assert result["ok"] is False
        assert "unavailable" in (result.get("error") or "").lower()

    def test_speak_returns_error_when_tts_probe_failed(self):
        tts = _RecordingTTS(available=False)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            tts=tts,
        )
        pipe._tts_available = False
        result = pipe.speak("hello")
        assert result["ok"] is False

    def test_speak_returns_error_on_empty_text(self):
        tts = _RecordingTTS()
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            tts=tts,
        )
        pipe._tts_available = True
        result = pipe.speak("")
        assert result["ok"] is False
        # Make sure we didn't bother the TTS server with empty input
        assert tts.texts_received == []

    def test_speak_handles_synthesize_failure(self, monkeypatch):
        tts = _RecordingTTS(raise_on_synthesize=True)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            output_device_index=0,
            tts=tts,
        )
        pipe._tts_available = True
        result = pipe.speak("hello")
        assert result["ok"] is False
        # Error message surfaces via /voice/status
        assert pipe.status().state == "error"
        assert "synth blew up" in (pipe.status().error_message or "")

    def test_playback_failure_arms_post_speak_cooldown(self, monkeypatch):
        # A mid-playback failure still drove the speaker for part of the
        # reply, so the anti-feedback cooldown must engage — otherwise the
        # partial Piper output can bleed into the mic and self-trigger a
        # wake. Pre-fix, _speak_ended_at was set only on the success path
        # (_restore_state_after_speak), so the except left it None.
        def _raising_play(audio, samplerate, device):
            raise RuntimeError("PortAudio write failed (test)")

        import voice.audio_io as _audio_io
        monkeypatch.setattr(_audio_io, "play", _raising_play)

        tts = _RecordingTTS()
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.99}]),
            input_device_index=0,
            output_device_index=0,
            threshold=0.5,
            tts=tts,
        )
        pipe._tts_available = True
        pipe._state = "listening"

        result = pipe.speak("hello")
        assert result["ok"] is False
        assert pipe.status().state == "error"
        # The load-bearing assertion: the cooldown timestamp is armed even
        # though playback raised, so wake detection is suppressed for the
        # post-speak window.
        assert pipe._speak_ended_at is not None
        now = time.time()
        assert now - pipe._speak_ended_at < pipe._post_speak_cooldown_s

        # And _run_wake_detect honours it: a high-scoring frame inside the
        # cooldown window does NOT fire a wake.
        fires: list[WakeEvent] = []
        pipe._on_wake = fires.append
        pipe._run_wake_detect(_silence_frame())
        assert fires == []

    def test_speak_transitions_into_and_out_of_speaking_state(self, monkeypatch):
        # We can't observe the intermediate 'speaking' state from outside
        # because speak() blocks for the duration. But we CAN verify the
        # post-speak state restoration: starts at listening, ends at
        # listening.
        _patch_play(monkeypatch)
        tts = _RecordingTTS()
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            output_device_index=0,
            tts=tts,
        )
        pipe._tts_available = True
        pipe._state = "listening"
        pipe.speak("hello")
        assert pipe.status().state == "listening"

    def test_speaking_state_skips_wake_detect(self, monkeypatch):
        # While in 'speaking' state, mic frames must NOT run wake-detect.
        # We force the state manually + drive a frame that WOULD fire
        # wake if dispatched, and confirm nothing happens.
        _patch_play(monkeypatch)
        fires: list[WakeEvent] = []
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.99}]),
            input_device_index=0,
            threshold=0.5,
            on_wake=fires.append,
        )
        pipe._state = "speaking"
        pipe._on_frame(_silence_frame())
        assert fires == []
        # State stays 'speaking' — _on_frame doesn't flip it.
        assert pipe._state == "speaking"

    def test_empty_pcm_from_tts_is_handled_cleanly(self, monkeypatch):
        # Some Piper voices return zero audio for filtered text. Pipeline
        # should report ok=True with duration_s=0 rather than crashing.
        play_calls = _patch_play(monkeypatch)
        tts = _RecordingTTS(scripted_audio=SynthesizedAudio(
            pcm=b"", sample_rate=22050, sample_width=2, channels=1,
        ))
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            output_device_index=0,
            tts=tts,
        )
        pipe._tts_available = True
        result = pipe.speak("hello")
        assert result["ok"] is True
        assert result["duration_s"] == 0.0
        # And we did NOT try to play empty audio (would crash sounddevice)
        assert play_calls == []


class TestSpeakStatus:
    def test_status_exposes_tts_loaded_after_probe(self):
        tts = _RecordingTTS(available=True)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            tts=tts,
        )
        pipe.start()
        assert pipe.status().tts_loaded is True
        pipe.stop()

    def test_status_exposes_tts_loaded_false_when_unreachable(self):
        tts = _RecordingTTS(available=False)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            tts=tts,
        )
        pipe.start()
        assert pipe.status().tts_loaded is False
        pipe.stop()


# ────────────────────────────────────────────────────────────────────
# Commit 7 — closed-loop transcript → LLM → speak
# ────────────────────────────────────────────────────────────────────

class _RecordingLLM(LLMClient):
    """MockLLM variant with failure injection."""

    def __init__(
        self,
        scripted_replies: Optional[list[str]] = None,
        available: bool = True,
        raise_on_reply: bool = False,
    ):
        self._scripts = list(scripted_replies or [])
        self._available = available
        self._raise_on_reply = raise_on_reply
        self.requests: list[str] = []
        # Records tool_choice values for parity with MockLLM so tests can
        # assert the intent gate's decision is threaded through to the LLM.
        self.tool_choices: list = []

    @property
    def available(self) -> bool:
        return self._available

    def reply(self, user_text: str, *, tool_choice=None) -> str:
        self.requests.append(user_text)
        self.tool_choices.append(tool_choice)
        if self._raise_on_reply:
            raise LLMUnavailable("LLM blew up (test)")
        return self._scripts.pop(0) if self._scripts else ""


class TestClosedLoop:
    """End-to-end through the default callback: a transcript arrives,
    LLM is asked, reply is spoken. These are the most behaviorally
    important tests in the file — they exercise the same code path the
    user will hit at runtime when they say "hey jarvis, what time is
    it" and hear an answer back.
    """

    def test_transcript_triggers_llm_then_speak(self, monkeypatch):
        play_calls = _patch_play(monkeypatch)
        llm = _RecordingLLM(scripted_replies=["it is three p.m."])
        tts = _RecordingTTS(scripted_audio=SynthesizedAudio(
            pcm=b"\x00" * 200, sample_rate=22050, sample_width=2, channels=1,
        ))
        stt = _RecordingSTT(scripted_transcripts=["what time is it"])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            output_device_index=7,
            threshold=0.5,
            stt=stt,
            tts=tts,
            llm=llm,
            stt_max_record_s=0.05,
        )
        pipe._stt_available = True
        pipe._tts_available = True
        pipe._llm_available = True
        # Drive the same frame sequence the real loop would deliver.
        pipe._on_frame(_silence_frame())  # wake
        pipe._on_frame(_silence_frame())  # begin transcription + chunk
        time.sleep(0.08)
        pipe._on_frame(_silence_frame())  # exceed window → finish

        # LLM received the transcript:
        assert llm.requests == ["what time is it"]
        # TTS got the LLM reply:
        assert tts.texts_received == ["it is three p.m."]
        # Speaker got the synthesized audio:
        assert play_calls[0]["device"] == 7
        # Status reflects the whole loop:
        s = pipe.status()
        assert s.last_transcript == "what time is it"
        assert s.last_response == "it is three p.m."

    def test_fragment_transcript_stays_quiet(self, monkeypatch):
        # A residual false wake (TV phonetic near-collision) captures a
        # fragment like "it." — the box must NOT send it to the LLM and
        # must NOT speak, or it ends up chatting with the television.
        # Observed live on the single-box: wake at conf 1.00 off TV
        # audio, transcript 'it.', spoken reply into an empty room.
        play_calls = _patch_play(monkeypatch)
        llm = _RecordingLLM(scripted_replies=["should never be asked"])
        tts = _RecordingTTS(scripted_audio=SynthesizedAudio(
            pcm=b"\x00" * 200, sample_rate=22050, sample_width=2, channels=1,
        ))
        stt = _RecordingSTT(scripted_transcripts=["it."])
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            output_device_index=7,
            threshold=0.5,
            stt=stt,
            tts=tts,
            llm=llm,
            stt_max_record_s=0.05,
        )
        pipe._stt_available = True
        pipe._tts_available = True
        pipe._llm_available = True
        pipe._on_frame(_silence_frame())  # wake
        pipe._on_frame(_silence_frame())  # begin transcription + chunk
        time.sleep(0.08)
        pipe._on_frame(_silence_frame())  # exceed window → finish

        assert llm.requests == []           # fragment never reaches the LLM
        assert tts.texts_received == []     # nothing synthesized
        assert play_calls == []             # nothing spoken
        # The transcript still lands in status for diagnosis.
        assert pipe.status().last_transcript == "it."

    def test_llm_unavailable_does_not_break_wake_loop(self, monkeypatch):
        # If the orchestrator is down, the wake → STT → transcript path
        # still works (transcript visible in status), just no spoken
        # reply. Pipeline must NOT enter error state.
        _patch_play(monkeypatch)
        llm = _RecordingLLM(available=False)  # never reachable
        stt = _RecordingSTT(scripted_transcripts=["what time is it"])
        tts = _RecordingTTS()
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            output_device_index=0,
            threshold=0.5,
            stt=stt,
            tts=tts,
            llm=llm,
            stt_max_record_s=0.05,
        )
        pipe._stt_available = True
        pipe._tts_available = True
        pipe._llm_available = False  # simulated probe-fail at startup
        pipe._on_frame(_silence_frame())
        pipe._on_frame(_silence_frame())
        time.sleep(0.08)
        pipe._on_frame(_silence_frame())

        # Transcript landed:
        assert pipe.status().last_transcript == "what time is it"
        # No LLM call attempted (because llm_available is False, skip):
        assert llm.requests == []
        # No TTS playback:
        assert tts.texts_received == []
        # Pipeline NOT in error state:
        s = pipe.status()
        assert s.state in ("transcript_ready", "listening")

    def test_llm_raises_lands_in_error_state(self, monkeypatch):
        # Hard failure during reply() — orchestrator returned 500. The
        # error message surfaces via /voice/status.
        _patch_play(monkeypatch)
        llm = _RecordingLLM(raise_on_reply=True)
        stt = _RecordingSTT(scripted_transcripts=["what time is it"])
        tts = _RecordingTTS()
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            output_device_index=0,
            threshold=0.5,
            stt=stt,
            tts=tts,
            llm=llm,
            stt_max_record_s=0.05,
        )
        pipe._stt_available = True
        pipe._tts_available = True
        pipe._llm_available = True
        pipe._on_frame(_silence_frame())
        pipe._on_frame(_silence_frame())
        time.sleep(0.08)
        pipe._on_frame(_silence_frame())

        s = pipe.status()
        assert s.state == "error"
        assert "LLM blew up" in (s.error_message or "")
        # No speaking happened:
        assert tts.texts_received == []

    def test_llm_empty_reply_doesnt_speak(self, monkeypatch):
        # Operator could configure a model that returns "" on irrelevant
        # input. We should NOT push empty audio through Piper.
        _patch_play(monkeypatch)
        llm = _RecordingLLM(scripted_replies=[""])
        stt = _RecordingSTT(scripted_transcripts=["play some music"])
        tts = _RecordingTTS()
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            output_device_index=0,
            threshold=0.5,
            stt=stt,
            tts=tts,
            llm=llm,
            stt_max_record_s=0.05,
        )
        pipe._stt_available = True
        pipe._tts_available = True
        pipe._llm_available = True
        pipe._on_frame(_silence_frame())
        pipe._on_frame(_silence_frame())
        time.sleep(0.08)
        pipe._on_frame(_silence_frame())

        assert llm.requests == ["play some music"]
        assert tts.texts_received == []  # no Piper call for empty reply

    def test_status_exposes_llm_loaded_after_probe(self):
        llm = _RecordingLLM(available=True)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            llm=llm,
        )
        pipe.start()
        assert pipe.status().llm_loaded is True
        pipe.stop()

    def test_status_exposes_llm_loaded_false_when_unreachable(self):
        llm = _RecordingLLM(available=False)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            llm=llm,
        )
        pipe.start()
        assert pipe.status().llm_loaded is False
        pipe.stop()


# ────────────────────────────────────────────────────────────────────
# WARP-626 — streaming, sentence-chunked, per-sentence speak
# ────────────────────────────────────────────────────────────────────


class _StreamingLLM(LLMClient):
    """Client whose reply_stream yields SCRIPTED deltas — exercises the
    multi-delta pipeline path so we can prove the chunker spans delta
    boundaries end to end (the future-proofing for WARP-1442 token
    streaming)."""

    def __init__(self, deltas, available=True):
        self._deltas = list(deltas)
        self._available = available
        self.requests: list[str] = []
        self.stream_tool_choices: list = []

    @property
    def available(self) -> bool:
        return self._available

    def reply(self, user_text: str, *, tool_choice=None) -> str:
        # Present for the abstract contract; the streaming path uses
        # reply_stream, so this is only the blocking fallback shape.
        return "".join(self._deltas)

    def reply_stream(self, user_text: str, *, tool_choice=None):
        self.requests.append(user_text)
        self.stream_tool_choices.append(tool_choice)
        for delta in self._deltas:
            yield delta


class _ProbingTTS(TextToSpeech):
    """TTS that, DURING each synthesize call, records the pipeline state and
    the result of a re-entrant speak() attempt. Proves the utterance holds
    ONE speak-lock and stays in 'speaking' across every sentence (the lock
    isn't released/re-acquired per sentence). Optionally raises on the Nth
    call to model a mid-utterance synth failure."""

    def __init__(self, raise_on_call: Optional[int] = None):
        self.pipe: Optional[WakePipeline] = None
        self._raise_on_call = raise_on_call
        self.texts_received: list[str] = []
        self.states_during: list[str] = []
        self.reentrant_results: list[dict] = []

    @property
    def available(self) -> bool:
        return True

    def synthesize(self, text: str, voice: Optional[str] = None) -> SynthesizedAudio:
        self.texts_received.append(text)
        if self.pipe is not None:
            self.states_during.append(self.pipe.status().state)
            # A concurrent speak() must be rejected while the utterance holds
            # the lock — non-reentrant threading.Lock, same thread here.
            self.reentrant_results.append(self.pipe.speak("intruder"))
        if self._raise_on_call is not None and len(self.texts_received) == self._raise_on_call:
            raise TTSUnavailable("synth failed on chunk (test)")
        return SynthesizedAudio(
            pcm=b"\x00" * 200, sample_rate=22050, sample_width=2, channels=1,
        )


class _RecordingReporter(ActivityReporter):
    """Captures emitted activity event types in order."""

    def __init__(self):
        self.events: list[str] = []

    def report(self, type_, *, at, score=None, threshold=None, model=None) -> None:
        self.events.append(type_)


class TestStreamingChunkedSpeak:
    """The WARP-626 win: a multi-sentence reply is chunked and each sentence
    is synthesized + played on its own, under ONE utterance's lock / state /
    cooldown. `_default_on_transcript` is invoked directly — the same entry
    the pipeline thread uses after `_finish_transcription` (state is
    'transcript_ready' at that point)."""

    def _wire(self, monkeypatch, llm, tts, reporter=None, detector=None):
        _patch_play(monkeypatch)
        pipe = WakePipeline(
            detector=detector or MockWakeWordDetector(),
            input_device_index=0,
            output_device_index=0,
            threshold=0.5,
            tts=tts,
            llm=llm,
            activity_reporter=reporter,
        )
        pipe._tts_available = True
        pipe._llm_available = True
        pipe._state = "transcript_ready"  # what _finish_transcription sets
        return pipe

    def test_multi_sentence_reply_synthesizes_each_sentence_in_order(self, monkeypatch):
        reporter = _RecordingReporter()
        llm = _RecordingLLM(
            scripted_replies=["The camera is online. The network looks good."],
        )
        tts = _RecordingTTS()
        pipe = self._wire(monkeypatch, llm, tts, reporter)
        pipe._default_on_transcript("what's the status")
        # One reply → two sentences → two ordered synth calls.
        assert tts.texts_received == [
            "The camera is online.",
            "The network looks good.",
        ]

    def test_last_response_reflects_the_full_spoken_reply(self, monkeypatch):
        llm = _RecordingLLM(
            scripted_replies=["The camera is online. The network looks good."],
        )
        tts = _RecordingTTS()
        pipe = self._wire(monkeypatch, llm, tts)
        pipe._default_on_transcript("what's the status")
        assert pipe.status().last_response == (
            "The camera is online. The network looks good."
        )

    def test_multi_delta_stream_chunks_span_delta_boundaries(self, monkeypatch):
        # The sentence "The camera is online." spans the first two deltas —
        # the chunker must stitch it back before synth. This is the same
        # code path that moves first-audio even earlier once WARP-1442 lands
        # server-side token streaming.
        llm = _StreamingLLM(deltas=["The camera ", "is online. All ", "good here now."])
        tts = _RecordingTTS()
        pipe = self._wire(monkeypatch, llm, tts)
        pipe._default_on_transcript("status please")
        assert tts.texts_received == [
            "The camera is online.",
            "All good here now.",
        ]
        assert llm.requests == ["status please"]  # streamed, not blocking-replied

    def test_single_speak_lock_and_speaking_state_across_sentences(self, monkeypatch):
        tts = _ProbingTTS()
        llm = _RecordingLLM(
            scripted_replies=["First sentence here. Second sentence here."],
        )
        pipe = self._wire(monkeypatch, llm, tts)
        tts.pipe = pipe
        pipe._default_on_transcript("go now please")
        assert tts.texts_received == [
            "First sentence here.",
            "Second sentence here.",
        ]
        # State was 'speaking' during BOTH sentences (never restored between).
        assert tts.states_during == ["speaking", "speaking"]
        # A concurrent speak() during EACH sentence was rejected — one lock
        # held for the whole utterance, not re-acquired per sentence.
        assert [r.get("error") for r in tts.reentrant_results] == [
            "already_speaking",
            "already_speaking",
        ]

    def test_one_post_speak_cooldown_after_the_last_sentence(self, monkeypatch):
        tts = _RecordingTTS()
        llm = _RecordingLLM(
            scripted_replies=["First one here now. Second one here now."],
        )
        pipe = self._wire(
            monkeypatch, llm, tts,
            detector=_ScriptedDetector([{"hey_jarvis": 0.99}]),
        )
        before = time.time()
        pipe._default_on_transcript("go now please")
        # Cooldown stamped once, at the true end of the utterance.
        assert pipe._speak_ended_at is not None
        assert pipe._speak_ended_at >= before
        assert time.time() - pipe._speak_ended_at < pipe._post_speak_cooldown_s
        # And wake detection honours it: a high-scoring frame inside the
        # window does NOT fire a new turn mid-cooldown.
        fires: list[WakeEvent] = []
        pipe._on_wake = fires.append
        pipe._run_wake_detect(_silence_frame())
        assert fires == []

    def test_wake_answered_emitted_exactly_once_for_multi_sentence(self, monkeypatch):
        reporter = _RecordingReporter()
        llm = _RecordingLLM(
            scripted_replies=["The camera is online. The network looks good."],
        )
        tts = _RecordingTTS()
        pipe = self._wire(monkeypatch, llm, tts, reporter)
        pipe._default_on_transcript("what's the status")
        # One outcome row for the whole utterance — not one per sentence.
        assert reporter.events.count("wake_answered") == 1
        assert reporter.events.count("wake_heard") == 0

    def test_greeting_single_sentence_speaks_once_via_intent_gate(self, monkeypatch):
        reporter = _RecordingReporter()
        llm = _RecordingLLM(scripted_replies=["Good morning to you."])
        tts = _RecordingTTS()
        pipe = self._wire(monkeypatch, llm, tts, reporter)
        pipe._default_on_transcript("good morning")
        assert tts.texts_received == ["Good morning to you."]
        assert reporter.events.count("wake_answered") == 1
        # Intent gate still threads tool_choice="none" through the stream.
        assert llm.tool_choices == ["none"]

    def test_mid_utterance_tts_failure_arms_cooldown_and_surfaces_error(self, monkeypatch):
        # Sentence 1 synthesizes + plays; sentence 2's synth blows up. The
        # partial reply drove the speaker, so the anti-feedback cooldown must
        # engage, and the fault must surface via /voice/status.
        reporter = _RecordingReporter()
        tts = _ProbingTTS(raise_on_call=2)
        llm = _RecordingLLM(
            scripted_replies=["First sentence here. Second sentence here."],
        )
        pipe = self._wire(
            monkeypatch, llm, tts, reporter,
            detector=_ScriptedDetector([{"hey_jarvis": 0.99}]),
        )
        tts.pipe = pipe
        pipe._default_on_transcript("go now please")
        # Both sentences were attempted (synth called twice), the second raised.
        assert tts.texts_received == [
            "First sentence here.",
            "Second sentence here.",
        ]
        s = pipe.status()
        assert s.state == "error"
        assert "synth failed" in (s.error_message or "")
        # Cooldown armed because sentence 1 drove the speaker.
        assert pipe._speak_ended_at is not None
        # A partial/failed reply is honestly "heard", not "answered".
        assert reporter.events.count("wake_answered") == 0
        assert reporter.events.count("wake_heard") == 1

    def test_llm_stream_break_mid_utterance_arms_cooldown(self, monkeypatch):
        # The SSE stream raises after sentence 1 has played. Same contract as
        # a mid-utterance synth failure: cooldown armed, error surfaced,
        # "heard" not "answered".
        def _broken_stream():
            yield "The camera is online. "
            raise LLMUnavailable("stream dropped mid-reply (test)")

        class _BrokenStreamLLM(LLMClient):
            def __init__(self):
                self.requests = []

            @property
            def available(self):
                return True

            def reply(self, user_text, *, tool_choice=None):
                return ""

            def reply_stream(self, user_text, *, tool_choice=None):
                self.requests.append(user_text)
                yield from _broken_stream()

        reporter = _RecordingReporter()
        llm = _BrokenStreamLLM()
        tts = _RecordingTTS()
        pipe = self._wire(monkeypatch, llm, tts, reporter)
        pipe._default_on_transcript("status please")
        # Sentence 1 spoke before the break.
        assert tts.texts_received == ["The camera is online."]
        s = pipe.status()
        assert s.state == "error"
        assert "stream dropped" in (s.error_message or "")
        assert pipe._speak_ended_at is not None  # cooldown armed after partial audio
        assert reporter.events.count("wake_heard") == 1

    def test_mid_utterance_failure_closes_the_sse_stream(self, monkeypatch):
        # A mid-utterance TTS failure must tear down the LLM reply stream
        # (GeneratorExit) so the orchestrator sees the client disconnect and
        # aborts its agent loop (WARP-329) — no reply generated into a void.
        closed = {"flag": False}

        class _CloseTrackingLLM(LLMClient):
            def __init__(self):
                self.requests: list[str] = []

            @property
            def available(self):
                return True

            def reply(self, user_text, *, tool_choice=None):
                return ""

            def reply_stream(self, user_text, *, tool_choice=None):
                self.requests.append(user_text)
                try:
                    yield "First sentence here. Second sentence here. Third one here."
                except GeneratorExit:
                    closed["flag"] = True
                    raise

        tts = _ProbingTTS(raise_on_call=2)  # play sentence 1, fail on sentence 2
        llm = _CloseTrackingLLM()
        pipe = self._wire(
            monkeypatch, llm, tts,
            detector=_ScriptedDetector([{"hey_jarvis": 0.99}]),
        )
        tts.pipe = pipe
        pipe._default_on_transcript("go now please")
        # We bailed after sentence 2's synth raised, with sentence 3 still
        # pending in the stream — the stream was closed rather than drained.
        assert closed["flag"] is True
        assert tts.texts_received == [
            "First sentence here.",
            "Second sentence here.",
        ]


# ────────────────────────────────────────────────────────────────────
# Upstream re-probing — post-reboot resilience.
# Without this, an STT/TTS/LLM container that's slow to bind on boot
# leaves voice-io stuck at *_available=False forever, even
# after the container becomes ready. Boot races are common: whisper
# takes ~5 min on first run to download the small.en model; piper
# takes ~30 s to download a voice; ai-gateway needs Postgres up first.
# ────────────────────────────────────────────────────────────────────

class _FlippableSTT(StreamingSTT):
    """STT mock whose `available` flips at our command. Lets tests
    simulate an upstream that goes from down → up between probes."""

    def __init__(self, initial: bool = False):
        self._available = initial
        self.probe_count = 0

    @property
    def available(self) -> bool:
        self.probe_count += 1
        return self._available

    def session(self):
        raise NotImplementedError


class _FlippableTTS(TextToSpeech):
    def __init__(self, initial: bool = False):
        self._available = initial
        self.probe_count = 0

    @property
    def available(self) -> bool:
        self.probe_count += 1
        return self._available

    def synthesize(self, text, voice=None):
        raise NotImplementedError


class _FlippableLLM(LLMClient):
    def __init__(self, initial: bool = False):
        self._available = initial
        self.probe_count = 0

    @property
    def available(self) -> bool:
        self.probe_count += 1
        return self._available

    def reply(self, user_text, *, tool_choice=None):
        return ""


class TestUpstreamReprobing:
    def test_initial_probe_sets_flags_synchronously(self):
        # The first probe runs in start() — caller can read truthful
        # _stt_available immediately after, no waiting on the bg thread.
        stt = _FlippableSTT(initial=True)
        tts = _FlippableTTS(initial=True)
        llm = _FlippableLLM(initial=False)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            stt=stt, tts=tts, llm=llm,
            upstream_probe_interval_s=0,  # disable bg loop for this test
        )
        pipe.start()
        s = pipe.status()
        assert s.stt_loaded is True
        assert s.tts_loaded is True
        assert s.llm_loaded is False
        # Each upstream probed exactly once (the initial sync probe).
        assert stt.probe_count == 1
        assert tts.probe_count == 1
        assert llm.probe_count == 1
        pipe.stop()

    def test_periodic_reprobe_picks_up_late_upstream(self):
        # An STT that comes online AFTER startup must be detected by
        # the next bg probe tick. Without the bg loop, this regresses
        # to the cold-boot bug.
        stt = _FlippableSTT(initial=False)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            stt=stt,
            upstream_probe_interval_s=0.05,  # 50 ms tick for the test
        )
        pipe.start()
        # Initially down.
        assert pipe.status().stt_loaded is False
        # Simulate the upstream coming online.
        stt._available = True
        # Wait for the bg loop to tick at least once.
        time.sleep(0.15)
        assert pipe.status().stt_loaded is True
        pipe.stop()

    def test_periodic_reprobe_picks_up_lost_upstream(self):
        # The reverse: an upstream that goes DOWN after start should
        # also be detected so we surface it via /voice/status.
        stt = _FlippableSTT(initial=True)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            stt=stt,
            upstream_probe_interval_s=0.05,
        )
        pipe.start()
        assert pipe.status().stt_loaded is True
        stt._available = False
        time.sleep(0.15)
        assert pipe.status().stt_loaded is False
        pipe.stop()

    def test_zero_probe_interval_disables_bg_loop(self):
        # Tests + dev contexts can disable the periodic re-probe by
        # passing 0. The initial sync probe still runs.
        stt = _FlippableSTT(initial=True)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            stt=stt,
            upstream_probe_interval_s=0,
        )
        pipe.start()
        baseline = stt.probe_count  # 1, from initial probe
        time.sleep(0.2)
        assert stt.probe_count == baseline  # no further probes
        pipe.stop()

    def test_bg_thread_stops_cleanly_on_pipeline_stop(self):
        # No leaked timer threads — leaks would break test parallelism.
        stt = _FlippableSTT(initial=True)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            stt=stt,
            upstream_probe_interval_s=0.05,
        )
        pipe.start()
        time.sleep(0.1)  # let bg loop run a tick
        assert pipe._probe_thread is not None
        assert pipe._probe_thread.is_alive()
        pipe.stop()
        # stop() joins the thread.
        assert pipe._probe_thread is None

    def test_stable_state_doesnt_log_every_tick(self, caplog):
        # An always-down upstream shouldn't spam the log every interval.
        # Initial probe logs once; subsequent ticks where state is
        # unchanged should be silent.
        import logging as _logging
        stt = _FlippableSTT(initial=False)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            stt=stt,
            upstream_probe_interval_s=0.03,
        )
        with caplog.at_level(_logging.WARNING, logger="voice.pipeline"):
            pipe.start()
            time.sleep(0.15)  # ~5 bg ticks
            pipe.stop()
        # Initial "unreachable at startup" line, then nothing further
        # — same down state, no transitions.
        warnings_seen = [
            r for r in caplog.records
            if r.name == "voice.pipeline" and "STT" in r.message
        ]
        assert len(warnings_seen) == 1
        assert "at startup" in warnings_seen[0].message

    def test_transition_logs_on_recovery(self, caplog):
        # Down → up transition should emit ONE info line.
        import logging as _logging
        stt = _FlippableSTT(initial=False)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            stt=stt,
            upstream_probe_interval_s=0.03,
        )
        with caplog.at_level(_logging.INFO, logger="voice.pipeline"):
            pipe.start()
            stt._available = True
            time.sleep(0.1)
            pipe.stop()
        recovery_lines = [
            r for r in caplog.records
            if r.name == "voice.pipeline"
            and "STT" in r.message
            and "reachable" in r.message
            and "unreachable" not in r.message
        ]
        assert len(recovery_lines) == 1

    def test_operator_supplied_on_transcript_overrides_default(self, monkeypatch):
        # When the operator passes a custom on_transcript callback, the
        # default closed-loop behaviour is NOT invoked. Commit 8 may
        # want to dispatch via a different path; this contract pins it.
        _patch_play(monkeypatch)
        captured: list[str] = []
        llm = _RecordingLLM(scripted_replies=["should not be heard"])
        stt = _RecordingSTT(scripted_transcripts=["hello"])
        tts = _RecordingTTS()
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            output_device_index=0,
            threshold=0.5,
            stt=stt,
            tts=tts,
            llm=llm,
            on_transcript=captured.append,
            stt_max_record_s=0.05,
        )
        pipe._stt_available = True
        pipe._tts_available = True
        pipe._llm_available = True
        pipe._on_frame(_silence_frame())
        pipe._on_frame(_silence_frame())
        time.sleep(0.08)
        pipe._on_frame(_silence_frame())

        assert captured == ["hello"]
        # And the LLM was NOT called (operator's callback is in charge now):
        assert llm.requests == []
        assert tts.texts_received == []


class TestIntentClassifier:
    """`classify_tool_choice(transcript)` is the pure-function intent
    gate the pipeline calls on every transcript before dispatching to
    the LLM. Returns "none" for utterances that the system prompt
    already answers (greetings, time-of-day, who-are-you); None for
    everything else so the agent loop's default "auto" applies.

    The docstring on _INTENT_NO_TOOLS_PATTERNS pins that updates here
    MUST be paired with a test addition. Mirror that contract — every
    new regex pattern in pipeline.py gets a row in `should_be_none` or
    `should_be_auto` below.
    """

    @pytest.mark.parametrize("transcript", [
        # Greetings + check-ins
        "hello",
        "Hello",
        "hi",
        "hey",
        "yo",
        "sup",
        "hello there",
        "hey jarvis",
        "Hey Jarvis",
        "hey jarvis.",
        "hey jarvis!",
        "hey droplet",
        "hey assistant",
        "hello jarvis",
        # WARP-1431 — a bare "droplet" (the wake word said alone) is an
        # attention/greeting utterance the persona answers, same as
        # "hey droplet". Recognized as a standalone greeting and as a
        # bare address prefix on liveness / who-are-you check-ins.
        "droplet",
        "Droplet",
        "droplet.",
        "droplet!",
        "droplet, are you there",
        "droplet can you hear me",
        "droplet, who are you",
        "droplet what can you do",
        "hey droplet, are you there",
        "good morning",
        "good evening",
        "good afternoon, jarvis",
        "good night",
        "Hey Jarvis, can you hear me?",
        "can you hear me",
        "are you there?",
        "are you listening?",
        "do you hear me",
        # Time
        "what time is it",
        "What time is it?",
        "what's the time",
        "what is the time",
        "what time is it now",
        "what's the current time",
        "current time",
        "time now",
        "tell me the time",
        "do you know the time",
        "got the time?",
        # Date
        "what's the date",
        "what is the date",
        "what's today's date",
        "what day is it",
        "what day of the week is it",
        "what day is today",
        "what's today",
        # Who/what-are-you
        "who are you",
        "what's your name",
        "what is your name",
        "what are you",
        "what can you do",
        "are you jarvis",
        "are you there",
    ])
    def test_no_tools_for_context_only_utterances(self, transcript: str):
        assert classify_tool_choice(transcript) == "none"

    @pytest.mark.parametrize("transcript", [
        # Real appliance-state queries — must NOT be gated
        "list my cameras",
        "what cameras do I have",
        "show me the front door camera",
        "is the system OK?",
        "is the system healthy",
        "turn off the lights",
        "block the kid's phone",
        "what's on my calendar today",
        "any new reminders",
        "what's the weather like",  # not in our tools but not in our gate either
        # Greeting + real request — keep auto so the request gets a tool
        "hey jarvis, what cameras do I have",
        "hey jarvis, turn off the lights",
        "hello, is the system OK",
        # WARP-1431 — a bare "droplet" prefix must NOT swallow a real
        # command into the no-tools gate: these still route to the agent
        # loop so the tool actually fires.
        "droplet turn off the lights",
        "droplet what cameras do I have",
        "droplet list my cameras",
        # Empty / nonsense
        "",
        "   ",
    ])
    def test_auto_for_real_queries_and_edge_cases(self, transcript: str):
        assert classify_tool_choice(transcript) is None

    def test_none_input_returns_none(self):
        # Defensive: pipeline never passes None, but make sure the
        # signature handles it without raising.
        assert classify_tool_choice(None) is None  # type: ignore[arg-type]


class TestTranscriptActionable:
    """transcript_is_actionable — the fragment gate on the LLM→speak path.
    Pure-function contract: a real command always carries at least one
    word of ≥3 letters; ambient fragments captured by a residual false
    wake don't."""

    @pytest.mark.parametrize("transcript", [
        "it.",
        "uh",
        "ah.",
        "no",
        "ok",
        "",
        "   ",
        "a b c",
        "I'm ok",          # contractions of short words only
        "...",
        "24 7",            # digits aren't command words
    ])
    def test_fragments_are_not_actionable(self, transcript: str):
        assert transcript_is_actionable(transcript) is False

    @pytest.mark.parametrize("transcript", [
        "stop",
        "lights",
        "what time is it",
        "turn on the kitchen light",
        "what's the weather",
        "play some music",
        "who are you",
        "set a timer for ten minutes",
    ])
    def test_commands_are_actionable(self, transcript: str):
        assert transcript_is_actionable(transcript) is True

    def test_none_input_is_not_actionable(self):
        assert transcript_is_actionable(None) is False  # type: ignore[arg-type]


# ────────────────────────────────────────────────────────────────────
# Input-level tracking — rolling RMS inside the frame handler (WARP-1037)
# ────────────────────────────────────────────────────────────────────
#
# The ReSpeaker XVF3800's XMOS DSP has a known wedge mode: the USB audio
# stream stays open (so the pipeline sits in 'listening') but every frame
# is pure digital silence — the box reports healthy while deaf. The
# pipeline's own frame handler is the ONLY safe place to measure input
# level (a second InputStream on the same hw device risks ALSA EBUSY),
# so _on_frame tracks a rolling RMS + the wall time of the last frame
# carrying real signal, and status() computes a read-time flatline flag.


def _audio_frame(amplitude: int) -> np.ndarray:
    """Constant-amplitude int16 frame — RMS == amplitude exactly."""
    return np.full(WAKE_FRAME_SAMPLES, amplitude, dtype=np.int16)


def _quiet_pipe(**kwargs) -> WakePipeline:
    """Pipeline whose detector never fires, parked in 'listening'."""
    pipe = WakePipeline(
        detector=_ScriptedDetector([{"hey_jarvis": 0.0}]),
        input_device_index=0,
        threshold=0.5,
        **kwargs,
    )
    pipe._set_state("listening")
    return pipe


class TestDspAutoRecovery:
    """WARP-1409 — bounded in-app auto-recovery of a wedged XVF3800 DSP."""

    def _wedged_pipe(self, restart, **kwargs) -> WakePipeline:
        # Parked 'listening', flatlines almost immediately, with the
        # injected heal and (by default) a cooldown-free policy so each
        # tick re-attempts.
        kwargs.setdefault("dsp_recovery_cooldown_s", 0.0)
        pipe = _quiet_pipe(flatline_window_s=0.01, dsp_restart=restart, **kwargs)
        pipe._on_frame(_silence_frame())  # baseline frame starts the clock
        time.sleep(0.03)                  # elapse the flatline window
        assert pipe.status().input_flatlined is True
        return pipe

    def test_no_restart_callback_is_a_noop(self):
        pipe = _quiet_pipe(flatline_window_s=0.01)
        pipe._on_frame(_silence_frame())
        time.sleep(0.03)
        assert pipe.status().input_flatlined is True
        pipe._maybe_auto_recover_dsp()  # dsp_restart is None → no action
        s = pipe.status()
        assert s.dsp_restart_attempts == 0
        assert s.mic_fault == "flatlined"

    def test_wedge_triggers_one_restart(self):
        calls = []
        pipe = self._wedged_pipe(lambda: calls.append(1))
        pipe._maybe_auto_recover_dsp()
        assert len(calls) == 1
        s = pipe.status()
        assert s.dsp_restart_attempts == 1
        assert s.mic_fault == "wedged_restarting"
        assert s.dsp_last_restart_at is not None

    def test_cooldown_suppresses_back_to_back_restart(self):
        calls = []
        pipe = self._wedged_pipe(
            lambda: calls.append(1), dsp_recovery_cooldown_s=3600.0,
        )
        pipe._maybe_auto_recover_dsp()  # attempt 1
        pipe._maybe_auto_recover_dsp()  # inside cooldown → skipped
        assert len(calls) == 1
        assert pipe.status().dsp_restart_attempts == 1

    def test_bounded_attempts_then_escalates(self):
        calls = []
        pipe = self._wedged_pipe(
            lambda: calls.append(1), dsp_recovery_max_attempts=2,
        )
        pipe._maybe_auto_recover_dsp()  # attempt 1
        pipe._maybe_auto_recover_dsp()  # attempt 2
        pipe._maybe_auto_recover_dsp()  # cap reached → escalate, no call
        assert len(calls) == 2
        s = pipe.status()
        assert s.dsp_restart_attempts == 2
        assert s.mic_fault == "wedged_escalated"
        pipe._maybe_auto_recover_dsp()  # stays escalated, still no call
        assert len(calls) == 2

    def test_failing_restart_still_counts_and_escalates(self):
        calls = []

        def boom():
            calls.append(1)
            raise RuntimeError("xvf_host missing")

        pipe = self._wedged_pipe(boom, dsp_recovery_max_attempts=1)
        pipe._maybe_auto_recover_dsp()  # attempt 1 (exception caught)
        assert len(calls) == 1
        assert pipe.status().dsp_restart_attempts == 1
        pipe._maybe_auto_recover_dsp()  # cap → escalate
        assert pipe.status().mic_fault == "wedged_escalated"

    def test_recovery_resets_the_machine(self):
        calls = []
        pipe = self._wedged_pipe(lambda: calls.append(1))
        pipe._maybe_auto_recover_dsp()
        assert pipe.status().dsp_restart_attempts == 1
        # Real audio returns → no longer flatlined.
        pipe._on_frame(_audio_frame(1000))
        assert pipe.status().input_flatlined is False
        pipe._maybe_auto_recover_dsp()  # recovery edge → reset to nominal
        s = pipe.status()
        assert s.dsp_restart_attempts == 0
        assert s.mic_fault is None

    # ── Skipped (never-issued) restarts — WARP-1409 review finding ──
    # A heal that declines to act (an operator's manual
    # /voice/restart-processor holds the DSP lock) is NOT an attempt: no
    # `xvf_host REBOOT 1` reached the chip, so it must spend none of the
    # bounded budget and arm no cooldown.

    def test_skipped_restart_spends_no_attempt_and_arms_no_cooldown(self):
        calls = []

        def skip():
            calls.append(1)
            raise DspRestartSkipped("a manual restart is in flight")

        pipe = self._wedged_pipe(skip)
        pipe._maybe_auto_recover_dsp()
        assert len(calls) == 1  # the heal was invoked...
        s = pipe.status()
        assert s.dsp_restart_attempts == 0      # ...but issued nothing
        assert s.dsp_last_restart_at is None    # no cooldown armed
        assert s.mic_fault == "flatlined"       # not "wedged_restarting"

    def test_skip_genuinely_retries_on_the_next_tick(self):
        # A long cooldown is the sharp end of the bug: if a skip armed
        # `dsp_last_restart_at`, the retry tick would be suppressed for
        # an hour for a reboot that never happened.
        calls = []
        skipping = [True]

        def heal():
            if skipping[0]:
                raise DspRestartSkipped("a manual restart is in flight")
            calls.append(1)

        pipe = self._wedged_pipe(heal, dsp_recovery_cooldown_s=3600.0)
        pipe._maybe_auto_recover_dsp()          # skipped
        assert pipe.status().dsp_restart_attempts == 0
        skipping[0] = False
        pipe._maybe_auto_recover_dsp()          # must NOT be cooled down
        assert len(calls) == 1
        s = pipe.status()
        assert s.dsp_restart_attempts == 1
        assert s.dsp_last_restart_at is not None
        assert s.mic_fault == "wedged_restarting"

    def test_repeated_skips_never_exhaust_the_budget(self):
        # The reported failure mode: an operator holding the manual lock
        # across several probe ticks must not latch wedged_escalated
        # without a single real reboot behind it.
        skipping = [True]
        calls = []

        def heal():
            if skipping[0]:
                raise DspRestartSkipped("a manual restart is in flight")
            calls.append(1)

        pipe = self._wedged_pipe(heal, dsp_recovery_max_attempts=1)
        for _ in range(5):
            pipe._maybe_auto_recover_dsp()
        s = pipe.status()
        assert s.dsp_restart_attempts == 0
        assert s.mic_fault == "flatlined"   # NOT wedged_escalated
        assert calls == []
        # The lock frees → the budget is intact and the heal really runs.
        skipping[0] = False
        pipe._maybe_auto_recover_dsp()
        assert len(calls) == 1
        assert pipe.status().dsp_restart_attempts == 1

    def test_skip_after_a_real_attempt_preserves_the_earlier_attempt(self):
        # Rollback must restore the PRIOR bookkeeping, not zero it — an
        # attempt already spent stays spent, and its cooldown clock stays
        # anchored to the real reboot.
        calls = []
        skipping = [False]

        def heal():
            if skipping[0]:
                raise DspRestartSkipped("a manual restart is in flight")
            calls.append(1)

        pipe = self._wedged_pipe(heal, dsp_recovery_max_attempts=3)
        pipe._maybe_auto_recover_dsp()          # real attempt 1
        first_at = pipe.status().dsp_last_restart_at
        assert pipe.status().dsp_restart_attempts == 1
        assert first_at is not None
        skipping[0] = True
        pipe._maybe_auto_recover_dsp()          # skipped
        s = pipe.status()
        assert s.dsp_restart_attempts == 1
        assert s.dsp_last_restart_at == first_at
        assert s.mic_fault == "wedged_restarting"  # attempt 1 still in flight
        assert len(calls) == 1


class TestWindowedMeasure:
    """WARP-1410 — wizard measurements read the wake loop's ALREADY-OPEN
    stream. Opening a second one on the reSpeaker's exclusive hw device
    raised PortAudio -9985 for the whole time the assistant was listening,
    which dead-ended the calibration wizard on a healthy mic."""

    def test_collects_rms_and_peak_from_live_frames(self):
        pipe = _quiet_pipe()
        pipe._start_measure()
        for _ in range(4):
            pipe._on_frame(_audio_frame(1000))
        result = pipe._finish_measure()
        # Constant-1000 frames → RMS == peak == 1000 → 20·log10(1000/32768).
        assert result["rms_dbfs"] == pytest.approx(-30.31, abs=0.05)
        assert result["peak_dbfs"] == pytest.approx(-30.31, abs=0.05)

    def test_peak_tracks_the_loudest_frame(self):
        pipe = _quiet_pipe()
        pipe._start_measure()
        pipe._on_frame(_silence_frame())
        pipe._on_frame(_audio_frame(8000))
        pipe._on_frame(_silence_frame())
        result = pipe._finish_measure()
        # Peak comes from the loud frame; RMS is diluted by the silent ones,
        # which is exactly what the wizard's speech-peak step needs.
        assert result["peak_dbfs"] == pytest.approx(-12.26, abs=0.05)
        assert result["rms_dbfs"] < result["peak_dbfs"]

    def test_no_frames_raises_measurement_unavailable(self):
        pipe = _quiet_pipe()
        pipe._start_measure()
        with pytest.raises(MeasurementUnavailable):
            pipe._finish_measure()

    def test_non_capturing_state_refuses_to_measure(self):
        pipe = _quiet_pipe()
        pipe._set_state("no_mic")
        with pytest.raises(MeasurementUnavailable):
            pipe._start_measure()

    def test_concurrent_measurement_refused(self):
        pipe = _quiet_pipe()
        pipe._start_measure()
        with pytest.raises(MeasurementUnavailable):
            pipe._start_measure()

    def test_collector_is_disarmed_after_finish(self):
        pipe = _quiet_pipe()
        pipe._start_measure()
        pipe._on_frame(_audio_frame(1000))
        pipe._finish_measure()
        assert pipe._measure_collector is None
        # Frames after the window must not accumulate anywhere.
        pipe._on_frame(_audio_frame(1000))
        assert pipe._measure_collector is None

    def test_measure_input_blocks_then_returns_live_levels(self):
        pipe = _quiet_pipe()
        stop = threading.Event()

        def feeder():
            while not stop.is_set():
                pipe._on_frame(_audio_frame(1000))
                time.sleep(0.005)

        t = threading.Thread(target=feeder, daemon=True)
        t.start()
        try:
            result = pipe.measure_input(0.08)
        finally:
            stop.set()
            t.join(timeout=1.0)
        assert result["rms_dbfs"] == pytest.approx(-30.31, abs=0.5)
        assert pipe._measure_collector is None


class TestInputLevelTracking:
    def test_no_frames_yet_reports_none(self):
        pipe = _quiet_pipe()
        s = pipe.status()
        assert s.input_rms_dbfs is None
        assert s.last_audio_at is None

    def test_zero_frames_report_floor_rms_and_no_audio(self):
        pipe = _quiet_pipe()
        for _ in range(3):
            pipe._on_frame(_silence_frame())
        s = pipe.status()
        assert s.input_rms_dbfs == pytest.approx(RMS_DBFS_FLOOR)
        assert s.last_audio_at is None

    def test_real_audio_updates_rms_and_last_audio_at(self):
        pipe = _quiet_pipe()
        before = time.time()
        pipe._on_frame(_audio_frame(1000))
        s = pipe.status()
        # RMS of a constant-1000 frame = 1000 → 20·log10(1000/32768)
        assert s.input_rms_dbfs == pytest.approx(-30.31, abs=0.05)
        assert s.last_audio_at is not None
        assert s.last_audio_at >= before

    def test_rms_is_rolling_across_frames(self):
        # Half zero frames + half amplitude-1000 frames → rolling RMS
        # sits between the floor and the single-frame value: RMS of the
        # combined window is 1000/√2 → ≈ -33.3 dBFS.
        pipe = _quiet_pipe()
        for _ in range(5):
            pipe._on_frame(_silence_frame())
        for _ in range(5):
            pipe._on_frame(_audio_frame(1000))
        s = pipe.status()
        assert s.input_rms_dbfs == pytest.approx(-33.32, abs=0.05)

    def test_near_zero_dither_does_not_count_as_audio(self):
        # Amplitude-1 frames are ≈ -90 dBFS — below the default -70
        # flatline threshold. They must NOT refresh last_audio_at, or a
        # wedged DSP emitting 1-count dither would never flag.
        pipe = _quiet_pipe()
        pipe._on_frame(_audio_frame(1))
        assert pipe.status().last_audio_at is None

    def test_level_fields_are_json_safe_plain_floats(self):
        import json
        pipe = _quiet_pipe()
        pipe._on_frame(_audio_frame(1000))
        d = pipe.status().to_dict()
        assert isinstance(d["input_rms_dbfs"], float)
        assert isinstance(d["last_audio_at"], float)
        assert isinstance(d["input_flatlined"], bool)
        json.dumps(d)  # MUST NOT raise

    def test_default_constants(self):
        # Drift detectors — README + compose comments document these.
        assert DEFAULT_FLATLINE_WINDOW_S == 240.0
        assert DEFAULT_FLATLINE_DBFS == -70.0
        assert RMS_DBFS_FLOOR == -120.0


class TestFlatlineDegraded:
    def test_not_flatlined_before_window_elapses(self):
        pipe = _quiet_pipe(flatline_window_s=10.0)
        pipe._on_frame(_silence_frame())
        assert pipe.status().input_flatlined is False

    def test_flatlines_after_window_of_zero_frames(self):
        pipe = _quiet_pipe(flatline_window_s=0.05)
        pipe._on_frame(_silence_frame())  # baseline: first frame seen
        time.sleep(0.1)
        assert pipe.status().input_flatlined is True

    def test_near_zero_dither_still_flatlines(self):
        # A wedged DSP can emit ±1-count dither instead of exact zeros;
        # "at/near digital zero" must catch that too.
        pipe = _quiet_pipe(flatline_window_s=0.05)
        pipe._on_frame(_audio_frame(1))
        time.sleep(0.1)
        assert pipe.status().input_flatlined is True

    def test_real_audio_prevents_flatline(self):
        pipe = _quiet_pipe(flatline_window_s=0.05)
        pipe._on_frame(_audio_frame(1000))
        time.sleep(0.1)
        pipe._on_frame(_audio_frame(1000))  # refreshes last_audio_at
        assert pipe.status().input_flatlined is False

    def test_recovery_when_audio_returns(self):
        # The wedge cleared (DSP rebooted) → frames carry signal again →
        # the flag must drop without a container restart.
        pipe = _quiet_pipe(flatline_window_s=0.05)
        pipe._on_frame(_silence_frame())
        time.sleep(0.1)
        assert pipe.status().input_flatlined is True
        pipe._on_frame(_audio_frame(1000))
        s = pipe.status()
        assert s.input_flatlined is False
        assert s.last_audio_at is not None

    def test_only_listening_state_flatlines(self):
        # 'speaking' (mic frames dropped by design), 'error', 'no_mic'
        # must not flag — error/no_mic already 503 on their own, and
        # speaking is a normal signal-free window.
        for state in ("speaking", "error", "no_mic", "idle"):
            pipe = _quiet_pipe(flatline_window_s=0.05)
            pipe._on_frame(_silence_frame())
            pipe._set_state(state)
            time.sleep(0.1)
            assert pipe.status().input_flatlined is False, state

    def test_zero_window_disables_flatline_detection(self):
        pipe = _quiet_pipe(flatline_window_s=0.0)
        pipe._on_frame(_silence_frame())
        time.sleep(0.05)
        assert pipe.status().input_flatlined is False

    def test_no_frames_seen_never_flatlines(self):
        # Baseline is the first frame seen — with no frames at all there
        # is nothing to measure (that's 'no_mic' territory, not flatline).
        pipe = _quiet_pipe(flatline_window_s=0.01)
        time.sleep(0.05)
        assert pipe.status().input_flatlined is False


class TestFlatlineGainCompensation:
    """WARP-1060 (R1 from the WARP-1055 review) — the flatline gate is
    tuned in the effective (post-gain) domain, but frames are tracked
    raw (pre-gain, the F1 domain contract). The compare must therefore
    shift by 20·log10(input_gain): a quiet-but-healthy chain whose raw
    self-noise sits below -70 dBFS on a gained box must not read as
    "Mic processor not responding" after a silent flatline window."""

    # Constant-amplitude-5 frames: 20·log10(5/32768) ≈ -76.3 dBFS raw —
    # below the -70 default gate, above the gain-4 compensated gate
    # (-70 - 20·log10(4) ≈ -82.0).
    QUIET_CHAIN_AMPLITUDE = 5

    def test_raw_self_noise_counts_as_audio_under_gain(self):
        pipe = _quiet_pipe(input_gain=4.0)
        pipe._on_frame(_audio_frame(self.QUIET_CHAIN_AMPLITUDE))
        assert pipe.status().last_audio_at is not None

    def test_same_frames_do_not_count_without_gain(self):
        # Companion pin: the compensation comes from the gain, not from
        # a loosened default gate.
        pipe = _quiet_pipe(input_gain=1.0)
        pipe._on_frame(_audio_frame(self.QUIET_CHAIN_AMPLITUDE))
        assert pipe.status().last_audio_at is None

    def test_gained_box_does_not_false_flag_flatline(self):
        pipe = _quiet_pipe(flatline_window_s=0.05, input_gain=4.0)
        pipe._on_frame(_audio_frame(self.QUIET_CHAIN_AMPLITUDE))
        time.sleep(0.1)
        pipe._on_frame(_audio_frame(self.QUIET_CHAIN_AMPLITUDE))
        assert pipe.status().input_flatlined is False

    def test_wedge_dither_still_flatlines_under_gain(self):
        # ±1-count dither (≈ -90 dBFS) is the wedged-DSP signature; it
        # must stay below the compensated gate on a gained box.
        pipe = _quiet_pipe(flatline_window_s=0.05, input_gain=4.0)
        pipe._on_frame(_audio_frame(1))
        time.sleep(0.1)
        assert pipe.status().input_flatlined is True

    def test_live_calibration_gain_applies_to_the_gate(self):
        # set_input_gain (the wizard's live-apply) must move the gate
        # the same way the construct-time env gain does.
        pipe = _quiet_pipe()
        pipe.set_input_gain(4.0)
        pipe._on_frame(_audio_frame(self.QUIET_CHAIN_AMPLITUDE))
        assert pipe.status().last_audio_at is not None


# ────────────────────────────────────────────────────────────────────
# WARP-1619 — stop() must not claim a join it did not get
# ────────────────────────────────────────────────────────────────────
#
# The capture loop only re-checks `_shutdown` BETWEEN frames, and
# `_on_frame` runs the whole turn (LLM reply → TTS synthesize →
# `_play_pcm`, documented blocking) on that same thread. So a stop()
# issued mid-turn can hit its join timeout while the worker is still
# inside `with stream_cm as stream:` — i.e. with the exclusive mic
# InputStream STILL OPEN.
#
# To be precise about what that window is: no NEW audio is processed
# (the loop exits before the next `_on_frame`), so it is "the device is
# still held and the box is still speaking", not "it is still listening
# to you". What made it dangerous was that stop() cleared `_thread`
# unconditionally, destroying the only evidence that the worker — and
# the device — was still live. Everything downstream (the endpoint's
# 200, a re-enable opening a SECOND InputStream on an exclusive device)
# followed from that lost fact.


class _HeldStream:
    """InputStream stub that tracks its REAL open/closed state.

    Reads silence forever; the pipeline's own `_shutdown` check is what
    ends the session, which is exactly the code path under test.
    """

    def __init__(self) -> None:
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.closed = True
        return False

    def read(self, n):
        # A hair of sleep so the loop doesn't busy-spin a core while the
        # test drives it.
        time.sleep(0.001)
        return _silence_frame().reshape(-1, 1), False


class _HeldSoundDevice:
    """Mock sounddevice handing out `_HeldStream`s, counting opens and
    the process-wide PortAudio reset hooks."""

    def __init__(self) -> None:
        self.streams: list[_HeldStream] = []
        self.terminate_calls = 0
        self.initialize_calls = 0

    def _terminate(self) -> None:
        self.terminate_calls += 1

    def _initialize(self) -> None:
        self.initialize_calls += 1

    def query_devices(self, index=None):
        return {"max_input_channels": 1}

    def InputStream(self, **kwargs):  # noqa: N802 — matches real API
        stream = _HeldStream()
        self.streams.append(stream)
        return stream


class _TurnBlockingDetector(WakeWordDetector):
    """Blocks inside predict() to stand in for a turn in progress.

    The real blocker is `_play_pcm`, several frames deeper. What matters
    for stop() is the POSITION, which is identical: on the capture
    thread, inside `_on_frame`, after `stream.read()`, with the
    InputStream open and the `_shutdown` re-check still one frame away.
    """

    def __init__(self) -> None:
        self.in_turn = threading.Event()
        self.finish_turn = threading.Event()

    @property
    def model_name(self) -> str:
        return "turn-blocking"

    @property
    def loaded(self) -> bool:
        return True

    def predict(self, audio_frame: np.ndarray) -> dict[str, float]:
        self.in_turn.set()
        # Bounded so a broken test fails instead of hanging the suite.
        self.finish_turn.wait(timeout=30.0)
        return {}


class TestStopReportsTheJoin:
    def test_stop_returns_true_when_the_worker_really_exits(self):
        fake_sd = _HeldSoundDevice()
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            sd_module=fake_sd,
            upstream_probe_interval_s=0.0,
        )
        pipe.start()
        # Wait for the stream to actually open before stopping.
        deadline = time.time() + 5.0
        while not fake_sd.streams and time.time() < deadline:
            time.sleep(0.005)
        assert fake_sd.streams, "the worker never opened a stream"

        assert pipe.stop(timeout=5.0) is True
        assert pipe.running is False
        # The OS-level fact, not a module reference: the stream closed.
        assert fake_sd.streams[0].closed is True

    def test_stop_returns_false_and_stays_running_on_a_timed_out_join(self):
        detector = _TurnBlockingDetector()
        fake_sd = _HeldSoundDevice()
        pipe = WakePipeline(
            detector=detector,
            input_device_index=0,
            sd_module=fake_sd,
            upstream_probe_interval_s=0.0,
        )
        pipe.start()
        assert detector.in_turn.wait(timeout=5.0), "the turn never started"
        try:
            # The turn outlives the join budget — this is the reported bug.
            assert pipe.stop(timeout=0.2) is False
            # …and the pipeline says so, because the mic really IS held:
            # the stream the worker is sitting inside is still open.
            assert pipe.running is True
            assert fake_sd.streams[0].closed is False
        finally:
            detector.finish_turn.set()
        # Once the turn ends, the worker leaves and the device is freed.
        assert pipe.stop(timeout=5.0) is True
        assert pipe.running is False
        assert fake_sd.streams[0].closed is True

    def test_stop_stays_idempotent(self):
        fake_sd = _HeldSoundDevice()
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            sd_module=fake_sd,
            upstream_probe_interval_s=0.0,
        )
        pipe.start()
        assert pipe.stop(timeout=5.0) is True
        # A second stop on an already-stopped pipeline is a no-op that
        # still reports success — nothing is holding anything.
        assert pipe.stop(timeout=5.0) is True
        assert pipe.running is False
        assert pipe.status().state == "idle"


# ────────────────────────────────────────────────────────────────────
# WARP-2213 — capture-rate negotiation.
#
# The wake path used to open the mic at a hardcoded WAKE_SAMPLE_RATE
# (16 kHz). Most capture hardware does not offer 16 kHz: the appliance's
# onboard ALC897 advertises {44100, 48000, 96000} and the ReSpeaker
# XVF3800's USB interface runs at 48 kHz. On such a device every open
# failed with PortAudio -9997, so the self-heal loop reopened forever and
# the box was permanently deaf while reporting a tidy 'no_mic'.
# ────────────────────────────────────────────────────────────────────

class _RateAwareStream:
    """InputStream stub that hands back blocks of the size it was opened
    with, so a resampling pipeline is exercised for real."""

    def __init__(self, blocksize, channels, sessions, shutdown_event):
        self.blocksize = blocksize
        self.channels = channels
        self._remaining = sessions
        self._shutdown = shutdown_event

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self, n):
        assert n == self.blocksize, (
            f"read({n}) but stream opened with blocksize={self.blocksize}"
        )
        if self._remaining <= 0:
            self._shutdown.set()
            return np.zeros((n, self.channels), dtype=np.int16), False
        self._remaining -= 1
        # A ramp rather than zeros so the resampler has real signal to
        # chew on — silence would hide an amplitude or dtype bug.
        ramp = (np.arange(n) % 64).astype(np.int16) * 200
        return np.tile(ramp.reshape(-1, 1), (1, self.channels)), False


class _RateAwareSoundDevice:
    """Fake sd whose check_input_settings accepts ONLY `supported` rates —
    modelling a real codec's advertised rate list."""

    class PortAudioError(Exception):
        pass

    def __init__(self, supported, shutdown_event, channels=1, sessions=3):
        self.supported = set(supported)
        self._shutdown = shutdown_event
        self._channels = channels
        self._sessions = sessions
        self.opened_with: dict = {}
        self.checked: list = []

    def query_devices(self, index=None):
        return {"max_input_channels": self._channels}

    def check_input_settings(self, device=None, samplerate=None,
                             channels=None, dtype=None):
        self.checked.append(samplerate)
        if samplerate not in self.supported:
            raise self.PortAudioError(
                f"Invalid sample rate [PaErrorCode -9997] ({samplerate})",
            )

    def InputStream(self, **kwargs):  # noqa: N802 — matches real API
        self.opened_with = dict(kwargs)
        if kwargs["samplerate"] not in self.supported:
            raise self.PortAudioError(
                "Error opening InputStream: Invalid sample rate "
                "[PaErrorCode -9997]",
            )
        return _RateAwareStream(
            kwargs["blocksize"], kwargs["channels"],
            self._sessions, self._shutdown,
        )

    def _terminate(self):
        pass

    def _initialize(self):
        pass


def _run_rate_pipeline(fake_sd, detector, shutdown_event):
    pipe = WakePipeline(
        detector=detector,
        input_device_index=3,
        threshold=0.99,
        sd_module=fake_sd,
        recover_backoff_initial_s=0.0,
        recover_backoff_max_s=0.0,
    )
    pipe._shutdown = shutdown_event
    pipe._loop()
    return pipe


class TestCaptureRateNegotiation:
    def test_device_supporting_16k_opens_at_16k_unresampled(self):
        """A 16 kHz-capable mic (the ReSpeaker USB 4-Mic Array) must keep
        the original zero-resample path — 16 kHz is probed FIRST."""
        ev = threading.Event()
        sd = _RateAwareSoundDevice({16000, 48000}, ev)
        det = _FrameRecordingDetector()
        _run_rate_pipeline(sd, det, ev)
        assert sd.opened_with["samplerate"] == 16000
        assert sd.opened_with["blocksize"] == WAKE_FRAME_SAMPLES
        assert sd.checked[0] == 16000, "16 kHz must be probed first"

    def test_48k_only_device_opens_at_48k_and_downsamples(self):
        """THE REGRESSION THIS FIXES — the ALC897 / XVF3800 case. 16 kHz is
        refused, so the stream opens at 48 kHz reading 3840-sample blocks,
        and the detector still sees exactly 1280-sample 16 kHz frames."""
        ev = threading.Event()
        sd = _RateAwareSoundDevice({44100, 48000, 96000}, ev)
        det = _FrameRecordingDetector()
        _run_rate_pipeline(sd, det, ev)
        assert sd.opened_with["samplerate"] == 48000
        assert sd.opened_with["blocksize"] == WAKE_FRAME_SAMPLES * 3
        assert det.frames, "detector received no frames"
        for f in det.frames:
            assert f.shape == (WAKE_FRAME_SAMPLES,), (
                f"detector got {f.shape}, expected ({WAKE_FRAME_SAMPLES},) "
                "— the resampled frame length must be exact"
            )
            assert f.dtype == np.int16

    def test_44k1_only_device_still_yields_exact_frames(self):
        """44100 is not an integer multiple of 16000, but 1280*44100/16000
        is still exactly 3528 — so frames stay exact with no carry buffer."""
        ev = threading.Event()
        sd = _RateAwareSoundDevice({44100}, ev)
        det = _FrameRecordingDetector()
        _run_rate_pipeline(sd, det, ev)
        assert sd.opened_with["samplerate"] == 44100
        assert sd.opened_with["blocksize"] == 3528
        for f in det.frames:
            assert f.shape == (WAKE_FRAME_SAMPLES,)

    def test_stereo_48k_array_downmixes_then_resamples(self):
        """The ReSpeaker XVF3800 shape: 2-channel capture, 48 kHz only."""
        ev = threading.Event()
        sd = _RateAwareSoundDevice({48000}, ev, channels=2)
        det = _FrameRecordingDetector()
        _run_rate_pipeline(sd, det, ev)
        assert sd.opened_with["channels"] == 2
        assert sd.opened_with["samplerate"] == 48000
        for f in det.frames:
            assert f.shape == (WAKE_FRAME_SAMPLES,), (
                "a 2ch 48 kHz array must still yield mono 16 kHz frames"
            )

    def test_device_accepting_no_candidate_rate_parks_in_no_mic(self):
        """A device that accepts nothing is a recoverable park, not a
        crash — a re-plug may well present a usable rate."""
        ev = threading.Event()
        sd = _RateAwareSoundDevice({22050}, ev)  # in no candidate list
        det = _FrameRecordingDetector()
        pipe = WakePipeline(
            detector=det, input_device_index=3, threshold=0.99,
            sd_module=sd, recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
        )
        pipe._shutdown = ev
        pipe._reresolve_input_device = lambda *a, **k: ev.set()  # type: ignore
        pipe._loop()
        assert pipe.status().state == "no_mic"
        assert not det.frames

    def test_binding_without_check_input_settings_uses_16k(self):
        """The fake sd the rest of this suite injects exposes no
        check_input_settings — those callers must keep the old behaviour
        rather than hit a probe the fake cannot answer."""
        ev = threading.Event()
        sd = _FakeSoundDevice([_silence_frame()] * 2, ev)
        det = _FrameRecordingDetector()
        pipe = WakePipeline(
            detector=det, input_device_index=7, threshold=0.99, sd_module=sd,
        )
        pipe._shutdown = ev
        pipe._loop()
        assert sd.opened_with["samplerate"] == 16000
        assert sd.opened_with["blocksize"] == WAKE_FRAME_SAMPLES


class TestRecoverFailureLogDeduplication:
    """A permanently-absent mic emitted ~690 identical WARNING lines an
    hour, rotating the 10 MB container log roughly daily and destroying
    the diagnostic history of everything else in it. The retry CADENCE is
    deliberately unchanged — only the logging is de-duplicated."""

    def _pipe(self):
        return WakePipeline(
            detector=MockWakeWordDetector(), input_device_index=None,
            threshold=0.5,
        )

    def test_identical_reason_warns_once_then_stays_quiet(self, caplog):
        import logging as _logging
        pipe = self._pipe()
        err = OSError("Invalid sample rate [PaErrorCode -9997]")
        with caplog.at_level(_logging.WARNING, logger="voice.pipeline"):
            for _ in range(50):
                pipe._note_recover_failure(err)
        warns = [
            r for r in caplog.records
            if r.levelno == _logging.WARNING
            and "recoverable audio-device error" in r.getMessage()
        ]
        assert len(warns) == 1, (
            f"50 identical failures produced {len(warns)} WARNING lines; "
            "expected exactly 1"
        )

    def test_changed_reason_warns_again(self, caplog):
        import logging as _logging
        pipe = self._pipe()
        with caplog.at_level(_logging.WARNING, logger="voice.pipeline"):
            pipe._note_recover_failure(OSError("rate rejected"))
            pipe._note_recover_failure(OSError("rate rejected"))
            pipe._note_recover_failure(OSError("device disconnected"))
        warns = [
            r for r in caplog.records
            if r.levelno == _logging.WARNING
            and "recoverable audio-device error" in r.getMessage()
        ]
        assert len(warns) == 2, "a NEW failure reason must warn again"

    def test_persistent_failure_is_restated_periodically(self, caplog):
        import logging as _logging
        pipe = self._pipe()
        err = OSError("still no mic")
        with caplog.at_level(_logging.INFO, logger="voice.pipeline"):
            for _ in range(pipe._RECOVER_RESTATE_EVERY + 1):
                pipe._note_recover_failure(err)
        restates = [
            r for r in caplog.records if "unresolved after" in r.getMessage()
        ]
        assert len(restates) == 1, (
            "a long-running identical failure must be restated so it does "
            "not become invisible forever"
        )
        assert restates[0].levelno == _logging.WARNING, (
            "the restatement carries the ONLY signal that a dead mic is "
            "still dead — alerting keyed on level=WARNING must still see "
            "it, so throttling it must not also demote it"
        )


class TestCaptureRateCandidatesAreShared:
    """One tuple, one home. The wake loop and the one-shot record() paths
    negotiating against DIFFERENT candidate lists is a silent desync: a
    rate added for the ReSpeaker in one file would leave the other still
    refusing the device."""

    def test_pipeline_reuses_the_audio_io_tuple(self):
        assert (
            pipeline_module.CAPTURE_RATE_CANDIDATES
            is audio_io.CAPTURE_RATE_CANDIDATES
        )

    def test_every_candidate_divides_a_wake_frame_exactly(self):
        """The wake loop reads WAKE_FRAME_SAMPLES * rate / WAKE_SAMPLE_RATE
        samples per block and resamples that to exactly one 1280-sample
        frame — no carry buffer. A candidate that does not divide evenly
        would introduce drift, and the tuple now lives in a module that
        knows nothing about WAKE_FRAME_SAMPLES."""
        for rate in audio_io.CAPTURE_RATE_CANDIDATES:
            assert (WAKE_FRAME_SAMPLES * rate) % WAKE_SAMPLE_RATE == 0, (
                f"{rate} Hz does not yield a whole number of "
                f"{WAKE_SAMPLE_RATE} Hz frames"
            )


class TestResamplerBuiltOncePerStreamOpen:
    """resample_int16 re-derives the ratio and re-designs a Kaiser FIR on
    every call. In the wake loop that is once per ~80 ms block, forever,
    on exactly the non-16 kHz hardware this path exists to serve. The rate
    pair is fixed for the life of a capture session."""

    def test_filter_is_not_redesigned_on_every_frame(self, monkeypatch):
        ev = threading.Event()
        sd = _RateAwareSoundDevice({48000}, ev, sessions=6)
        det = _FrameRecordingDetector()
        builds: list = []
        real = pipeline_module.make_int16_resampler

        def _counting(src_rate, dst_rate):
            builds.append((src_rate, dst_rate))
            return real(src_rate, dst_rate)

        monkeypatch.setattr(
            pipeline_module, "make_int16_resampler", _counting,
        )
        _run_rate_pipeline(sd, det, ev)
        assert len(det.frames) >= 6, "the loop must have read real frames"
        assert builds == [(48000, WAKE_SAMPLE_RATE)], (
            f"expected ONE resampler build per stream-open, got {builds}"
        )

    def test_resampled_frames_match_the_uncached_helper(self):
        """Caching the filter must not change a single sample."""
        ev = threading.Event()
        sd = _RateAwareSoundDevice({48000}, ev, sessions=2)
        det = _FrameRecordingDetector()
        _run_rate_pipeline(sd, det, ev)
        assert det.frames
        raw = (np.arange(WAKE_FRAME_SAMPLES * 3) % 64).astype(np.int16) * 200
        expected = audio_io.resample_int16(raw, 48000, WAKE_SAMPLE_RATE)
        assert np.array_equal(det.frames[0], expected)
