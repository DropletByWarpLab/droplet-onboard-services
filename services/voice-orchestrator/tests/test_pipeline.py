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
    DEFAULT_STT_MAX_RECORD_S,
    DEFAULT_THRESHOLD,
    DEFAULT_VISUAL_DECAY_S,
    PipelineStatus,
    WakePipeline,
)
from voice.stt import MockSTT, STTUnavailable, StreamingSTT
from voice.tts import MockTTS, SynthesizedAudio, TextToSpeech, TTSUnavailable
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
        # Drift detector — make sure README's "5-second post-wake window"
        # documentation still matches the default.
        assert DEFAULT_STT_MAX_RECORD_S == 5.0


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
