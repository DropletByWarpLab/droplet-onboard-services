"""voice-orchestrator FastAPI control surface.

Three responsibilities this commit:

  1. Boot up, discover audio devices, log what we picked.
  2. Expose /health + /audio/devices so the dashboard can show state.
  3. Expose /audio/test-tone + /audio/test-record so operators can
     answer "is my mic / speaker actually wired correctly?" without
     SSH-ing into the host.

Wake / STT / TTS / pipeline come in subsequent commits — each ships a
new sub-package and a small endpoint or two; the dashboard's voice
settings page stays in sync via the same /health snapshot shape.
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

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("voice.main")

SAMPLE_RATE = int(os.environ.get("VOICE_SAMPLE_RATE", "16000"))

app = FastAPI(title="voice-orchestrator", version="0.1.0")


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
    # Resolve on boot so the first /health hit is cheap. Doesn't fail
    # the boot if PortAudio is missing — we want the service running
    # so operators can still hit /audio/devices and see "no audio".
    try:
        _resolve()
    except Exception as exc:  # pragma: no cover — defensive
        logger.error("device resolution failed at startup: %s", exc)


# ────────────────────────────────────────────────────────────────────
# Schemas
# ────────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    ok: bool
    inputAvailable: bool
    outputAvailable: bool
    # Subsequent commits flip these to true as their layers come online.
    wakeLoaded: bool = False
    sttLoaded: bool = False
    ttsLoaded: bool = False


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
    return HealthResponse(
        ok=True,
        inputAvailable=r.input_device is not None,
        outputAvailable=r.output_device is not None,
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
