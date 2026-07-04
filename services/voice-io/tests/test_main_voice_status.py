"""Tests for /voice/status exposing the input-level fields (WARP-1037).

The wizard's live level meter and the ops-console both ride these
fields — measured inside the pipeline's own frame handler, never via a
second InputStream on the same hw device (ALSA EBUSY risk):

  input_rms_dbfs  — rolling RMS over the last ~2 s of mic frames
  last_audio_at   — wall time of the last frame carrying real signal
  input_flatlined — True when the input sat at/near digital zero for
                    the flatline window while state=listening (the
                    ReSpeaker XVF3800 wedged-DSP signature)
"""
from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

import main
from voice.pipeline import WakePipeline
from voice.wake import WAKE_FRAME_SAMPLES, DisabledWakeWordDetector


@pytest.fixture
def client():
    return TestClient(main.app)


def _listening_pipeline() -> WakePipeline:
    pipe = WakePipeline(
        detector=DisabledWakeWordDetector(),
        input_device_index=0,
    )
    pipe._set_state("listening")
    return pipe


def test_voice_status_surfaces_input_level_fields(client, monkeypatch):
    pipe = _listening_pipeline()
    pipe._on_frame(np.full(WAKE_FRAME_SAMPLES, 1000, dtype=np.int16))
    monkeypatch.setattr(main, "_pipeline", pipe)
    resp = client.get("/voice/status")
    assert resp.status_code == 200
    body = resp.json()
    # RMS of a constant-1000 int16 frame → 20·log10(1000/32768)
    assert body["input_rms_dbfs"] == pytest.approx(-30.31, abs=0.05)
    assert body["last_audio_at"] is not None
    assert body["input_flatlined"] is False


def test_voice_status_reports_flatline(client, monkeypatch):
    pipe = _listening_pipeline()
    # Zero window: baseline frame is silence, so the (tiny) window has
    # already elapsed by the time the status read happens.
    pipe._flatline_window_s = 0.001
    pipe._on_frame(np.zeros(WAKE_FRAME_SAMPLES, dtype=np.int16))
    import time

    time.sleep(0.01)
    monkeypatch.setattr(main, "_pipeline", pipe)
    body = client.get("/voice/status").json()
    assert body["input_flatlined"] is True
    assert body["last_audio_at"] is None


def test_voice_status_without_pipeline_defaults_level_fields(client, monkeypatch):
    monkeypatch.setattr(main, "_pipeline", None)
    body = client.get("/voice/status").json()
    assert body["input_rms_dbfs"] is None
    assert body["last_audio_at"] is None
    assert body["input_flatlined"] is False
