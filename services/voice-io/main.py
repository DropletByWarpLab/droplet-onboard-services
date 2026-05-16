"""voice-io FastAPI control surface.

Live this commit:

  1. Boot up, discover audio devices, pick best, start wake pipeline.
  2. /health + /audio/devices for the dashboard.
  3. /audio/test-tone + /audio/test-record for hardware verification.
  4. /voice/status — wake pipeline state machine.

Wake-word loop runs on a background thread spawned at FastAPI
startup; shut down cleanly on shutdown event. STT / TTS / agent glue
come in subsequent commits.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from voice.audio_io import (
    AudioUnavailable,
    measure_input_level,
    test_tone,
)
from voice.devices import (
    DeviceResolution,
    resolve_devices,
)
from voice.pipeline import (
    DEFAULT_DEBOUNCE_S,
    DEFAULT_STT_MAX_RECORD_S,
    DEFAULT_THRESHOLD,
    WakePipeline,
)
from voice.llm import build_llm_from_env
from voice.stt import build_stt_from_env
from voice.tts import build_tts_from_env
from voice.wake import build_detector_from_env

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("voice.main")

SAMPLE_RATE = int(os.environ.get("VOICE_SAMPLE_RATE", "16000"))
WAKE_THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", str(DEFAULT_THRESHOLD)))
WAKE_DEBOUNCE_S = float(
    os.environ.get("WAKE_DEBOUNCE_S", str(DEFAULT_DEBOUNCE_S))
)
STT_MAX_RECORD_S = float(
    os.environ.get("STT_MAX_RECORD_S", str(DEFAULT_STT_MAX_RECORD_S))
)

app = FastAPI(title="voice-io", version="0.1.0")

# Pipeline lives at module scope so /voice/status can read its state
# from the request thread while the worker thread is mid-prediction.
_pipeline: Optional[WakePipeline] = None


# Cached on first call; /audio/devices refreshes on demand.
_resolution: Optional[DeviceResolution] = None
_resolved_at: float = 0.0


def _resolve() -> DeviceResolution:
    """Resolve devices, caching the result for the process lifetime.

    Hot-plug rescan lives in a subsequent commit (background task on
    DEVICE_RESCAN_INTERVAL); for now /audio/devices?refresh=1 forces
    a re-pick.
    """
    global _resolution, _resolved_at
    if _resolution is None:
        _resolution = resolve_devices()
        _resolved_at = time.time()
        if _resolution.input_device:
            logger.info(
                "picked input: %s (bus=%s, score=%d, source=%s)",
                _resolution.input_device.name,
                _resolution.input_device.bus,
                _resolution.input_device.score_as_input,
                _resolution.input_source,
            )
        else:
            logger.warning("no input device available (no-mic mode)")
        if _resolution.output_device:
            logger.info(
                "picked output: %s (bus=%s, score=%d, source=%s)",
                _resolution.output_device.name,
                _resolution.output_device.bus,
                _resolution.output_device.score_as_output,
                _resolution.output_source,
            )
        else:
            logger.warning("no output device available")
    return _resolution


@app.on_event("startup")
async def startup() -> None:
    # Resolve audio devices on boot so the first /health hit is cheap.
    # Doesn't fail the boot if PortAudio is missing — we want the
    # service running so operators can still hit /audio/devices and
    # see "no audio".
    try:
        r = _resolve()
    except Exception as exc:  # pragma: no cover — defensive
        logger.error("device resolution failed at startup: %s", exc)
        return

    # Spin up the wake-detection pipeline. The detector is constructed
    # synchronously (cheap — model load is lazy) but the worker thread
    # is what actually opens the mic stream + ONNX runtime. STT + TTS
    # clients are also lazy — `available` is probed by pipeline.start()
    # once, not on every transcript / synthesize.
    global _pipeline
    try:
        detector = build_detector_from_env()
        stt = build_stt_from_env()
        tts = build_tts_from_env()
        llm = build_llm_from_env()
        _pipeline = WakePipeline(
            detector=detector,
            stt=stt,
            tts=tts,
            llm=llm,
            input_device_index=r.input_device.index if r.input_device else None,
            output_device_index=r.output_device.index if r.output_device else None,
            threshold=WAKE_THRESHOLD,
            debounce_s=WAKE_DEBOUNCE_S,
            stt_max_record_s=STT_MAX_RECORD_S,
        )
        _pipeline.start()
    except Exception as exc:
        logger.error("wake pipeline failed to start: %s", exc)


@app.on_event("shutdown")
async def shutdown() -> None:
    global _pipeline
    if _pipeline is not None:
        _pipeline.stop()
        _pipeline = None


# ────────────────────────────────────────────────────────────────────
# Schemas
# ────────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    ok: bool
    inputAvailable: bool
    outputAvailable: bool
    wakeLoaded: bool = False
    sttLoaded: bool = False
    ttsLoaded: bool = False
    # Commit 7. True iff the orchestrator's /api/llm/chat was reachable
    # at startup. Wake + STT still work when this is false, but no
    # spoken replies happen.
    llmLoaded: bool = False


class VoiceStatusResponse(BaseModel):
    state: str
    listening: bool
    wake_loaded: bool
    wake_model: Optional[str] = None
    # Reflects the wake-word fallback: when WAKE_WORD asks for a model
    # whose .onnx isn't on disk and isn't bundled, OpenWakeWordDetector
    # falls back to a bundled model. requested_wake_word shows what was
    # asked for; using_wake_fallback is the bool. Dashboard shows
    # "configured: hey_droplet (currently using hey_jarvis — training
    # pending)" when both differ.
    requested_wake_word: Optional[str] = None
    using_wake_fallback: bool = False
    threshold: float
    last_wake_at: Optional[float] = None
    last_wake_score: Optional[float] = None
    last_wake_model: Optional[str] = None
    error_message: Optional[str] = None
    # STT (commit 5). `stt_loaded` is the at-startup reachability flag;
    # `last_transcript` is the most recent transcribed utterance, kept
    # in memory until the next wake clears it. The dashboard tails this
    # endpoint to display what the user just said.
    stt_loaded: bool = False
    last_transcript: Optional[str] = None
    last_transcript_at: Optional[float] = None
    # TTS (commit 6). `tts_loaded` is the at-startup reachability flag;
    # `last_response` is the most recent text we spoke aloud — set by
    # pipeline.speak() (called from the LLM-reply path or /voice/say).
    tts_loaded: bool = False
    last_response: Optional[str] = None
    last_response_at: Optional[float] = None
    # LLM (commit 7). Reflects whether the orchestrator's /api/llm/chat
    # was reachable at startup. The dashboard surfaces this so a
    # degraded LLM is visible.
    llm_loaded: bool = False


class SayRequest(BaseModel):
    text: str
    voice: Optional[str] = None


class SayResponse(BaseModel):
    ok: bool
    duration_s: float
    sample_rate: Optional[int] = None
    error: Optional[str] = None


class TestRecordResponse(BaseModel):
    rms_dbfs: float
    peak_dbfs: float
    samples: int
    duration_s: float


class TestToneResponse(BaseModel):
    played: bool
    duration_s: float
    frequency_hz: float


# ────────────────────────────────────────────────────────────────────
# Endpoints
# ────────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    r = _resolve()
    wake_loaded = False
    stt_loaded = False
    tts_loaded = False
    llm_loaded = False
    if _pipeline is not None:
        # Cheap atomic read; no I/O on the pipeline thread.
        s = _pipeline.status()
        wake_loaded = s.wake_loaded
        stt_loaded = s.stt_loaded
        tts_loaded = s.tts_loaded
        llm_loaded = s.llm_loaded
    return HealthResponse(
        ok=True,
        inputAvailable=r.input_device is not None,
        outputAvailable=r.output_device is not None,
        wakeLoaded=wake_loaded,
        sttLoaded=stt_loaded,
        ttsLoaded=tts_loaded,
        llmLoaded=llm_loaded,
    )


@app.get("/voice/status", response_model=VoiceStatusResponse)
def voice_status() -> VoiceStatusResponse:
    """Snapshot of the wake-detection pipeline.

    Read-only — never blocks the worker. The dashboard polls this on
    the voice settings page to render the "listening" pulse + show
    the last wake event for debugging.
    """
    if _pipeline is None:
        # Pipeline never started (no mic, or startup() bailed). Surface
        # a stable shape so the dashboard doesn't need a special case.
        return VoiceStatusResponse(
            state="no_mic",
            listening=False,
            wake_loaded=False,
            threshold=WAKE_THRESHOLD,
        )
    s = _pipeline.status()
    return VoiceStatusResponse(
        state=s.state,
        listening=s.listening,
        wake_loaded=s.wake_loaded,
        wake_model=s.wake_model,
        requested_wake_word=s.requested_wake_word,
        using_wake_fallback=s.using_wake_fallback,
        threshold=s.threshold,
        last_wake_at=s.last_wake_at,
        last_wake_score=s.last_wake_score,
        last_wake_model=s.last_wake_model,
        error_message=s.error_message,
        stt_loaded=s.stt_loaded,
        last_transcript=s.last_transcript,
        last_transcript_at=s.last_transcript_at,
        tts_loaded=s.tts_loaded,
        last_response=s.last_response,
        last_response_at=s.last_response_at,
        llm_loaded=s.llm_loaded,
    )


@app.post("/voice/say", response_model=SayResponse)
def voice_say(req: SayRequest) -> SayResponse:
    """Synthesize `req.text` and play it through the picked output device.

    Test endpoint — commit 7 wires this same path from the LLM-reply
    callback. For now it's manual: useful for "is the speaker hooked
    up?" + "does Piper sound right?" without needing to wake-trigger.

    Blocks for the full playback duration. The pipeline transitions
    into the 'speaking' state during synthesis + playback, then back
    to listening — wake detection is muted during that window
    (anti-feedback).
    """
    if _pipeline is None:
        raise HTTPException(
            status_code=503,
            detail="pipeline not started — usually means no input device at boot",
        )
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is empty")
    if len(req.text) > 2000:
        # Piper's typical phrase is <100 chars. 2 KB lets a longer reply
        # through but bounds runaway requests.
        raise HTTPException(status_code=400, detail="text too long (max 2000 chars)")

    result = _pipeline.speak(req.text, voice=req.voice)
    if not result["ok"]:
        raise HTTPException(status_code=503, detail=result.get("error", "speak failed"))
    return SayResponse(
        ok=True,
        duration_s=result["duration_s"],
        sample_rate=result.get("sample_rate"),
    )


@app.get("/audio/devices")
def audio_devices(refresh: bool = False) -> dict:
    """Return the current pick + the full discovered device list.

    The dashboard's voice settings page hits this to render the device
    picker. `refresh=1` forces a re-enumeration — useful right after a
    customer hot-plugs a USB mic.
    """
    global _resolution
    if refresh:
        _resolution = None
    r = _resolve()
    return r.to_dict()


@app.post("/audio/test-tone", response_model=TestToneResponse)
def audio_test_tone(duration_s: float = 1.0, frequency_hz: float = 440.0) -> TestToneResponse:
    """Play a 440 Hz sine through the picked output. Mic-test's sibling."""
    r = _resolve()
    if r.output_device is None:
        raise HTTPException(
            status_code=503,
            detail="No output device available. Plug in a speaker / USB audio device.",
        )
    if not (0.05 <= duration_s <= 5.0):
        raise HTTPException(
            status_code=400, detail="duration_s must be between 0.05 and 5.0",
        )
    if not (50 <= frequency_hz <= 8000):
        raise HTTPException(
            status_code=400, detail="frequency_hz must be between 50 and 8000",
        )
    try:
        test_tone(
            duration_s=duration_s,
            samplerate=SAMPLE_RATE,
            frequency_hz=frequency_hz,
            device=r.output_device.index,
        )
    except AudioUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return TestToneResponse(
        played=True, duration_s=duration_s, frequency_hz=frequency_hz,
    )


@app.post("/audio/test-record", response_model=TestRecordResponse)
def audio_test_record(duration_s: float = 2.0) -> TestRecordResponse:
    """Record a short clip from the picked input + report level.

    Returns RMS + peak in dBFS. Useful for "is the mic actually
    picking up sound?" — speak normally during the capture and a
    healthy mic shows roughly -40 to -20 dBFS RMS; silence is below
    -60 dBFS.
    """
    r = _resolve()
    if r.input_device is None:
        raise HTTPException(
            status_code=503,
            detail="No input device available. Plug in a USB mic or check the onboard mic jack.",
        )
    if not (0.1 <= duration_s <= 10.0):
        raise HTTPException(
            status_code=400, detail="duration_s must be between 0.1 and 10.0",
        )
    try:
        result = measure_input_level(
            duration_s=duration_s,
            samplerate=SAMPLE_RATE,
            channels=1,
            device=r.input_device.index,
        )
    except AudioUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return TestRecordResponse(
        rms_dbfs=result["rms_dbfs"],
        peak_dbfs=result["peak_dbfs"],
        samples=result["samples"],
        duration_s=duration_s,
    )
