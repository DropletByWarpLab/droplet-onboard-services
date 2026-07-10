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

import asyncio
import logging
import os
import threading
import time
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from voice.audio_io import (
    AudioUnavailable,
    echo_check,
    measure_input_level,
    test_tone,
)

# WARP-1055 (F5) — PortAudio's own error type, when the binding exists.
# A device that's busy / unplugged / rate-rejected raises this out of a
# capture, which is an operational 503 ("mic didn't respond, try again"),
# never a raw 500 relayed to the dashboard. The placeholder class keeps
# the except-clause valid on hosts without PortAudio (macOS dev).
try:
    from sounddevice import PortAudioError as _PortAudioError  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — sounddevice absent on this host
    class _PortAudioError(Exception):
        """Stand-in when sounddevice isn't importable."""
from voice.calibration import CalibrationStore
from voice.devices import (
    DeviceResolution,
    resolve_devices,
)
from voice.dsp import DspRestartError, restart_dsp
from voice.pipeline import (
    DEFAULT_DEBOUNCE_S,
    DEFAULT_FLATLINE_DBFS,
    DEFAULT_FLATLINE_WINDOW_S,
    DEFAULT_INPUT_DOWNMIX,
    DEFAULT_INPUT_GAIN,
    DEFAULT_POST_SPEAK_COOLDOWN_S,
    DEFAULT_STT_MAX_RECORD_S,
    DEFAULT_THRESHOLD,
    WakePipeline,
)
from voice.llm import build_llm_from_env
from voice.stt import build_stt_from_env
from voice.tts import build_tts_from_env
from voice.wake import (
    VOSK_DEFAULT_THRESHOLD,
    VoskWakeWordDetector,
    build_detector_from_env,
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("voice.main")

SAMPLE_RATE = int(os.environ.get("VOICE_SAMPLE_RATE", "16000"))


def resolve_wake_threshold(detector: object) -> float:
    """Wake threshold for the pipeline. An explicit WAKE_THRESHOLD env
    always wins; otherwise the default follows the ACTUAL detector type.
    The defaults differ because the score semantics differ: Vosk scores
    are min-per-word confidences (real acoustic evidence, ~0.9+ for a
    genuinely spoken phrase → default VOSK_DEFAULT_THRESHOLD) while
    openWakeWord scores are sigmoid outputs (default DEFAULT_THRESHOLD,
    0.3). Keyed off the detector instance, not WAKE_ENGINE, because
    build_detector_from_env has fallbacks (unknown engine → vosk;
    vosk-without-model → openWakeWord) that make the env string
    unreliable for this decision."""
    env = (os.environ.get("WAKE_THRESHOLD") or "").strip()
    if env:
        return float(env)
    return (
        VOSK_DEFAULT_THRESHOLD
        if isinstance(detector, VoskWakeWordDetector)
        else DEFAULT_THRESHOLD
    )


# Display-only fallback for /voice/status before the pipeline exists
# (no mic / startup bailed). The live pipeline reports its own value.
# Compose passes WAKE_THRESHOLD through as "" when unset — treat empty
# the same as absent (resolve_wake_threshold does too). Falls back to
# the engine-agnostic DEFAULT_THRESHOLD: before build_detector_from_env
# runs the detector type is unknowable, and reporting the Vosk 0.7 on a
# box that would resolve to openWakeWord (live gate 0.3) sends an
# operator down the wrong path. resolve_wake_threshold owns the real,
# engine-aware value once the pipeline exists.
WAKE_THRESHOLD = float(
    (os.environ.get("WAKE_THRESHOLD") or "").strip()
    or str(DEFAULT_THRESHOLD),
)
WAKE_DEBOUNCE_S = float(
    os.environ.get("WAKE_DEBOUNCE_S", str(DEFAULT_DEBOUNCE_S))
)
STT_MAX_RECORD_S = float(
    os.environ.get("STT_MAX_RECORD_S", str(DEFAULT_STT_MAX_RECORD_S))
)
POST_SPEAK_COOLDOWN_S = float(
    os.environ.get("POST_SPEAK_COOLDOWN_S", str(DEFAULT_POST_SPEAK_COOLDOWN_S))
)
# Multichannel→mono strategy + digital input gain (see pipeline.py's
# DEFAULT_INPUT_DOWNMIX / DEFAULT_INPUT_GAIN). Empty env = default.
VOICE_INPUT_DOWNMIX = (
    (os.environ.get("VOICE_INPUT_DOWNMIX") or "").strip().lower()
    or DEFAULT_INPUT_DOWNMIX
)
VOICE_INPUT_GAIN = float(
    (os.environ.get("VOICE_INPUT_GAIN") or "").strip()
    or str(DEFAULT_INPUT_GAIN),
)
# Flatline watchdog (WARP-1037) — see pipeline.py's DEFAULT_FLATLINE_*
# docstrings. Window in seconds of at/near-digital-zero input while
# state=listening before /health degrades (0 disables); dBFS level
# below which a frame counts as "no signal". Empty env = default.
VOICE_FLATLINE_WINDOW_S = float(
    (os.environ.get("VOICE_FLATLINE_WINDOW_S") or "").strip()
    or str(DEFAULT_FLATLINE_WINDOW_S),
)
VOICE_FLATLINE_DBFS = float(
    (os.environ.get("VOICE_FLATLINE_DBFS") or "").strip()
    or str(DEFAULT_FLATLINE_DBFS),
)

app = FastAPI(title="voice-io", version="0.1.0")

# WARP-1055 — default capture window for /audio/measure when the
# wizard doesn't specify one. Long enough for a stable noise-floor
# read or a spoken phrase, short enough that the wizard stays snappy.
DEFAULT_MEASURE_SECONDS = 5.0

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


def _reresolve_input_index() -> Optional[int]:
    """Force a fresh device resolution and return the picked input index
    (or None if no mic is present now).

    Wired into WakePipeline as its `resolve_input_device` hook so the wake
    loop can recompute the input index after the mic re-enumerates — the
    reSpeaker XVF3800's ALSA card index shifts under Docker, so the index
    captured at startup goes stale. Reuses the same `resolve_devices()`
    scoring path used at boot (voice/devices.py stays authoritative); we
    only invalidate the cache so it actually re-enumerates. Runs on the
    pipeline worker thread on a device disconnect — a benign race with a
    concurrent /audio/devices?refresh=1 at worst repeats an idempotent
    resolve."""
    global _resolution
    _resolution = None  # drop the cached pick so _resolve() re-enumerates
    try:
        r = _resolve()
    except Exception:  # pragma: no cover — defensive; resolve is best-effort
        logger.exception("voice re-resolution failed")
        return None
    return r.input_device.index if r.input_device else None


def apply_stored_calibration(pipeline: WakePipeline) -> None:
    """Re-apply a persisted calibration over the env defaults (WARP-1055).

    Called at startup right after the pipeline is constructed, and the
    same value-application path runs after POST /voice/calibration
    persists a fresh record. The calibration record wins over
    VOICE_INPUT_GAIN / WAKE_THRESHOLD env defaults — the wizard's
    measured tuning is more specific than a fleet-wide env knob. The
    pipeline's setters reject nonsense values, so a hand-edited or
    corrupt record degrades to "keep the defaults", never to a muted
    mic or an impossible wake gate.
    """
    record = CalibrationStore().load()
    if not record:
        return
    _apply_calibration_values(pipeline, record)
    logger.info(
        "applied stored calibration (gain=%s, threshold=%s, calibrated_at=%s)",
        record.get("input_gain"),
        record.get("wake_threshold"),
        record.get("calibrated_at"),
    )


def _apply_calibration_values(pipeline: WakePipeline, record: dict) -> None:
    gain = record.get("input_gain")
    if isinstance(gain, (int, float)) and not isinstance(gain, bool):
        pipeline.set_input_gain(float(gain))
    threshold = record.get("wake_threshold")
    if isinstance(threshold, (int, float)) and not isinstance(threshold, bool):
        pipeline.set_wake_threshold(float(threshold))


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
    #
    # `build_llm_from_env()` does a synchronous httpx.get to ipapi.co
    # for the geo lookup; `_pipeline.start()` does three sync
    # socket.create_connection probes of STT / TTS / orchestrator. Both
    # can each block the event loop for up to ~5 s each in the worst
    # case (DNS failures, dropped packets). Run them in a worker thread
    # so the FastAPI `/health` endpoint stays responsive within the
    # Dockerfile `HEALTHCHECK --start-period=10s` window.
    global _pipeline
    try:
        detector = build_detector_from_env()
        stt = build_stt_from_env()
        tts = build_tts_from_env()
        llm = await asyncio.to_thread(build_llm_from_env)
        wake_threshold = resolve_wake_threshold(detector)
        # Announce the EFFECTIVE threshold: boxes that relied on the old
        # compose default (`:-0.3`) silently moved to the engine-aware
        # default when the passthrough became `:-` — this line is how an
        # operator sees what the container actually runs at.
        logger.info(
            "wake threshold: %.2f (engine: %s%s)",
            wake_threshold,
            type(detector).__name__,
            ""
            if (os.environ.get("WAKE_THRESHOLD") or "").strip()
            else " — engine default; set WAKE_THRESHOLD to override",
        )
        _pipeline = WakePipeline(
            detector=detector,
            stt=stt,
            tts=tts,
            llm=llm,
            input_device_index=r.input_device.index if r.input_device else None,
            output_device_index=r.output_device.index if r.output_device else None,
            threshold=wake_threshold,
            debounce_s=WAKE_DEBOUNCE_S,
            stt_max_record_s=STT_MAX_RECORD_S,
            post_speak_cooldown_s=POST_SPEAK_COOLDOWN_S,
            # Self-heal hook: recompute the input index after the mic
            # re-enumerates (reSpeaker card-index shift under Docker) so
            # the wake loop reopens the right device instead of dying.
            resolve_input_device=_reresolve_input_index,
            input_downmix=VOICE_INPUT_DOWNMIX,
            input_gain=VOICE_INPUT_GAIN,
            flatline_window_s=VOICE_FLATLINE_WINDOW_S,
            flatline_dbfs=VOICE_FLATLINE_DBFS,
        )
        # WARP-1055 — a persisted calibration (named-volume JSON) wins
        # over the env-derived gain/threshold. Applied before start()
        # so the very first captured frame runs at the tuned gain.
        apply_stored_calibration(_pipeline)
        await asyncio.to_thread(_pipeline.start)
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
    # Pipeline state machine value (idle | loading | listening | … | error |
    # no_mic), or None before the pipeline exists. When it's 'error' or
    # 'no_mic' the pipeline drops every frame (stuck-and-deaf), so /health
    # reports ok=False + HTTP 503 to mark the container unhealthy (see the
    # health() handler).
    state: Optional[str] = None
    wakeLoaded: bool = False
    sttLoaded: bool = False
    ttsLoaded: bool = False
    # Commit 7. True iff the orchestrator's /api/llm/chat was reachable
    # at startup. Wake + STT still work when this is false, but no
    # spoken replies happen.
    llmLoaded: bool = False
    # WARP-1037. Rolling input RMS (dBFS) measured inside the pipeline's
    # frame handler + wall time of the last frame carrying real signal.
    # `inputFlatlined` is the wedged-DSP signature: input at/near digital
    # zero for the whole flatline window while state=listening — the
    # health() handler degrades to 503 on it (the stream is open but the
    # ReSpeaker's XMOS DSP is delivering pure silence: listening, deaf).
    inputRmsDbfs: Optional[float] = None
    lastAudioAt: Optional[float] = None
    inputFlatlined: bool = False


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
    # Input level (WARP-1037). `input_rms_dbfs` is a rolling RMS over the
    # last ~2 s of mic frames — measured inside the pipeline's own frame
    # handler, never via a second stream on the same hw device (ALSA
    # EBUSY). Domain contract (WARP-1055): PRE-gain / raw capture — the
    # same domain as /audio/measure and the persisted calibration floor,
    # so the dashboard's noise-drift compare needs no gain math. The
    # wizard's live level meter rides this field.
    # `last_audio_at` is when a frame last carried real signal;
    # `input_flatlined` is the wedged-DSP flag (see /health).
    input_rms_dbfs: Optional[float] = None
    last_audio_at: Optional[float] = None
    input_flatlined: bool = False


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


# WARP-1055 — calibration-wizard measurement + persistence schemas.

class MeasureRequest(BaseModel):
    """One wizard capture. `kind` is descriptive (it rides back in the
    response + logs so the dashboard can correlate) — the capture path
    is identical for both; the wizard interprets rms (noise floor) vs
    peak (speech)."""

    kind: Literal["noise_floor", "speech_peak"]
    seconds: Optional[float] = Field(default=None, ge=1.0, le=30.0)


class MeasureResponse(BaseModel):
    rms_dbfs: float
    peak_dbfs: float
    duration_s: float
    kind: str


class EchoCheckResponse(BaseModel):
    heard: bool
    tone_dbfs: float
    floor_dbfs: float


class RestartProcessorResponse(BaseModel):
    """WARP-1057 — successful DSP reboot. `restarted_at` lets the
    dashboard anchor its "re-poll until audio returns" window."""

    ok: bool
    method: str
    restarted_at: float


class CalibrationApplyRequest(BaseModel):
    """The wizard's single write (§4 step 5 'Apply calibration').

    `input_gain` / `wake_threshold` are the values the box applies
    live + re-applies at startup; the measured fields + flags are
    stored so the /voice page can render proof ('Calibrated 3 days
    ago · noise floor -41 dB') and drift comparisons. Bounds mirror
    what the pipeline setters accept — reject at the API edge rather
    than persisting a record whose apply would be silently ignored.
    """

    input_gain: Optional[float] = Field(default=None, gt=0.0, le=16.0)
    wake_threshold: Optional[float] = Field(default=None, gt=0.0, le=1.0)
    noise_floor_dbfs: float
    speech_peak_dbfs: float
    wake_detections: int = Field(ge=0, le=3)
    echo_ok: bool
    flags: list[str] = []


# ────────────────────────────────────────────────────────────────────
# Endpoints
# ────────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
def health(response: Response) -> HealthResponse:
    r = _resolve()
    state: Optional[str] = None
    wake_loaded = False
    stt_loaded = False
    tts_loaded = False
    llm_loaded = False
    input_rms_dbfs: Optional[float] = None
    last_audio_at: Optional[float] = None
    input_flatlined = False
    if _pipeline is not None:
        # Cheap atomic read; no I/O on the pipeline thread.
        s = _pipeline.status()
        state = s.state
        wake_loaded = s.wake_loaded
        stt_loaded = s.stt_loaded
        tts_loaded = s.tts_loaded
        llm_loaded = s.llm_loaded
        input_rms_dbfs = s.input_rms_dbfs
        last_audio_at = s.last_audio_at
        input_flatlined = s.input_flatlined
    # Both 'error' and 'no_mic' are stuck-and-deaf: _on_frame drops every
    # frame for state in ('error', 'no_mic') (voice/pipeline.py), so the
    # assistant can't hear a wake word in either. 'error' latches on a
    # transient STT/TTS/LLM failure; 'no_mic' parks when no input device
    # resolves (there is no supported mic-less / output-only mode — no-mic is
    # a fault the supervisor keeps retrying, not a configuration). Report
    # degraded (ok=False + 503) for both so the Dockerfile healthcheck
    # (`curl -sf`, which fails on >=400) flags the container unhealthy instead
    # of /health lying with a 200 forever. Other states (loading, listening,
    # …) stay 200 — they're not stuck-and-deaf.
    #
    # `input_flatlined` (WARP-1037) is a third stuck-and-deaf shape: the
    # ReSpeaker XVF3800's XMOS DSP wedges with the USB stream still open,
    # so state stays 'listening' while every frame is digital silence.
    # The pipeline flags it after the flatline window; degrade the same
    # way. Recovery is automatic — audio returning flips the flag off on
    # the next status read, no restart needed.
    degraded = state in ("error", "no_mic") or input_flatlined
    if degraded:
        response.status_code = 503
    return HealthResponse(
        ok=not degraded,
        inputAvailable=r.input_device is not None,
        outputAvailable=r.output_device is not None,
        state=state,
        wakeLoaded=wake_loaded,
        sttLoaded=stt_loaded,
        ttsLoaded=tts_loaded,
        llmLoaded=llm_loaded,
        inputRmsDbfs=input_rms_dbfs,
        lastAudioAt=last_audio_at,
        inputFlatlined=input_flatlined,
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
        input_rms_dbfs=s.input_rms_dbfs,
        last_audio_at=s.last_audio_at,
        input_flatlined=s.input_flatlined,
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


# WARP-1055 (F5) — one wizard capture at a time. Two overlapping
# sd.rec/playrec calls on the same hw device collide (ALSA EBUSY or
# interleaved buffers); a second concurrent measure answers 409 so the
# dashboard can tell "busy, retry" apart from "device broken" (503).
# threading.Lock works because these endpoints are sync `def`s — FastAPI
# runs each in its own threadpool thread.
_capture_lock = threading.Lock()

_CAPTURE_BUSY_DETAIL = (
    "Another microphone measurement is already running — try again in a few seconds."
)


@app.post("/audio/measure", response_model=MeasureResponse)
def audio_measure(req: MeasureRequest) -> MeasureResponse:
    """Wizard measurement capture (WARP-1055): noise floor / speech peak.

    Same capture mechanism as /audio/test-record (`measure_input_level`
    → sounddevice.rec on the picked input) so it coexists with the wake
    pipeline's stream exactly the way the proven test-record path does.
    """
    r = _resolve()
    if r.input_device is None:
        raise HTTPException(
            status_code=503,
            detail="No input device available. Plug in a USB mic or check the onboard mic jack.",
        )
    seconds = (
        req.seconds if req.seconds is not None else DEFAULT_MEASURE_SECONDS
    )
    if not _capture_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail=_CAPTURE_BUSY_DETAIL)
    try:
        result = measure_input_level(
            duration_s=seconds,
            samplerate=SAMPLE_RATE,
            channels=1,
            device=r.input_device.index,
        )
    except AudioUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except _PortAudioError as exc:
        # Device unplugged / busy / rate-rejected mid-capture — an
        # operational fault the caller can retry, not a server bug.
        raise HTTPException(
            status_code=503,
            detail=(
                "The microphone didn't respond (device busy or "
                f"disconnected: {exc}). Check the mic and try again."
            ),
        )
    finally:
        _capture_lock.release()
    return MeasureResponse(
        rms_dbfs=result["rms_dbfs"],
        peak_dbfs=result["peak_dbfs"],
        duration_s=seconds,
        kind=req.kind,
    )


@app.post("/audio/echo-check", response_model=EchoCheckResponse)
def audio_echo_check() -> EchoCheckResponse:
    """Wizard step 4 (WARP-1055): play the test tone and listen for it
    in the same window (full-duplex playrec), then judge whether the
    tone arrived (voice.audio_io.detect_tone). Fully automatic — the
    user does nothing."""
    r = _resolve()
    if r.input_device is None:
        raise HTTPException(
            status_code=503,
            detail="No input device available. Plug in a USB mic or check the onboard mic jack.",
        )
    if r.output_device is None:
        raise HTTPException(
            status_code=503,
            detail="No output device available. Plug in a speaker / USB audio device.",
        )
    if not _capture_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail=_CAPTURE_BUSY_DETAIL)
    try:
        result = echo_check(
            samplerate=SAMPLE_RATE,
            input_device=r.input_device.index,
            output_device=r.output_device.index,
        )
    except AudioUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except _PortAudioError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "The speaker/mic pair didn't respond (device busy or "
                f"disconnected: {exc}). Check both connections and try again."
            ),
        )
    finally:
        _capture_lock.release()
    return EchoCheckResponse(
        heard=bool(result["heard"]),
        tone_dbfs=float(result["tone_dbfs"]),
        floor_dbfs=float(result["floor_dbfs"]),
    )


@app.get("/voice/calibration")
def get_voice_calibration() -> dict:
    """Persisted calibration record, or {calibrated: false} (WARP-1055).

    The dashboard's /voice hero keys its four states on this: a stored
    record → calibrated/needs-attention; none → 'Not calibrated yet'.
    """
    record = CalibrationStore().load()
    if not record or not record.get("calibrated"):
        return {"calibrated": False}
    return record


@app.post("/voice/calibration")
def post_voice_calibration(req: CalibrationApplyRequest) -> dict:
    """The wizard's single write (WARP-1055): persist + apply live.

    Persists the record to the named-volume JSON (survives container
    restarts; startup() re-applies it), then applies the tuned input
    gain + wake threshold to the running pipeline. When the pipeline
    isn't up (no mic at boot), the record still persists — it applies
    on the next successful start.
    """
    record = req.model_dump()
    record["calibrated"] = True
    record["calibrated_at"] = time.time()
    CalibrationStore().save(record)
    if _pipeline is not None:
        _apply_calibration_values(_pipeline, record)
    return record


# WARP-1057 — one DSP reboot at a time. A second concurrent restart while
# the chip is mid-re-enumeration answers 409 so the dashboard can tell
# "already restarting, wait" apart from a real fault (503). Same sync-def
# threadpool + non-blocking-lock pattern as _capture_lock above.
_restart_lock = threading.Lock()


@app.post("/voice/restart-processor", response_model=RestartProcessorResponse)
def voice_restart_processor() -> RestartProcessorResponse:
    """Reboot the XVF3800's XMOS DSP over USB (WARP-1057).

    Recovery for the WARP-1037 wedge: `input_flatlined` on /voice/status
    means the DSP is delivering pure silence with the stream still open.
    This issues the host watchdog's proven heal (`xvf_host REBOOT 1`,
    voice/dsp.py); the chip drops off USB and re-enumerates (~10 s audio
    outage), the pipeline's device self-heal reopens the card, and the
    flatline flag clears on the next real audio frame.

    Deliberately NOT gated on the pipeline or on input_flatlined: the
    reboot is a USB control write that works even when the wake loop
    never started, and an operator diagnosing by hand may restart at any
    time (the watchdog keys on kernel-log overruns instead — neither
    signal is a precondition for the other).
    """
    if not _restart_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail=(
                "A processor restart is already in progress — give it a "
                "few seconds, then check the status again."
            ),
        )
    try:
        result = restart_dsp()
    except DspRestartError as exc:
        raise HTTPException(status_code=503, detail=exc.detail)
    finally:
        _restart_lock.release()
    return RestartProcessorResponse(**result)
