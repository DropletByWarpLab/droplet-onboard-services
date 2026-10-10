"""WARP-3934 - capture-liveness watchdog.

The incident: the reSpeaker XVF3800 re-enumerated on USB and Debian's
libportaudio2 19.6.0 busy-spun inside ``stream.read()`` instead of raising,
so the capture thread never returned to Python and every in-process
recovery (reopen flag, ``_DeviceError``, the DSP reboot budget) was dead.
The watchdog runs on the scheduler ticks and exits the process so the
container supervisor restarts voice-io.

What is judged is the time the capture thread has spent inside ONE
PortAudio call (``_capture_io_since``), not the pipeline state: a device
that drops mid-capture wedges ``read()`` in ``transcribing`` exactly as it
does in ``listening``, while a voice turn (LLM + TTS + playback on the same
thread, outside any PortAudio call) must never trip it however long it runs.

The "C spin" is simulated with a read (or an open) that blocks on a
threading.Event. sounddevice is fully mocked - no audio hardware is touched.
"""
from __future__ import annotations

import os
import threading
import time

import numpy as np
import pytest

from voice import pipeline as pipeline_mod
from voice.pipeline import DEFAULT_CAPTURE_STALL_S, WakePipeline
from voice.wake import MockWakeWordDetector, WakeWordDetector

STALL_S = 0.05


class _BlockingStream:
    """Returns `flowing_reads` frames, then blocks like a wedged C call."""

    def __init__(self, release: threading.Event, flowing_reads: int):
        self._release = release
        self._left = flowing_reads

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n):
        if self._left > 0:
            self._left -= 1
            time.sleep(0.005)
        else:
            self._release.wait(10.0)  # the busy-spin on the dead device node
        return np.zeros((n, 1), dtype=np.int16), False


class _FakeSd:
    def __init__(self, release: threading.Event, flowing_reads: int):
        self._release = release
        self._flowing = flowing_reads

    def InputStream(self, **kwargs):  # noqa: N802
        return _BlockingStream(self._release, self._flowing)


class _BlockingOpenSd:
    """PortAudio wedged in the OPEN: `InputStream()` never returns."""

    def __init__(self, release: threading.Event):
        self._release = release
        self.opened = threading.Event()

    def InputStream(self, **kwargs):  # noqa: N802
        self.opened.set()
        self._release.wait(10.0)
        return _BlockingStream(self._release, 10**9)


class _BlockingDetector(WakeWordDetector):
    """A detector whose predict() blocks - stands in for a whole voice turn
    running inside `_on_frame` on the capture thread, OUTSIDE PortAudio."""

    def __init__(self, release: threading.Event):
        self._release = release
        self.entered = threading.Event()

    @property
    def model_name(self) -> str:
        return "blocking"

    @property
    def loaded(self) -> bool:
        return True

    def predict(self, audio_frame):
        self.entered.set()
        self._release.wait(10.0)
        return {}


class _Harness:
    def __init__(
        self,
        capture_stall_s: float = STALL_S,
        flowing_reads: int = 3,
        sd=None,
        detector=None,
    ):
        self.release = threading.Event()
        self.calls: list[str] = []
        self.sd = sd if sd is not None else _FakeSd(self.release, flowing_reads)
        self.pipe = WakePipeline(
            detector=detector if detector is not None else MockWakeWordDetector(),
            input_device_index=1,
            sd_module=self.sd,
            recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
            capture_stall_s=capture_stall_s,
            on_capture_stall=self.calls.append,
        )
        self.thread = threading.Thread(target=self.pipe._loop, daemon=True)

    def start(self):
        self.thread.start()
        deadline = time.monotonic() + 5.0
        while self.pipe._state != "listening" and time.monotonic() < deadline:
            time.sleep(0.005)
        assert self.pipe._state == "listening"

    def stop(self):
        self.pipe._shutdown.set()
        self.release.set()
        self.thread.join(timeout=5.0)


@pytest.fixture
def harness():
    created: list[_Harness] = []

    def make(**kwargs):
        h = _Harness(**kwargs)
        created.append(h)
        return h

    yield make
    for h in created:
        h.stop()


class TestStallDetection:
    def test_stalled_read_while_listening_fires_once(self, harness):
        h = harness()
        h.start()
        time.sleep(STALL_S * 4)  # the read is now wedged past the threshold
        h.pipe._check_capture_liveness()
        h.pipe._check_capture_liveness()  # one-shot latch
        assert len(h.calls) == 1
        assert "no progress" in h.calls[0]
        assert "PortAudio" in h.calls[0]
        assert "state=listening" in h.calls[0]

    def test_flowing_reads_never_fire(self, harness):
        h = harness(flowing_reads=10**9)
        h.start()
        for _ in range(10):
            time.sleep(0.02)
            h.pipe._check_capture_liveness()
        assert h.calls == []
        # Between reads the stamp is clear; during one it is fresh.
        since = h.pipe._capture_io_since
        assert since is None or time.monotonic() - since < STALL_S

    @pytest.mark.parametrize("state", ["wake_detected", "transcribing"])
    def test_a_read_wedged_mid_capture_is_judged(self, harness, state):
        # The device drops while the loop is still draining the stream for
        # the sidecar: a wedge in these states used to stay deaf forever.
        h = harness()
        h.start()
        h.pipe._state = state  # a turn's capture is in flight
        time.sleep(STALL_S * 4)
        h.pipe._check_capture_liveness()
        assert len(h.calls) == 1
        assert f"state={state}" in h.calls[0]

    @pytest.mark.parametrize(
        "state", ["listening", "wake_detected", "transcribing",
                  "transcript_ready", "speaking"],
    )
    def test_a_turn_outside_portaudio_is_never_judged(self, harness, state):
        # The whole voice turn (STT finish, LLM, TTS, playback) runs inside
        # `_on_frame` on the capture thread, OUTSIDE any PortAudio call -
        # simulated by a detector whose predict() blocks. However long it
        # takes and whatever state it moves through, the stamp is clear.
        det = _BlockingDetector(threading.Event())
        h = harness(flowing_reads=10**9, detector=det)
        h.start()
        assert det.entered.wait(2.0)
        h.pipe._state = state
        time.sleep(STALL_S * 4)
        h.pipe._check_capture_liveness()
        assert h.calls == []
        assert h.pipe._capture_io_since is None
        det._release.set()

    def test_returning_from_a_turn_to_reads_restarts_the_clock(self, harness):
        det = _BlockingDetector(threading.Event())
        h = harness(flowing_reads=10**9, detector=det)
        h.start()
        assert det.entered.wait(2.0)
        time.sleep(STALL_S * 4)  # a long voice turn, stream not drained
        det._release.set()  # the turn ends; reads flow again
        for _ in range(5):
            time.sleep(0.02)
            h.pipe._check_capture_liveness()
        assert h.calls == []

    def test_a_wedged_open_is_judged(self, harness):
        # Opening a half-gone device can spin in C just like a read.
        sd = _BlockingOpenSd(threading.Event())
        h = harness(sd=sd)
        h.pipe._set_state("loading")  # what start() sets before the worker runs
        h.thread.start()
        assert sd.opened.wait(2.0)
        time.sleep(STALL_S * 4)
        h.pipe._check_capture_liveness()
        assert len(h.calls) == 1
        assert "state=loading" in h.calls[0]
        sd._release.set()
        h.release.set()

    def test_no_mic_backoff_is_never_judged(self):
        # Parked in no_mic between reopen attempts the thread waits on the
        # shutdown event, not on PortAudio: nothing to judge.
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=None,
            capture_stall_s=STALL_S,
            on_capture_stall=lambda reason: pytest.fail(reason),
        )
        pipe._state = "no_mic"
        assert pipe._capture_io_since is None
        pipe._check_capture_liveness()

    def test_disabled_when_zero(self, harness):
        h = harness(capture_stall_s=0)
        h.start()
        time.sleep(0.1)
        h.pipe._capture_io_since = time.monotonic() - 3600
        h.pipe._check_capture_liveness()
        assert h.calls == []

    def test_handler_exception_does_not_escape(self):
        def boom(_reason):
            raise RuntimeError("handler broke")

        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=1,
            capture_stall_s=STALL_S,
            on_capture_stall=boom,
        )
        pipe._state = "listening"
        pipe._capture_io_since = time.monotonic() - 3600
        pipe._check_capture_liveness()  # must not raise
        assert pipe._capture_stall_fired


class TestDefaultHandler:
    def test_default_handler_exits_with_code_70(self, monkeypatch):
        exits: list[int] = []
        monkeypatch.setattr(os, "_exit", exits.append)
        pipe = WakePipeline(detector=MockWakeWordDetector(), input_device_index=1)
        assert pipe._on_capture_stall is pipeline_mod._exit_for_capture_stall
        pipe._on_capture_stall("test reason")
        assert exits == [70]

    def test_default_threshold(self):
        assert DEFAULT_CAPTURE_STALL_S == 15.0
        pipe = WakePipeline(detector=MockWakeWordDetector(), input_device_index=1)
        assert pipe._capture_stall_s == 15.0


class TestSchedulerTicksCheck:
    def test_probe_tick_runs_the_check(self, monkeypatch):
        pipe = WakePipeline(detector=MockWakeWordDetector(), input_device_index=1)
        seen: list[str] = []
        monkeypatch.setattr(
            pipe, "_check_capture_liveness", lambda: seen.append("check"),
        )
        monkeypatch.setattr(pipe, "_probe_upstreams", lambda: None)
        pipe._probe_tick()
        assert seen == ["check"]

    def test_rescan_tick_runs_the_check_before_early_returns(self, monkeypatch):
        # No device_fingerprint wired -> _rescan_tick early-returns; the
        # check must still have run.
        pipe = WakePipeline(detector=MockWakeWordDetector(), input_device_index=1)
        seen: list[str] = []
        monkeypatch.setattr(
            pipe, "_check_capture_liveness", lambda: seen.append("check"),
        )
        pipe._rescan_tick()
        assert seen == ["check"]


class TestEnvWiring:
    def test_env_parse(self, monkeypatch):
        import main

        monkeypatch.delenv("VOICE_CAPTURE_STALL_S", raising=False)
        assert main._capture_stall_from_env() == DEFAULT_CAPTURE_STALL_S
        monkeypatch.setenv("VOICE_CAPTURE_STALL_S", "  ")
        assert main._capture_stall_from_env() == DEFAULT_CAPTURE_STALL_S
        monkeypatch.setenv("VOICE_CAPTURE_STALL_S", "42.5")
        assert main._capture_stall_from_env() == 42.5
        monkeypatch.setenv("VOICE_CAPTURE_STALL_S", "0")
        assert main._capture_stall_from_env() == 0.0
        monkeypatch.setenv("VOICE_CAPTURE_STALL_S", "soon")
        assert main._capture_stall_from_env() == DEFAULT_CAPTURE_STALL_S
