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
    stream — that is the kill-switch guarantee, not a mute;
  - /voice/status tells deliberate silence (`state="off"`) apart from a
    mic fault (`state="no_mic"`), which the box keeps retrying;
  - boot honours a persisted "off": startup() never builds a pipeline.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Optional

import pytest
from fastapi.testclient import TestClient

import main
from voice.enabled import VoiceEnabledStore
from voice.pipeline import WakePipeline
from voice.wake import DisabledWakeWordDetector


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

    def stop(self) -> None:
        self.stops += 1
        self.flag_when_stopped.append(VoiceEnabledStore().load())


@dataclass
class _FakeResolution:
    """Stand-in for DeviceResolution — a box with no audio hardware."""

    input_device: Optional[object] = None
    output_device: Optional[object] = None


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
        assert resp.json() == {"enabled": False}
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
        assert second.json() == {"enabled": False}
        assert VoiceEnabledStore().load() is False

    def test_enable_starts_a_pipeline(self, client, stub_pipeline_deps):
        VoiceEnabledStore().save(False)
        resp = client.post("/voice/enabled", json={"enabled": True})
        try:
            assert resp.status_code == 200
            assert resp.json() == {"enabled": True}
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
        assert resp.json() == {"enabled": True}
        assert main._pipeline is None
        assert VoiceEnabledStore().load() is True
        # ...and the box then looks exactly like a mic-less boot.
        body = client.get("/voice/status").json()
        assert body["enabled"] is True
        assert body["state"] == "no_mic"

    @pytest.mark.parametrize(
        "body",
        [{"enabled": "banana"}, {"enabled": None}, {"enabled": [True]}, {}],
    )
    def test_rejects_a_non_boolean_body(self, client, body):
        assert client.post("/voice/enabled", json=body).status_code == 422
        # A rejected request persists nothing.
        assert VoiceEnabledStore().load() is True


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
