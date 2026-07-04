"""Tests for the /health endpoint's degraded-on-deaf-state contract.

The wake pipeline latches into a state where `_on_frame` drops every
incoming frame — `state in ('error', 'no_mic')` (voice/pipeline.py). In
either of those the assistant is alive but stuck-and-deaf, so /health must
report ok=False + HTTP 503 to make the Dockerfile healthcheck (`curl -sf`,
which fails on >=400) flag the container unhealthy. Every other state stays
ok=True + 200.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import pytest
from fastapi.testclient import TestClient

import main


@dataclass
class _FakeStatus:
    """Minimal stand-in for pipeline.PipelineStatus — only the fields
    /health reads."""

    state: str
    wake_loaded: bool = True
    stt_loaded: bool = True
    tts_loaded: bool = True
    llm_loaded: bool = True
    # Input-level tracking (WARP-1037).
    input_rms_dbfs: Optional[float] = None
    last_audio_at: Optional[float] = None
    input_flatlined: bool = False


class _FakePipeline:
    def __init__(self, state: str, **status_overrides):
        self._status = _FakeStatus(state=state, **status_overrides)

    def status(self) -> _FakeStatus:
        return self._status


@dataclass
class _FakeDevice:
    name: str = "fake"


@dataclass
class _FakeResolution:
    input_device: Optional[_FakeDevice]
    output_device: Optional[_FakeDevice]


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def _stub_resolve(monkeypatch):
    """Stop /health from touching real audio hardware."""
    monkeypatch.setattr(
        main,
        "_resolve",
        lambda: _FakeResolution(
            input_device=_FakeDevice(), output_device=_FakeDevice()
        ),
    )


def _set_pipeline_state(monkeypatch, state: str) -> None:
    monkeypatch.setattr(main, "_pipeline", _FakePipeline(state))


# ── stuck-and-deaf states → degraded ────────────────────────────────

def test_error_state_reports_degraded_503(client, monkeypatch):
    _set_pipeline_state(monkeypatch, "error")
    resp = client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["ok"] is False
    assert body["state"] == "error"


def test_no_mic_state_reports_degraded_503(client, monkeypatch):
    # no_mic drops every frame exactly like error (voice/pipeline.py
    # _on_frame: state in ('error', 'no_mic')). There is no supported
    # mic-less / output-only mode, so a no-mic container is equally deaf
    # and must degrade — not silently stay 200.
    _set_pipeline_state(monkeypatch, "no_mic")
    resp = client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["ok"] is False
    assert body["state"] == "no_mic"


# ── healthy / transient states → ok ─────────────────────────────────

@pytest.mark.parametrize("state", ["listening", "loading", "idle", "speaking"])
def test_non_deaf_states_report_ok_200(client, monkeypatch, state):
    _set_pipeline_state(monkeypatch, state)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["state"] == state


def test_no_pipeline_reports_ok_200(client, monkeypatch):
    # Before the pipeline exists state is None — not stuck-and-deaf.
    monkeypatch.setattr(main, "_pipeline", None)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["state"] is None


# ── input flatline (WARP-1037) → degraded ───────────────────────────
#
# A wedged ReSpeaker DSP keeps the stream open (state stays 'listening')
# but delivers pure digital silence. The pipeline flags that via
# status().input_flatlined; /health must degrade to 503 so the Docker
# healthcheck + ops-console see "deaf", not "healthy".

def test_listening_but_flatlined_reports_degraded_503(client, monkeypatch):
    monkeypatch.setattr(
        main,
        "_pipeline",
        _FakePipeline(
            "listening",
            input_flatlined=True,
            input_rms_dbfs=-120.0,
            last_audio_at=1000.0,
        ),
    )
    resp = client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["ok"] is False
    assert body["state"] == "listening"
    assert body["inputFlatlined"] is True
    assert body["inputRmsDbfs"] == -120.0
    assert body["lastAudioAt"] == 1000.0


def test_listening_with_audio_reports_ok_200_with_level_fields(client, monkeypatch):
    monkeypatch.setattr(
        main,
        "_pipeline",
        _FakePipeline(
            "listening",
            input_flatlined=False,
            input_rms_dbfs=-42.5,
            last_audio_at=2000.0,
        ),
    )
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["inputFlatlined"] is False
    assert body["inputRmsDbfs"] == -42.5
    assert body["lastAudioAt"] == 2000.0


def test_recovery_after_flatline_reports_ok_again(client, monkeypatch):
    # Audio returned (DSP rebooted) → the same pipeline object now says
    # input_flatlined=False → /health must flip back to 200 without a
    # container restart.
    pipe = _FakePipeline("listening", input_flatlined=True)
    monkeypatch.setattr(main, "_pipeline", pipe)
    assert client.get("/health").status_code == 503
    pipe._status.input_flatlined = False
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
