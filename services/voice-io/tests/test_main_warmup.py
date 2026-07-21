"""WARP-1433 — startup warm-up + shutdown client-close.

Warm-up fires ONE throwaway Piper synth (pays the ~70 MB voice download /
warm-up — tts.py budgets 15 s) and ONE tiny Whisper transcribe (pays the
CTranslate2 init) so the FIRST real utterance isn't cold. It must be:
best-effort (a synth/transcribe failure never propagates), run once, skip
cleanly when an upstream is unreachable or a __mock__ dev client, and never
block startup or /health (it runs on a daemon thread — tested here by
calling the worker directly).

Shutdown closes the pooled httpx clients (the LLM + the persona fetcher)
once the pipeline worker has joined, so no request is in flight.
"""
from __future__ import annotations

import asyncio

import main
from voice.stt import MockSTT
from voice.tts import MockTTS


# ── recording fakes (duck-typed; NOT the Mock* classes, which warm-up skips)

class _RecordingTTS:
    def __init__(self, available: bool = True, raises: bool = False):
        self._available = available
        self._raises = raises
        self.synth_calls: list[str] = []

    @property
    def available(self) -> bool:
        return self._available

    def synthesize(self, text: str, voice=None):
        self.synth_calls.append(text)
        if self._raises:
            raise RuntimeError("piper synth blew up")
        return None


class _RecordingSTTSession:
    def __init__(self, parent: "_RecordingSTT"):
        self._parent = parent

    def send_chunk(self, audio_bytes: bytes) -> None:
        self._parent.chunks.append(audio_bytes)

    def finish(self) -> str:
        self._parent.finished += 1
        if self._parent._raises_finish:
            raise RuntimeError("whisper transcribe blew up")
        return ""

    def close(self) -> None:
        self._parent.closed += 1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class _RecordingSTT:
    def __init__(
        self,
        available: bool = True,
        raises_session: bool = False,
        raises_finish: bool = False,
    ):
        self._available = available
        self._raises_session = raises_session
        self._raises_finish = raises_finish
        self.sessions = 0
        self.chunks: list[bytes] = []
        self.finished = 0
        self.closed = 0

    @property
    def available(self) -> bool:
        return self._available

    def session(self) -> _RecordingSTTSession:
        self.sessions += 1
        if self._raises_session:
            raise RuntimeError("connect refused")
        return _RecordingSTTSession(self)


# ── warm-up ──────────────────────────────────────────────────────────

class TestWarmUp:
    def test_runs_synth_and_transcribe_once(self):
        tts = _RecordingTTS()
        stt = _RecordingSTT()
        main._warm_up_upstreams(stt, tts)
        assert len(tts.synth_calls) == 1
        # Non-empty text — tts.py short-circuits an empty synthesize request.
        assert tts.synth_calls[0].strip()
        assert stt.sessions == 1
        assert stt.finished == 1
        assert stt.chunks  # a tiny chunk was streamed to force the model load

    def test_non_fatal_on_synth_failure(self):
        tts = _RecordingTTS(raises=True)
        stt = _RecordingSTT()
        # Must not raise — a cold first turn is a latency blip, not an outage.
        main._warm_up_upstreams(stt, tts)
        # A TTS failure must not stop STT from warming.
        assert stt.sessions == 1

    def test_non_fatal_on_transcribe_failure(self):
        tts = _RecordingTTS()
        stt = _RecordingSTT(raises_finish=True)
        main._warm_up_upstreams(stt, tts)  # must not raise
        assert len(tts.synth_calls) == 1

    def test_non_fatal_on_session_open_failure(self):
        stt = _RecordingSTT(raises_session=True)
        main._warm_up_upstreams(stt, _RecordingTTS())  # must not raise

    def test_skips_when_upstreams_unavailable(self):
        tts = _RecordingTTS(available=False)
        stt = _RecordingSTT(available=False)
        main._warm_up_upstreams(stt, tts)
        assert tts.synth_calls == []
        assert stt.sessions == 0

    def test_handles_none_clients(self):
        main._warm_up_upstreams(None, None)  # no raise

    def test_skips_mock_clients(self):
        # __mock__ dev clients have no real Piper/Whisper to warm — skip
        # cleanly (never touch them) so a dev box does no pointless work.
        tts = MockTTS()
        stt = MockSTT()
        main._warm_up_upstreams(stt, tts)
        assert tts.texts_received == []
        assert stt.sessions_opened == 0


# ── shutdown closes the pooled clients (WARP-1433) ──────────────────

class TestShutdownClosesClients:
    def test_shutdown_closes_llm_and_persona(self, monkeypatch):
        closed = {"llm": 0, "persona": 0}

        class _FakeLLM:
            def close(self) -> None:
                closed["llm"] += 1

        class _FakePersona:
            def close(self) -> None:
                closed["persona"] += 1

        class _FakePipeline:
            def stop(self) -> None:
                pass

        monkeypatch.setattr(main, "_pipeline", _FakePipeline())
        monkeypatch.setattr(main, "_activity_reporter", None)
        monkeypatch.setattr(main, "_llm", _FakeLLM())
        monkeypatch.setattr(main, "_persona_fetcher", _FakePersona())

        asyncio.run(main.shutdown())

        assert closed["llm"] == 1
        assert closed["persona"] == 1
        assert main._llm is None
        assert main._persona_fetcher is None

    def test_shutdown_survives_close_raising(self, monkeypatch):
        # A client whose close() raises must not break shutdown.
        class _AngryLLM:
            def close(self) -> None:
                raise RuntimeError("close blew up")

        class _FakePipeline:
            def stop(self) -> None:
                pass

        monkeypatch.setattr(main, "_pipeline", _FakePipeline())
        monkeypatch.setattr(main, "_activity_reporter", None)
        monkeypatch.setattr(main, "_llm", _AngryLLM())
        monkeypatch.setattr(main, "_persona_fetcher", None)

        asyncio.run(main.shutdown())  # must not raise
        assert main._llm is None
