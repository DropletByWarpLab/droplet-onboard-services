"""
Voice service — FastAPI app.

Endpoints:
  GET  /health                 — readiness probe
  GET  /state                  — current state machine
  POST /listen                 — capture N seconds of audio + transcribe
                                 (returns the text). Drives the state
                                 idle → listening → processing → idle.
  POST /transcribe             — transcribe an uploaded WAV (no capture)
  POST /speak                  — synthesize text to a WAV blob (return)
                                 OR play it through the speaker (?play=1).
                                 Drives idle → speaking → idle.
  POST /mute                   — force MUTED. Cuts mic VDD via GPIO if
                                 configured. Lights the red LED.
  POST /unmute                 — return to IDLE.

All POST endpoints require `Authorization: Bearer <VOICE_TOKEN>` if
VOICE_TOKEN is set in the environment. The orchestrator's voice tools
pass this header. Without VOICE_TOKEN set the service runs unauthenticated
(dev mode); production deployments MUST set it because the service exposes
audio capture (privacy-sensitive).
"""

from __future__ import annotations

import io
import logging

from fastapi import Body, Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, Response

from audio import make_audio, pcm_to_wav, wav_to_pcm
from config import VoiceConfig, load_config
from gpio import make_gpio
from state import State, StateMachine
from stt import make_stt
from tts import make_tts


logger = logging.getLogger("voice.main")

# ── Lazy module-level singletons. Constructed by the FastAPI app factory
# below so tests can swap them out. ──

_cfg: VoiceConfig | None = None
_audio = None
_stt = None
_tts = None
_gpio = None
_state: StateMachine | None = None


def _ensure_init() -> None:
    """Idempotent init. Wired this way so tests can monkey-patch the
    backends BEFORE the first request lands."""
    global _cfg, _audio, _stt, _tts, _gpio, _state
    if _cfg is None:
        _cfg = load_config()
    if _audio is None:
        _audio = make_audio(_cfg)
    if _stt is None:
        _stt = make_stt(_cfg)
    if _tts is None:
        _tts = make_tts(_cfg)
    if _gpio is None:
        _gpio = make_gpio(_cfg)
    if _state is None:
        _state = StateMachine()
        # Drive the mute LED from state changes.
        def _on_state(_old: State, new: State) -> None:
            assert _gpio is not None
            _gpio.set_mute_led(new == State.MUTED)
            _gpio.set_mic_power(new != State.MUTED)
        _state.on_change(_on_state)


def _check_auth(authorization: str | None) -> None:
    """Bearer-token gate. Falls open if VOICE_TOKEN isn't set so dev
    machines work without configuration; raises 401 otherwise."""
    assert _cfg is not None
    if not _cfg.voice_token:
        return
    if not authorization:
        raise HTTPException(status_code=401, detail="missing_authorization")
    expected = f"Bearer {_cfg.voice_token}"
    # Constant-time compare for the token.
    import hmac
    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="invalid_token")


def auth_dep(authorization: str | None = Header(default=None)) -> None:
    _ensure_init()
    _check_auth(authorization)


def create_app() -> FastAPI:
    app = FastAPI(title="Droplet Voice Service", version="0.1.0")
    _ensure_init()

    @app.get("/health")
    def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "audio_backend": _cfg.audio_backend,                 # type: ignore[union-attr]
                "stt_backend": _cfg.stt_backend,                     # type: ignore[union-attr]
                "tts_backend": _cfg.tts_backend,                     # type: ignore[union-attr]
                "gpio_backend": _cfg.gpio_backend,                   # type: ignore[union-attr]
                "state": _state.current.value,                        # type: ignore[union-attr]
            }
        )

    @app.get("/state")
    def state() -> dict:
        assert _state is not None
        return {"state": _state.current.value}

    @app.post("/listen")
    def listen(
        seconds: float = Query(default=5.0, ge=0.5, le=30.0),
        _auth: None = Depends(auth_dep),
    ) -> dict:
        """Capture `seconds` of audio, transcribe it, return the text.
        Refuses if the service is currently muted."""
        assert _state is not None and _audio is not None and _stt is not None and _cfg is not None
        if _state.current == State.MUTED:
            raise HTTPException(status_code=409, detail="muted")
        if _state.current != State.IDLE:
            raise HTTPException(status_code=409, detail=f"busy: {_state.current.value}")

        try:
            _state.set(State.LISTENING)
            pcm = _audio.record_seconds(seconds)
            _state.set(State.PROCESSING)
            text = _stt.transcribe_pcm(pcm, _cfg.sample_rate_hz)
        finally:
            try:
                _state.set(State.IDLE)
            except ValueError:
                # If something already moved us elsewhere (e.g. mute pressed
                # mid-capture), respect that state.
                pass

        return {"text": text, "captured_seconds": seconds}

    @app.post("/transcribe")
    async def transcribe(
        file: UploadFile = File(...),
        _auth: None = Depends(auth_dep),
    ) -> dict:
        assert _stt is not None
        if file.content_type and "wav" not in file.content_type.lower() and not (file.filename or "").lower().endswith(".wav"):
            raise HTTPException(status_code=400, detail="only WAV is accepted")
        data = await file.read()
        if len(data) > 50 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="upload too large (>50MB)")
        try:
            pcm, rate = wav_to_pcm(data)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"invalid_wav: {exc}") from exc
        text = _stt.transcribe_pcm(pcm, rate)
        return {"text": text, "sample_rate": rate}

    @app.post("/speak")
    def speak(
        text: str = Body(..., embed=True),
        play: bool = Query(default=False),
        _auth: None = Depends(auth_dep),
    ):
        """Synthesize text. If play=true, plays through the speaker AND
        returns 200 with no body. Otherwise returns the WAV blob."""
        assert _state is not None and _tts is not None and _audio is not None
        if not isinstance(text, str) or not text.strip():
            raise HTTPException(status_code=400, detail="text required")
        if len(text) > 5000:
            raise HTTPException(status_code=413, detail="text too long (>5000 chars)")
        if _state.current == State.MUTED and play:
            raise HTTPException(status_code=409, detail="muted")

        pcm = _tts.synthesize(text)
        wav = pcm_to_wav(pcm, _tts.sample_rate_hz())

        if play:
            try:
                _state.set(State.SPEAKING)
                _audio.play_pcm(pcm)
            finally:
                try:
                    _state.set(State.IDLE)
                except ValueError:
                    pass
            return JSONResponse({"played": True, "bytes": len(pcm)})
        return Response(content=wav, media_type="audio/wav")

    @app.post("/mute")
    def mute(_auth: None = Depends(auth_dep)) -> dict:
        assert _state is not None
        _state.force(State.MUTED)
        return {"state": _state.current.value}

    @app.post("/unmute")
    def unmute(_auth: None = Depends(auth_dep)) -> dict:
        assert _state is not None
        _state.set(State.IDLE)
        return {"state": _state.current.value}

    return app


# Module-level app for `uvicorn main:app`.
app = create_app()
