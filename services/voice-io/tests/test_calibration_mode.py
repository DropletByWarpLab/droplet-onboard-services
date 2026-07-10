"""WARP-1059 — calibration mode: suppress wake HANDLING while the
wizard measures, keep wake DETECTION counting.

Contract pinned here (from WARP-1055 review finding F6):

  - enter/exit/renew: status() reports the mode + its expiry; exit is
    idempotent.
  - fail-safe: the mode is a wall-clock TTL computed on read — it
    auto-expires with no timer thread, a nonsense TTL falls back to the
    default (never an unbounded window), and a fresh pipeline starts
    with the mode off (process restart can't come back deaf).
  - while active: an above-threshold frame still records
    last_wake_at/score/model (the wizard's step-3 ticker rides those)
    but the state stays 'listening', the on_wake callback never fires,
    and no STT session opens — so no LLM call and nothing is spoken.
  - after expiry/exit: the very next above-threshold frame is handled
    normally (wake_detected → STT).
"""
from __future__ import annotations

import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

import main
from voice.pipeline import (
    DEFAULT_CALIBRATION_MODE_TTL_S,
    WakePipeline,
)
from voice.stt import MockSTT
from voice.wake import WAKE_FRAME_SAMPLES, MockWakeWordDetector


def _frame() -> np.ndarray:
    return np.zeros(WAKE_FRAME_SAMPLES, dtype=np.int16)


def _wake_pipeline(**kwargs) -> WakePipeline:
    """A pipeline whose detector fires on the FIRST frame only —
    subsequent frames score 0, so each test drives exactly the wakes it
    scripts. State is forced to 'listening' (no worker thread)."""
    pipe = WakePipeline(
        detector=MockWakeWordDetector(
            scripted_scores=kwargs.pop("scores", [{"hey_jarvis": 0.9}]),
        ),
        input_device_index=0,
        debounce_s=0.0,
        **kwargs,
    )
    pipe._set_state("listening")
    return pipe


# ────────────────────────────────────────────────────────────────────
# Enter / exit / expiry
# ────────────────────────────────────────────────────────────────────

class TestModeLifecycle:
    def test_enter_reports_active_with_expiry(self):
        pipe = _wake_pipeline()
        before = time.time()
        expires = pipe.enter_calibration_mode(60.0)
        s = pipe.status()
        assert s.calibration_mode is True
        assert s.calibration_mode_expires_at == expires
        assert before + 59.0 < expires < before + 61.0

    def test_exit_clears_the_mode_and_is_idempotent(self):
        pipe = _wake_pipeline()
        pipe.enter_calibration_mode(60.0)
        pipe.exit_calibration_mode()
        s = pipe.status()
        assert s.calibration_mode is False
        assert s.calibration_mode_expires_at is None
        pipe.exit_calibration_mode()  # second exit: no error, still off
        assert pipe.status().calibration_mode is False

    def test_reenter_renews_the_window(self):
        pipe = _wake_pipeline()
        first = pipe.enter_calibration_mode(10.0)
        second = pipe.enter_calibration_mode(120.0)
        assert second > first
        assert pipe.status().calibration_mode_expires_at == second

    def test_auto_expires_without_any_exit_call(self):
        # Fail-safe: wizard abandoned mid-calibration — the TTL alone
        # restores wake handling.
        pipe = _wake_pipeline()
        pipe.enter_calibration_mode(0.01)
        time.sleep(0.03)
        s = pipe.status()
        assert s.calibration_mode is False
        assert s.calibration_mode_expires_at is None

    @pytest.mark.parametrize("bad_ttl", [0, -5, float("inf"), float("nan"), "x"])
    def test_nonsense_ttl_falls_back_to_default(self, bad_ttl):
        pipe = _wake_pipeline()
        before = time.time()
        expires = pipe.enter_calibration_mode(bad_ttl)  # type: ignore[arg-type]
        # Never an unbounded (or instantly-expired) window.
        assert before < expires <= before + DEFAULT_CALIBRATION_MODE_TTL_S + 1.0

    def test_fresh_pipeline_starts_with_mode_off(self):
        # Process restart is a clearing event by construction — the
        # mode is in-memory only, never persisted.
        assert _wake_pipeline().status().calibration_mode is False


# ────────────────────────────────────────────────────────────────────
# Counted, not handled
# ────────────────────────────────────────────────────────────────────

class TestWakeSuppression:
    def test_wake_counted_but_not_handled_while_active(self):
        fired = []
        stt = MockSTT(scripted_transcripts=["turn on the lights"])
        pipe = _wake_pipeline(on_wake=fired.append, stt=stt)
        pipe._stt_available = True
        pipe.enter_calibration_mode(60.0)

        pipe._on_frame(_frame())  # above-threshold frame
        s = pipe.status()
        # Counted: the wizard's step-3 ticker rides these fields.
        assert s.last_wake_at is not None
        assert s.last_wake_score == pytest.approx(0.9)
        assert s.last_wake_model == "hey_jarvis"
        # Not handled: no state excursion, no callback.
        assert s.state == "listening"
        assert fired == []

        # And the next frame must NOT begin a transcription (in normal
        # mode the wake_detected state routes it into the STT path).
        pipe._on_frame(_frame())
        assert stt.sessions_opened == 0
        assert pipe.status().state == "listening"

    def test_no_stt_llm_tts_chain_means_nothing_spoken(self):
        # The reply path only runs off a transcript; with no STT session
        # there is no transcript, no LLM call, and last_response stays
        # empty — the box speaker never pollutes a measurement window.
        stt = MockSTT(scripted_transcripts=["what's the weather"])
        pipe = _wake_pipeline(stt=stt)
        pipe._stt_available = True
        pipe.enter_calibration_mode(60.0)
        for _ in range(5):
            pipe._on_frame(_frame())
        assert stt.sessions_opened == 0
        s = pipe.status()
        assert s.last_transcript is None
        assert s.last_response is None

    def test_detector_reset_after_counted_wake(self):
        # Same contract as the decay path: a stateful recognizer (Vosk)
        # must not carry a half-decoded utterance into the next try —
        # step 3 says the phrase three times back to back.
        resets = []
        pipe = _wake_pipeline()
        pipe._detector.reset = lambda: resets.append(1)  # type: ignore[method-assign]
        pipe.enter_calibration_mode(60.0)
        pipe._on_frame(_frame())
        assert len(resets) == 1

    def test_handling_resumes_after_expiry(self):
        stt = MockSTT(scripted_transcripts=["hello"])
        pipe = _wake_pipeline(
            scores=[{"hey_jarvis": 0.9}, {"hey_jarvis": 0.9}],
            stt=stt,
        )
        pipe._stt_available = True
        pipe.enter_calibration_mode(0.01)
        time.sleep(0.03)

        pipe._on_frame(_frame())  # wake fires — mode has expired
        assert pipe.status().state == "wake_detected"
        pipe._on_frame(_frame())  # next frame begins transcription
        assert stt.sessions_opened == 1

    def test_handling_resumes_after_explicit_exit(self):
        fired = []
        pipe = _wake_pipeline(
            scores=[{"hey_jarvis": 0.9}, {"hey_jarvis": 0.9}],
            on_wake=fired.append,
        )
        pipe.enter_calibration_mode(60.0)
        pipe._on_frame(_frame())
        assert fired == []
        pipe.exit_calibration_mode()
        pipe._on_frame(_frame())
        assert len(fired) == 1
        assert pipe.status().state == "wake_detected"


# ────────────────────────────────────────────────────────────────────
# HTTP surface (main.py)
# ────────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    return TestClient(main.app)


class TestCalibrationModeEndpoints:
    def test_enter_returns_active_with_expiry(self, client, monkeypatch):
        pipe = _wake_pipeline()
        monkeypatch.setattr(main, "_pipeline", pipe)
        before = time.time()
        resp = client.post("/voice/calibration-mode", json={"ttl_s": 60})
        assert resp.status_code == 200
        body = resp.json()
        assert body["active"] is True
        assert before + 59.0 < body["expires_at"] < before + 61.0
        assert pipe.status().calibration_mode is True

    def test_enter_without_body_uses_default_ttl(self, client, monkeypatch):
        pipe = _wake_pipeline()
        monkeypatch.setattr(main, "_pipeline", pipe)
        before = time.time()
        resp = client.post("/voice/calibration-mode")
        assert resp.status_code == 200
        expires = resp.json()["expires_at"]
        assert expires == pytest.approx(
            before + DEFAULT_CALIBRATION_MODE_TTL_S, abs=1.0,
        )

    @pytest.mark.parametrize("ttl", [1, 0, -4, 3600])
    def test_out_of_bounds_ttl_is_rejected(self, client, monkeypatch, ttl):
        pipe = _wake_pipeline()
        monkeypatch.setattr(main, "_pipeline", pipe)
        resp = client.post("/voice/calibration-mode", json={"ttl_s": ttl})
        assert resp.status_code == 422
        assert pipe.status().calibration_mode is False

    def test_enter_without_pipeline_is_503(self, client, monkeypatch):
        monkeypatch.setattr(main, "_pipeline", None)
        resp = client.post("/voice/calibration-mode", json={"ttl_s": 60})
        assert resp.status_code == 503

    def test_exit_clears_the_mode(self, client, monkeypatch):
        pipe = _wake_pipeline()
        pipe.enter_calibration_mode(60.0)
        monkeypatch.setattr(main, "_pipeline", pipe)
        resp = client.delete("/voice/calibration-mode")
        assert resp.status_code == 200
        assert resp.json() == {"active": False, "expires_at": None}
        assert pipe.status().calibration_mode is False

    def test_exit_without_pipeline_never_errors(self, client, monkeypatch):
        # Cancel/close paths fire this best-effort — it must be safe
        # even when the pipeline never started.
        monkeypatch.setattr(main, "_pipeline", None)
        resp = client.delete("/voice/calibration-mode")
        assert resp.status_code == 200
        assert resp.json()["active"] is False

    def test_status_surfaces_the_mode_fields(self, client, monkeypatch):
        pipe = _wake_pipeline()
        expires = pipe.enter_calibration_mode(60.0)
        monkeypatch.setattr(main, "_pipeline", pipe)
        body = client.get("/voice/status").json()
        assert body["calibration_mode"] is True
        assert body["calibration_mode_expires_at"] == pytest.approx(expires)
