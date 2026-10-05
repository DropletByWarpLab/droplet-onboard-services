"""WARP-3710 - voice-io self-heals a wrong / wedged microphone.

The incident: voice-io started before the reSpeaker XVF3800 enumerated,
picked the silent onboard codec (`HD-Audio Generic: ALC897`), then burned
its bounded `xvf_host REBOOT 1` budget against a device that is not an XVF
(exit 8) and latched `wedged_escalated` for two days - while the XVF sat
right there as card 3. These tests pin the fix: re-pick instead of
rebooting a DSP that isn't there, hot-plug rescan, and the operator
endpoints (GET /voice/devices, POST /voice/mic/restart, POST /voice/mic/test).

sounddevice is fully mocked - no audio hardware is touched.
"""
from __future__ import annotations

import threading
import time
from typing import Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

import main
from voice.devices import (
    AudioDevice,
    DeviceResolution,
    alsa_fingerprint,
    is_xvf_device,
    resolve_devices,
)
from voice.dsp import DspRestartError
from voice.pipeline import (
    MeasurementUnavailable,
    WakePipeline,
    pcm_level_dbfs,
)
from voice.wake import (
    WAKE_FRAME_SAMPLES,
    DisabledWakeWordDetector,
    MockWakeWordDetector,
)

ALC897 = "HD-Audio Generic: ALC897 Analog (hw:2,0)"
XVF = "reSpeaker XVF3800 4-Mic Array: USB Audio (hw:3,0)"


def _dev(index: int, name: str, bus: str, score_in: int, ch_in: int = 2) -> AudioDevice:
    return AudioDevice(
        index=index,
        name=name,
        max_input_channels=ch_in,
        max_output_channels=2,
        default_samplerate=48000.0,
        hostapi_name="ALSA",
        bus=bus,
        card_number=index,
        score_as_input=score_in,
        score_as_output=score_in,
    )


# ────────────────────────────────────────────────────────────────────
# Device selection - the re-pick itself
# ────────────────────────────────────────────────────────────────────


class TestRepickAfterLateEnumeration:
    def test_xvf_is_recognised_only_by_its_chip_name(self):
        assert is_xvf_device(_dev(3, XVF, "usb", 450))
        assert not is_xvf_device(_dev(2, ALC897, "pci", 0))
        assert not is_xvf_device(_dev(4, "ReSpeaker 4 Mic Array (UAC1.0)", "usb", 450))
        assert not is_xvf_device(None)

    def test_second_resolution_prefers_the_usb_array_that_appeared(
        self, make_sounddevice, make_sysfs_root,
    ):
        """The incident: first scan has only the onboard codec, a later one
        also sees the XVF - the best-score pick must switch to it."""
        analog = {
            "name": ALC897, "max_input_channels": 2, "max_output_channels": 2,
            "default_samplerate": 48000.0, "hostapi": 0,
        }
        xvf = {
            "name": XVF, "max_input_channels": 2, "max_output_channels": 2,
            "default_samplerate": 48000.0, "hostapi": 0,
        }
        root = make_sysfs_root({2: "pci", 3: "usb"})
        before = resolve_devices(
            env={}, sys_root=root, sd_module=make_sounddevice([analog]),
        )
        assert before.input_device is not None
        assert before.input_device.name == ALC897
        assert before.input_device.score_as_input == 0

        after = resolve_devices(
            env={}, sys_root=root,
            sd_module=make_sounddevice([analog, xvf]),
        )
        assert after.input_device is not None
        assert is_xvf_device(after.input_device)
        assert after.input_device.bus == "usb"
        assert after.input_device.score_as_input == 450

    def test_alsa_fingerprint_changes_when_a_card_appears(self, tmp_path):
        root = tmp_path / "snd"
        root.mkdir()
        (root / "card2").mkdir()
        (root / "card2" / "id").write_text("ALC897\n")
        (root / "controlC2").mkdir()  # not a card dir - ignored
        first = alsa_fingerprint(root)
        assert first == ("card2:ALC897",)
        (root / "card3").mkdir()
        (root / "card3" / "id").write_text("XVF3800\n")
        assert alsa_fingerprint(root) == ("card2:ALC897", "card3:XVF3800")
        assert alsa_fingerprint(root) != first

    def test_alsa_fingerprint_is_none_when_sysfs_is_unreadable(self, tmp_path):
        assert alsa_fingerprint(tmp_path / "missing") is None


# ────────────────────────────────────────────────────────────────────
# Pipeline: DSP reboot only on an XVF; re-pick otherwise
# ────────────────────────────────────────────────────────────────────


def _flatlined_pipeline(**kw) -> WakePipeline:
    pipe = WakePipeline(
        detector=DisabledWakeWordDetector(),
        input_device_index=0,
        flatline_window_s=0.001,
        dsp_recovery_cooldown_s=60.0,
        **kw,
    )
    pipe._set_state("listening")
    pipe._on_frame(np.zeros(WAKE_FRAME_SAMPLES, dtype=np.int16))
    time.sleep(0.01)
    assert pipe.status().input_flatlined is True
    return pipe


class TestSelfHealOnFlatline:
    def test_no_xvf_reboot_when_active_device_is_not_an_xvf(self):
        reboots: list[int] = []
        pipe = _flatlined_pipeline(
            dsp_restart=lambda: reboots.append(1),
            active_device_is_xvf=lambda: False,
        )
        for _ in range(5):  # would have burned all 3 attempts + escalated
            pipe._maybe_auto_recover_dsp()
        assert reboots == []
        assert pipe._dsp_restart_attempts == 0
        assert pipe.status().mic_fault == "flatlined"  # never wedged_escalated

    def test_flatline_on_non_xvf_requests_a_repick(self):
        pipe = _flatlined_pipeline(active_device_is_xvf=lambda: False)
        pipe._maybe_repick_flatlined_input()
        assert pipe._reopen_requested.is_set()
        reason, reset = pipe._consume_reopen_request()
        assert "non-XVF" in reason
        assert reset is True

    def test_repick_is_rate_limited_by_the_cooldown(self):
        pipe = _flatlined_pipeline(active_device_is_xvf=lambda: False)
        pipe._maybe_repick_flatlined_input()
        pipe._consume_reopen_request()
        # A failed re-pick must not clear its own cooldown when the stream
        # reopens on the same silent device.
        pipe._reset_recovery_state("re-pick still silent")
        pipe._maybe_repick_flatlined_input()  # inside the 60 s cooldown
        assert not pipe._reopen_requested.is_set()

    def test_flatline_on_a_real_xvf_still_reboots_the_dsp(self):
        reboots: list[int] = []
        pipe = _flatlined_pipeline(
            dsp_restart=lambda: reboots.append(1),
            active_device_is_xvf=lambda: True,
        )
        pipe._maybe_repick_flatlined_input()
        assert not pipe._reopen_requested.is_set()  # the DSP path owns it
        pipe._maybe_auto_recover_dsp()
        assert reboots == [1]

    def test_unknown_device_keeps_the_legacy_dsp_only_behaviour(self):
        reboots: list[int] = []
        pipe = _flatlined_pipeline(dsp_restart=lambda: reboots.append(1))
        pipe._maybe_repick_flatlined_input()
        assert not pipe._reopen_requested.is_set()
        pipe._maybe_auto_recover_dsp()
        assert reboots == [1]

    def test_reset_recovery_state_clears_the_escalation_latch(self):
        pipe = _flatlined_pipeline(
            dsp_restart=lambda: None, active_device_is_xvf=lambda: True,
        )
        pipe._dsp_recovery = "escalated"
        pipe._dsp_restart_attempts = 3
        assert pipe.status().mic_fault == "wedged_escalated"
        pipe._reset_recovery_state("test")
        assert pipe._dsp_restart_attempts == 0
        assert pipe._dsp_recovery == "nominal"
        assert pipe.status().mic_fault == "flatlined"  # latch gone


# ────────────────────────────────────────────────────────────────────
# Pipeline: the in-process reopen (no container restart)
# ────────────────────────────────────────────────────────────────────


class _Stream:
    def __init__(self, on_read):
        self._on_read = on_read

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n):
        self._on_read()
        return np.zeros((n, 1), dtype=np.int16), False


class _FakeSd:
    """Records every open + every PortAudio re-init, in order."""

    def __init__(self, pipe_ref):
        self.events: list[tuple] = []
        self._pipe_ref = pipe_ref
        self.opens = 0

    def _terminate(self):
        self.events.append(("terminate",))

    def _initialize(self):
        self.events.append(("initialize",))

    def InputStream(self, **kwargs):  # noqa: N802
        self.opens += 1
        self.events.append(("open", kwargs["device"]))
        opens = self.opens
        pipe = self._pipe_ref[0]

        def on_read():
            if opens == 1:
                pipe.request_reopen("test: hardware changed", reset_recovery=False)
            else:
                pipe._shutdown.set()

        return _Stream(on_read)


class TestReopenInProcess:
    def test_reopen_reinits_portaudio_repicks_and_clears_the_latch(self):
        ref: list = [None]
        sd = _FakeSd(ref)
        picks = iter([3])  # the resolver now returns the XVF at index 3
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=2,  # the wrong, onboard device
            sd_module=sd,
            resolve_input_device=lambda: next(picks),
            recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
        )
        ref[0] = pipe
        # The incident state: latched escalation from the wrong device.
        pipe._dsp_recovery = "escalated"
        pipe._dsp_restart_attempts = 3
        pipe._loop()
        # Stream 1 on the old index, PortAudio re-initialised ONLY after it
        # closed, stream 2 on the freshly picked index.
        assert sd.events == [
            ("open", 2),
            ("terminate",),
            ("initialize",),
            ("open", 3),
        ]
        assert pipe._dsp_recovery == "nominal"
        assert pipe._dsp_restart_attempts == 0
        assert pipe.input_device_index == 3

    def test_pending_restart_is_not_reported_ready_until_after_device_repick(self):
        ref: list = [None]

        class _PendingRestartSd(_FakeSd):
            def InputStream(self, **kwargs):  # noqa: N802
                self.opens += 1
                self.events.append(("open", kwargs["device"]))
                opens = self.opens
                pipe = self._pipe_ref[0]

                def on_read():
                    if opens > 1:
                        pipe._shutdown.set()

                return _Stream(on_read)

        sd = _PendingRestartSd(ref)
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=2,
            sd_module=sd,
            resolve_input_device=lambda: 3,
            recover_backoff_initial_s=0.0,
            recover_backoff_max_s=0.0,
        )
        ref[0] = pipe
        generation = pipe.request_reopen("operator restart", reset_recovery=True)

        pipe._loop()

        # The first open uses the cached index, but cannot satisfy the
        # operator's waiter. It closes, reinitializes PortAudio, and opens
        # the newly resolved device before publishing a session generation.
        assert sd.events == [
            ("open", 2),
            ("terminate",),
            ("initialize",),
            ("open", 3),
        ]
        assert pipe._session_generation == generation + 1
        assert pipe.input_device_index == 3

    def test_wait_for_session_returns_once_a_new_stream_listens(self):
        pipe = WakePipeline(
            detector=MockWakeWordDetector(), input_device_index=0,
        )
        gen = pipe.request_reopen("x")

        def later():
            time.sleep(0.05)
            with pipe._lock:
                pipe._session_generation += 1
                pipe._session_cv.notify_all()

        threading.Thread(target=later, daemon=True).start()
        assert pipe.wait_for_session(gen, timeout=2.0) is True
        assert pipe.wait_for_session(gen + 5, timeout=0.05) is False

    def test_a_reopen_request_cuts_the_no_mic_backoff_short(self):
        """Parked in no_mic with a long backoff, an operator restart must
        not wait the backoff out."""
        calls = {"n": 0}
        pipe_ref: list[Optional[WakePipeline]] = [None]

        class _Sd:
            def InputStream(self, **kw):  # noqa: N802
                calls["n"] += 1
                # The first failed open consumes the pending restart and
                # retries immediately; stop the following no-mic attempt.
                if calls["n"] > 1:
                    assert pipe_ref[0] is not None
                    pipe_ref[0]._shutdown.set()
                raise OSError("no device")

        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            sd_module=_Sd(),
            recover_backoff_initial_s=30.0,
            recover_backoff_max_s=30.0,
        )
        pipe_ref[0] = pipe
        pipe._reopen_requested.set()  # pending request skips the wait
        real_wait = pipe._shutdown.wait
        waits: list[float] = []

        def _wait(timeout=None):
            waits.append(timeout)
            pipe._shutdown.set()
            return real_wait(0)

        pipe._shutdown.wait = _wait  # type: ignore[assignment]
        started = time.monotonic()
        pipe._loop()
        assert time.monotonic() - started < 5.0
        assert 30.0 not in waits
        assert calls["n"] == 2  # one immediate re-open, then shutdown
        assert not pipe._reopen_requested.is_set()


class TestHotplugRescan:
    def test_changed_fingerprint_requests_a_reopen(self):
        fingerprints = iter([("card2:ALC897",), ("card2:ALC897", "card3:XVF3800")])
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=2,
            device_fingerprint=lambda: next(fingerprints),
            device_rescan_interval_s=5.0,
        )
        pipe._last_fingerprint = ("card2:ALC897",)
        pipe._rescan_tick()  # same set as the baseline - nothing to do
        assert pipe._last_fingerprint == ("card2:ALC897",)
        assert not pipe._reopen_requested.is_set()
        pipe._rescan_tick()
        assert pipe._reopen_requested.is_set()
        assert pipe._last_fingerprint == ("card2:ALC897", "card3:XVF3800")

    def test_unreadable_sysfs_never_churns_the_stream(self):
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=2,
            device_fingerprint=lambda: None,
            device_rescan_interval_s=5.0,
        )
        pipe._last_fingerprint = ("card2:ALC897",)
        pipe._rescan_tick()
        assert not pipe._reopen_requested.is_set()

    def test_rescan_is_an_apscheduler_interval_job(self):
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.interval import IntervalTrigger

        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            device_fingerprint=lambda: ("card0:X",),
            device_rescan_interval_s=5.0,
        )
        pipe.start()
        try:
            sched = pipe._rescan_scheduler
            assert isinstance(sched, BackgroundScheduler)
            (job,) = sched.get_jobs()
            assert isinstance(job.trigger, IntervalTrigger)
            assert job.trigger.interval.total_seconds() == 5.0
        finally:
            pipe.stop()
        assert pipe._rescan_scheduler is None

    def test_no_rescan_job_without_an_interval(self):
        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            device_fingerprint=lambda: ("card0:X",),
            device_rescan_interval_s=0.0,
        )
        pipe.start()
        try:
            assert pipe._rescan_scheduler is None
        finally:
            pipe.stop()


class TestCaptureInput:
    def test_taps_the_running_stream(self):
        pipe = WakePipeline(
            detector=DisabledWakeWordDetector(), input_device_index=0,
        )
        pipe._set_state("listening")
        stop = threading.Event()

        def feeder():
            while not stop.is_set():
                pipe._on_frame(np.full(WAKE_FRAME_SAMPLES, 1000, dtype=np.int16))
                time.sleep(0.02)

        t = threading.Thread(target=feeder, daemon=True)
        t.start()
        try:
            pcm = pipe.capture_input(0.3)
        finally:
            stop.set()
            t.join()
        assert pcm.dtype == np.int16
        assert pcm.size >= 0.5 * 0.3 * 16000
        rms, peak = pcm_level_dbfs(pcm)
        assert rms == pytest.approx(-30.31, abs=0.05)
        assert peak == pytest.approx(-30.31, abs=0.05)
        assert pipe._capture_tap is None  # tap disarmed

    def test_refuses_when_no_mic(self):
        pipe = WakePipeline(
            detector=DisabledWakeWordDetector(), input_device_index=0,
        )
        pipe._set_state("no_mic")
        with pytest.raises(MeasurementUnavailable):
            pipe.capture_input(0.1)

    def test_no_audio_in_window_is_unavailable(self):
        pipe = WakePipeline(
            detector=DisabledWakeWordDetector(), input_device_index=0,
        )
        pipe._set_state("listening")
        with pytest.raises(MeasurementUnavailable):
            pipe.capture_input(0.05)

    def test_level_helper_floors_digital_silence(self):
        rms, peak = pcm_level_dbfs(np.zeros(1600, dtype=np.int16))
        assert rms == -120.0 and peak == -120.0


# ────────────────────────────────────────────────────────────────────
# HTTP: GET /voice/devices, POST /voice/mic/restart, POST /voice/mic/test
# ────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _flag_path(tmp_path, monkeypatch):
    monkeypatch.setenv("VOICE_ENABLED_PATH", str(tmp_path / "voice-enabled.json"))


@pytest.fixture
def client():
    return TestClient(main.app)


def _resolution(active: str = "xvf") -> DeviceResolution:
    analog = _dev(2, ALC897, "pci", 0)
    xvf = _dev(3, XVF, "usb", 450)
    picked = xvf if active == "xvf" else analog
    return DeviceResolution(
        input_device=picked,
        output_device=picked,
        input_source="auto",
        output_source="auto",
        all_devices=[analog, xvf],
    )


class _FakeMicPipeline:
    def __init__(self, *, pcm: Optional[np.ndarray] = None, session_ok: bool = True):
        self._pcm = pcm
        self._session_ok = session_ok
        self.reopens: list[tuple[str, bool]] = []
        self.played: list[np.ndarray] = []
        self.flatline_gate_dbfs = -70.0
        self._gen = 0

    def request_reopen(self, reason, reset_recovery=False):
        self.reopens.append((reason, reset_recovery))
        return self._gen

    def wait_for_session(self, after, timeout):
        return self._session_ok

    def capture_input(self, seconds):
        if self._pcm is None:
            raise MeasurementUnavailable("no audio")
        return self._pcm

    def play_capture(self, pcm):
        self.played.append(pcm)
        return True

    def status(self):
        class S:
            state = "listening"
            mic_fault = None

        return S()


class TestDevicesEndpoint:
    def test_lists_inputs_outputs_scores_and_the_active_pair(
        self, client, monkeypatch,
    ):
        monkeypatch.setattr(main, "_resolution", _resolution("xvf"))
        body = client.get("/voice/devices").json()
        assert [d["name"] for d in body["inputs"]] == [XVF, ALC897]  # best first
        assert body["inputs"][0]["score"] == 450
        assert body["inputs"][0]["bus"] == "usb"
        assert body["inputs"][0]["active"] is True
        assert body["inputs"][0]["is_xvf"] is True
        assert body["inputs"][1]["active"] is False
        assert body["active"]["input"]["name"] == XVF
        assert body["active"]["input_is_xvf"] is True
        assert len(body["outputs"]) == 2
        # legacy /audio/devices keys survive for older readers
        assert body["input"]["name"] == XVF
        assert len(body["all"]) == 2

    def test_no_mic_reports_a_null_active_input(self, client, monkeypatch):
        res = DeviceResolution(
            input_device=None, output_device=None,
            input_source="none-available", output_source="none-available",
            all_devices=[],
        )
        monkeypatch.setattr(main, "_resolution", res)
        body = client.get("/voice/devices").json()
        assert body["active"]["input"] is None
        assert body["inputs"] == []


class TestStatusExposesActiveDevice:
    def test_status_names_the_active_mic_without_a_pipeline(
        self, client, monkeypatch,
    ):
        monkeypatch.setattr(main, "_pipeline", None)
        monkeypatch.setattr(main, "_resolution", _resolution("analog"))
        body = client.get("/voice/status").json()
        assert body["input_device"] == ALC897
        assert body["input_device_bus"] == "pci"
        assert body["input_device_is_xvf"] is False

    def test_status_flags_an_xvf(self, client, monkeypatch):
        monkeypatch.setattr(main, "_pipeline", None)
        monkeypatch.setattr(main, "_resolution", _resolution("xvf"))
        body = client.get("/voice/status").json()
        assert body["input_device"] == XVF
        assert body["input_device_is_xvf"] is True

    def test_status_null_device_when_no_mic(self, client, monkeypatch):
        monkeypatch.setattr(main, "_pipeline", None)
        monkeypatch.setattr(main, "_resolution", None)
        body = client.get("/voice/status").json()
        assert body["input_device"] is None
        assert body["input_device_is_xvf"] is False


class TestMicRestartEndpoint:
    def test_restart_reopens_and_resets_recovery(self, client, monkeypatch):
        pipe = _FakeMicPipeline()
        monkeypatch.setattr(main, "_pipeline", pipe)
        monkeypatch.setattr(main, "_resolution", _resolution("xvf"))
        resp = client.post("/voice/mic/restart", json={})
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["device"] == XVF
        assert body["dsp_rebooted"] is False
        assert body["mic_fault"] is None
        assert pipe.reopens == [("operator mic restart", True)]

    def test_dsp_reboot_runs_only_on_an_xvf(self, client, monkeypatch):
        reboots: list[int] = []
        monkeypatch.setattr(main, "restart_dsp", lambda: reboots.append(1) or {})
        monkeypatch.setattr(main, "_pipeline", _FakeMicPipeline())
        monkeypatch.setattr(main, "_resolution", _resolution("xvf"))
        body = client.post("/voice/mic/restart", json={"dspReboot": True}).json()
        assert reboots == [1]
        assert body["dsp_rebooted"] is True
        assert body["dsp_error"] is None

    def test_dsp_reboot_is_skipped_on_a_non_xvf_but_still_repicks(
        self, client, monkeypatch,
    ):
        reboots: list[int] = []
        monkeypatch.setattr(main, "restart_dsp", lambda: reboots.append(1) or {})
        pipe = _FakeMicPipeline()
        monkeypatch.setattr(main, "_pipeline", pipe)
        monkeypatch.setattr(main, "_resolution", _resolution("analog"))
        resp = client.post("/voice/mic/restart", json={"dspReboot": True})
        assert resp.status_code == 200
        body = resp.json()
        assert reboots == []
        assert body["dsp_rebooted"] is False
        assert "not an XVF3800" in body["dsp_error"]
        assert len(pipe.reopens) == 1  # re-picked anyway

    def test_a_failed_dsp_reboot_does_not_block_the_repick(
        self, client, monkeypatch,
    ):
        def boom():
            raise DspRestartError("xvf_host REBOOT 1 failed (exit 8)")

        monkeypatch.setattr(main, "restart_dsp", boom)
        pipe = _FakeMicPipeline()
        monkeypatch.setattr(main, "_pipeline", pipe)
        monkeypatch.setattr(main, "_resolution", _resolution("xvf"))
        body = client.post("/voice/mic/restart", json={"dspReboot": True}).json()
        assert body["dsp_rebooted"] is False
        assert "exit 8" in body["dsp_error"]
        assert body["ok"] is True
        assert len(pipe.reopens) == 1

    def test_503_when_no_microphone_came_back(self, client, monkeypatch):
        monkeypatch.setattr(
            main, "_pipeline", _FakeMicPipeline(session_ok=False),
        )
        monkeypatch.setattr(main, "_resolution", _resolution("xvf"))
        resp = client.post("/voice/mic/restart", json={})
        assert resp.status_code == 503
        assert "No microphone came back" in resp.json()["detail"]

    def test_non_boolean_dsp_reboot_is_rejected(self, client, monkeypatch):
        monkeypatch.setattr(main, "_pipeline", _FakeMicPipeline())
        resp = client.post("/voice/mic/restart", json={"dspReboot": "yes"})
        assert resp.status_code == 422

    def test_overlapping_restart_answers_409(self, client, monkeypatch):
        monkeypatch.setattr(main, "_pipeline", _FakeMicPipeline())
        assert main._mic_restart_lock.acquire(blocking=False)
        try:
            resp = client.post("/voice/mic/restart", json={})
        finally:
            main._mic_restart_lock.release()
        assert resp.status_code == 409

    def test_refused_while_voice_is_switched_off(self, client, monkeypatch):
        from voice.enabled import VoiceEnabledStore

        VoiceEnabledStore().save(False)
        monkeypatch.setattr(main, "_pipeline", _FakeMicPipeline())
        resp = client.post("/voice/mic/restart", json={})
        assert resp.status_code == 409

    def test_cold_start_rebuilds_a_missing_pipeline(self, client, monkeypatch):
        """Voice is on but startup bailed with no mic: restart builds it."""
        monkeypatch.setattr(main, "_pipeline", None)
        monkeypatch.setattr(main, "_resolution", _resolution("xvf"))
        built: list[int] = []

        def fake_build():
            built.append(1)
            main._pipeline = _FakeMicPipeline()

        monkeypatch.setattr(main, "_build_and_start_pipeline", fake_build)
        resp = client.post("/voice/mic/restart", json={})
        try:
            assert resp.status_code == 200
            assert built == [1]
        finally:
            main._pipeline = None

    def test_cold_start_with_nothing_to_listen_with_is_503(
        self, client, monkeypatch,
    ):
        monkeypatch.setattr(main, "_pipeline", None)
        monkeypatch.setattr(main, "_build_and_start_pipeline", lambda: None)
        resp = client.post("/voice/mic/restart", json={})
        assert resp.status_code == 503


class TestMicTestEndpoint:
    def test_passes_on_real_signal(self, client, monkeypatch):
        pcm = np.full(48000, 1000, dtype=np.int16)
        pipe = _FakeMicPipeline(pcm=pcm)
        monkeypatch.setattr(main, "_pipeline", pipe)
        monkeypatch.setattr(main, "_resolution", _resolution("xvf"))
        resp = client.post("/voice/mic/test", json={})
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["flatlined"] is False
        assert body["rms_dbfs"] == pytest.approx(-30.31, abs=0.05)
        assert body["peak_dbfs"] == pytest.approx(-30.31, abs=0.05)
        assert body["device"] == XVF
        assert body["duration_s"] == 3.0
        assert body["played"] is None
        assert pipe.played == []

    def test_flags_a_flatlined_mic(self, client, monkeypatch):
        pipe = _FakeMicPipeline(pcm=np.zeros(48000, dtype=np.int16))
        monkeypatch.setattr(main, "_pipeline", pipe)
        monkeypatch.setattr(main, "_resolution", _resolution("analog"))
        body = client.post("/voice/mic/test", json={}).json()
        assert body["ok"] is False
        assert body["flatlined"] is True
        assert body["rms_dbfs"] == -120.0
        assert body["device"] == ALC897

    def test_playback_replays_the_capture(self, client, monkeypatch):
        pcm = np.full(16000, 500, dtype=np.int16)
        pipe = _FakeMicPipeline(pcm=pcm)
        monkeypatch.setattr(main, "_pipeline", pipe)
        monkeypatch.setattr(main, "_resolution", _resolution("xvf"))
        body = client.post(
            "/voice/mic/test", json={"playback": True, "duration_s": 1.0},
        ).json()
        assert body["played"] is True
        assert len(pipe.played) == 1
        assert body["duration_s"] == 1.0

    def test_503_when_the_mic_is_not_capturing(self, client, monkeypatch):
        monkeypatch.setattr(main, "_pipeline", _FakeMicPipeline(pcm=None))
        resp = client.post("/voice/mic/test", json={})
        assert resp.status_code == 503

    def test_503_without_a_pipeline(self, client, monkeypatch):
        monkeypatch.setattr(main, "_pipeline", None)
        assert client.post("/voice/mic/test", json={}).status_code == 503

    def test_busy_capture_lock_answers_409(self, client, monkeypatch):
        monkeypatch.setattr(
            main, "_pipeline",
            _FakeMicPipeline(pcm=np.zeros(16000, dtype=np.int16)),
        )
        assert main._capture_lock.acquire(blocking=False)
        try:
            resp = client.post("/voice/mic/test", json={})
        finally:
            main._capture_lock.release()
        assert resp.status_code == 409

    def test_duration_is_bounded(self, client, monkeypatch):
        monkeypatch.setattr(main, "_pipeline", _FakeMicPipeline())
        assert client.post("/voice/mic/test", json={"duration_s": 60}).status_code == 422

    def test_refused_while_voice_is_switched_off(self, client, monkeypatch):
        from voice.enabled import VoiceEnabledStore

        VoiceEnabledStore().save(False)
        monkeypatch.setattr(main, "_pipeline", _FakeMicPipeline())
        assert client.post("/voice/mic/test", json={}).status_code == 409


class TestResolverFollowsOutput:
    def test_reresolve_pushes_the_new_output_index_to_the_pipeline(
        self, monkeypatch,
    ):
        seen: list[int] = []

        class P:
            def set_output_device_index(self, i):
                seen.append(i)

        monkeypatch.setattr(main, "_pipeline", P())
        monkeypatch.setattr(main, "_resolution", None)
        monkeypatch.setattr(main, "_resolve", lambda: _resolution("xvf"))
        assert main._reresolve_input_index() == 3
        assert seen == [3]
