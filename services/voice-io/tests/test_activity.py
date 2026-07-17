"""WARP-1058 — voice activity event emission.

Two layers under test:

  1. `voice.activity.OrchestratorActivityReporter` — the queue + POST
     worker that pushes events to the orchestrator's
     `POST /api/voice/events` (same base URL + bearer conventions as
     llm.py). Non-blocking `report()`, bounded queue, drop-don't-crash
     on failure.

  2. `WakePipeline`'s emit points — each §3.4 outcome produces exactly
     one event of the right type:
       - answered turn        → wake_answered
       - fragment transcript  → wake_ignored
       - LLM down / no reply  → wake_heard
       - STT down at the fire → wake_heard
       - near-miss score      → wake_missed (debounced; never below the
                                miss floor; never in calibration mode)
       - flatline transitions → dsp_wedge / dsp_recovered (one per edge)
"""
from __future__ import annotations

import time

import httpx
import numpy as np
import pytest

from voice.activity import (
    DEFAULT_EVENTS_PATH,
    MockActivityReporter,
    OrchestratorActivityReporter,
    build_reporter_from_env,
)
from voice.pipeline import WAKE_MISS_RATIO, WakePipeline
from voice.llm import MockLLM
from voice.wake import WAKE_FRAME_SAMPLES

# Shared pipeline fakes (scripted detector, failure-injectable STT/TTS,
# play recorder) — reused rather than re-declared.
from tests.test_pipeline import (
    _patch_play,
    _RecordingSTT,
    _RecordingTTS,
    _ScriptedDetector,
)


def _silence_frame() -> np.ndarray:
    return np.zeros(WAKE_FRAME_SAMPLES, dtype=np.int16)


def _wait_for(predicate, timeout_s: float = 2.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


# ────────────────────────────────────────────────────────────────────
# Reporter — HTTP shape + queue behaviour
# ────────────────────────────────────────────────────────────────────

def _install_mock_transport(monkeypatch, handler) -> list:
    """Route module-level httpx.post through a MockTransport (the same
    plumbing test_llm.py uses — the reporter calls `httpx.post`)."""
    captured: list[httpx.Request] = []

    def _record_and_handle(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_record_and_handle)
    client = httpx.Client(transport=transport)

    def _patched_post(url, **kwargs):
        return client.post(url, **kwargs)

    monkeypatch.setattr(httpx, "post", _patched_post)
    return captured


class TestOrchestratorActivityReporter:
    def test_posts_event_with_bearer_and_payload(self, monkeypatch):
        def handler(req):
            return httpx.Response(202, json={"recorded": True})
        captured = _install_mock_transport(monkeypatch, handler)

        reporter = OrchestratorActivityReporter(
            base_url="http://orchestrator:3000", bearer_token="tok-123",
        )
        try:
            reporter.report(
                "wake_answered",
                at=1234.5, score=0.91, threshold=0.7, model="hey_droplet",
            )
            assert _wait_for(lambda: len(captured) == 1)
        finally:
            reporter.stop()

        req = captured[0]
        assert req.url.path == DEFAULT_EVENTS_PATH
        assert req.headers["Authorization"] == "Bearer tok-123"
        import json
        body = json.loads(req.content)
        assert body == {
            "type": "wake_answered",
            "at": 1234.5,
            "score": 0.91,
            "threshold": 0.7,
            "model": "hey_droplet",
        }

    def test_omits_absent_fields_and_auth_header_without_token(self, monkeypatch):
        def handler(req):
            return httpx.Response(202, json={"recorded": True})
        captured = _install_mock_transport(monkeypatch, handler)

        reporter = OrchestratorActivityReporter(
            base_url="http://orchestrator:3000", bearer_token=None,
        )
        try:
            reporter.report("dsp_wedge", at=99.0)
            assert _wait_for(lambda: len(captured) == 1)
        finally:
            reporter.stop()

        req = captured[0]
        assert "authorization" not in {k.lower() for k in req.headers}
        import json
        assert json.loads(req.content) == {"type": "dsp_wedge", "at": 99.0}

    def test_unknown_event_type_is_dropped_client_side(self, monkeypatch):
        captured = _install_mock_transport(
            monkeypatch, lambda req: httpx.Response(202, json={}),
        )
        reporter = OrchestratorActivityReporter(
            base_url="http://orchestrator:3000", bearer_token="t",
        )
        try:
            reporter.report("wake_word_stolen", at=1.0)
            # Give the worker a beat — nothing must arrive.
            time.sleep(0.1)
        finally:
            reporter.stop()
        assert captured == []

    def test_full_queue_drops_without_raising(self, monkeypatch):
        # A handler that never returns quickly would need threads; instead
        # use a tiny queue and never start draining it: patch httpx.post
        # to block until we release it.
        import threading
        release = threading.Event()

        def handler(req):
            release.wait(2.0)
            return httpx.Response(202, json={})
        _install_mock_transport(monkeypatch, handler)

        reporter = OrchestratorActivityReporter(
            base_url="http://orchestrator:3000", bearer_token="t", queue_max=2,
        )
        try:
            # First event occupies the worker; the next two fill the
            # queue; everything after that must drop silently.
            for _ in range(10):
                reporter.report("wake_heard", at=1.0)
            assert reporter._dropped > 0
        finally:
            release.set()
            reporter.stop()

    def test_http_error_is_swallowed(self, monkeypatch):
        def handler(req):
            raise httpx.ConnectError("refused")
        captured = _install_mock_transport(monkeypatch, handler)
        reporter = OrchestratorActivityReporter(
            base_url="http://orchestrator:3000", bearer_token="t",
        )
        try:
            reporter.report("wake_missed", at=1.0)
            assert _wait_for(lambda: len(captured) == 1)
            # Worker survives — a second event still goes out.
            reporter.report("wake_missed", at=2.0)
            assert _wait_for(lambda: len(captured) == 2)
        finally:
            reporter.stop()


class TestBuildReporterFromEnv:
    def test_mock_llm_url_disables_reporting(self, monkeypatch):
        monkeypatch.setenv("LLM_URL", "__mock__")
        assert build_reporter_from_env() is None

    def test_defaults_to_orchestrator_dns(self, monkeypatch):
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("ORCHESTRATOR_TOKEN", "tok")
        reporter = build_reporter_from_env()
        try:
            assert isinstance(reporter, OrchestratorActivityReporter)
            assert reporter._base_url == "http://orchestrator:3000"
            assert reporter._bearer_token == "tok"
        finally:
            reporter.stop()


# ────────────────────────────────────────────────────────────────────
# Pipeline emit points
# ────────────────────────────────────────────────────────────────────

def _closed_loop_pipe(
    reporter: MockActivityReporter,
    *,
    transcripts: list[str],
    replies: list[str],
    llm_available: bool = True,
) -> WakePipeline:
    pipe = WakePipeline(
        detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
        input_device_index=0,
        output_device_index=0,
        threshold=0.5,
        stt=_RecordingSTT(scripted_transcripts=transcripts),
        tts=_RecordingTTS(),
        llm=MockLLM(scripted_replies=replies),
        stt_max_record_s=0.05,
        activity_reporter=reporter,
    )
    pipe._stt_available = True
    pipe._tts_available = True
    pipe._llm_available = llm_available
    return pipe


def _drive_turn(pipe: WakePipeline) -> None:
    pipe._on_frame(_silence_frame())  # wake
    pipe._on_frame(_silence_frame())  # begin transcription + chunk
    time.sleep(0.08)
    pipe._on_frame(_silence_frame())  # exceed window → finish


class TestPipelineWakeOutcomeEvents:
    def test_answered_turn_emits_wake_answered(self, monkeypatch):
        _patch_play(monkeypatch)
        reporter = MockActivityReporter()
        pipe = _closed_loop_pipe(
            reporter, transcripts=["what time is it"], replies=["three p.m."],
        )
        _drive_turn(pipe)
        assert reporter.types() == ["wake_answered"]
        event = reporter.events[0]
        assert event.score == pytest.approx(0.9)
        assert event.threshold == pytest.approx(0.5)
        assert event.model == "hey_jarvis"

    def test_fragment_transcript_emits_wake_ignored(self, monkeypatch):
        _patch_play(monkeypatch)
        reporter = MockActivityReporter()
        pipe = _closed_loop_pipe(
            reporter, transcripts=["it."], replies=["never asked"],
        )
        _drive_turn(pipe)
        assert reporter.types() == ["wake_ignored"]

    def test_llm_unavailable_emits_wake_heard(self, monkeypatch):
        _patch_play(monkeypatch)
        reporter = MockActivityReporter()
        pipe = _closed_loop_pipe(
            reporter,
            transcripts=["what time is it"],
            replies=[],
            llm_available=False,
        )
        _drive_turn(pipe)
        assert reporter.types() == ["wake_heard"]

    def test_stt_down_at_fire_emits_wake_heard(self):
        reporter = MockActivityReporter()
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            activity_reporter=reporter,
        )
        # No STT wired at all — the interaction ends at the detection.
        pipe._on_frame(_silence_frame())
        assert reporter.types() == ["wake_heard"]

    def test_calibration_mode_wake_emits_nothing(self):
        reporter = MockActivityReporter()
        pipe = WakePipeline(
            detector=_ScriptedDetector([{"hey_jarvis": 0.9}]),
            input_device_index=0,
            threshold=0.5,
            activity_reporter=reporter,
        )
        pipe.enter_calibration_mode(60)
        pipe._on_frame(_silence_frame())
        # Counted (the wizard's ticker rides last_wake_at), not fed.
        assert pipe.status().last_wake_at is not None
        assert reporter.events == []


class TestPipelineMissedWakeEvents:
    def _pipe(self, reporter, scores, threshold=0.5, debounce_s=2.0):
        return WakePipeline(
            detector=_ScriptedDetector(scores),
            input_device_index=0,
            threshold=threshold,
            debounce_s=debounce_s,
            activity_reporter=reporter,
        )

    def test_near_miss_emits_wake_missed(self):
        reporter = MockActivityReporter()
        # 0.4 sits in [0.5 * WAKE_MISS_RATIO, 0.5) — a near-miss.
        assert 0.5 * WAKE_MISS_RATIO <= 0.4 < 0.5
        pipe = self._pipe(reporter, [{"hey_jarvis": 0.4}])
        pipe._on_frame(_silence_frame())
        assert reporter.types() == ["wake_missed"]
        assert reporter.events[0].score == pytest.approx(0.4)
        # No wake was recorded — this never cleared the gate.
        assert pipe.status().last_wake_at is None

    def test_room_noise_below_miss_floor_emits_nothing(self):
        reporter = MockActivityReporter()
        pipe = self._pipe(reporter, [{"hey_jarvis": 0.1}])
        pipe._on_frame(_silence_frame())
        assert reporter.events == []

    def test_missed_wake_is_debounced(self):
        # One hesitant utterance spans many frames above the miss floor;
        # exactly one row within the debounce window.
        reporter = MockActivityReporter()
        pipe = self._pipe(reporter, [{"hey_jarvis": 0.4}] * 8)
        for _ in range(8):
            pipe._on_frame(_silence_frame())
        assert reporter.types() == ["wake_missed"]

    def test_near_miss_in_calibration_mode_emits_nothing(self):
        reporter = MockActivityReporter()
        pipe = self._pipe(reporter, [{"hey_jarvis": 0.4}])
        pipe.enter_calibration_mode(60)
        pipe._on_frame(_silence_frame())
        assert reporter.events == []


class TestPipelineFlatlineEvents:
    def _listening_pipe(self, reporter, flatline_window_s=0.05):
        from voice.wake import MockWakeWordDetector

        pipe = WakePipeline(
            detector=MockWakeWordDetector(),
            input_device_index=0,
            flatline_window_s=flatline_window_s,
            activity_reporter=reporter,
        )
        pipe._set_state("listening")
        return pipe

    def test_wedge_and_recovery_emit_once_per_edge(self):
        reporter = MockActivityReporter()
        pipe = self._listening_pipe(reporter)
        # Start the flatline clock in the past — whole window elapsed.
        with pipe._lock:
            pipe._audio_watch_started_at = time.time() - 1.0
        assert pipe.status().input_flatlined is True

        pipe._check_flatline_transition()
        pipe._check_flatline_transition()  # steady state: no second row
        assert reporter.types() == ["dsp_wedge"]

        # Audio returns — the flag clears on the next real frame.
        with pipe._lock:
            pipe._last_audio_at = time.time()
        assert pipe.status().input_flatlined is False
        pipe._check_flatline_transition()
        pipe._check_flatline_transition()
        assert reporter.types() == ["dsp_wedge", "dsp_recovered"]

    def test_healthy_pipeline_emits_nothing(self):
        reporter = MockActivityReporter()
        pipe = self._listening_pipe(reporter)
        with pipe._lock:
            pipe._audio_watch_started_at = time.time()
            pipe._last_audio_at = time.time()
        pipe._check_flatline_transition()
        assert reporter.events == []
