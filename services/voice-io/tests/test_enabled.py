"""WARP-1599 — the admin voice kill switch: persisted flag, the toggle
endpoint, `status.enabled`, and the boot gate.

Contract pinned here:

  - the flag survives restarts and reads as ON for every shape the
    reader can't trust (absent / corrupt / unreadable / non-boolean), so
    a box upgrading into this change keeps listening exactly as before;
  - POST /voice/enabled persists BEFORE it touches the pipeline, is
    idempotent both directions, and never needs working audio hardware —
    a pipeline that can't start still answers 200 `{"enabled": true}`;
  - turning off drops the pipeline, which closes the exclusive mic
    stream — that is the kill-switch guarantee, not a mute, and
    TestRealPipelineKillSwitch checks it against a REAL WakePipeline's
    actual stream state rather than against `_pipeline is None`
    (WARP-1619);
  - when the worker is mid-turn and outlives its join, the disable says
    so (`mic_released: false`) and a re-enable waits for the device
    instead of opening a second stream on it;
  - and every OTHER path that opens the mic (the two wizards' capture
    endpoints) refuses with 409 while off, so "no audio is captured" is
    true of the box rather than of the dashboard that gates it;
  - /voice/status tells deliberate silence (`state="off"`) apart from a
    mic fault (`state="no_mic"`), which the box keeps retrying;
  - boot honours a persisted "off": startup() never builds a pipeline.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

import main
from voice.enabled import VoiceEnabledStore
from voice.pipeline import WakePipeline
from voice.speaker_id import REQUIRED_LINES, EnrollmentSessions
from voice.wake import WAKE_FRAME_SAMPLES, DisabledWakeWordDetector


@pytest.fixture(autouse=True)
def flag_path(tmp_path, monkeypatch):
    """Point the store at tmp_path — no test may read or write /data."""
    path = tmp_path / "voice-enabled.json"
    monkeypatch.setenv("VOICE_ENABLED_PATH", str(path))
    return path


@pytest.fixture(autouse=True)
def _pinned_globals(monkeypatch):
    """Pin every module global the toggle writes, so monkeypatch's
    teardown restores them and no test can leak a pipeline (or a rebuilt
    client) into the next one."""
    monkeypatch.setattr(main, "_pipeline", None)
    monkeypatch.setattr(main, "_draining_pipeline", None)
    monkeypatch.setattr(main, "_persona_fetcher", None)
    monkeypatch.setattr(main, "_activity_reporter", None)
    monkeypatch.setattr(main, "_llm", None)


@pytest.fixture
def client():
    return TestClient(main.app)


# ────────────────────────────────────────────────────────────────────
# The store
# ────────────────────────────────────────────────────────────────────

class TestVoiceEnabledStore:
    def test_absent_file_reads_enabled(self, flag_path):
        # Back-compat: boxes upgrading into WARP-1599 have no flag file
        # and must keep listening.
        assert not flag_path.exists()
        assert VoiceEnabledStore().load() is True

    def test_round_trip_survives_a_fresh_store(self, flag_path):
        VoiceEnabledStore().save(False)
        assert json.loads(flag_path.read_text(encoding="utf-8")) == {"enabled": False}
        # A fresh store is what a restarted process builds.
        assert VoiceEnabledStore().load() is False
        VoiceEnabledStore().save(True)
        assert VoiceEnabledStore().load() is True

    def test_corrupt_file_reads_enabled(self, flag_path):
        flag_path.write_text("{not json", encoding="utf-8")
        assert VoiceEnabledStore().load() is True

    def test_non_object_json_reads_enabled(self, flag_path):
        flag_path.write_text("[false]", encoding="utf-8")
        assert VoiceEnabledStore().load() is True

    def test_non_boolean_flag_reads_enabled(self, flag_path):
        # A hand-edited "false" string is not evidence of an admin's
        # intent — never guess a kill switch into the off position.
        flag_path.write_text('{"enabled": "false"}', encoding="utf-8")
        assert VoiceEnabledStore().load() is True

    def test_unreadable_path_reads_enabled(self, tmp_path, monkeypatch):
        directory = tmp_path / "not-a-file.json"
        directory.mkdir()
        monkeypatch.setenv("VOICE_ENABLED_PATH", str(directory))
        assert VoiceEnabledStore().load() is True

    def test_save_creates_missing_parent_directories(self, tmp_path, monkeypatch):
        # First write on a freshly-created named volume.
        path = tmp_path / "fresh" / "volume" / "voice-enabled.json"
        monkeypatch.setenv("VOICE_ENABLED_PATH", str(path))
        VoiceEnabledStore().save(False)
        assert VoiceEnabledStore().load() is False

    def test_explicit_path_wins_over_the_env(self, tmp_path, flag_path):
        explicit = tmp_path / "explicit.json"
        VoiceEnabledStore(str(explicit)).save(False)
        assert VoiceEnabledStore(str(explicit)).load() is False
        # The env-pointed file was never touched.
        assert not flag_path.exists()


# ────────────────────────────────────────────────────────────────────
# POST /voice/enabled
# ────────────────────────────────────────────────────────────────────

class _FakePipeline:
    """Records stop() plus what the persisted flag said at that moment
    (the ordering assertion for "persist first")."""

    def __init__(self) -> None:
        self.stops = 0
        self.flag_when_stopped: list[bool] = []

    def stop(self, timeout: float = 5.0) -> bool:
        self.stops += 1
        self.flag_when_stopped.append(VoiceEnabledStore().load())
        # Matches the real contract (WARP-1619): True == the worker
        # actually exited, so the mic device is free.
        return True

    @property
    def running(self) -> bool:
        return False


@dataclass
class _FakeResolution:
    """Stand-in for DeviceResolution — a box with no audio hardware."""

    input_device: Optional[object] = None
    output_device: Optional[object] = None


class _RecordingReporter:
    """Duck-type of ActivityReporter. The pipeline only reaches for it on
    a wake event, so stop() is the whole surface these tests need."""

    def __init__(self) -> None:
        self.stops = 0

    def stop(self) -> None:
        self.stops += 1


class _RecordingClient:
    """Duck-type of LLMClient / PersonaFetcher: pipeline.start() probes
    `available`, the build path primes `get_block()`, teardown closes."""

    def __init__(self) -> None:
        self.closes = 0

    @property
    def available(self) -> bool:
        return False

    def get_block(self) -> None:
        return None

    def close(self) -> None:
        self.closes += 1


@pytest.fixture
def recorded_runtime(monkeypatch):
    """Record every activity reporter / LLM client / persona fetcher the
    build path constructs, so a test can assert what was freed."""
    built: dict[str, list] = {"reporters": [], "llms": [], "personas": []}

    def _recorder(key: str, factory):
        def _build(*_args):
            instance = factory()
            built[key].append(instance)
            return instance

        return _build

    monkeypatch.setattr(
        main, "build_reporter_from_env", _recorder("reporters", _RecordingReporter),
    )
    monkeypatch.setattr(
        main, "build_llm_from_env", _recorder("llms", _RecordingClient),
    )
    monkeypatch.setattr(
        main,
        "build_persona_fetcher_from_env",
        _recorder("personas", _RecordingClient),
    )
    return built


@pytest.fixture
def stub_pipeline_deps(tmp_path, monkeypatch):
    """Let the REAL _build_and_start_pipeline run without hardware or
    upstreams: no devices, a no-op detector, no STT/TTS/LLM clients."""
    monkeypatch.setenv("VOICE_CALIBRATION_PATH", str(tmp_path / "calibration.json"))
    monkeypatch.setattr(main, "_resolve", _FakeResolution)
    monkeypatch.setattr(main, "build_detector_from_env", DisabledWakeWordDetector)
    monkeypatch.setattr(main, "build_stt_from_env", lambda: None)
    monkeypatch.setattr(main, "build_tts_from_env", lambda: None)
    monkeypatch.setattr(main, "build_reporter_from_env", lambda: None)
    monkeypatch.setattr(main, "build_persona_fetcher_from_env", lambda: None)
    monkeypatch.setattr(main, "build_llm_from_env", lambda persona: None)


class TestToggleEndpoint:
    def test_disable_stops_and_drops_the_pipeline(self, client, monkeypatch):
        pipe = _FakePipeline()
        monkeypatch.setattr(main, "_pipeline", pipe)
        resp = client.post("/voice/enabled", json={"enabled": False})
        assert resp.status_code == 200
        # WARP-1619 — `mic_released` is part of the wire shape now:
        # `enabled: false` alone never proves the device is free.
        assert resp.json() == {"enabled": False, "mic_released": True}
        assert pipe.stops == 1
        # The kill-switch guarantee: nothing holds the mic afterwards.
        assert main._pipeline is None
        assert VoiceEnabledStore().load() is False

    def test_disable_persists_before_it_touches_the_pipeline(self, client, monkeypatch):
        pipe = _FakePipeline()
        monkeypatch.setattr(main, "_pipeline", pipe)
        client.post("/voice/enabled", json={"enabled": False})
        # A crash between the two steps must leave the box off on the
        # next boot, never listening.
        assert pipe.flag_when_stopped == [False]

    def test_disable_is_idempotent_without_a_pipeline(self, client):
        first = client.post("/voice/enabled", json={"enabled": False})
        second = client.post("/voice/enabled", json={"enabled": False})
        assert first.status_code == second.status_code == 200
        assert second.json() == {"enabled": False, "mic_released": True}
        assert VoiceEnabledStore().load() is False

    def test_enable_starts_a_pipeline(self, client, stub_pipeline_deps):
        VoiceEnabledStore().save(False)
        resp = client.post("/voice/enabled", json={"enabled": True})
        try:
            assert resp.status_code == 200
            assert resp.json() == {"enabled": True, "mic_released": True}
            assert main._pipeline is not None
            assert VoiceEnabledStore().load() is True
        finally:
            if main._pipeline is not None:
                main._pipeline.stop()

    def test_enable_leaves_an_already_running_pipeline_alone(
        self, client, stub_pipeline_deps, monkeypatch,
    ):
        # Rebuilding would open a SECOND stream on an exclusive device.
        pipe = _FakePipeline()
        monkeypatch.setattr(main, "_pipeline", pipe)
        resp = client.post("/voice/enabled", json={"enabled": True})
        assert resp.status_code == 200
        assert main._pipeline is pipe
        assert pipe.stops == 0
        assert VoiceEnabledStore().load() is True

    def test_enable_survives_a_pipeline_that_cannot_start(
        self, client, stub_pipeline_deps, monkeypatch,
    ):
        def _no_wake_model():
            raise RuntimeError("no wake model on this box")

        monkeypatch.setattr(main, "build_detector_from_env", _no_wake_model)
        VoiceEnabledStore().save(False)
        resp = client.post("/voice/enabled", json={"enabled": True})
        # The switch must be flippable on exactly the boxes whose audio
        # is broken — otherwise it can't be turned back on at all.
        assert resp.status_code == 200
        assert resp.json() == {"enabled": True, "mic_released": True}
        assert main._pipeline is None
        assert VoiceEnabledStore().load() is True
        # ...and the box then looks exactly like a mic-less boot.
        body = client.get("/voice/status").json()
        assert body["enabled"] is True
        assert body["state"] == "no_mic"

    def test_disable_frees_the_clients_built_alongside_the_pipeline(
        self, client, stub_pipeline_deps, recorded_runtime,
    ):
        # Disable is "stop and free". The pooled httpx clients and the
        # reporter's daemon thread belong to the pipeline's lifetime, not
        # the process's.
        client.post("/voice/enabled", json={"enabled": True})
        assert main._llm is not None  # the runtime really was built
        client.post("/voice/enabled", json={"enabled": False})
        assert recorded_runtime["reporters"][0].stops == 1
        assert recorded_runtime["llms"][0].closes == 1
        assert recorded_runtime["personas"][0].closes == 1
        assert main._pipeline is None
        assert main._activity_reporter is None
        assert main._llm is None
        assert main._persona_fetcher is None

    def test_repeated_toggles_do_not_stack_up_runtime_singletons(
        self, client, stub_pipeline_deps, recorded_runtime,
    ):
        # The leak this guards: a service that runs for months, where
        # every admin off→on would otherwise strand two httpx pools and a
        # parked reporter thread.
        try:
            for enabled in (True, False, True, False):
                assert client.post(
                    "/voice/enabled", json={"enabled": enabled},
                ).status_code == 200
        finally:
            if main._pipeline is not None:
                main._pipeline.stop()

        # One runtime built per enable, and every one of them released.
        assert [r.stops for r in recorded_runtime["reporters"]] == [1, 1]
        assert [c.closes for c in recorded_runtime["llms"]] == [1, 1]
        assert [c.closes for c in recorded_runtime["personas"]] == [1, 1]
        assert main._llm is None
        assert main._activity_reporter is None
        assert main._persona_fetcher is None

    def test_a_build_that_fails_before_the_pipeline_strands_nothing(
        self, client, stub_pipeline_deps, recorded_runtime, monkeypatch,
    ):
        # Raise between the client builds and WakePipeline(): `_pipeline`
        # stays None, so the enable guard would happily let the NEXT
        # enable overwrite these globals. They have to be freed here —
        # the guard keys on `_pipeline`, but the objects it protects
        # aren't `_pipeline`.
        def _threshold_blew_up(detector):
            raise RuntimeError("threshold resolution blew up")

        monkeypatch.setattr(main, "resolve_wake_threshold", _threshold_blew_up)
        assert client.post(
            "/voice/enabled", json={"enabled": True},
        ).status_code == 200
        assert main._pipeline is None
        assert main._activity_reporter is None
        assert main._llm is None
        assert main._persona_fetcher is None
        assert recorded_runtime["reporters"][0].stops == 1
        assert recorded_runtime["llms"][0].closes == 1
        assert recorded_runtime["personas"][0].closes == 1

        # ...and the box still switches on once the fault clears.
        monkeypatch.setattr(main, "resolve_wake_threshold", lambda detector: 0.7)
        try:
            assert client.post(
                "/voice/enabled", json={"enabled": True},
            ).status_code == 200
            assert main._pipeline is not None
            assert len(recorded_runtime["llms"]) == 2
        finally:
            if main._pipeline is not None:
                main._pipeline.stop()

    def test_a_build_that_fails_after_the_pipeline_leaves_no_dead_pipeline(
        self, client, stub_pipeline_deps, recorded_runtime, monkeypatch,
    ):
        # Raise after WakePipeline() but before start(): a non-None but
        # never-started `_pipeline` has no worker thread, yet every later
        # enable would no-op on the idempotence guard — the box would
        # stay deaf until someone restarted the container.
        def _calibration_blew_up(pipeline):
            raise RuntimeError("calibration record blew up")

        monkeypatch.setattr(main, "apply_stored_calibration", _calibration_blew_up)
        assert client.post(
            "/voice/enabled", json={"enabled": True},
        ).status_code == 200
        assert main._pipeline is None
        assert main._llm is None
        assert recorded_runtime["llms"][0].closes == 1

        monkeypatch.setattr(main, "apply_stored_calibration", lambda pipeline: None)
        try:
            assert client.post(
                "/voice/enabled", json={"enabled": True},
            ).status_code == 200
            assert main._pipeline is not None
        finally:
            if main._pipeline is not None:
                main._pipeline.stop()

    def test_a_warm_up_that_cannot_spawn_leaves_the_pipeline_listening(
        self, client, stub_pipeline_deps, monkeypatch,
    ):
        # The STT/TTS warm-up is a best-effort optimisation that runs
        # AFTER the pipeline is already listening. While its spawn sat
        # inside the builder's try, a Thread.start() that raised (thread
        # or memory exhaustion) reached the `except` and tore that live
        # pipeline back down — the box went silent because a cache
        # warmer couldn't start, where before it would simply have
        # answered the first utterance cold.
        class _RefusesWarmUp(threading.Thread):
            def start(self) -> None:
                if self.name == "voice-warmup":
                    raise RuntimeError("can't start new thread")
                super().start()

        monkeypatch.setattr(main.threading, "Thread", _RefusesWarmUp)
        VoiceEnabledStore().save(False)
        try:
            resp = client.post("/voice/enabled", json={"enabled": True})
            assert resp.status_code == 200
            assert main._pipeline is not None
            # ...and nothing was unwound with it.
            assert VoiceEnabledStore().load() is True
        finally:
            if main._pipeline is not None:
                main._pipeline.stop()

    def test_a_pipeline_that_refuses_to_stop_still_frees_the_clients(
        self, client, monkeypatch,
    ):
        # Teardown is documented best-effort. A raising stop() must not
        # escape as a 500 with the flag already persisted off and the
        # three singletons still live — that is the leak again, on the
        # error path.
        class _AngryPipeline:
            def stop(self) -> None:
                raise RuntimeError("worker join blew up")

        reporter = _RecordingReporter()
        llm = _RecordingClient()
        persona = _RecordingClient()
        monkeypatch.setattr(main, "_pipeline", _AngryPipeline())
        monkeypatch.setattr(main, "_activity_reporter", reporter)
        monkeypatch.setattr(main, "_llm", llm)
        monkeypatch.setattr(main, "_persona_fetcher", persona)

        resp = client.post("/voice/enabled", json={"enabled": False})
        assert resp.status_code == 200
        assert reporter.stops == 1
        assert llm.closes == 1
        assert persona.closes == 1
        assert main._pipeline is None
        assert VoiceEnabledStore().load() is False

    def test_a_concurrent_toggle_answers_409(self, client):
        # Part of the wire contract tasks 2/3 consume: overlapping
        # toggles are refused, never queued behind a stop() that can take
        # five seconds.
        assert main._enabled_lock.acquire(blocking=False)
        try:
            resp = client.post("/voice/enabled", json={"enabled": False})
        finally:
            main._enabled_lock.release()
        assert resp.status_code == 409
        # The refused request persisted nothing.
        assert VoiceEnabledStore().load() is True

    def test_enable_after_disable_rebuilds_from_clean_state(
        self, client, stub_pipeline_deps, recorded_runtime,
    ):
        client.post("/voice/enabled", json={"enabled": True})
        client.post("/voice/enabled", json={"enabled": False})
        client.post("/voice/enabled", json={"enabled": True})
        try:
            # Exactly one live instance, and it is the NEW one — the
            # first was closed rather than left behind it.
            assert main._llm is recorded_runtime["llms"][1]
            assert main._activity_reporter is recorded_runtime["reporters"][1]
            assert main._persona_fetcher is recorded_runtime["personas"][1]
            assert recorded_runtime["llms"][0].closes == 1
            assert recorded_runtime["llms"][1].closes == 0
        finally:
            if main._pipeline is not None:
                main._pipeline.stop()

    @pytest.mark.parametrize(
        "body",
        [
            {"enabled": "banana"},
            {"enabled": None},
            {"enabled": [True]},
            {},
            # Coercible-but-not-boolean: pydantic's lax mode would read
            # these as real booleans and flip the switch. The store
            # already refuses to read a string "false" out of the file as
            # intent (test_non_boolean_flag_reads_enabled) — the wire has
            # to agree, or the same value means two different things
            # depending on which layer sees it.
            {"enabled": "false"},
            {"enabled": "true"},
            {"enabled": 0},
            {"enabled": 1},
        ],
    )
    def test_rejects_a_non_boolean_body(self, client, body):
        assert client.post("/voice/enabled", json=body).status_code == 422
        # A rejected request persists nothing.
        assert VoiceEnabledStore().load() is True

    @pytest.mark.parametrize("enabled", [True, False])
    def test_accepts_a_real_json_boolean(self, client, stub_pipeline_deps, enabled):
        try:
            resp = client.post("/voice/enabled", json={"enabled": enabled})
            assert resp.status_code == 200
            assert resp.json() == {"enabled": enabled, "mic_released": True}
        finally:
            if main._pipeline is not None:
                main._pipeline.stop()


# ────────────────────────────────────────────────────────────────────
# The capture endpoints refuse while voice is off
# ────────────────────────────────────────────────────────────────────
#
# Dropping the wake pipeline only stops the WAKE path from reading PCM.
# Every endpoint below opens the mic on its own and worked perfectly on
# a switched-off box, which made the /voice off hero's "no audio is
# captured" a promise the dashboard kept rather than the box — and UI
# gating is not enforcement (a second admin session, a stale tab, or any
# direct caller of the orchestrator proxy walks straight past it).


@dataclass
class _FakeDevice:
    name: str = "fake"
    index: int = 0


@dataclass
class _WorkingAudio:
    """A box that HAS audio hardware — without it these endpoints 503 on
    the device check and would hide the switch's own refusal."""

    input_device: Optional[_FakeDevice] = field(default_factory=_FakeDevice)
    output_device: Optional[_FakeDevice] = field(default_factory=_FakeDevice)


class _OneVoiceEmbedder:
    """Every capture embeds to the same unit vector — enough for the
    enrollment flow to reach verify/commit without any DSP."""

    def embed(self, pcm, samplerate: int):
        v = np.zeros(8, dtype=np.float32)
        v[0] = 1.0
        return v


@pytest.fixture
def capture_env(tmp_path, monkeypatch):
    """Stub the audio + embedder layers so the ONLY thing that can refuse
    a request here is the kill switch. Returns the capture-call counters:
    the guard has to run BEFORE the mic is opened, not around it."""
    calls = {"measure": 0, "echo": 0, "record": 0}

    def _measure(**_kw):
        calls["measure"] += 1
        return {"rms_dbfs": -50.0, "peak_dbfs": -30.0, "samples": 1}

    def _echo(**_kw):
        calls["echo"] += 1
        return {"heard": True, "tone_dbfs": -22.0, "floor_dbfs": -57.0}

    def _record(**_kw):
        calls["record"] += 1
        return np.full((16000, 1), 8000, dtype=np.int16)

    monkeypatch.setenv("VOICE_PROFILES_DIR", str(tmp_path / "voiceprints"))
    monkeypatch.setattr(main, "_resolve", _WorkingAudio)
    monkeypatch.setattr(main, "measure_input_level", _measure)
    monkeypatch.setattr(main, "echo_check", _echo)
    monkeypatch.setattr(main, "record", _record)
    monkeypatch.setattr(main, "_speaker_embedder", _OneVoiceEmbedder())
    monkeypatch.setattr(main, "_speaker_embedder_built", True)
    monkeypatch.setattr(main, "_enroll_sessions", EnrollmentSessions())
    return calls


def _enroll_session(client, user_id: str = "alice") -> str:
    resp = client.post("/speaker/enroll/start", json={"user_id": user_id})
    assert resp.status_code == 200
    return resp.json()["session_id"]


class TestCaptureEndpointsRefuseWhileOff:
    def test_test_record(self, client, capture_env):
        assert client.post("/audio/test-record").status_code == 200
        VoiceEnabledStore().save(False)
        resp = client.post("/audio/test-record")
        assert resp.status_code == 409
        assert "switched off" in resp.json()["detail"]
        # Refused before the mic was opened, not after.
        assert capture_env["measure"] == 1

    def test_measure(self, client, capture_env):
        body = {"kind": "noise_floor"}
        assert client.post("/audio/measure", json=body).status_code == 200
        VoiceEnabledStore().save(False)
        resp = client.post("/audio/measure", json=body)
        assert resp.status_code == 409
        assert "switched off" in resp.json()["detail"]
        assert capture_env["measure"] == 1

    def test_echo_check(self, client, capture_env):
        assert client.post("/audio/echo-check").status_code == 200
        VoiceEnabledStore().save(False)
        resp = client.post("/audio/echo-check")
        assert resp.status_code == 409
        assert "switched off" in resp.json()["detail"]
        assert capture_env["echo"] == 1

    def test_enroll_capture(self, client, capture_env):
        sid = _enroll_session(client)
        body = {"session_id": sid}
        assert client.post("/speaker/enroll/capture", json=body).status_code == 200
        VoiceEnabledStore().save(False)
        resp = client.post("/speaker/enroll/capture", json=body)
        assert resp.status_code == 409
        assert "switched off" in resp.json()["detail"]
        assert capture_env["record"] == 1

    def test_enroll_verify(self, client, capture_env):
        sid = _enroll_session(client)
        body = {"session_id": sid}
        for _ in range(REQUIRED_LINES):
            assert client.post("/speaker/enroll/capture", json=body).status_code == 200
        assert client.post("/speaker/enroll/verify", json=body).status_code == 200
        VoiceEnabledStore().save(False)
        resp = client.post("/speaker/enroll/verify", json=body)
        assert resp.status_code == 409
        assert "switched off" in resp.json()["detail"]
        assert capture_env["record"] == REQUIRED_LINES + 1

    def test_speaker_match(self, client, capture_env):
        # Not one of the five the review named, but it opens the mic
        # through the same `_capture_speaker_pcm` — guarding the helper
        # rather than the handlers is what makes that impossible to miss.
        sid = _enroll_session(client)
        body = {"session_id": sid}
        for _ in range(REQUIRED_LINES):
            client.post("/speaker/enroll/capture", json=body)
        assert client.post("/speaker/enroll/commit", json=body).status_code == 200
        assert client.post("/speaker/match").status_code == 200
        VoiceEnabledStore().save(False)
        resp = client.post("/speaker/match")
        assert resp.status_code == 409
        assert "switched off" in resp.json()["detail"]

    def test_the_capture_lock_is_not_held_by_a_refusal(self, client, capture_env):
        # The guard runs before the lock is taken, so a run of refusals
        # can't leave the box permanently "busy" once voice comes back.
        VoiceEnabledStore().save(False)
        for _ in range(3):
            assert client.post("/audio/echo-check").status_code == 409
        assert main._capture_lock.acquire(blocking=False)
        main._capture_lock.release()
        VoiceEnabledStore().save(True)
        assert client.post("/audio/echo-check").status_code == 200

    def test_the_playback_only_endpoint_is_untouched(
        self, client, capture_env, monkeypatch,
    ):
        # The switch is about CAPTURE. /audio/test-tone plays a tone and
        # reads no PCM at all, so silencing it would be ceremony: an
        # admin can still prove the speaker works on a silent box.
        monkeypatch.setattr(main, "test_tone", lambda **_kw: None)
        VoiceEnabledStore().save(False)
        assert client.post("/audio/test-tone").status_code == 200


# ────────────────────────────────────────────────────────────────────
# /voice/status
# ────────────────────────────────────────────────────────────────────

class TestStatusEnabledField:
    def test_disabled_reports_state_off(self, client):
        VoiceEnabledStore().save(False)
        body = client.get("/voice/status").json()
        assert body["enabled"] is False
        assert body["state"] == "off"
        assert body["listening"] is False

    def test_enabled_without_a_pipeline_still_reports_no_mic(self, client):
        # "off" is a deliberate silence; "no_mic" is a fault the box keeps
        # retrying. The dashboard has to tell them apart.
        body = client.get("/voice/status").json()
        assert body["enabled"] is True
        assert body["state"] == "no_mic"

    def test_running_pipeline_reports_enabled_alongside_its_state(
        self, client, monkeypatch,
    ):
        pipe = WakePipeline(
            detector=DisabledWakeWordDetector(), input_device_index=0,
        )
        pipe._set_state("listening")
        monkeypatch.setattr(main, "_pipeline", pipe)
        body = client.get("/voice/status").json()
        assert body["enabled"] is True
        assert body["state"] == "listening"

    def test_health_stays_ok_when_voice_is_switched_off(self, client, monkeypatch):
        # A deliberately-silent box is healthy. /health degrades to 503
        # on "no_mic" (a fault), and Docker's HEALTHCHECK restarts on
        # that — a switched-off box must not be restart-looped for doing
        # exactly what it was told.
        monkeypatch.setattr(main, "_resolve", _FakeResolution)
        VoiceEnabledStore().save(False)
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


# ────────────────────────────────────────────────────────────────────
# Boot gate
# ────────────────────────────────────────────────────────────────────

class TestBootGate:
    def test_startup_skips_the_pipeline_when_disabled(self, monkeypatch):
        VoiceEnabledStore().save(False)
        calls: list[int] = []
        monkeypatch.setattr(main, "_build_and_start_pipeline", lambda: calls.append(1))
        asyncio.run(main.startup())
        assert calls == []
        assert main._pipeline is None

    def test_startup_starts_the_pipeline_when_enabled(self, monkeypatch):
        calls: list[int] = []
        monkeypatch.setattr(main, "_build_and_start_pipeline", lambda: calls.append(1))
        asyncio.run(main.startup())
        assert calls == [1]

    def test_a_box_switched_off_boots_silent(self, client, monkeypatch):
        # The whole point of persisting: the switch outlives the process.
        client.post("/voice/enabled", json={"enabled": False})
        calls: list[int] = []
        monkeypatch.setattr(main, "_build_and_start_pipeline", lambda: calls.append(1))
        asyncio.run(main.startup())  # the next container start
        assert calls == []


# ────────────────────────────────────────────────────────────────────
# WARP-1619 — the kill-switch guarantee, tested against a REAL pipeline
# ────────────────────────────────────────────────────────────────────
#
# Every test above injects a `_FakePipeline` whose stop() increments a
# counter, and pins the guarantee as `main._pipeline is None`. A None
# module reference is not evidence that the OS stream closed. These
# tests drive the REAL `WakePipeline` through the REAL disable path with
# a fake sounddevice, and assert on the STREAM'S OWN closed state.
#
# The window they pin: `_on_frame` runs the whole turn (LLM → TTS →
# `_play_pcm`, blocking) on the capture thread, which only re-checks
# `_shutdown` BETWEEN frames. A stop() issued mid-turn — the single most
# likely activation path for this control, since the admin usually hits
# it BECAUSE the box is talking — can hit its join timeout with the
# exclusive InputStream still open. No NEW audio is processed in that
# window (the loop exits before the next `_on_frame`), so the honest
# statement is "the device is still held and the box is still speaking",
# not "it is still listening to you".


class _HeldStream:
    """InputStream stub that tracks its REAL open/closed state."""

    def __init__(self) -> None:
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.closed = True
        return False

    def read(self, n):
        import time as _time

        _time.sleep(0.001)
        return np.zeros(WAKE_FRAME_SAMPLES, dtype=np.int16).reshape(-1, 1), False


class _HeldSoundDevice:
    """Mock sounddevice handing out `_HeldStream`s. Counts opens, and the
    process-wide PortAudio reset hooks that the failed-open recovery path
    would fire against a still-open stream."""

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


class _TurnBlockingDetector:
    """Blocks inside predict() to stand in for a turn in progress — same
    thread, same position in the capture loop as the real LLM → TTS →
    `_play_pcm` chain, which is what stop() has to survive."""

    def __init__(self) -> None:
        self.in_turn = threading.Event()
        self.finish_turn = threading.Event()

    @property
    def model_name(self) -> str:
        return "turn-blocking"

    @property
    def loaded(self) -> bool:
        return True

    def reset(self) -> None:
        return None

    def predict(self, audio_frame):
        self.in_turn.set()
        # Bounded so a broken test fails instead of hanging the suite.
        self.finish_turn.wait(timeout=30.0)
        return {}


@pytest.fixture
def quick_join(monkeypatch):
    """Shrink both join budgets so the timed-out-join tests cost
    milliseconds instead of the production 5 s + 5 s."""
    monkeypatch.setattr(main, "_STOP_JOIN_TIMEOUT_S", 0.2, raising=False)
    monkeypatch.setattr(main, "_DRAIN_JOIN_TIMEOUT_S", 0.2, raising=False)


def _live_pipeline(detector, fake_sd) -> WakePipeline:
    """A REAL WakePipeline, listening on a fake device, installed as the
    module global the disable path tears down."""
    pipe = WakePipeline(
        detector=detector,
        input_device_index=0,
        sd_module=fake_sd,
        upstream_probe_interval_s=0.0,
    )
    pipe.start()
    return pipe


class TestRealPipelineKillSwitch:
    def test_disable_closes_the_actual_mic_stream(self, client, monkeypatch):
        # The guarantee the suite has been asserting with `_pipeline is
        # None`, finally checked against the device: after a disable the
        # InputStream itself is CLOSED.
        fake_sd = _HeldSoundDevice()
        pipe = _live_pipeline(DisabledWakeWordDetector(), fake_sd)
        monkeypatch.setattr(main, "_pipeline", pipe)
        try:
            deadline = time.time() + 5.0
            while not fake_sd.streams and time.time() < deadline:
                time.sleep(0.005)
            assert fake_sd.streams, "the worker never opened a stream"

            resp = client.post("/voice/enabled", json={"enabled": False})
            assert resp.status_code == 200
            assert resp.json()["enabled"] is False
            # Honest: the device really was released before we answered.
            assert resp.json()["mic_released"] is True
            assert main._pipeline is None
            assert fake_sd.streams[0].closed is True
        finally:
            pipe.stop(timeout=5.0)

    def test_disable_mid_turn_admits_the_mic_is_still_held(
        self, client, monkeypatch, quick_join,
    ):
        # The reported bug: the join times out, yet the endpoint answered
        # 200 {"enabled": false} with no hint that the exclusive device
        # was still open — under a dashboard hero that reads verbatim
        # "the wake word does nothing and no audio is captured".
        detector = _TurnBlockingDetector()
        fake_sd = _HeldSoundDevice()
        pipe = _live_pipeline(detector, fake_sd)
        monkeypatch.setattr(main, "_pipeline", pipe)
        try:
            assert detector.in_turn.wait(timeout=5.0), "the turn never started"

            resp = client.post("/voice/enabled", json={"enabled": False})
            assert resp.status_code == 200
            # The switch is genuinely off — the flag is persisted and the
            # module reference is dropped, exactly as before.
            assert resp.json()["enabled"] is False
            assert main._pipeline is None
            assert VoiceEnabledStore().load() is False
            # …but the box does NOT claim the device was released, and
            # the stream proves why: it is still open.
            assert resp.json()["mic_released"] is False
            assert fake_sd.streams[0].closed is False
        finally:
            detector.finish_turn.set()
            pipe.stop(timeout=5.0)
        # The turn ends, the worker leaves, the device is freed.
        assert fake_sd.streams[0].closed is True

    def test_a_re_enable_mid_drain_opens_no_second_stream(
        self, client, monkeypatch, quick_join, stub_pipeline_deps,
    ):
        # The dangerous second-order consequence. With `_pipeline` None,
        # a quick re-enable used to call `_build_and_start_pipeline()` and
        # open a SECOND InputStream while the old worker still held the
        # exclusive ALSA device → EBUSY → _DeviceError → the supervisor
        # parks in no_mic (the red hardware-fault panel after an off→on
        # toggle). Worse, that recovery runs `_refresh_audio_enumeration`
        # → sd._terminate()/_initialize(): a PROCESS-WIDE PortAudio reset
        # while another stream is still open.
        detector = _TurnBlockingDetector()
        fake_sd = _HeldSoundDevice()
        pipe = _live_pipeline(detector, fake_sd)
        monkeypatch.setattr(main, "_pipeline", pipe)
        try:
            assert detector.in_turn.wait(timeout=5.0), "the turn never started"
            off = client.post("/voice/enabled", json={"enabled": False})
            assert off.json()["mic_released"] is False

            # Re-enable while the old worker is still mid-turn.
            on = client.post("/voice/enabled", json={"enabled": True})
            assert on.status_code == 200
            assert on.json()["enabled"] is True
            # No second pipeline was built on top of the live one…
            assert main._pipeline is None
            # …no second stream was opened on the exclusive device…
            assert len(fake_sd.streams) == 1
            assert fake_sd.streams[0].closed is False
            # …and no process-wide PortAudio reset fired against it.
            assert fake_sd.terminate_calls == 0
            assert fake_sd.initialize_calls == 0
        finally:
            detector.finish_turn.set()
            pipe.stop(timeout=5.0)

        # Not a permanent lockout: once the old worker is gone, the next
        # enable builds normally.
        assert fake_sd.streams[0].closed is True
        again = client.post("/voice/enabled", json={"enabled": True})
        assert again.status_code == 200
        try:
            assert main._pipeline is not None
        finally:
            if main._pipeline is not None:
                main._pipeline.stop(timeout=5.0)
