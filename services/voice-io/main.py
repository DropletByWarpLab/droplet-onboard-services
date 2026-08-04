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

import numpy as np
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, StrictBool

from voice.audio_io import (
    AudioUnavailable,
    echo_check,
    measure_input_level,
    record,
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
from voice.activity import ActivityReporter, build_reporter_from_env
from voice.calibration import CalibrationStore
from voice.speaker_id import (
    MAX_TOTAL_LINES,
    REQUIRED_LINES,
    SPEAKER_MODEL_NAME,
    USER_ID_RE,
    EnrollmentSessions,
    OnnxSpeakerEmbedder,
    SpeakerIdUnavailable,
    VoiceprintStore,
    annotate_confusable,
    assess_capture,
    build_embedder_from_env,
    confidence_word,
    cosine,
    match_against,
)
from voice.devices import (
    DeviceResolution,
    resolve_devices,
)
from voice.dsp import DspRestartError, restart_dsp
from voice.enabled import VoiceEnabledStore
from voice.pipeline import (
    DEFAULT_CALIBRATION_MODE_TTL_S,
    DEFAULT_DEBOUNCE_S,
    DEFAULT_FLATLINE_DBFS,
    DEFAULT_FLATLINE_WINDOW_S,
    DEFAULT_INPUT_DOWNMIX,
    DEFAULT_INPUT_GAIN,
    DEFAULT_POST_SPEAK_COOLDOWN_S,
    DEFAULT_STT_MAX_RECORD_S,
    DEFAULT_THRESHOLD,
    DEFAULT_VAD_MIN_SPEECH_S,
    DEFAULT_VAD_SILENCE_S,
    DEFAULT_VAD_SPEECH_RMS,
    DEFAULT_VISUAL_DECAY_S,
    DspRestartSkipped,
    MeasurementUnavailable,
    WakePipeline,
)
from voice.llm import LLMClient, build_llm_from_env
from voice.persona import PersonaFetcher, build_persona_fetcher_from_env
from voice.stt import MockSTT, StreamingSTT, build_stt_from_env
from voice.tts import MockTTS, TextToSpeech, build_tts_from_env
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


def _env_float(name: str, default: float) -> float:
    """Parse a float env knob, tolerating the compose empty-string
    passthrough. Compose ships these as `NAME=${NAME:-}`, so an unset knob
    arrives as "" — `float("")` would crash, so empty/whitespace selects the
    default (same posture as the VOICE_INPUT_GAIN / VOICE_FLATLINE_* reads
    below). An explicit "0" is a real value and is kept."""
    return float((os.environ.get(name) or "").strip() or str(default))


def resolve_vad_config() -> dict[str, float]:
    """End-of-speech VAD + visual-decay knobs, read from env → the exact
    kwargs WakePipeline accepts (WARP-1434).

    Before this, main.py never read any of these, so the per-room
    `VAD_SPEECH_RMS` tuning documented in pipeline.py and the
    `WAKE_VISUAL_DECAY_S` decay window were unfollowable — the constructor
    defaults were the only reachable values. Returned as a dict spread
    straight into `WakePipeline(**resolve_vad_config())` so a mis-key would
    fail loudly rather than silently ignore a knob."""
    return {
        "vad_silence_s": _env_float("VAD_SILENCE_S", DEFAULT_VAD_SILENCE_S),
        "vad_speech_rms": _env_float("VAD_SPEECH_RMS", DEFAULT_VAD_SPEECH_RMS),
        "vad_min_speech_s": _env_float("VAD_MIN_SPEECH_S", DEFAULT_VAD_MIN_SPEECH_S),
        "visual_decay_s": _env_float("WAKE_VISUAL_DECAY_S", DEFAULT_VISUAL_DECAY_S),
    }


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

# WARP-1619 — a pipeline whose stop() outlived its join budget. Its
# capture worker is finishing the turn it was in (LLM → TTS → playback
# all run inline on that thread) and STILL HOLDS the exclusive mic
# device, so it is kept reachable here after `_pipeline` is dropped.
# `_build_and_start_pipeline` is gated on it: opening a second
# InputStream on the same device is ALSA EBUSY, and the failed-open
# recovery would then run `sd._terminate()`/`_initialize()` — a
# PROCESS-WIDE PortAudio reset — while the first stream is still open.
_draining_pipeline: Optional[WakePipeline] = None

# How long the disable path waits for the capture worker to exit before
# answering, and how much longer a subsequent enable waits for a worker
# that outlived that budget before refusing to open a second stream.
# Both sit well inside the orchestrator proxy's 40 s enable budget.
_STOP_JOIN_TIMEOUT_S = 5.0
_DRAIN_JOIN_TIMEOUT_S = 5.0

# WARP-1119 — the greeting-path persona fetcher (arch brief §14). Module
# scope so /health can mirror its fetch_ok / last_fetch_at from the
# request thread. None until startup builds it (and always None under
# LLM_URL=__mock__).
_persona_fetcher: Optional[PersonaFetcher] = None

# WARP-1433 — the LLM client (holds the pooled httpx.Client). Module scope
# so the shutdown hook can close its connection pool. The pipeline holds the
# same instance; None until startup builds it.
_llm: Optional[LLMClient] = None

# WARP-1058 — the activity-feed event reporter (voice → orchestrator
# POST /api/voice/events). Module scope so shutdown can stop its POST
# worker. None until startup builds it (and always None under
# LLM_URL=__mock__).
_activity_reporter: Optional[ActivityReporter] = None


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


# WARP-1433 — startup warm-up. The FIRST real voice turn otherwise pays the
# cold-start cost twice: Piper downloads/loads its ~70 MB voice (tts.py
# budgets 15 s for this) and Whisper does its CTranslate2 model init. Firing
# one throwaway synth + one tiny transcribe at boot moves both off the
# critical path, so the first "hey Droplet" answers promptly.
_WARMUP_TTS_TEXT = "Ready"  # non-empty: tts.py short-circuits an empty synth
# 10 ms of int16 silence @ 16 kHz — enough to open a Whisper session and
# force the model load without transcribing anything meaningful.
_WARMUP_STT_PCM = b"\x00\x00" * 160


def _warm_up_upstreams(
    stt: Optional[StreamingSTT], tts: Optional[TextToSpeech],
) -> None:
    """Prime STT + TTS off the critical path (WARP-1433).

    Best-effort and fire-once: every failure is swallowed (a cold first turn
    is a latency blip, not an outage), and it no-ops for the __mock__ dev
    clients and for any upstream that isn't reachable right now. main.py runs
    this on a background daemon thread after pipeline.start(), so it never
    blocks startup or /health.
    """
    _warm_up_tts(tts)
    _warm_up_stt(stt)


def _warm_up_tts(tts: Optional[TextToSpeech]) -> None:
    # MockTTS has no real Piper to warm — skip so a dev box does no work.
    if tts is None or isinstance(tts, MockTTS):
        return
    try:
        if not tts.available:
            logger.info("voice TTS warm-up skipped — Piper not reachable yet")
            return
        tts.synthesize(_WARMUP_TTS_TEXT)
        logger.info("voice TTS warm-up done — Piper voice loaded")
    except Exception as exc:  # noqa: BLE001 — warm-up is strictly best-effort
        logger.info("voice TTS warm-up skipped: %s", exc)


def _warm_up_stt(stt: Optional[StreamingSTT]) -> None:
    # MockSTT has no real Whisper to warm — skip.
    if stt is None or isinstance(stt, MockSTT):
        return
    try:
        if not stt.available:
            logger.info("voice STT warm-up skipped — Whisper not reachable yet")
            return
        with stt.session() as session:
            session.send_chunk(_WARMUP_STT_PCM)
            session.finish()
        logger.info("voice STT warm-up done — Whisper model initialized")
    except Exception as exc:  # noqa: BLE001 — warm-up is strictly best-effort
        logger.info("voice STT warm-up skipped: %s", exc)


def _build_and_start_pipeline() -> None:
    """Construct the wake pipeline and start its worker thread.

    The ONE place that opens the mic. Shared by the boot path
    (`startup()`, which runs it on a worker thread) and the WARP-1599
    enable path (`POST /voice/enabled`, already on a threadpool thread):
    a second construction site would be a second way to start listening,
    and the kill switch's whole guarantee is that nothing else can.

    Blocking throughout — device enumeration, a geo lookup, and three
    upstream socket probes — so callers must keep it off the event loop.

    Every failure is logged and swallowed, and a partial build is torn
    back down before returning, so a failed start always leaves the same
    clean state a never-started box has: `_pipeline` None and no orphaned
    clients. The box then behaves like a mic-less boot — exactly what the
    enable path wants when there's no working hardware to listen with —
    and the NEXT enable can retry from scratch.

    WARP-1619 — refuses outright while a previous pipeline is still
    draining. That is the hard guarantee this function owes the
    exclusive audio device: two of them can never coexist on it.
    """
    global _draining_pipeline
    if _draining_pipeline is not None:
        # A previous stop() timed out. Give the worker the rest of its
        # turn, then re-check: in the common case (the box was finishing
        # a sentence) it has left by now and the toggle just works.
        _draining_pipeline.stop(timeout=_DRAIN_JOIN_TIMEOUT_S)
        if _draining_pipeline.running:
            logger.error(
                "voice enable refused: the previous wake pipeline's worker is "
                "still mid-turn and holds the mic device. Nothing was started "
                "— toggle voice on again once it has finished speaking.",
            )
            return
        logger.info("previous wake pipeline finished draining — mic released")
        _draining_pipeline = None

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
    global _pipeline, _persona_fetcher, _activity_reporter, _llm
    try:
        detector = build_detector_from_env()
        stt = build_stt_from_env()
        tts = build_tts_from_env()
        # WARP-1058 — activity-feed event bridge (wake outcomes, missed
        # wakes, DSP wedge/recovery → orchestrator /api/voice/events).
        # Cheap to build (env read + a parked daemon thread); no I/O
        # until the first event.
        _activity_reporter = build_reporter_from_env()
        # WARP-1119 — build the persona fetcher FIRST so the same instance
        # is shared by the LLM's greeting path and /health's observability
        # fields. Prime it once off the event loop: the result is cached
        # for the short TTL and, more importantly, /health shows a real
        # fetch_ok immediately instead of null until the first greeting.
        # A failed prime is fine — greeting turns fall back and retry.
        _persona_fetcher = build_persona_fetcher_from_env()
        if _persona_fetcher is not None:
            _persona_fetcher.get_block()
        llm = build_llm_from_env(_persona_fetcher)
        # WARP-1433 — keep a module ref so shutdown() can close its pooled
        # httpx.Client (the pipeline holds the same instance).
        _llm = llm
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
            # WARP-1434 — end-of-speech VAD + visual-decay knobs, now env-wired
            # (VAD_SILENCE_S / VAD_SPEECH_RMS / VAD_MIN_SPEECH_S /
            # WAKE_VISUAL_DECAY_S). Previously main never read these.
            **resolve_vad_config(),
            activity_reporter=_activity_reporter,
            # WARP-1409 — bounded in-app auto-recovery: on a sustained
            # wedge the pipeline issues the same `xvf_host REBOOT 1` heal
            # as the dashboard button, sharing its lock (see
            # _auto_restart_dsp) so the two never overlap.
            dsp_restart=_auto_restart_dsp,
        )
        # WARP-1055 — a persisted calibration (named-volume JSON) wins
        # over the env-derived gain/threshold. Applied before start()
        # so the very first captured frame runs at the tuned gain.
        apply_stored_calibration(_pipeline)
        _pipeline.start()
    except Exception as exc:
        logger.error("wake pipeline failed to start: %s", exc)
        # Unwind the partial build. The reporter and the two pooled
        # clients are assigned BEFORE `_pipeline` is, so a raise anywhere
        # in between leaves them live behind a None `_pipeline` — and the
        # enable path's idempotence guard keys on `_pipeline`, so the next
        # enable would re-enter here and overwrite them, stranding a
        # thread and two socket pools per attempt. A raise AFTER the
        # assignment is worse: a never-started pipeline has no worker, yet
        # that same guard would make every later enable a no-op until
        # someone restarted the container. Tearing down settles both.
        _teardown_voice_runtime()
        return
    # WARP-1433 — prime STT + TTS off the critical path so the first real
    # utterance isn't cold. Fire-and-forget on a daemon thread:
    # best-effort, runs once, never blocks startup or /health.
    #
    # WARP-1599 — spawned BELOW the try, with its own guard. Inside it,
    # a `Thread.start()` that raised (thread/memory exhaustion) would
    # reach the `except` above and tear down a pipeline that is ALREADY
    # LISTENING: the box would go silent because a warm-up couldn't
    # start, where before it would simply have answered the first
    # utterance cold. A best-effort optimisation must never unwind a
    # successful build.
    try:
        threading.Thread(
            target=_warm_up_upstreams,
            args=(stt, tts),
            name="voice-warmup",
            daemon=True,
        ).start()
    except Exception as exc:  # noqa: BLE001 — warm-up is strictly best-effort
        logger.info("voice warm-up thread not started: %s", exc)


@app.on_event("startup")
async def startup() -> None:
    # WARP-1599 — the admin kill switch is consulted BEFORE anything can
    # open the mic. A box whose owner switched voice off boots silent and
    # stays silent: no detector, no capture stream, no worker thread.
    # Only POST /voice/enabled brings it back.
    if not VoiceEnabledStore().load():
        logger.info(
            "voice assistant is switched off — wake pipeline not started "
            '(POST /voice/enabled {"enabled": true} to turn it back on)',
        )
        return
    # `build_llm_from_env()` does a synchronous httpx.get to ipapi.co
    # for the geo lookup; `_pipeline.start()` does three sync
    # socket.create_connection probes of STT / TTS / orchestrator. Both
    # can each block for up to ~5 s in the worst case (DNS failures,
    # dropped packets), so the whole build runs on a worker thread and
    # the FastAPI `/health` endpoint stays responsive within the
    # Dockerfile `HEALTHCHECK --start-period=10s` window.
    await asyncio.to_thread(_build_and_start_pipeline)


def _teardown_voice_runtime() -> bool:
    """Stop the pipeline and release everything built alongside it.

    Returns True when the mic device was genuinely released. False means
    the capture worker outlived its join budget: it is finishing the turn
    it was in and STILL HOLDS the device (WARP-1619). The switch is off
    either way — no new audio is processed, because the loop exits before
    the next frame — but the box is still speaking and the device is not
    free yet, and the disable path says so rather than claiming otherwise.

    The mirror image of `_build_and_start_pipeline()`: every module
    global that one assigns, this one closes and clears. Shared by the
    shutdown hook and the WARP-1599 disable path — which is what keeps a
    disable→enable cycle from stacking duplicates: each enable rebuilds
    from clean state, so an admin flipping the switch can't strand a
    pooled httpx client or a parked reporter thread per toggle.

    Ordering matters. The pipeline worker holds the same LLM client and
    persona fetcher, so those are only closed once `stop()` has joined
    it and no reply()/persona fetch can still be in flight.
    """
    global _pipeline, _activity_reporter, _llm, _persona_fetcher
    global _draining_pipeline
    released = True
    # Drop the module reference BEFORE stopping: stop() joins the worker
    # (up to 5 s) and a join timeout or a raise must never leave
    # /voice/status handing out a pipeline that is on its way out.
    pipeline = _pipeline
    _pipeline = None
    if pipeline is not None:
        # Best-effort like the closes below — this runs from a request
        # path too (the disable toggle), where a raise would escape as a
        # 500 with the flag already persisted off and the three
        # singletons below never freed. stop() signals `_shutdown` before
        # anything that can fail, so the worker is on its way out either
        # way; giving up on the join is better than skipping the rest.
        try:
            if not pipeline.stop(timeout=_STOP_JOIN_TIMEOUT_S):
                # WARP-1619 — the worker did NOT exit. Keep it reachable:
                # it still owns the exclusive device, and the next enable
                # has to wait for it rather than open a second stream.
                released = False
                _draining_pipeline = pipeline
                logger.warning(
                    "voice disable: the wake pipeline's worker did not exit "
                    "within %.1fs — it is finishing the turn it was in and "
                    "still holds the mic device. No new audio is processed; "
                    "the device frees itself when the turn ends.",
                    _STOP_JOIN_TIMEOUT_S,
                )
        except Exception:  # noqa: BLE001 — teardown is best-effort
            logger.warning("pipeline stop raised", exc_info=True)
    if _activity_reporter is not None:
        try:
            _activity_reporter.stop()
        except Exception:  # noqa: BLE001 — teardown is best-effort
            logger.warning("activity reporter stop raised", exc_info=True)
        _activity_reporter = None
    # WARP-1433 — close the pooled httpx clients now that the pipeline worker
    # has joined (no reply()/persona fetch is in flight). Both are
    # best-effort: teardown must never raise.
    if _llm is not None:
        try:
            _llm.close()
        except Exception:  # noqa: BLE001 — teardown is best-effort
            logger.debug("llm client close raised", exc_info=True)
        _llm = None
    if _persona_fetcher is not None:
        try:
            _persona_fetcher.close()
        except Exception:  # noqa: BLE001 — teardown is best-effort
            logger.debug("persona fetcher close raised", exc_info=True)
        _persona_fetcher = None
    return released


@app.on_event("shutdown")
async def shutdown() -> None:
    _teardown_voice_runtime()


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
    # WARP-1409. Explicit mic-fault + the auto-recovery loop's counters.
    # `micFault` projects the recovery state machine (None | flatlined |
    # wedged_restarting | wedged_escalated | no_mic | error) — observability
    # only; the `degraded` predicate is unchanged. `dspRestartAttempts` /
    # `lastDspRestartAt` expose the bounded auto-restart for operators.
    micFault: Optional[str] = None
    dspRestartAttempts: int = 0
    lastDspRestartAt: Optional[float] = None
    # WARP-1119 (§14). Greeting-path persona fetch observability: whether
    # the last GET /api/persona/prompt succeeded + wall time of the last
    # attempt (None/None = never attempted, e.g. __mock__ deployments).
    # NEVER degrades health — a failed fetch falls back to the built-in
    # greeting prompt and voice keeps working; these fields exist so a
    # rotated ORCHESTRATOR_TOKEN is visible here instead of drifting
    # silently for months.
    personaFetchOk: Optional[bool] = None
    personaLastFetchAt: Optional[float] = None


class VoiceStatusResponse(BaseModel):
    # WARP-1599 — the persisted admin kill switch. False means an admin
    # switched the assistant off: no pipeline exists, nothing reads PCM,
    # and `state` reads "off" — a deliberate silence, distinct from
    # "no_mic", which is a hardware fault the box keeps retrying.
    enabled: bool
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
    # WARP-1409 — explicit mic-fault + auto-recovery counters (snake_case
    # on the /voice/status wire; the dashboard's health card reads these to
    # distinguish transient / wedged-restarting / wedged-escalated).
    mic_fault: Optional[str] = None
    dsp_restart_attempts: int = 0
    dsp_last_restart_at: Optional[float] = None
    # Calibration mode (WARP-1059). True while the wizard's suppression
    # window is live — wakes are counted (last_wake_at still updates,
    # which the wizard's step-3 ticker rides) but not handled (no
    # STT/LLM/TTS). `calibration_mode_expires_at` is the fail-safe TTL
    # expiry the wizard renews; None when the mode is off.
    calibration_mode: bool = False
    calibration_mode_expires_at: Optional[float] = None


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


# WARP-1059 — calibration-mode schemas. The wizard enters/renews the
# suppression window around its measure/echo/wake-test steps and exits
# on close; the TTL bounds mirror what the pipeline treats as sane
# (long enough to cover a slow step, short enough that an abandoned
# wizard never leaves the assistant deaf for minutes on end).

class CalibrationModeRequest(BaseModel):
    ttl_s: Optional[float] = Field(default=None, ge=5.0, le=300.0)


class CalibrationModeResponse(BaseModel):
    active: bool
    expires_at: Optional[float] = None


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


# WARP-1599 — admin kill-switch schemas. One boolean in, the persisted
# boolean back out: there is no third state and nothing is "pending" —
# the response is what a subsequent GET /voice/status reports as
# `enabled`.
#
# StrictBool, not bool: pydantic's default lax mode reads "false", "off"
# and 0 as real booleans, so a caller sending a string could silently
# silence the box. VoiceEnabledStore deliberately refuses to read a
# string "false" out of the flag file as an admin's intent, and the wire
# has to agree with the file — otherwise the same value means two
# different things depending on which layer sees it. Only a JSON
# `true`/`false` flips the switch; anything else is a 422, never a guess.

class VoiceEnabledRequest(BaseModel):
    enabled: StrictBool


class VoiceEnabledResponse(BaseModel):
    enabled: bool
    # WARP-1619 — whether the mic device is free by the time we answer.
    # Always True on enable, and on a disable that joined its worker.
    # False means the switch IS off (nothing reads new audio) but the
    # capture worker is finishing the turn it was in — the box is still
    # speaking and still holds the exclusive device for a few seconds.
    # Callers must not render "no audio is captured" unconditionally on
    # the strength of `enabled: false` alone.
    mic_released: bool = True


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
    mic_fault: Optional[str] = None
    dsp_restart_attempts = 0
    dsp_last_restart_at: Optional[float] = None
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
        mic_fault = s.mic_fault
        dsp_restart_attempts = s.dsp_restart_attempts
        dsp_last_restart_at = s.dsp_last_restart_at
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
        # WARP-1409 — explicit mic-fault + auto-recovery counters (observability).
        micFault=mic_fault,
        dspRestartAttempts=dsp_restart_attempts,
        lastDspRestartAt=dsp_last_restart_at,
        # WARP-1119 — persona-fetch observability (never degrades health).
        personaFetchOk=_persona_fetcher.fetch_ok if _persona_fetcher else None,
        personaLastFetchAt=(
            _persona_fetcher.last_fetch_at if _persona_fetcher else None
        ),
    )


@app.get("/voice/status", response_model=VoiceStatusResponse)
def voice_status() -> VoiceStatusResponse:
    """Snapshot of the wake-detection pipeline.

    Read-only — never blocks the worker. The dashboard polls this on
    the voice settings page to render the "listening" pulse + show
    the last wake event for debugging.
    """
    # WARP-1599 — read the persisted switch on every poll instead of
    # caching it: POST /voice/enabled is its only writer, and a read off
    # the page cache is cheaper than reasoning about a stale cache when a
    # toggle and a poll race.
    enabled = VoiceEnabledStore().load()
    if _pipeline is None:
        # No pipeline, for one of two reasons the dashboard must be able
        # to tell apart: an admin switched voice off (state "off" — a
        # deliberate, persisted silence) or the pipeline never started
        # (no mic / startup bailed — state "no_mic", a fault the box
        # keeps retrying). Same stable shape either way, so the
        # dashboard still needs no special case.
        return VoiceStatusResponse(
            enabled=enabled,
            state="no_mic" if enabled else "off",
            listening=False,
            wake_loaded=False,
            threshold=WAKE_THRESHOLD,
        )
    s = _pipeline.status()
    return VoiceStatusResponse(
        enabled=enabled,
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
        mic_fault=s.mic_fault,
        dsp_restart_attempts=s.dsp_restart_attempts,
        dsp_last_restart_at=s.dsp_last_restart_at,
        calibration_mode=s.calibration_mode,
        calibration_mode_expires_at=s.calibration_mode_expires_at,
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


# WARP-1055 (F5) — one wizard capture at a time. Two overlapping
# sd.rec/playrec calls on the same hw device collide (ALSA EBUSY or
# interleaved buffers); a second concurrent measure answers 409 so the
# dashboard can tell "busy, retry" apart from "device broken" (503).
# threading.Lock works because these endpoints are sync `def`s — FastAPI
# runs each in its own threadpool thread. /audio/test-record opens the
# same capture device, so it holds the same lock (WARP-1060).
_capture_lock = threading.Lock()

_CAPTURE_BUSY_DETAIL = (
    "Another microphone measurement is already running — try again in a few seconds."
)

# WARP-1599 — the kill switch's guarantee, enforced here rather than in
# the dashboard. The /voice off hero promises, verbatim, that "the wake
# word does nothing and no audio is captured", and dropping the wake
# pipeline only makes the first half true: every endpoint below opens
# the mic on its own and works perfectly well on a switched-off box. UI
# gating cannot be the enforcement — a second admin session, a stale tab
# mid-wizard, or any direct caller of the proxy reaches them anyway.
#
# Deliberate product decision: while voice is off the box captures
# NOTHING, not even a diagnostic. An admin who wants to test the mic
# turns voice back on first. No override flag — an override is just a
# second way to make the sentence false.
_VOICE_OFF_CAPTURE_DETAIL = (
    "The voice assistant is switched off — this Droplet captures no audio "
    "while it's off. Turn voice back on to use the microphone."
)


def _require_voice_on() -> None:
    """409 unless the admin switch is on — for every path that opens the mic.

    409 (not 403) for the same reason `_CAPTURE_BUSY_DETAIL` uses it: the
    request is well-formed and the caller is allowed, the box is just in a
    state where it won't capture — and flipping the switch makes the very
    same request work.
    """
    if not VoiceEnabledStore().load():
        raise HTTPException(status_code=409, detail=_VOICE_OFF_CAPTURE_DETAIL)


@app.post("/audio/test-record", response_model=TestRecordResponse)
def audio_test_record(duration_s: float = 2.0) -> TestRecordResponse:
    """Record a short clip from the picked input + report level.

    Returns RMS + peak in dBFS. Useful for "is the mic actually
    picking up sound?" — speak normally during the capture and a
    healthy mic shows roughly -40 to -20 dBFS RMS; silence is below
    -60 dBFS.
    """
    _require_voice_on()
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
    if not _capture_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail=_CAPTURE_BUSY_DETAIL)
    try:
        result = measure_input_level(
            duration_s=duration_s,
            samplerate=SAMPLE_RATE,
            channels=1,
            device=r.input_device.index,
        )
    except AudioUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except _PortAudioError as exc:
        # Same operational-fault mapping as /audio/measure (WARP-1060):
        # device busy / unplugged / rate-rejected is a retryable 503,
        # never a raw 500 relayed to the dashboard.
        raise HTTPException(
            status_code=503,
            detail=(
                "The microphone didn't respond (device busy or "
                f"disconnected: {exc}). Check the mic and try again."
            ),
        )
    finally:
        _capture_lock.release()
    return TestRecordResponse(
        rms_dbfs=result["rms_dbfs"],
        peak_dbfs=result["peak_dbfs"],
        samples=result["samples"],
        duration_s=duration_s,
    )


@app.post("/audio/measure", response_model=MeasureResponse)
def audio_measure(req: MeasureRequest) -> MeasureResponse:
    """Wizard measurement capture (WARP-1055): noise floor / speech peak.

    WARP-1410 — measured from the wake pipeline's ALREADY-OPEN capture
    stream, never a second `sounddevice.rec`. The reSpeaker's hw device is
    exclusive, so opening a second stream while the assistant is listening
    always failed with PortAudio -9985 ("Device unavailable") — which
    dead-ended the wizard's "let's listen to the room" step even on a
    perfectly healthy mic. Calibration mode (WARP-1059) suppresses wake
    HANDLING but keeps the stream open, so it never freed the device
    either. The sounddevice fallback below only runs when there is NO
    pipeline holding the device (no mic at boot / startup bailed).
    """
    _require_voice_on()
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
        pipeline = _pipeline
        if pipeline is not None:
            try:
                result = pipeline.measure_input(seconds)
            except MeasurementUnavailable as exc:
                raise HTTPException(status_code=503, detail=str(exc))
        else:
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
    _require_voice_on()
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


@app.post("/voice/calibration-mode", response_model=CalibrationModeResponse)
def enter_voice_calibration_mode(
    req: Optional[CalibrationModeRequest] = None,
) -> CalibrationModeResponse:
    """Enter (or renew) calibration mode (WARP-1059).

    While active, the pipeline counts wakes (last_wake_at still updates
    for the wizard's step-3 ticker) but never handles them — no STT
    capture pausing the detector, no LLM call, no reply spoken through
    the box speaker to pollute a measurement. Fail-safe: auto-expires
    after `ttl_s` (default DEFAULT_CALIBRATION_MODE_TTL_S) unless the
    wizard renews it, and a voice-io restart clears it — the assistant
    can never be left permanently deaf.
    """
    if _pipeline is None:
        raise HTTPException(
            status_code=503,
            detail="pipeline not started — usually means no input device at boot",
        )
    ttl = (
        req.ttl_s
        if req is not None and req.ttl_s is not None
        else DEFAULT_CALIBRATION_MODE_TTL_S
    )
    expires_at = _pipeline.enter_calibration_mode(ttl)
    return CalibrationModeResponse(active=True, expires_at=expires_at)


@app.delete("/voice/calibration-mode", response_model=CalibrationModeResponse)
def exit_voice_calibration_mode() -> CalibrationModeResponse:
    """Exit calibration mode (WARP-1059). Idempotent and deliberately
    error-free even without a pipeline: clearing suppression must always
    be safe to call (wizard close/cancel paths fire it best-effort)."""
    if _pipeline is not None:
        _pipeline.exit_calibration_mode()
    return CalibrationModeResponse(active=False)


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


def _auto_restart_dsp() -> None:
    """WARP-1409 — the heal the pipeline's bounded auto-recovery loop
    injects. Shares `_restart_lock` with POST /voice/restart-processor so
    an operator restart and the auto-recovery never issue overlapping DSP
    reboots: if the lock is held (a manual restart is mid-flight) this
    raises `DspRestartSkipped` so the pipeline knows no reboot went out —
    it spends no attempt, arms no cooldown, and retries on the next probe
    tick. Returning normally means the reboot was genuinely issued.
    `restart_dsp` stays module-scoped so the endpoint tests' monkeypatch
    of `main.restart_dsp` still covers this call site too (WARP-1288)."""
    if not _restart_lock.acquire(blocking=False):
        raise DspRestartSkipped(
            "a manual /voice/restart-processor is already in flight"
        )
    try:
        restart_dsp()
    finally:
        _restart_lock.release()


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


# WARP-1599 — one kill-switch toggle at a time. A second concurrent
# POST answers 409 rather than queueing: overlapping toggles would race
# the persist against the stop/start and could leave a live pipeline
# behind a flag that says "off". Deliberately its OWN lock, never
# `_capture_lock`: a measure or an enrollment capture holds that one for
# seconds at a time, and an admin killing the mic must not have to wait
# on the very capture they're trying to stop. Same sync-def threadpool +
# non-blocking-lock pattern as _capture_lock / _restart_lock above.
_enabled_lock = threading.Lock()


@app.post("/voice/enabled", response_model=VoiceEnabledResponse)
def set_voice_enabled(req: VoiceEnabledRequest) -> VoiceEnabledResponse:
    """Switch the voice assistant on or off, persistently (WARP-1599).

    Off is a real kill switch, not a mute: the wake pipeline is stopped
    and dropped — closing the exclusive mic stream, so no PCM is read by
    the wake path afterwards — along with the LLM client, persona fetcher
    and activity reporter built alongside it. The flag is written BEFORE
    any of that is touched, so a process death mid-toggle brings the box
    back in the state the admin asked for, never the one they were
    leaving.

    Idempotent both directions: switching on a box that is already
    listening re-persists the flag and leaves the running pipeline alone
    (rebuilding it would open a second stream on an exclusive device);
    switching off a box with no pipeline just persists the flag.

    Enabling never requires working hardware or the speaker model. When
    the pipeline can't start (no mic, missing wake model) this still
    answers 200 `enabled: true` and the box behaves exactly like a
    mic-less boot — /voice/status reports `no_mic` and the pipeline's own
    self-heal picks the mic up if it appears later. Failing here instead
    would make the switch un-flippable on precisely the boxes that need
    it most.
    """
    if not _enabled_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail=(
                "The voice assistant is already being switched on or off "
                "— give it a moment, then check the status again."
            ),
        )
    mic_released = True
    try:
        VoiceEnabledStore().save(req.enabled)
        if req.enabled:
            # A pipeline that is already listening is left exactly as it
            # is — rebuilding one would open a second stream on a device
            # that only allows one.
            if _pipeline is None:
                _build_and_start_pipeline()
        else:
            # "Stop and free", not just "stop": the shared teardown also
            # closes the LLM client, the persona fetcher and the activity
            # reporter that were built alongside the pipeline, so the
            # next enable rebuilds from clean state rather than stranding
            # a set of them per toggle. Tolerates an already-off box.
            #
            # WARP-1619 — the return says whether the mic device was
            # actually released. Answering a flat 200 when the worker is
            # mid-turn is what made the dashboard's "no audio is
            # captured" hero false for the length of a reply.
            mic_released = _teardown_voice_runtime()
    finally:
        _enabled_lock.release()
    return VoiceEnabledResponse(enabled=req.enabled, mic_released=mic_released)


# ────────────────────────────────────────────────────────────────────
# WARP-1056 — per-person voiceprints (Flow B enrollment + matching)
# ────────────────────────────────────────────────────────────────────
#
# Engine + stores live in voice/speaker_id.py (privacy invariants and
# the personalize-never-authenticate HARD RULE are documented there).
# These endpoints are reached ONLY through the orchestrator's
# /api/voice/* proxy (owner/admin wall) — voice-io itself binds on the
# internal Docker network. The orchestrator validates that `user_id`
# names an EXISTING person before /speaker/enroll/start is ever called;
# enrollment attaches a voiceprint to a person, it never creates one.

# Capture windows: a scripted line reads in ~3–4 s (give it air), the
# no-script verify utterance gets a little more.
ENROLL_LINE_SECONDS = 5.0
ENROLL_VERIFY_SECONDS = 6.0
SPEAKER_MATCH_SECONDS = 4.0

# Lazily-built embedder (model load itself is lazy inside). `None` after
# building means the deps or baked weights are absent — endpoints answer
# 503 speaker_model_unavailable. Tests inject via these module attrs.
_speaker_embedder: Optional[OnnxSpeakerEmbedder] = None
_speaker_embedder_built = False

_enroll_sessions = EnrollmentSessions()

_SPEAKER_UNAVAILABLE_DETAIL = (
    "Speaker recognition isn't available on this Droplet — the "
    "voice model isn't installed."
)


def _get_speaker_embedder() -> Optional[OnnxSpeakerEmbedder]:
    global _speaker_embedder, _speaker_embedder_built
    if not _speaker_embedder_built:
        _speaker_embedder = build_embedder_from_env()
        _speaker_embedder_built = True
    return _speaker_embedder


def _require_speaker_embedder() -> OnnxSpeakerEmbedder:
    embedder = _get_speaker_embedder()
    if embedder is None:
        raise HTTPException(status_code=503, detail=_SPEAKER_UNAVAILABLE_DETAIL)
    return embedder


def _capture_speaker_pcm(seconds: float) -> np.ndarray:
    """One mono enrollment/match capture off the picked input device.

    Same coexistence posture as /audio/measure: sounddevice.rec under
    the shared _capture_lock (never two overlapping captures on the hw
    device), AudioUnavailable/PortAudio faults → operational 503s. The
    returned PCM lives only for the embed call — never persisted.

    WARP-1599 — the kill-switch guard sits HERE rather than on each of
    /speaker/enroll/capture, /speaker/enroll/verify and /speaker/match:
    this is the one place the speaker surface opens the mic, so a switch
    that is off cannot be routed around by a fourth caller later.
    """
    _require_voice_on()
    r = _resolve()
    if r.input_device is None:
        raise HTTPException(
            status_code=503,
            detail="No input device available. Plug in a USB mic or check the onboard mic jack.",
        )
    if not _capture_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail=_CAPTURE_BUSY_DETAIL)
    try:
        data = record(
            duration_s=seconds,
            samplerate=SAMPLE_RATE,
            channels=1,
            device=r.input_device.index,
        )
    except AudioUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except _PortAudioError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "The microphone didn't respond (device busy or "
                f"disconnected: {exc}). Check the mic and try again."
            ),
        )
    finally:
        _capture_lock.release()
    return data.reshape(-1)


def _validated_user_id(user_id: str) -> str:
    if not USER_ID_RE.match(user_id or ""):
        raise HTTPException(status_code=400, detail="invalid user_id")
    return user_id


class SpeakerProfileInfo(BaseModel):
    """One enrolled voiceprint, WITHOUT the embedding — the vector never
    leaves this service (it isn't useful to the dashboard and shipping
    it around would only widen the biometric-adjacent surface)."""

    user_id: str
    enrolled_at: float
    updated_at: float
    last_recognized_at: Optional[float] = None
    # §5 step 3 honest fallback: enrollment saved but the no-script
    # verify never matched — the profile row shows "Learning".
    learning: bool = False
    # §7.6 — the other enrolled user this voiceprint is hard to tell
    # apart from (None when distinct).
    confused_with: Optional[str] = None
    lines: int = REQUIRED_LINES
    voice_model: str = SPEAKER_MODEL_NAME


class SpeakerProfilesResponse(BaseModel):
    # False = enrollment can't run here (weights/deps absent); the
    # dashboard disables its entry points instead of launching a wizard
    # that cannot succeed (§7.2 rule).
    speaker_model_available: bool
    profiles: list[SpeakerProfileInfo]


class EnrollStartRequest(BaseModel):
    user_id: str


class EnrollStartResponse(BaseModel):
    session_id: str
    lines_required: int


class EnrollCaptureRequest(BaseModel):
    session_id: str
    # "Redo" for an already-captured line (0-based). Absent = append.
    replace_index: Optional[int] = Field(default=None, ge=0)
    seconds: Optional[float] = Field(default=None, ge=2.0, le=15.0)


class EnrollCaptureResponse(BaseModel):
    # "good" | "too_quiet" | "crosstalk" — the §5/§7.5 capture guard.
    quality: str
    captured: int
    required: int


class EnrollVerifyRequest(BaseModel):
    session_id: str
    seconds: Optional[float] = Field(default=None, ge=2.0, le=15.0)


class EnrollVerifyResponse(BaseModel):
    quality: str
    matched: bool
    # Plain word ("high" / "good") or null — NEVER a percentage or raw
    # score (§5 step 3). The similarity stays server-side.
    confidence: Optional[str] = None


class EnrollCommitRequest(BaseModel):
    session_id: str


class EnrollCommitResponse(BaseModel):
    saved: bool
    profile: SpeakerProfileInfo


class EnrollDiscardResponse(BaseModel):
    discarded: bool


class SpeakerMatchResponse(BaseModel):
    """Who is speaking, for PERSONALIZATION only.

    HARD RULE (brief §5, FEATURES.md §6): this result never
    authenticates. It carries no session, token, role, or authority —
    deliberately just an id + a plain confidence word. Any confirm-tier
    action a recognized speaker asks for still routes to the
    dashboard/phone for the explicit confirm; nothing in this service
    (or its callers) may treat a voice match as an approval.
    """

    matched: bool
    user_id: Optional[str] = None
    confidence: Optional[str] = None


class SpeakerProfileDeleteResponse(BaseModel):
    deleted: bool


def _profile_info(record: dict) -> SpeakerProfileInfo:
    return SpeakerProfileInfo(
        user_id=str(record["user_id"]),
        enrolled_at=float(record.get("enrolled_at") or 0.0),
        updated_at=float(record.get("updated_at") or 0.0),
        last_recognized_at=record.get("last_recognized_at"),
        learning=bool(record.get("learning", False)),
        confused_with=record.get("confused_with"),
        lines=int(record.get("lines", REQUIRED_LINES)),
        voice_model=str(record.get("voice_model", SPEAKER_MODEL_NAME)),
    )


@app.get("/speaker/profiles", response_model=SpeakerProfilesResponse)
def speaker_profiles() -> SpeakerProfilesResponse:
    """Enrolled voiceprints (metadata only) + §7.6 confusability."""
    records = VoiceprintStore().load_all()
    annotate_confusable(records)
    return SpeakerProfilesResponse(
        speaker_model_available=_get_speaker_embedder() is not None,
        profiles=[_profile_info(r) for r in records],
    )


@app.post("/speaker/enroll/start", response_model=EnrollStartResponse)
def speaker_enroll_start(req: EnrollStartRequest) -> EnrollStartResponse:
    """Open an enrollment session for an EXISTING person.

    The orchestrator proxy has already verified the user row exists —
    enrollment never creates a person (§3.3). Requires the embedder and
    a mic now, so the dashboard fails fast instead of on line 1.
    """
    user_id = _validated_user_id(req.user_id)
    _require_speaker_embedder()
    r = _resolve()
    if r.input_device is None:
        raise HTTPException(
            status_code=503,
            detail="No input device available. Plug in a USB mic or check the onboard mic jack.",
        )
    session = _enroll_sessions.create(user_id)
    return EnrollStartResponse(
        session_id=session.id, lines_required=REQUIRED_LINES,
    )


@app.post("/speaker/enroll/capture", response_model=EnrollCaptureResponse)
def speaker_enroll_capture(req: EnrollCaptureRequest) -> EnrollCaptureResponse:
    """Capture one scripted line: record → quality-guard → embed.

    The PCM is dropped as soon as the embedding exists; a "too_quiet" /
    "crosstalk" capture stores nothing (the wizard re-prompts with the
    §5 / §7.5 copy).
    """
    embedder = _require_speaker_embedder()
    session = _enroll_sessions.get(req.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="enrollment session not found")
    replace = req.replace_index
    if replace is not None and replace >= len(session.embeddings):
        raise HTTPException(status_code=400, detail="replace_index out of range")
    if replace is None and len(session.embeddings) >= MAX_TOTAL_LINES:
        raise HTTPException(status_code=400, detail="enough lines captured")
    pcm = _capture_speaker_pcm(req.seconds or ENROLL_LINE_SECONDS)
    try:
        embedding, quality = assess_capture(
            pcm, lambda p: embedder.embed(p, SAMPLE_RATE),
        )
    except SpeakerIdUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if embedding is not None:
        if replace is not None:
            session.embeddings[replace] = embedding
        else:
            session.embeddings.append(embedding)
    return EnrollCaptureResponse(
        quality=quality,
        captured=len(session.embeddings),
        required=REQUIRED_LINES,
    )


@app.post("/speaker/enroll/verify", response_model=EnrollVerifyResponse)
def speaker_enroll_verify(req: EnrollVerifyRequest) -> EnrollVerifyResponse:
    """§5 step 3 — the no-script proof: capture anything, then check the
    session's own voiceprint wins. `matched` requires BOTH a real match
    against this enrollment's mean AND beating every OTHER enrolled
    voiceprint — recognizing the new voice as a sibling is a mismatch,
    not a pass. A too-quiet/crosstalk capture doesn't count as an
    attempt (quality rides back so the wizard re-prompts)."""
    embedder = _require_speaker_embedder()
    session = _enroll_sessions.get(req.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="enrollment session not found")
    if len(session.embeddings) < REQUIRED_LINES:
        raise HTTPException(
            status_code=400,
            detail=f"need {REQUIRED_LINES} captured lines before verifying",
        )
    pcm = _capture_speaker_pcm(req.seconds or ENROLL_VERIFY_SECONDS)
    try:
        candidate, quality = assess_capture(
            pcm, lambda p: embedder.embed(p, SAMPLE_RATE),
        )
    except SpeakerIdUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if candidate is None:
        return EnrollVerifyResponse(quality=quality, matched=False)
    sim_self = cosine(candidate, session.mean_embedding())
    others = [
        r
        for r in VoiceprintStore().load_all()
        if str(r.get("user_id")) != session.user_id
    ]
    _, best_other_sim = match_against(candidate, others)
    word = confidence_word(sim_self)
    matched = word is not None and sim_self > best_other_sim
    session.verify_attempts += 1
    if matched:
        session.verify_matched = True
    return EnrollVerifyResponse(
        quality="good",
        matched=matched,
        confidence=word if matched else None,
    )


@app.post("/speaker/enroll/commit", response_model=EnrollCommitResponse)
def speaker_enroll_commit(req: EnrollCommitRequest) -> EnrollCommitResponse:
    """The ONE write of Flow B ("Save [Name]'s voice"): persist the mean
    embedding as the person's voiceprint, then discard the session.

    `learning` is server-derived (§5 step 3 honest fallback): the
    session never passed a no-script verify → the profile row shows
    "Learning" and improves via re-record — the client can't forge a
    verified state. Re-recording keeps the original enrolled_at (the
    row meta is "when this person was enrolled", not "last write").
    """
    session = _enroll_sessions.get(req.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="enrollment session not found")
    if len(session.embeddings) < REQUIRED_LINES:
        raise HTTPException(
            status_code=400,
            detail=f"need {REQUIRED_LINES} captured lines before saving",
        )
    store = VoiceprintStore()
    existing = store.load(session.user_id)
    now = time.time()
    record_out = {
        "user_id": session.user_id,
        "embedding": [float(x) for x in session.mean_embedding()],
        "lines": len(session.embeddings),
        "enrolled_at": (existing or {}).get("enrolled_at") or now,
        "updated_at": now,
        "last_recognized_at": (
            now if session.verify_matched
            else (existing or {}).get("last_recognized_at")
        ),
        "learning": not session.verify_matched,
        "voice_model": SPEAKER_MODEL_NAME,
    }
    store.save(record_out)
    _enroll_sessions.discard(session.id)
    return EnrollCommitResponse(saved=True, profile=_profile_info(record_out))


@app.delete("/speaker/enroll/{session_id}", response_model=EnrollDiscardResponse)
def speaker_enroll_discard(session_id: str) -> EnrollDiscardResponse:
    """Cancel path — "Cancel deletes these recordings now". Idempotent
    and deliberately error-free: the wizard's close paths fire it blind,
    and the embeddings live only in RAM anyway."""
    return EnrollDiscardResponse(discarded=_enroll_sessions.discard(session_id))


@app.post("/speaker/match", response_model=SpeakerMatchResponse)
def speaker_match() -> SpeakerMatchResponse:
    """Capture a few seconds and identify the speaker — the on-box
    matching primitive (the wake pipeline's personalization hook rides
    this same logic in a follow-up ticket; wiring it into pipeline.py is
    deliberately out of scope here). Response is words-only — see
    SpeakerMatchResponse for the personalize-never-authenticate rule."""
    embedder = _require_speaker_embedder()
    store = VoiceprintStore()
    records = store.load_all()
    if not records:
        return SpeakerMatchResponse(matched=False)
    pcm = _capture_speaker_pcm(SPEAKER_MATCH_SECONDS)
    try:
        candidate, quality = assess_capture(
            pcm, lambda p: embedder.embed(p, SAMPLE_RATE),
        )
    except SpeakerIdUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if candidate is None:
        # Too quiet / crosstalk — an honest "not sure" (guest treatment),
        # never a low-confidence guess.
        return SpeakerMatchResponse(matched=False)
    user_id, sim = match_against(candidate, records)
    if user_id is None:
        return SpeakerMatchResponse(matched=False)
    store.touch_recognized(user_id)
    return SpeakerMatchResponse(
        matched=True, user_id=user_id, confidence=confidence_word(sim),
    )


@app.delete(
    "/speaker/profiles/{user_id}",
    response_model=SpeakerProfileDeleteResponse,
)
def speaker_profile_delete(user_id: str) -> SpeakerProfileDeleteResponse:
    """Remove a voiceprint — IMMEDIATE and complete (§3.3 caption:
    "deleted instantly when removed"). Synchronous file removal plus a
    purge of any in-flight enrollment session for the same person;
    idempotent so a retry after a timeout can't error."""
    uid = _validated_user_id(user_id)
    deleted = VoiceprintStore().delete(uid)
    _enroll_sessions.discard_for_user(uid)
    return SpeakerProfileDeleteResponse(deleted=deleted)
