"""End-to-end tests against the FastAPI app using mock backends.

These tests are deliberately INSIDE-the-process and do not require any
real audio hardware — that's the value of the mock backend pattern.
The same code paths run in production with VOICE_AUDIO_BACKEND=alsa /
VOICE_STT_BACKEND=whisper / etc.
"""

from __future__ import annotations

import io
import os
import wave

import pytest
from fastapi.testclient import TestClient

# Ensure mock backends + no token requirement BEFORE main.py reads env.
os.environ.setdefault("VOICE_AUDIO_BACKEND", "mock")
os.environ.setdefault("VOICE_STT_BACKEND", "mock")
os.environ.setdefault("VOICE_TTS_BACKEND", "mock")
os.environ.setdefault("VOICE_GPIO_BACKEND", "noop")
os.environ.pop("VOICE_TOKEN", None)

import main  # noqa: E402


@pytest.fixture(autouse=True)
def reset_state():
    """Reset module state between tests so the state machine doesn't carry
    over (one test moves to MUTED — without reset the next would 401)."""
    # Reset by re-creating the singletons.
    main._cfg = None
    main._audio = None
    main._stt = None
    main._tts = None
    main._gpio = None
    main._state = None
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(main.create_app())


def test_health_returns_backends(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["audio_backend"] == "mock"
    assert body["stt_backend"] == "mock"
    assert body["state"] == "idle"


def test_listen_transcribes_captured_audio(client: TestClient):
    r = client.post("/listen?seconds=1.0")
    assert r.status_code == 200
    body = r.json()
    assert body["captured_seconds"] == 1.0
    assert "[mock transcription of" in body["text"]
    # State should return to idle after the request completes.
    assert client.get("/state").json()["state"] == "idle"


def test_listen_refuses_when_muted(client: TestClient):
    client.post("/mute")
    r = client.post("/listen?seconds=1.0")
    assert r.status_code == 409
    assert r.json()["detail"] == "muted"


def test_unmute_returns_to_idle(client: TestClient):
    client.post("/mute")
    assert client.get("/state").json()["state"] == "muted"
    client.post("/unmute")
    assert client.get("/state").json()["state"] == "idle"


def test_listen_clamps_seconds(client: TestClient):
    """0.1s rejected (below 0.5 lower bound), 60s rejected (above 30 upper)."""
    assert client.post("/listen?seconds=0.1").status_code == 422
    assert client.post("/listen?seconds=60").status_code == 422


def test_speak_returns_wav_when_play_false(client: TestClient):
    r = client.post("/speak", json={"text": "hello world"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    # Verify the body is actually a WAV.
    with wave.open(io.BytesIO(r.content), "rb") as w:
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getnframes() > 0


def test_speak_plays_when_play_true(client: TestClient):
    r = client.post("/speak?play=true", json={"text": "test"})
    assert r.status_code == 200
    body = r.json()
    assert body["played"] is True
    assert body["bytes"] > 0
    assert client.get("/state").json()["state"] == "idle"


def test_speak_rejects_empty_text(client: TestClient):
    r = client.post("/speak", json={"text": ""})
    assert r.status_code == 400


def test_speak_rejects_oversized_text(client: TestClient):
    r = client.post("/speak", json={"text": "a" * 6000})
    assert r.status_code == 413


def test_speak_with_play_refuses_when_muted(client: TestClient):
    client.post("/mute")
    r = client.post("/speak?play=true", json={"text": "test"})
    assert r.status_code == 409
    # Without play=true, speak still returns the WAV even when muted —
    # the mute only blocks the speaker, not synthesis.


def test_transcribe_accepts_wav_upload(client: TestClient):
    # Build a tiny valid WAV.
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 1600)  # 100ms of silence
    r = client.post(
        "/transcribe",
        files={"file": ("test.wav", buf.getvalue(), "audio/wav")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["sample_rate"] == 16000
    assert "[mock transcription of" in body["text"]


def test_transcribe_rejects_non_wav(client: TestClient):
    r = client.post(
        "/transcribe",
        files={"file": ("test.mp3", b"not a wav", "audio/mpeg")},
    )
    assert r.status_code == 400


def test_auth_required_when_voice_token_set():
    """When VOICE_TOKEN is set in the env, every POST requires the
    Authorization header. GET /health and GET /state stay public."""
    os.environ["VOICE_TOKEN"] = "secret123"
    main._cfg = None
    main._state = None
    try:
        c = TestClient(main.create_app())
        # Public reads
        assert c.get("/health").status_code == 200
        assert c.get("/state").status_code == 200
        # Protected POST without token
        assert c.post("/listen?seconds=1").status_code == 401
        assert c.post("/speak", json={"text": "hi"}).status_code == 401
        assert c.post("/mute").status_code == 401
        # With correct token
        assert c.post("/mute", headers={"Authorization": "Bearer secret123"}).status_code == 200
        # Wrong token
        assert c.post("/unmute", headers={"Authorization": "Bearer wrong"}).status_code == 401
    finally:
        os.environ.pop("VOICE_TOKEN", None)
        main._cfg = None
