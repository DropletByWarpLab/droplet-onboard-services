"""WARP-1055 — calibration persistence + live-apply + the wizard's
measurement endpoints.

Covers:
  * voice/calibration.py — CalibrationStore JSON round-trip (atomic
    write, missing/corrupt file → None).
  * WakePipeline.set_input_gain / set_wake_threshold — the live-apply
    hooks the calibration POST drives.
  * main.apply_stored_calibration — startup hook that re-applies a
    persisted calibration over the env defaults.
  * POST /audio/measure — wizard noise-floor / speech-peak capture
    (reuses the test-record capture path; audio layer mocked).
  * POST /audio/echo-check — simultaneous play+record with the tone
    detector (audio layer mocked here; the pure detector is covered in
    test_audio_echo.py).
  * GET/POST /voice/calibration — persisted record or
    {calibrated: false}; POST persists + applies to the live pipeline.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional

import pytest
from fastapi.testclient import TestClient

import main
from voice.calibration import CalibrationStore
from voice.pipeline import WakePipeline
from voice.wake import DisabledWakeWordDetector


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def cal_path(tmp_path, monkeypatch):
    """Point the store at a per-test file via the env override."""
    p = tmp_path / "calibration.json"
    monkeypatch.setenv("VOICE_CALIBRATION_PATH", str(p))
    return p


@dataclass
class _FakeDevice:
    name: str = "fake"
    index: int = 0


@dataclass
class _FakeResolution:
    input_device: Optional[_FakeDevice] = field(default_factory=_FakeDevice)
    output_device: Optional[_FakeDevice] = field(default_factory=_FakeDevice)


def _make_pipeline() -> WakePipeline:
    return WakePipeline(
        detector=DisabledWakeWordDetector(),
        input_device_index=0,
        threshold=0.7,
        input_gain=1.0,
    )


VALID_BODY = {
    "input_gain": 2.0,
    "noise_floor_dbfs": -41.0,
    "speech_peak_dbfs": -18.0,
    "wake_detections": 3,
    "echo_ok": True,
    "flags": [],
}


# ── CalibrationStore ────────────────────────────────────────────────

def test_store_round_trip(cal_path):
    store = CalibrationStore()
    record = {"calibrated": True, "noise_floor_dbfs": -41.0, "flags": []}
    store.save(record)
    assert cal_path.exists()
    assert CalibrationStore().load() == record


def test_store_missing_file_loads_none(cal_path):
    assert CalibrationStore().load() is None


def test_store_corrupt_file_loads_none(cal_path):
    cal_path.write_text("{not json", encoding="utf-8")
    assert CalibrationStore().load() is None


def test_store_creates_parent_dirs(tmp_path, monkeypatch):
    nested = tmp_path / "deep" / "dir" / "calibration.json"
    monkeypatch.setenv("VOICE_CALIBRATION_PATH", str(nested))
    CalibrationStore().save({"calibrated": True})
    assert json.loads(nested.read_text(encoding="utf-8"))["calibrated"] is True


# ── WakePipeline live-apply setters ─────────────────────────────────

def test_set_input_gain_applies_and_rejects_nonpositive():
    pipe = _make_pipeline()
    pipe.set_input_gain(2.5)
    assert pipe._input_gain == 2.5
    pipe.set_input_gain(0.0)   # ignored — nonsense gain
    assert pipe._input_gain == 2.5
    pipe.set_input_gain(-1.0)  # ignored
    assert pipe._input_gain == 2.5


def test_set_wake_threshold_reflected_in_status():
    pipe = _make_pipeline()
    pipe.set_wake_threshold(0.55)
    assert pipe.status().threshold == 0.55


# ── startup re-apply ────────────────────────────────────────────────

def test_apply_stored_calibration_overrides_env_defaults(cal_path):
    CalibrationStore().save(
        {"calibrated": True, "input_gain": 3.0, "wake_threshold": 0.5},
    )
    pipe = _make_pipeline()
    main.apply_stored_calibration(pipe)
    assert pipe._input_gain == 3.0
    assert pipe.status().threshold == 0.5


def test_apply_stored_calibration_noop_without_record(cal_path):
    pipe = _make_pipeline()
    main.apply_stored_calibration(pipe)
    assert pipe._input_gain == 1.0
    assert pipe.status().threshold == 0.7


# ── POST /audio/measure ─────────────────────────────────────────────

def test_measure_returns_levels(client, monkeypatch):
    monkeypatch.setattr(main, "_resolve", lambda: _FakeResolution())
    monkeypatch.setattr(
        main,
        "measure_input_level",
        lambda **kw: {"rms_dbfs": -50.5, "peak_dbfs": -30.2, "samples": 80000},
    )
    resp = client.post(
        "/audio/measure", json={"kind": "noise_floor", "seconds": 5.0},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "rms_dbfs": -50.5,
        "peak_dbfs": -30.2,
        "duration_s": 5.0,
        "kind": "noise_floor",
    }


def test_measure_defaults_seconds(client, monkeypatch):
    seen = {}

    def fake_measure(**kw):
        seen.update(kw)
        return {"rms_dbfs": -40.0, "peak_dbfs": -20.0, "samples": 1}

    monkeypatch.setattr(main, "_resolve", lambda: _FakeResolution())
    monkeypatch.setattr(main, "measure_input_level", fake_measure)
    resp = client.post("/audio/measure", json={"kind": "speech_peak"})
    assert resp.status_code == 200
    assert seen["duration_s"] == pytest.approx(main.DEFAULT_MEASURE_SECONDS)


def test_measure_rejects_bad_kind(client, monkeypatch):
    monkeypatch.setattr(main, "_resolve", lambda: _FakeResolution())
    resp = client.post("/audio/measure", json={"kind": "loudness"})
    assert resp.status_code == 422


def test_measure_rejects_out_of_range_seconds(client, monkeypatch):
    monkeypatch.setattr(main, "_resolve", lambda: _FakeResolution())
    resp = client.post(
        "/audio/measure", json={"kind": "noise_floor", "seconds": 60},
    )
    assert resp.status_code == 422


def test_measure_503_without_input_device(client, monkeypatch):
    monkeypatch.setattr(
        main, "_resolve", lambda: _FakeResolution(input_device=None),
    )
    resp = client.post("/audio/measure", json={"kind": "noise_floor"})
    assert resp.status_code == 503


# ── POST /audio/echo-check ──────────────────────────────────────────

def test_echo_check_relays_detector_result(client, monkeypatch):
    monkeypatch.setattr(main, "_resolve", lambda: _FakeResolution())
    monkeypatch.setattr(
        main,
        "echo_check",
        lambda **kw: {"heard": True, "tone_dbfs": -22.4, "floor_dbfs": -57.1},
    )
    resp = client.post("/audio/echo-check")
    assert resp.status_code == 200
    assert resp.json() == {
        "heard": True, "tone_dbfs": -22.4, "floor_dbfs": -57.1,
    }


def test_echo_check_503_without_output_device(client, monkeypatch):
    monkeypatch.setattr(
        main, "_resolve", lambda: _FakeResolution(output_device=None),
    )
    resp = client.post("/audio/echo-check")
    assert resp.status_code == 503


def test_echo_check_503_without_input_device(client, monkeypatch):
    monkeypatch.setattr(
        main, "_resolve", lambda: _FakeResolution(input_device=None),
    )
    resp = client.post("/audio/echo-check")
    assert resp.status_code == 503


# ── GET/POST /voice/calibration ─────────────────────────────────────

def test_get_calibration_uncalibrated(client, cal_path):
    resp = client.get("/voice/calibration")
    assert resp.status_code == 200
    assert resp.json() == {"calibrated": False}


def test_post_calibration_persists_and_applies(client, cal_path, monkeypatch):
    pipe = _make_pipeline()
    monkeypatch.setattr(main, "_pipeline", pipe)

    body = dict(VALID_BODY, wake_threshold=0.6, flags=["Echo check skipped"])
    resp = client.post("/voice/calibration", json=body)
    assert resp.status_code == 200
    saved = resp.json()
    assert saved["calibrated"] is True
    assert saved["calibrated_at"] is not None
    assert saved["noise_floor_dbfs"] == -41.0
    assert saved["flags"] == ["Echo check skipped"]

    # Applied live.
    assert pipe._input_gain == 2.0
    assert pipe.status().threshold == 0.6

    # Persisted — a fresh GET reads it back from disk.
    got = client.get("/voice/calibration").json()
    assert got == saved


def test_post_calibration_without_pipeline_still_persists(
    client, cal_path, monkeypatch,
):
    monkeypatch.setattr(main, "_pipeline", None)
    resp = client.post("/voice/calibration", json=VALID_BODY)
    assert resp.status_code == 200
    assert cal_path.exists()
    assert client.get("/voice/calibration").json()["calibrated"] is True


def test_post_calibration_validates_payload(client, cal_path):
    resp = client.post(
        "/voice/calibration",
        json={"echo_ok": True},  # missing the measured values
    )
    assert resp.status_code == 422
    # Nothing persisted on a rejected write.
    assert not cal_path.exists()


def test_post_calibration_rejects_absurd_gain(client, cal_path):
    resp = client.post(
        "/voice/calibration", json=dict(VALID_BODY, input_gain=100.0),
    )
    assert resp.status_code == 422
    assert not cal_path.exists()
