"""Speaker output volume over HTTP: GET/POST /voice/volume and the
output fields on /voice/status.

Contract pinned here:

  - main.py owns ONE module-level VolumeController, built at import, so
    the endpoints work whether or not the wake pipeline exists (voice
    switched off, no mic) — and the pipeline it builds shares that same
    controller, so a dashboard change and a spoken "turn it up" act on
    one state;
  - POST takes exactly one of an integer `level` (0-100), an integer
    `change` (-100..100) or a boolean `muted`, strictly: no coercion,
    no unknown keys, anything else is a 422 that changes nothing;
  - the answer carries the state before and after, and any storage fault;
  - /voice/status reports output_level / output_muted / output_fault
    with and without a pipeline.
"""
from __future__ import annotations

import json
from typing import Optional

import pytest
from fastapi.testclient import TestClient

import main
from voice.pipeline import WakePipeline
from voice.volume import VolumeController, VolumeState, VolumeStore
from voice.wake import DisabledWakeWordDetector


@pytest.fixture
def volume_path(tmp_path, monkeypatch):
    path = tmp_path / "voice-volume.json"
    monkeypatch.setenv("VOICE_VOLUME_PATH", str(path))
    return path


@pytest.fixture
def controller(volume_path, monkeypatch) -> VolumeController:
    """A fresh controller on tmp_path in place of main's — no test may
    read or write /data."""
    ctl = VolumeController(VolumeStore())
    monkeypatch.setattr(main, "_volume", ctl)
    monkeypatch.setattr(main, "_pipeline", None)
    return ctl


@pytest.fixture
def client():
    return TestClient(main.app)


def test_main_builds_one_module_level_controller():
    assert isinstance(main._volume, VolumeController)


class TestGetVolume:
    def test_a_fresh_box_reports_unity(self, client, controller):
        resp = client.get("/voice/volume")
        assert resp.status_code == 200
        assert resp.json() == {"level": 100, "muted": False, "fault": None}

    def test_reports_the_persisted_state(self, client, volume_path, monkeypatch):
        VolumeStore().save(VolumeState(level=35, muted=True))
        monkeypatch.setattr(main, "_volume", VolumeController(VolumeStore()))
        assert client.get("/voice/volume").json() == {
            "level": 35, "muted": True, "fault": None,
        }

    def test_an_unreadable_file_reports_audible_with_the_fault(
        self, client, volume_path, monkeypatch,
    ):
        volume_path.write_text("{not json", encoding="utf-8")
        monkeypatch.setattr(main, "_volume", VolumeController(VolumeStore()))
        body = client.get("/voice/volume").json()
        assert body["level"] == 100 and body["muted"] is False
        assert body["fault"] and str(volume_path) in body["fault"]


class TestPostVolume:
    def test_level(self, client, controller, volume_path):
        resp = client.post("/voice/volume", json={"level": 40})
        assert resp.status_code == 200
        assert resp.json() == {
            "level": 40, "muted": False, "fault": None,
            "previous_level": 100, "previous_muted": False,
        }
        assert json.loads(volume_path.read_text(encoding="utf-8")) == {
            "level": 40, "muted": False,
        }

    def test_change_is_relative_and_clamped(self, client, controller):
        controller.set_level(95)
        assert client.post("/voice/volume", json={"change": 10}).json()["level"] == 100
        assert client.post("/voice/volume", json={"change": -30}).json()["level"] == 70

    def test_mute_and_unmute_keep_the_level(self, client, controller):
        controller.set_level(60)
        muted = client.post("/voice/volume", json={"muted": True}).json()
        assert (muted["level"], muted["muted"]) == (60, True)
        assert (muted["previous_level"], muted["previous_muted"]) == (60, False)
        unmuted = client.post("/voice/volume", json={"muted": False}).json()
        assert (unmuted["level"], unmuted["muted"]) == (60, False)

    def test_works_with_no_pipeline(self, client, controller):
        assert main._pipeline is None
        assert client.post("/voice/volume", json={"level": 20}).status_code == 200
        assert controller.state().level == 20

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"level": 40, "muted": False},
            {"level": 40, "change": 10},
            {"change": 10, "muted": True},
            {"level": 40, "change": 10, "muted": True},
            {"level": "40"},
            {"level": 40.0},
            {"level": 40.5},
            {"level": True},
            {"level": None},
            {"level": -1},
            {"level": 101},
            {"change": "up"},
            {"change": 1.5},
            {"change": 101},
            {"change": -101},
            {"change": False},
            {"muted": "true"},
            {"muted": 1},
            {"muted": None},
            {"volume": 40},
            {"level": 40, "source": "voice"},
        ],
    )
    def test_rejects_everything_but_exactly_one_strict_field(
        self, client, controller, volume_path, body,
    ):
        resp = client.post("/voice/volume", json=body)
        assert resp.status_code == 422
        assert controller.state() == VolumeState(level=100, muted=False)
        assert not volume_path.exists()

    def test_a_failed_save_still_applies_and_reports_the_fault(
        self, client, controller, monkeypatch,
    ):
        def _boom(*_args, **_kwargs):
            raise OSError(30, "Read-only file system")

        monkeypatch.setattr(VolumeStore, "save", _boom)
        body = client.post("/voice/volume", json={"muted": True}).json()
        assert body["muted"] is True
        assert body["fault"] and "saved" in body["fault"]


class TestVoiceStatusOutputFields:
    def test_without_a_pipeline(self, client, controller, tmp_path, monkeypatch):
        monkeypatch.setenv("VOICE_ENABLED_PATH", str(tmp_path / "enabled.json"))
        controller.set_level(30)
        controller.set_muted(True)
        body = client.get("/voice/status").json()
        assert body["output_level"] == 30
        assert body["output_muted"] is True
        assert body["output_fault"] is None

    def test_with_a_pipeline(self, client, controller, tmp_path, monkeypatch):
        monkeypatch.setenv("VOICE_ENABLED_PATH", str(tmp_path / "enabled.json"))
        pipe = WakePipeline(
            detector=DisabledWakeWordDetector(),
            input_device_index=0,
            volume=controller,
        )
        monkeypatch.setattr(main, "_pipeline", pipe)
        controller.set_level(45)
        body = client.get("/voice/status").json()
        assert (body["output_level"], body["output_muted"]) == (45, False)

    def test_surfaces_a_storage_fault(
        self, client, volume_path, tmp_path, monkeypatch,
    ):
        monkeypatch.setenv("VOICE_ENABLED_PATH", str(tmp_path / "enabled.json"))
        volume_path.write_text('{"level": "loud"}', encoding="utf-8")
        monkeypatch.setattr(main, "_volume", VolumeController(VolumeStore()))
        monkeypatch.setattr(main, "_pipeline", None)
        body = client.get("/voice/status").json()
        assert body["output_level"] == 100 and body["output_muted"] is False
        assert body["output_fault"] and str(volume_path) in body["output_fault"]
        # A volume fault is not a pipeline fault: error_message stays clean.
        assert body["error_message"] is None


class _NoHardware:
    input_device: Optional[object] = None
    output_device: Optional[object] = None


def test_the_built_pipeline_shares_the_module_controller(
    controller, tmp_path, monkeypatch,
):
    monkeypatch.setenv("VOICE_CALIBRATION_PATH", str(tmp_path / "calibration.json"))
    monkeypatch.setattr(main, "_resolve", _NoHardware)
    monkeypatch.setattr(main, "build_detector_from_env", DisabledWakeWordDetector)
    monkeypatch.setattr(main, "build_stt_from_env", lambda: None)
    monkeypatch.setattr(main, "build_tts_from_env", lambda: None)
    monkeypatch.setattr(main, "build_reporter_from_env", lambda: None)
    monkeypatch.setattr(main, "build_persona_fetcher_from_env", lambda: None)
    monkeypatch.setattr(main, "build_llm_from_env", lambda persona: None)
    monkeypatch.setattr(main, "_draining_pipeline", None)
    monkeypatch.setattr(main, "_persona_fetcher", None)
    monkeypatch.setattr(main, "_activity_reporter", None)
    monkeypatch.setattr(main, "_llm", None)
    main._build_and_start_pipeline()
    try:
        assert main._pipeline is not None
        assert main._pipeline._volume is controller
    finally:
        if main._pipeline is not None:
            main._pipeline.stop()
