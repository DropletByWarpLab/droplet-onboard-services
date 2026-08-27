"""Wake-detection + STT pipeline — background thread that streams mic
audio into a wake-word detector, then on detection streams the next
few seconds to a Wyoming-protocol Whisper sidecar and emits a
transcript.

Architecture:

  capture (sounddevice InputStream)
      │
      ▼ 1280-sample (80 ms @ 16 kHz mono int16) chunks
  pipeline._loop (this module's background thread)
      │
      ▼ state-dispatched frame handler:
      │
      ├─ state=listening    → detector.predict() → threshold check
      │                       → wake fires → state=wake_detected
      │
      ├─ state=wake_detected → next frame transitions to transcribing
      │                       (opens Wyoming session, starts streaming)
      │
      ├─ state=transcribing  → send each frame as Wyoming audio-chunk
      │                       → after STT_MAX_RECORD_S, send audio-stop
      │                       → block briefly for transcript event
      │                       → state=transcript_ready
      │
      └─ state=transcript_ready → ignore until visual-decay; status()
                                  reports it for the dashboard's pulse,
                                  decays back to 'listening' after
                                  WAKE_VISUAL_DECAY_S.

Single thread. The Wyoming `finish()` call blocks for the final
transcript event (typically <1 s for small.en on CPU); during that
window the mic stream isn't being drained and may overflow into a
log line, which is harmless and brief. We don't bridge to asyncio
because the wake loop is already a blocking thread and the gain
isn't worth the threading-model complication.

Debounce: a single utterance produces many 80 ms frames above
threshold (the wake-word audio is ~600 ms). Without a debounce window
we'd fire 10+ WakeEvents back-to-back. `WAKE_DEBOUNCE_S` enforces a
minimum gap between events — defaults to 2 s. Once we transition into
transcribing, the wake detector is paused entirely, so debounce only
matters for the wake→wake re-fire window (which becomes very rare in
practice since the STT capture takes 5 s).

Status:
  state ∈ {idle, loading, listening, wake_detected, transcribing,
           transcript_ready, error, no_mic}
  last_wake_at / last_wake_score / last_wake_model
  last_transcript / last_transcript_at
  stt_loaded — true iff the STT server was reachable at startup
  error_message (only set in 'error' state)

`wake_detected` and `transcript_ready` are transient UI hints that
auto-decay to `listening` after `WAKE_VISUAL_DECAY_S` seconds (2 s by
default) so the dashboard's wake + transcript pulse animations have
time to play.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from typing import Any, Callable, Iterable, Iterator, Optional

import numpy as np

from voice.activity import ActivityReporter
from voice.audio_io import negotiate_capture_rate, resample_int16
from voice.llm import LLMClient, LLMUnavailable, ToolChoice
from voice.stt import STTUnavailable, StreamingSTT
from voice.text_chunk import SentenceChunker
from voice.tts import SynthesizedAudio, TextToSpeech, TTSUnavailable
from voice.wake import (
    WAKE_FRAME_SAMPLES,
    WAKE_SAMPLE_RATE,
    WakeEvent,
    WakeWordDetector,
)

logger = logging.getLogger("voice.pipeline")


class _DeviceError(Exception):
    """Internal marker for a RECOVERABLE audio-device failure (mic
    re-enumeration, shifted ALSA card index, invalidated PortAudio
    handle). Raised inside the capture session from the stream open/read
    and caught by the supervising loop, which re-resolves + reopens. Kept
    private — callers see the public state machine (state='no_mic' while
    recovering), never this type."""


class DspRestartSkipped(Exception):
    """Raised BY an injected ``dsp_restart`` heal to say "I issued no
    reboot" (WARP-1409).

    Public, because it is half the contract every heal implements: the
    bounded auto-recovery loop has to tell a restart that *ran* (and may
    have failed — that costs an attempt and starts a cooldown) apart from
    one that never reached the chip at all. `main._auto_restart_dsp`
    raises it when an operator's POST /voice/restart-processor already
    holds the DSP lock.

    Explicit signal, never inferred from a falsy/None return: heals are
    ``Callable[[], Any]`` and the natural ones (`list.append`, a bare
    subprocess call) already return None, so "returned nothing" cannot
    mean "did nothing". A skip spends no attempt and arms no cooldown —
    the next probe tick genuinely retries."""


class MeasurementUnavailable(Exception):
    """A windowed input measurement could not be taken from the live
    capture stream (WARP-1410): the pipeline isn't delivering frames
    (no_mic / error / not started), or another measurement is already
    collecting. Public — the API layer maps it to an operational 503."""


# ────────────────────────────────────────────────────────────────────
# Intent gate — suppress speculative tool calls
# ────────────────────────────────────────────────────────────────────
#
# llama3.1:8b speculatively dispatches tools (`get_router_system_info`,
# `get_system_health`, …) for utterances where the answer is already
# in the system prompt context — greetings, "what time is it?",
# "who are you?", "can you hear me?". The outcome is non-deterministic
# (same prompt sometimes works, sometimes routes to a tool that has
# no idea about the question and produces a confused fallback).
#
# Approach: classify the transcript with a small regex pass BEFORE we
# hit the LLM. If it matches one of the patterns below, ask the
# orchestrator for `tool_choice="none"` — the agent loop then sends
# ZERO tools to the model, so the answer can only come from the
# system prompt + the model's own knowledge. Deterministic by
# construction.
#
# Match rules:
#   * Whole-utterance only (`^…$`) so "hey, turn off the lights"
#     still goes to the agent loop (greeting prefix doesn't take it
#     out of the tool-driven path).
#   * Case-insensitive; tolerates trailing punctuation produced by
#     Whisper ("hey jarvis." vs "hey jarvis").
#   * Patterns deliberately tight: false-positives are recoverable
#     (model just says "I can't answer that without checking" instead
#     of calling the right tool); false-negatives are the status quo.
#
# Updates here MUST be paired with a unit test in
# `tests/test_pipeline.py::TestIntentClassifier` so regressions are
# caught before the next deploy.

_INTENT_NO_TOOLS_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Greetings and check-ins — whole utterance only. A bare greeting
    # may stand alone or take an optional "there" suffix ("hi there",
    # "hello there", "hey there") — applied uniformly to all three so a
    # new greeting word can't be added on one branch but forgotten on
    # the other. The wake-word address may be spoken WITH an optional
    # "hey"/"hello" ("hey droplet", "hello jarvis") OR bare ("droplet") —
    # the box now wakes on a bare "droplet" too (WARP-1431), so someone
    # who woke it that way and just says "droplet" is answered from the
    # persona rather than routed to a tool. Applied uniformly to the
    # three address words for the same forget-a-branch reason.
    re.compile(
        r"^\s*((hi|hello|hey)(\s+there)?|yo|sup|"
        r"(hey|hello)\s+(jarvis|droplet|assistant)|"
        r"(jarvis|droplet|assistant))"
        r"[\s!.,?]*$",
        re.IGNORECASE,
    ),
    # "good morning/evening/afternoon/night", optionally addressed.
    re.compile(
        r"^\s*good\s+(morning|evening|afternoon|night)"
        r"(\s*,?\s*(jarvis|droplet|assistant))?"
        r"[\s!.,?]*$",
        re.IGNORECASE,
    ),
    # Liveness check-ins: "can you hear me?" / "are you there?" with an
    # optional wake-word address prefix — "hey" is itself optional so a
    # bare "droplet, are you there" works alongside "hey droplet, are you
    # there" (WARP-1431).
    re.compile(
        r"^\s*((hey\s+)?(jarvis|droplet|assistant)[,\s]+)?"
        r"(can you hear me|are you there|you there|are you listening|"
        r"do you hear me|hello\?\s*are you there)"
        r"[\s!.,?]*$",
        re.IGNORECASE,
    ),
    # Time-of-day queries. Match the natural variants without
    # accidentally swallowing "what time should I leave?".
    re.compile(
        r"^\s*(what(?:'s|s| is)?\s+(the\s+)?time(\s+(is\s+it|now))?|"
        r"what time is it(\s+now)?|"
        r"what's the current time|current time|time now|"
        r"tell me the time|do you (know|have) the time|"
        r"got the time)"
        r"[\s!.,?]*$",
        re.IGNORECASE,
    ),
    # Date / day-of-week queries.
    re.compile(
        r"^\s*(what(?:'s|s| is)?\s+(the\s+|today'?s\s+)?date|"
        r"what day (of the week )?is it(\s+today)?|"
        r"what'?s today|what day is today|"
        r"what'?s the day)"
        r"[\s!.,?]*$",
        re.IGNORECASE,
    ),
    # Who-are-you / capability queries that the persona prompt already
    # answers — with the same optional wake-word address prefix so
    # "droplet, who are you" / "hey droplet, what can you do" are gated
    # too (WARP-1431).
    re.compile(
        r"^\s*((hey\s+)?(jarvis|droplet|assistant)[,\s]+)?"
        r"(who are you|what(?:'s|s| is)? your name|"
        r"what are you|what can you do|"
        r"are you (jarvis|droplet|an assistant|there))"
        r"[\s!.,?]*$",
        re.IGNORECASE,
    ),
)


def classify_tool_choice(transcript: str) -> Optional[ToolChoice]:
    """Return ``"none"`` for utterances that should answer from system-
    prompt context only; ``None`` to let the orchestrator pick (auto).

    Pure function — no I/O, no state. Safe to call from any thread.
    """
    if not transcript:
        return None
    for pat in _INTENT_NO_TOOLS_PATTERNS:
        if pat.match(transcript):
            return "none"
    return None


def transcript_is_actionable(transcript: str) -> bool:
    """Whether a post-wake transcript looks like an actual command.

    Residual false wakes (phonetic near-collisions — the TV saying
    "hey, drop it") capture ambient fragments: "it.", "uh", "yeah.".
    Every real command or question carries at least one word of three
    or more letters ("stop", "lights", "what's the weather"), so gate
    the LLM → speak path on that. False wakes then decay silently
    instead of the box answering the television; a false NEGATIVE here
    would require a genuine command made entirely of ≤2-letter words,
    which doesn't occur in practice.

    Pure function — no I/O, no state. Safe to call from any thread.
    """
    return bool(re.search(r"[a-zA-Z]{3,}", transcript or ""))

# Default tuning. Overridable via env at construct time (read by
# main.py's wiring, not by this module directly).
DEFAULT_THRESHOLD = 0.3
DEFAULT_DEBOUNCE_S = 2.0
DEFAULT_VISUAL_DECAY_S = 2.0
DEFAULT_STT_MAX_RECORD_S = 5.0  # hard cap on captured audio per wake. The
                                # end-of-speech VAD cuts sooner when the room
                                # goes quiet; this cap guarantees the capture
                                # always stops (e.g. in a room with continuous
                                # background audio where no silence is ever
                                # detected). WARP-1434: this 5.0 is the SINGLE
                                # source of truth — compose, the README, and
                                # the overview doc all ship 5.0 and the box
                                # runs 5.0; the old 3.0 code default was drift.
                                # Overridable via STT_MAX_RECORD_S.
DEFAULT_UPSTREAM_PROBE_INTERVAL_S = 30.0  # how often to re-probe STT/TTS/LLM
# Calibration mode (WARP-1059, from WARP-1055 review F6). While the
# dashboard wizard measures (noise floor / speech peak / echo / wake
# test), the pipeline must not HANDLE wakes: the step-2 spec phrase
# ("Hey Droplet, …") would otherwise start a full turn — STT capture
# pauses the detector ~3-4 s (swallowing step-3 tries), the LLM reply is
# SPOKEN through the box speaker (inflating step-2's speech_peak so
# auto-gain tunes to the box's own voice, +2 s cooldown), and a step-2
# wake can pre-count for step 3. In calibration mode wake DETECTION
# still runs and still records last_wake_at/score/model (the wizard's
# step-3 counter rides those), but the wake→STT→LLM→TTS chain never
# starts. Fail-safe: a wall-clock TTL computed on read — no timer
# thread, nothing persisted — renewed by the wizard while it's open, so
# an abandoned wizard/dead tab leaves the assistant deaf for at most the
# TTL and a process restart clears it instantly.
DEFAULT_CALIBRATION_MODE_TTL_S = 90.0

# Window after TTS playback ends during which wake detection is suppressed.
# The reSpeaker XVF3800 is both speaker and mic on the same USB endpoint;
# even with hardware AEC, the tail of a synthesized reply can bleed back
# into the capture stream and trip the wake detector. The cooldown also
# absorbs the user's natural "follow-up" talk that arrives right after
# the device finishes speaking ("ok thanks", "got it") — those shouldn't
# re-arm a new turn. Tuned to 2 s: long enough to swallow Piper's tail +
# room reverb, short enough that a deliberate second "hey jarvis" still
# wakes promptly.
DEFAULT_POST_SPEAK_COOLDOWN_S = 2.0

# End-of-speech (VAD) for the STT capture window. Once the user has
# actually started talking, the capture ends after a short run of
# trailing silence — so the box stops listening the moment they finish
# their statement instead of always holding the mic for the full
# max-record window. Energy-based on frame RMS; the max-record window
# stays the hard cap for noisy rooms where a clean silence never arrives.
DEFAULT_VAD_SILENCE_S = 0.6       # trailing silence (s) that ends the turn.
                                  # WARP-1434: trimmed 1.0 → 0.6 — a full
                                  # second of dead air used to end every turn;
                                  # 0.6 s still rides out a natural pause but
                                  # stops promptly once the speaker finishes.
                                  # Overridable per-room via VAD_SILENCE_S.
DEFAULT_VAD_SPEECH_RMS = 700.0    # int16 frame RMS above which a frame = "speech"
                                  # (sits between a typical room floor ~400
                                  # and normal speech ~1000+; tune per-room
                                  # via VAD_SPEECH_RMS).
DEFAULT_VAD_MIN_SPEECH_S = 0.4    # min CUMULATIVE speech before end-of-speech
                                  # may fire — keeps the wake-word tail + a
                                  # pause before the command from ending early

# Multichannel capture → mono for the detector + STT.
#
# "first" (default): consume CHANNEL 0 only. Mic arrays put the primary
# processed signal there — the reSpeaker XVF3800 ships beamformed voice
# on L and AEC *residual* on R, so the old mean-of-channels downmix
# halved the voice amplitude and mixed in residual noise. That cost
# ~6 dB of effective sensitivity ("you have to talk really loud") and
# fed the VAD/wake/STT a dirtier signal. "mean" stays available via
# VOICE_INPUT_DOWNMIX for plain stereo mics where both channels carry
# the room.
DEFAULT_INPUT_DOWNMIX = "first"
# Digital gain applied to the mono frame after downmix (int16-clipped).
# 1.0 = untouched. For a quiet capture chain raise via VOICE_INPUT_GAIN
# (e.g. 2.0 ≈ +6 dB) — cheaper and persistent vs. volatile DSP-side
# gain set over xvf_host (lost on every chip reboot).
DEFAULT_INPUT_GAIN = 1.0

# Audio-device self-heal backoff. When the mic re-enumerates (the
# reSpeaker XVF3800 USB array shifts its card index under Docker), the
# open InputStream goes invalid and read() — or the next open() — raises
# a PortAudioError/OSError. Rather than letting the worker thread die
# (which leaves voice stuck at state=error until a container restart), the
# loop refreshes PortAudio's device enumeration, re-resolves the input
# index, and reopens. Between attempts it waits with a capped exponential
# backoff so a genuinely-absent mic doesn't hot-loop the CPU while still
# recovering a flapping device within a few seconds. The wait is on the
# shutdown Event so stop() drops out of a backoff immediately.
DEFAULT_RECOVER_BACKOFF_INITIAL_S = 0.5  # first retry delay after a disconnect
DEFAULT_RECOVER_BACKOFF_MAX_S = 5.0      # cap — a missing mic retries every 5 s

# Capture-rate negotiation (WARP-2213).
#
# The wake detector and the STT hand-off both require int16 mono at
# EXACTLY WAKE_SAMPLE_RATE (16 kHz). Most capture hardware does not offer
# 16 kHz at all: the appliance's onboard Realtek ALC897 advertises
# {44100, 48000, 96000} and the ReSpeaker XVF3800 runs its USB audio
# interface at 48 kHz. Opening such a device at 16 kHz fails with
# PortAudio -9997 (paInvalidSampleRate) on EVERY attempt, so the
# self-heal loop above re-opens forever and the box never hears anything
# — an all-green appliance that is permanently deaf.
#
# So: ask the device what it accepts, open at the best rate it DOES
# support, and polyphase-resample each block down to 16 kHz before the
# detector sees it. WAKE_SAMPLE_RATE stays FIRST, so a device that
# genuinely supports 16 kHz (the ReSpeaker USB 4-Mic Array does) keeps
# the existing zero-resample path untouched.
#
# Every candidate divides WAKE_FRAME_SAMPLES exactly (1280 * rate / 16000
# is a whole number for all of them), so one read always yields exactly
# one detector frame — no carry buffer, no drift, no partial frames.
CAPTURE_RATE_CANDIDATES = (WAKE_SAMPLE_RATE, 48000, 32000, 44100, 96000)

# Input-level tracking + flatline watchdog (WARP-1037).
#
# The ReSpeaker XVF3800's XMOS DSP has a known wedge mode (continuous
# xhci buffer overruns): the USB audio stream stays open — so the
# pipeline sits in 'listening' and /health reports 200 — while every
# delivered frame is pure digital silence. "Healthy but deaf." The
# device self-heal path above only covers *disconnects*, not a stream
# that flows zeros. So the frame handler tracks a rolling input RMS
# (this is the ONLY safe place to measure it — opening a second
# InputStream on the same hw device risks ALSA EBUSY), and status()
# computes a read-time flatline flag: input at/near digital zero for
# the whole window while state=listening ⇒ input_flatlined=True ⇒
# /health degrades to 503 so the Docker healthcheck + ops-console see
# the wedge instead of a green light.
DEFAULT_FLATLINE_WINDOW_S = 240.0  # 4 min of silence while listening = wedged.
# DSP auto-recovery (WARP-1409): once wedged, how many times to auto-issue
# `xvf_host REBOOT 1` before escalating, and the gap between attempts (a reboot
# needs ~10 s to re-enumerate + a probe tick to re-verify; the gap also keeps the
# in-app path from racing the host watchdog's own overrun-keyed reboot).
DEFAULT_DSP_RECOVERY_MAX_ATTEMPTS = 3
DEFAULT_DSP_RECOVERY_COOLDOWN_S = 60.0
                                   # Long enough that a genuinely silent room
                                   # never trips it (a real mic's noise floor
                                   # sits well above the dBFS gate anyway);
                                   # short enough that ops sees a wedge within
                                   # minutes. 0 disables. Env: VOICE_FLATLINE_WINDOW_S.
DEFAULT_FLATLINE_DBFS = -70.0      # frames below this count as "no signal".
                                   # A healthy capture chain's noise floor is
                                   # ≈ -60…-50 dBFS; a wedged DSP emits exact
                                   # zeros (floor) or ±1-count dither (≈ -90).
                                   # Tuned in the EFFECTIVE (post-gain) domain;
                                   # frames are tracked pre-gain (WARP-1055),
                                   # so the compare compensates by
                                   # 20·log10(input_gain) — see
                                   # _track_input_level (WARP-1060).
                                   # Env: VOICE_FLATLINE_DBFS.
DEFAULT_RMS_WINDOW_FRAMES = 25     # rolling-RMS window ≈ 2 s of 80 ms frames —
                                   # smooth enough for a wizard level meter,
                                   # short enough to feel live.
RMS_DBFS_FLOOR = -120.0            # reported dBFS for pure digital silence
                                   # (log10(0) is -inf; JSON can't carry it).
_INT16_FULL_SCALE = 32768.0

# Near-miss floor for the missed-wake feed row (WARP-1058). A frame
# whose best score lands in [threshold * ratio, threshold) is someone
# probably saying the wake word without clearing the gate — exactly the
# "it didn't hear me" case §3.4's feed exists to make debuggable. Below
# the ratio is ordinary room audio and emits nothing (the detector
# scores every frame; without a floor the feed would drown in noise).
# Ratio-of-threshold rather than absolute because the two engines'
# score semantics differ (openWakeWord sigmoid ~0.3 gate vs Vosk
# min-word-confidence ~0.7 gate). Misses are debounced on the same
# `debounce_s` window as fires so one hesitant utterance = one row.
WAKE_MISS_RATIO = 0.6

# State enumeration. The string form is what /voice/status exposes so
# the dashboard can switch on it directly. Kept as a typedef rather
# than an Enum because all reads cross thread boundaries + JSON, and
# string is what survives both without ceremony.
PipelineState = str  # idle | loading | listening | wake_detected |
                     # transcribing | transcript_ready | speaking |
                     # error | no_mic


@dataclass
class PipelineStatus:
    """Snapshot of pipeline state. Returned by /voice/status as-is."""

    state: PipelineState
    listening: bool
    wake_loaded: bool
    wake_model: Optional[str]
    threshold: float
    last_wake_at: Optional[float]
    last_wake_score: Optional[float]
    last_wake_model: Optional[str]
    error_message: Optional[str]
    # WAKE_WORD env value (what the operator asked for). If a custom
    # model isn't on disk and isn't bundled, `wake_model` shows the
    # fallback name and `using_wake_fallback` is True. Dashboard
    # surfaces this as "wake configured: hey_droplet, currently:
    # hey_jarvis (training pending)". Defaulted to None / False so the
    # dataclass field-ordering rule (non-default before default) holds.
    requested_wake_word: Optional[str] = None
    using_wake_fallback: bool = False
    # STT fields (commit 5 onwards). `stt_loaded` reflects the at-startup
    # reachability check; transient send failures during a transcription
    # land in `error_message`, not here.
    stt_loaded: bool = False
    last_transcript: Optional[str] = None
    last_transcript_at: Optional[float] = None
    # TTS fields (commit 6). `tts_loaded` is the at-startup reachability;
    # `last_response` is the most recent text that got spoken. Commit 7
    # populates last_response from the LLM reply; speak() can also be
    # called directly via POST /voice/say.
    tts_loaded: bool = False
    last_response: Optional[str] = None
    last_response_at: Optional[float] = None
    # LLM fields (commit 7). `llm_loaded` reflects the at-startup
    # reachability probe of the orchestrator's /api/llm/chat endpoint.
    # When false the wake → STT path still works (transcripts land in
    # last_transcript) but no spoken reply happens.
    llm_loaded: bool = False
    # Input-level fields (WARP-1037). `input_rms_dbfs` is a rolling RMS
    # over the last ~2 s of captured mic frames, measured inside the
    # pipeline's own frame handler (never a second audio stream — ALSA
    # EBUSY). None until the first frame arrives. `last_audio_at` is
    # the wall time of the last frame whose level cleared the flatline
    # threshold, i.e. carried ANY real signal. `input_flatlined` flips
    # True when the input has sat at/near digital zero for the whole
    # flatline window while state=listening — the ReSpeaker XVF3800's
    # wedged-DSP signature ("listening but deaf"); /health degrades to
    # 503 on it.
    input_rms_dbfs: Optional[float] = None
    last_audio_at: Optional[float] = None
    input_flatlined: bool = False
    # DSP auto-recovery (WARP-1409). `mic_fault` is the EXPLICIT fault
    # projection health + the dashboard read, instead of guessing from
    # absence: None (healthy) | "flatlined" (wedge detected, not yet
    # acted on) | "wedged_restarting" (auto-restart in flight / retrying)
    # | "wedged_escalated" (bounded retries exhausted — a power cycle is
    # needed) | "no_mic" | "error". `dsp_restart_attempts` /
    # `dsp_last_restart_at` expose the recovery loop for operators.
    mic_fault: Optional[str] = None
    dsp_restart_attempts: int = 0
    dsp_last_restart_at: Optional[float] = None
    # Calibration mode (WARP-1059). True while the wizard's suppression
    # window is live: wakes are counted (last_wake_at/score/model) but
    # not handled (no STT/LLM/TTS). `calibration_mode_expires_at` is the
    # fail-safe expiry the wizard renews; None when the mode is off.
    calibration_mode: bool = False
    calibration_mode_expires_at: Optional[float] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class WakePipeline:
    """Owns the wake-detection background thread + status state.

    Construction is cheap (no audio yet); `start()` spawns the worker.
    `stop()` cleanly tears it down. Status is read-locked so /voice/
    status can be safely called from FastAPI's request thread while the
    worker is mid-prediction.

    `on_wake` is the hook subsequent commits use to chain into STT.
    For now (commit 4) the default callback just logs; the pipeline
    additionally records the event into `status` so /voice/status
    surfaces it.
    """

    def __init__(
        self,
        detector: WakeWordDetector,
        input_device_index: Optional[int],
        threshold: float = DEFAULT_THRESHOLD,
        debounce_s: float = DEFAULT_DEBOUNCE_S,
        visual_decay_s: float = DEFAULT_VISUAL_DECAY_S,
        on_wake: Optional[Callable[[WakeEvent], None]] = None,
        stt: Optional[StreamingSTT] = None,
        on_transcript: Optional[Callable[[str], None]] = None,
        stt_max_record_s: float = DEFAULT_STT_MAX_RECORD_S,
        tts: Optional[TextToSpeech] = None,
        output_device_index: Optional[int] = None,
        llm: Optional[LLMClient] = None,
        upstream_probe_interval_s: float = DEFAULT_UPSTREAM_PROBE_INTERVAL_S,
        post_speak_cooldown_s: float = DEFAULT_POST_SPEAK_COOLDOWN_S,
        vad_silence_s: float = DEFAULT_VAD_SILENCE_S,
        vad_speech_rms: float = DEFAULT_VAD_SPEECH_RMS,
        vad_min_speech_s: float = DEFAULT_VAD_MIN_SPEECH_S,
        sd_module: Any = None,
        resolve_input_device: Optional[Callable[[], Optional[int]]] = None,
        recover_backoff_initial_s: float = DEFAULT_RECOVER_BACKOFF_INITIAL_S,
        recover_backoff_max_s: float = DEFAULT_RECOVER_BACKOFF_MAX_S,
        sd_reinit: Optional[Callable[[Any], None]] = None,
        input_downmix: str = DEFAULT_INPUT_DOWNMIX,
        input_gain: float = DEFAULT_INPUT_GAIN,
        flatline_window_s: float = DEFAULT_FLATLINE_WINDOW_S,
        flatline_dbfs: float = DEFAULT_FLATLINE_DBFS,
        rms_window_frames: int = DEFAULT_RMS_WINDOW_FRAMES,
        activity_reporter: Optional[ActivityReporter] = None,
        dsp_restart: Optional[Callable[[], Any]] = None,
        dsp_recovery_max_attempts: int = DEFAULT_DSP_RECOVERY_MAX_ATTEMPTS,
        dsp_recovery_cooldown_s: float = DEFAULT_DSP_RECOVERY_COOLDOWN_S,
    ):
        self._detector = detector
        self._input_device_index = input_device_index
        self._threshold = threshold
        self._debounce_s = debounce_s
        self._visual_decay_s = visual_decay_s
        self._on_wake = on_wake or self._default_on_wake
        self._stt = stt  # None disables STT entirely (commit 4 behaviour)
        self._on_transcript = on_transcript or self._default_on_transcript
        self._stt_max_record_s = stt_max_record_s
        # TTS — commit 6 wires it up, commit 7 calls speak() from the
        # LLM-reply path; speak() is also still reachable via POST /voice/say.
        self._tts = tts
        self._output_device_index = output_device_index
        # LLM — commit 7. None disables the closed-loop behaviour;
        # transcript still lands in /voice/status but isn't spoken.
        self._llm = llm
        # How often the background probe thread re-checks STT/TTS/LLM
        # reachability. Without this, an upstream that came up AFTER
        # voice-io (common at boot when whisper / piper / ai-
        # gateway take longer to bind) stays stuck at 'unavailable'
        # forever — the user sees /voice/status.stt_loaded=false and
        # the closed loop never fires even though everything works.
        self._upstream_probe_interval_s = upstream_probe_interval_s
        # Cooldown window after a speak() finishes; suppresses wake fires
        # to absorb TTS bleed-back + user "ok thanks" follow-up talk.
        self._post_speak_cooldown_s = post_speak_cooldown_s
        self._speak_ended_at: Optional[float] = None
        # End-of-speech (VAD) config + per-utterance state (reset each turn
        # in _begin_transcription).
        self._vad_silence_s = vad_silence_s
        self._vad_speech_rms = vad_speech_rms
        self._vad_min_speech_s = vad_min_speech_s
        self._frame_s = WAKE_FRAME_SAMPLES / float(WAKE_SAMPLE_RATE)
        self._stt_speech_started = False
        self._stt_silence_s = 0.0
        self._stt_speech_s = 0.0
        self._sd_module = sd_module  # dependency injection for tests
        # Device self-heal hooks (fix/voice-wake-loop-resilience).
        # `resolve_input_device` recomputes the input index after a mic
        # re-enumeration — main.py wires it to the same resolve_devices()
        # path used at startup so the scoring logic in voice/devices.py
        # stays the single source of truth (we never re-rank here). None
        # means "no re-resolution available" → reuse the existing index.
        self._resolve_input_device = resolve_input_device
        self._recover_backoff_initial_s = max(0.0, recover_backoff_initial_s)
        self._recover_backoff_max_s = max(
            self._recover_backoff_initial_s, recover_backoff_max_s,
        )
        # Device-failure log de-dup latch (see _note_recover_failure).
        # Touched only from the capture worker thread.
        self._recover_last_reason: Optional[str] = None
        self._recover_repeat_count = 0
        # Hook to refresh PortAudio's cached device list before
        # re-resolving. Defaults to sd._terminate()+sd._initialize();
        # injectable for tests / alternate bindings.
        self._sd_reinit = sd_reinit or self._default_sd_reinit
        # Multichannel→mono strategy + digital input gain (see the
        # DEFAULT_INPUT_DOWNMIX / DEFAULT_INPUT_GAIN docstrings).
        self._input_downmix = (
            input_downmix if input_downmix in ("first", "mean")
            else DEFAULT_INPUT_DOWNMIX
        )
        self._input_gain = input_gain if input_gain > 0 else DEFAULT_INPUT_GAIN
        # Input-level tracking + flatline watchdog (WARP-1037). See the
        # DEFAULT_FLATLINE_* docstrings. The rolling window holds
        # (sum-of-squares, sample-count) per frame; running totals keep
        # the per-frame cost at scalar arithmetic. The pipeline thread
        # is the sole writer; the published fields are updated under
        # _lock so status() reads stay coherent.
        self._flatline_window_s = max(0.0, flatline_window_s)
        self._flatline_dbfs = flatline_dbfs
        self._rms_window_frames = max(1, int(rms_window_frames))
        self._rms_window: deque[tuple[float, int]] = deque()
        self._rms_sumsq_total = 0.0
        self._rms_samples_total = 0
        self._input_rms_dbfs: Optional[float] = None
        self._last_audio_at: Optional[float] = None
        # Baseline for "no real audio seen SINCE …" — set when a capture
        # session opens (and lazily on the first tracked frame) so the
        # flatline clock never compares against timestamps from before a
        # device recovery.
        self._audio_watch_started_at: Optional[float] = None
        # Windowed-measurement collector (WARP-1410). None = not
        # collecting; otherwise a list the pipeline thread appends
        # (sumsq, samples, peak) to for every captured frame. This is how
        # the calibration wizard measures WITHOUT opening a second
        # PortAudio stream on a device the wake loop already holds
        # exclusively (the -9985 that used to dead-end the wizard).
        self._measure_collector: Optional[list[tuple[float, int, float]]] = None

        self._thread: Optional[threading.Thread] = None
        self._probe_thread: Optional[threading.Thread] = None
        self._shutdown = threading.Event()
        self._lock = threading.Lock()
        # Speak-path mutex — held across synthesize() + _play_pcm() so a
        # concurrent POST /voice/say and a wake → LLM → speak callback
        # can't both drive sounddevice's global stream state at once.
        # Acquired non-blocking: second caller gets `already_speaking`
        # rather than queueing (LLM replies are short enough that queue
        # logic isn't worth the complexity). See review on PR #227.
        self._speak_lock = threading.Lock()

        # Status snapshot — guarded by _lock for atomic /voice/status reads.
        self._state: PipelineState = "idle"
        self._last_wake_at: Optional[float] = None
        self._last_wake_score: Optional[float] = None
        self._last_wake_model: Optional[str] = None
        self._last_transcript: Optional[str] = None
        self._last_transcript_at: Optional[float] = None
        self._last_response: Optional[str] = None
        self._last_response_at: Optional[float] = None
        self._error_message: Optional[str] = None
        self._last_fire_at: float = 0.0  # debounce tracking
        # WARP-1058 — activity-feed event emission. `report()` is
        # non-blocking (bounded queue + background POST worker), so
        # calling it from the frame handler is safe. None disables all
        # emission (tests, __mock__ deployments).
        self._activity_reporter = activity_reporter
        self._last_miss_emit_at: float = 0.0  # missed-wake debounce
        self._flatline_reported: bool = False  # dsp_wedge edge detector
        # DSP auto-recovery (WARP-1409). `_dsp_restart` is the injected
        # heal (main wires voice.dsp.restart_dsp behind the /voice/
        # restart-processor lock; None disables auto-recovery — most unit
        # tests, and any deploy without the xvf_host tool). The lifecycle
        # is an EXPLICIT state machine, never derived from absence:
        #   nominal → restarting → (nominal on recovery | escalated)
        # driven from the probe tick. Bounded attempts + an in-process
        # cooldown keep it from storming reboots or racing the host
        # watchdog's own overrun-keyed xvf_host REBOOT.
        self._dsp_restart = dsp_restart
        self._dsp_recovery_max_attempts = max(1, int(dsp_recovery_max_attempts))
        self._dsp_recovery_cooldown_s = max(0.0, dsp_recovery_cooldown_s)
        self._dsp_recovery: str = "nominal"  # nominal | restarting | escalated
        self._dsp_restart_attempts: int = 0
        self._dsp_last_restart_at: Optional[float] = None
        # Calibration mode (WARP-1059) — wall-clock expiry of the
        # wizard's suppression window; None = off. Deliberately
        # in-memory only: a restart must never come back deaf.
        self._calibration_mode_until: Optional[float] = None

        # STT capture session — only set while state=='transcribing'.
        # The pipeline thread is the sole writer; reads from status()
        # happen under _lock so the field is coherent across threads.
        self._stt_session = None  # type: ignore[var-annotated]
        self._transcribe_started_at: float = 0.0

        # Whether the STT server is reachable. Probed lazily on first
        # use (start()), cached for the process lifetime. Surfaced via
        # status().stt_loaded and /health's sttLoaded.
        self._stt_available: bool = False
        # Same idea for TTS — probed at start(), surfaced via tts_loaded.
        self._tts_available: bool = False
        # And LLM — probed at start(), surfaced via llm_loaded.
        self._llm_available: bool = False

    # ──────────────────────────────────────────────────────────────
    # Lifecycle
    # ──────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Spawn the supervising worker. Idempotent.

        WARP-1092: we no longer bail when ``input_device_index`` is None. A
        boot/reflash race can start voice-io before the ReSpeaker XVF3800's
        ALSA nodes settle, so ``resolve_devices()`` finds no mic and we're
        constructed with a None index. The old early-return parked us in
        ``no_mic`` FOREVER — the self-heal machinery (re-resolve + reopen)
        lives inside ``_loop``, which never ran, so a mic that appeared a
        few seconds later was never picked up until a container restart.

        Now we always spawn ``_loop``: with no input device it raises
        ``_DeviceError("no input device resolved")`` on the first session,
        parks in ``no_mic``, and keeps re-resolving (capped backoff) until a
        mic appears — then opens it. "No mic at boot" is just the disconnect
        case with a zero-length connected prefix, which the supervising loop
        already handles (``_run_capture_session`` guards a None index).
        """
        if self._thread is not None and self._thread.is_alive():
            return
        # Probe STT + TTS + LLM reachability synchronously now so the
        # first /voice/status read after start() has accurate flags. A
        # failed probe doesn't block the worker — we still want the
        # wake loop running so the operator can see detections in
        # /voice/status while diagnosing.
        self._probe_upstreams(initial=True)
        self._shutdown.clear()
        self._set_state("loading")
        self._thread = threading.Thread(
            target=self._loop, name="wake-pipeline", daemon=True,
        )
        self._thread.start()
        # Background re-probe so an upstream that comes up AFTER us
        # (whisper / piper / ai-gateway slow to bind on boot) is
        # noticed within `upstream_probe_interval_s`. Without this,
        # `_*_available` stays False forever after a cold-boot race.
        # Daemon thread — process exit doesn't wait on it.
        if self._upstream_probe_interval_s > 0:
            self._probe_thread = threading.Thread(
                target=self._probe_loop,
                name="upstream-probe",
                daemon=True,
            )
            self._probe_thread.start()

    def stop(self, timeout: float = 5.0) -> bool:
        """Signal shutdown and join the threads. Idempotent.

        Returns True when every thread this pipeline owns has actually
        exited. False means one is STILL RUNNING — and when that one is
        the capture worker, the exclusive mic InputStream is still open:
        the loop below only re-checks ``_shutdown`` BETWEEN frames, and
        ``_on_frame`` runs the whole turn (LLM reply → TTS synthesize →
        ``_play_pcm``, blocking) inline on that same thread. A stop()
        issued mid-turn therefore routinely outlives its join budget.

        WARP-1619: ``_thread`` used to be cleared unconditionally, which
        threw away the only evidence that the worker outlived the join —
        so every caller that treats stop() as "the device is free now"
        was guessing. It is now cleared only when the thread is gone,
        and ``running`` reports the difference.
        """
        self._shutdown.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=timeout)
        pt = self._probe_thread
        if pt is not None and pt.is_alive():
            pt.join(timeout=timeout)
        # Forget only a thread that is genuinely gone. A live one still
        # holds something the next caller must not race.
        joined = True
        if t is not None and t.is_alive():
            joined = False
        else:
            self._thread = None
        if pt is not None and pt.is_alive():
            joined = False
        else:
            self._probe_thread = None
        self._set_state("idle")
        return joined

    @property
    def running(self) -> bool:
        """True while the capture worker is alive — i.e. while this
        pipeline still owns the exclusive mic device. Stays True after a
        stop() whose join timed out, which is the whole point: nothing
        else may open that device until this reads False."""
        t = self._thread
        return t is not None and t.is_alive()

    # ──────────────────────────────────────────────────────────────
    # Upstream probes (STT/TTS/LLM) — periodic re-check
    # ──────────────────────────────────────────────────────────────

    def _probe_upstreams(self, initial: bool = False) -> None:
        """Re-check whether STT, TTS, LLM are reachable + update the
        cached `_*_available` flags. Called once synchronously by
        start(), then periodically by `_probe_loop` so the user-visible
        /voice/status converges to truth after a boot race.

        On `initial=True` we log warnings for any upstream that's down
        (matches pre-fix behaviour). On subsequent re-probes we only
        log on state TRANSITIONS (down→up, up→down) so a chronically
        unavailable upstream doesn't spam the log every interval.
        """
        for label, client_attr, flag_attr, hint in (
            ("STT", "_stt", "_stt_available",
             "wake detection stays on but no transcripts will be produced"),
            ("TTS", "_tts", "_tts_available",
             "synthesis disabled until reachable"),
            ("LLM", "_llm", "_llm_available",
             "transcripts land in /voice/status but nothing gets spoken back"),
        ):
            client = getattr(self, client_attr)
            if client is None:
                continue
            try:
                now_ok = bool(client.available)
            except Exception as exc:  # pragma: no cover — defensive
                logger.warning("%s probe raised %r — treating as down", label, exc)
                now_ok = False
            prev_ok = getattr(self, flag_attr)
            if now_ok != prev_ok:
                if now_ok:
                    logger.info(
                        "%s server reachable — %s", label,
                        "ready" if not initial else "up at startup",
                    )
                else:
                    logger.warning(
                        "%s server unreachable — %s", label, hint,
                    )
            elif initial and not now_ok:
                # Match pre-fix: log on every cold-boot fail so the
                # operator sees the situation in the boot logs.
                logger.warning(
                    "%s server unreachable at startup — %s", label, hint,
                )
            setattr(self, flag_attr, now_ok)

    def _probe_loop(self) -> None:
        """Background thread: re-probe upstreams every
        `upstream_probe_interval_s`. Exits when shutdown is set.

        Also the flatline edge-detector's clock (WARP-1058): the
        `input_flatlined` flag is computed on status() reads, so this is
        the one place inside voice-io that periodically observes it and
        can emit the dsp_wedge / dsp_recovered transition events.
        """
        while not self._shutdown.wait(self._upstream_probe_interval_s):
            try:
                self._probe_upstreams()
            except Exception:  # pragma: no cover
                logger.exception("upstream probe loop iteration crashed")
            try:
                self._check_flatline_transition()
            except Exception:  # pragma: no cover
                logger.exception("flatline transition check crashed")
            try:
                self._maybe_auto_recover_dsp()
            except Exception:  # pragma: no cover
                logger.exception("dsp auto-recovery tick crashed")

    # ──────────────────────────────────────────────────────────────
    # Activity-feed emission (WARP-1058)
    # ──────────────────────────────────────────────────────────────

    def _emit_activity(
        self,
        type_: str,
        *,
        score: Optional[float] = None,
        threshold: Optional[float] = None,
        model: Optional[str] = None,
    ) -> None:
        """Best-effort event emission. Never raises and never blocks —
        a broken reporter must not take down the wake loop."""
        reporter = self._activity_reporter
        if reporter is None:
            return
        try:
            reporter.report(
                type_,
                at=time.time(),
                score=score,
                threshold=threshold,
                model=model,
            )
        except Exception:  # pragma: no cover — defensive
            logger.exception("activity reporter raised (event dropped)")

    def _check_flatline_transition(self) -> None:
        """Emit dsp_wedge / dsp_recovered on `input_flatlined` edges.

        The flag itself is stateless (computed on every status() read);
        this keeps a one-bit memory of the last observed value so each
        wedge produces exactly ONE err row when it starts and one quiet
        recovery row when audio flows again — §6.3 self-heal
        transparency, not a row per probe tick.
        """
        flatlined = self.status().input_flatlined
        if flatlined and not self._flatline_reported:
            self._flatline_reported = True
            self._emit_activity("dsp_wedge")
        elif not flatlined and self._flatline_reported:
            self._flatline_reported = False
            self._emit_activity("dsp_recovered")

    def _compute_mic_fault(
        self, state: PipelineState, input_flatlined: bool,
    ) -> Optional[str]:
        """Explicit mic-fault projection (WARP-1409) for /health + the
        dashboard. Read the recovery state machine + the live signals;
        never guess from absence. Caller holds `_lock`."""
        if state == "no_mic":
            return "no_mic"
        if state == "error":
            return "error"
        if self._dsp_recovery == "escalated":
            return "wedged_escalated"
        if input_flatlined:
            return (
                "wedged_restarting"
                if self._dsp_recovery == "restarting"
                else "flatlined"
            )
        return None

    def _maybe_auto_recover_dsp(self) -> None:
        """Bounded auto-recovery for a wedged XVF3800 DSP (WARP-1409).

        The device self-heal (WARP-786) cannot clear a wedge on its own: a
        wedged DSP keeps the USB stream open flowing digital zeros, so the
        supervisor's ``stream.read()`` never errors and never reopens. The
        only fix is an out-of-band ``xvf_host REBOOT 1`` (the same heal the
        dashboard button and the host watchdog issue), after which the DSP
        drops off USB → the read finally errors → the self-heal reopens.

        Ticked from the probe loop: while ``input_flatlined`` holds, issue
        that reboot via the injected ``_dsp_restart``, bounded to
        ``_dsp_recovery_max_attempts`` with a ``_dsp_recovery_cooldown_s``
        gap between attempts (so a reboot has time to re-enumerate and be
        re-verified, and it never storms or races the host watchdog). After
        the cap it latches ``escalated`` (surfaced as mic_fault =
        wedged_escalated) and stops — a human power cycle is then needed.
        When audio flows again the machine resets to nominal.

        A heal that raises ``DspRestartSkipped`` issued no reboot at all,
        so the tick costs nothing: the attempt counter and the cooldown
        clock are handed back and the next tick retries. Only a restart
        that actually ran — including one that ran and *failed* — spends
        part of the bounded budget.

        No-op when ``_dsp_restart`` is None (feature disabled).
        """
        if self._dsp_restart is None:
            return
        flatlined = self.status().input_flatlined
        now = time.time()
        with self._lock:
            if not flatlined:
                # Recovered (or never wedged): reset on the edge to healthy.
                if self._dsp_recovery != "nominal" or self._dsp_restart_attempts:
                    logger.info(
                        "voice DSP recovered after %d auto-restart attempt(s)",
                        self._dsp_restart_attempts,
                    )
                    self._dsp_recovery = "nominal"
                    self._dsp_restart_attempts = 0
                    self._dsp_last_restart_at = None
                return
            # Wedged.
            if self._dsp_recovery == "escalated":
                return  # gave up; mic_fault=wedged_escalated is surfaced
            if (
                self._dsp_last_restart_at is not None
                and now - self._dsp_last_restart_at < self._dsp_recovery_cooldown_s
            ):
                return  # a restart is in flight — wait for the re-verify tick
            if self._dsp_restart_attempts >= self._dsp_recovery_max_attempts:
                self._dsp_recovery = "escalated"
                logger.error(
                    "voice DSP still wedged after %d auto-restart attempts — "
                    "escalating (a power cycle of the Droplet is needed)",
                    self._dsp_restart_attempts,
                )
                return
            attempt = self._dsp_restart_attempts + 1
            # Remember the prior bookkeeping so a heal that turns out to
            # have issued nothing can hand the attempt back untouched.
            prev_attempts = self._dsp_restart_attempts
            prev_last_restart_at = self._dsp_last_restart_at
            prev_recovery = self._dsp_recovery
            # Claim the attempt BEFORE dropping the lock so a concurrent
            # tick can't double-issue, and so status() reads
            # wedged_restarting for the ~seconds the reboot takes.
            self._dsp_restart_attempts = attempt
            self._dsp_last_restart_at = now
            self._dsp_recovery = "restarting"
        # Issue the reboot OUTSIDE the lock (subprocess, ~seconds). Best
        # effort: a failed heal still counts as an attempt and retries after
        # the cooldown, then escalates.
        logger.warning(
            "voice DSP wedged (input flatlined) — issuing auto DSP restart "
            "(attempt %d/%d)", attempt, self._dsp_recovery_max_attempts,
        )
        try:
            self._dsp_restart()
        except DspRestartSkipped as exc:
            # The heal declined — no `xvf_host REBOOT 1` reached the chip
            # (an operator restart holds the DSP lock). Release the claim:
            # a skipped tick must spend none of the bounded budget and arm
            # no cooldown, or an operator holding that lock across a few
            # probe ticks could latch `escalated` with zero real reboots
            # behind it. Compare-and-swap so we only undo OUR claim — a
            # recovery edge on another thread wins.
            with self._lock:
                if (
                    self._dsp_restart_attempts == attempt
                    and self._dsp_last_restart_at == now
                    and self._dsp_recovery == "restarting"
                ):
                    self._dsp_restart_attempts = prev_attempts
                    self._dsp_last_restart_at = prev_last_restart_at
                    self._dsp_recovery = prev_recovery
            logger.info(
                "auto DSP restart skipped (%s) — no attempt spent, retrying "
                "on the next probe tick", exc,
            )
        except Exception as exc:
            logger.warning("auto DSP restart attempt %d failed: %s", attempt, exc)

    # ──────────────────────────────────────────────────────────────
    # Speak — synthesize text + play through the speaker
    # ──────────────────────────────────────────────────────────────

    def speak(self, text: str, voice: Optional[str] = None) -> dict[str, Any]:
        """Synthesize `text` to PCM and play it through the output device.

        Returns a dict with the result for the API caller:
          ok          — bool
          duration_s  — float, playback length (0 if synthesize returned empty)
          sample_rate — server-determined
          error       — present iff ok=False

        Blocks until playback finishes. Called from the FastAPI request
        thread (POST /voice/say) and, in commit 7, from the LLM-reply
        callback. Either way, while we're speaking we don't run wake
        detection — that's anti-feedback by design (Piper's voice
        otherwise wakes the wake-word detector).
        """
        if self._tts is None or not self._tts_available:
            return {"ok": False, "error": "TTS unavailable", "duration_s": 0.0}
        if not text or not text.strip():
            return {"ok": False, "error": "empty text", "duration_s": 0.0}

        # Serialize against concurrent speak() callers. If another speak
        # is already in flight (POST /voice/say while wake → LLM → speak
        # is mid-playback, or vice versa), bail out instead of stepping
        # on sounddevice's global stream state. Non-blocking acquire so
        # we never queue up requests we'd play out of order.
        if not self._speak_lock.acquire(blocking=False):
            return {"ok": False, "error": "already_speaking", "duration_s": 0.0}

        try:
            # Record state + transition. The wake loop sees 'speaking' on
            # its next frame and skips wake detection (handler is a no-op
            # for that state).
            with self._lock:
                prev_state = self._state
                self._state = "speaking"
                self._last_response = text
                self._last_response_at = time.time()

            try:
                audio = self._tts.synthesize(text, voice=voice)
            except TTSUnavailable as exc:
                self._set_error(f"TTS synthesize failed: {exc}")
                return {"ok": False, "error": str(exc), "duration_s": 0.0}

            # Play. Skip if the synthesized audio is empty (e.g. empty text).
            if not audio.pcm:
                self._restore_state_after_speak(prev_state)
                return {"ok": True, "duration_s": 0.0, "sample_rate": audio.sample_rate}

            try:
                self._play_pcm(audio)
            except Exception as exc:
                self._set_error(f"playback failed: {exc}")
                # Mid-playback failure still drove the speaker for some of
                # the reply, so the same anti-feedback window applies: the
                # partial Piper output can bleed into the mic and score
                # above threshold. Arm the post-speak cooldown here too —
                # _restore_state_after_speak (which normally sets it) does
                # NOT run on this path because _set_error moved us out of
                # 'speaking' into 'error'.
                with self._lock:
                    self._speak_ended_at = time.time()
                return {"ok": False, "error": str(exc), "duration_s": audio.duration_s}

            self._restore_state_after_speak(prev_state)
            return {
                "ok": True,
                "duration_s": audio.duration_s,
                "sample_rate": audio.sample_rate,
            }
        finally:
            self._speak_lock.release()

    def _play_pcm(self, audio: SynthesizedAudio) -> None:
        """Hand the PCM to sounddevice. Blocking."""
        # sounddevice wants a numpy array. We get int16 mono from Piper —
        # the playback driver in audio_io.play handles dtype + rate.
        import numpy as _np
        from voice.audio_io import play as _play
        pcm = _np.frombuffer(audio.pcm, dtype=_np.int16)
        if audio.channels > 1:
            pcm = pcm.reshape(-1, audio.channels)
        _play(pcm, samplerate=audio.sample_rate, device=self._output_device_index)

    def _restore_state_after_speak(self, prev_state: PipelineState) -> None:
        """Return to whatever state we were in before speak() was called.

        If we were called mid-flow from the LLM reply path (commit 7),
        prev_state will be transcript_ready and we'll fall back into
        that until visual-decay. For a manual POST /voice/say, prev_state
        is usually 'listening' and we go straight back.

        Also marks `_speak_ended_at` so the post-speak cooldown takes
        effect immediately — the next few hundred ms of mic audio is
        the worst window for TTS bleed-back into the capture stream.
        """
        with self._lock:
            # If something else flipped us to error during playback,
            # don't clobber that with the previous state.
            if self._state == "speaking":
                self._state = (
                    prev_state if prev_state in ("listening", "transcript_ready")
                    else "listening"
                )
            self._speak_ended_at = time.time()

    # ──────────────────────────────────────────────────────────────
    # Streaming speak — synthesize + play sentence chunks as ONE utterance
    # (WARP-626)
    # ──────────────────────────────────────────────────────────────

    def _speak_chunks(
        self, chunks: Iterable[str], voice: Optional[str] = None,
    ) -> dict[str, Any]:
        """Synthesize + play a STREAM of sentence chunks as ONE utterance.

        The multi-sentence sibling of speak(). Everything the shared
        reSpeaker mic/speaker needs is held ONCE for the whole utterance,
        never per-sentence:

          * ONE non-blocking `_speak_lock` acquire — a concurrent
            POST /voice/say (or a second wake→speak) sees `already_speaking`,
            not a per-sentence race.
          * State goes to 'speaking' on the first real sentence and stays
            there until the last; the pipeline thread is busy here so wake
            detection can't run, and status() reports 'speaking' throughout.
          * `_speak_ended_at` is stamped ONCE at the true end, so the 2 s
            post-speak cooldown fires once after the LAST sentence.

        Playback is SEQUENTIAL per sentence (synth 1 → play 1 → synth 2 →
        play 2 …): first-audio starts right after sentence 1 — the WARP-626
        win — at the cost of a minor inter-sentence synth gap. A
        producer/consumer overlap (synthesize N+1 while N plays) is a
        localized future swap of the play loop below; the load-bearing
        lock/state/cooldown guards live here, not per-sentence, so that
        swap stays safe.

        `chunks` is consumed lazily and MAY raise LLMUnavailable mid-stream
        (the SSE broke) — that's surfaced like a synth failure. Returns a
        result dict: ok / duration_s / spoke_any / error / error_kind.
        """
        if self._tts is None or not self._tts_available:
            return {
                "ok": False, "error": "TTS unavailable",
                "duration_s": 0.0, "spoke_any": False,
            }
        # ONE lock for the WHOLE utterance. Non-blocking so a second speaker
        # never queues audio to play out of order (same contract as speak()).
        if not self._speak_lock.acquire(blocking=False):
            return {
                "ok": False, "error": "already_speaking",
                "duration_s": 0.0, "spoke_any": False,
            }
        try:
            return self._run_speak_chunks(chunks, voice)
        finally:
            self._speak_lock.release()

    def _run_speak_chunks(
        self, chunks: Iterable[str], voice: Optional[str],
    ) -> dict[str, Any]:
        """Drive the sequential synth→play loop under the already-held
        `_speak_lock`. Caller (`_speak_chunks`) owns the lock lifecycle."""
        prev_state: Optional[PipelineState] = None  # None until first chunk
        spoke_any = False
        drove_speaker = False
        total_duration = 0.0
        spoken: list[str] = []
        first_error: Optional[BaseException] = None
        error_kind: Optional[str] = None
        # Iterate through a handle we can explicitly close: if we bail out
        # mid-utterance (TTS/playback failure), closing the chunk generator
        # propagates GeneratorExit into reply_stream, which tears down the
        # in-flight SSE — the orchestrator then sees the client disconnect
        # and ABORTS its agent loop (WARP-329) instead of finishing a reply
        # nobody will hear. On normal completion the generator is already
        # exhausted, so close() is a no-op.
        chunk_iter = iter(chunks)
        try:
            try:
                for chunk in chunk_iter:  # may raise LLMUnavailable (SSE broke)
                    text = chunk.strip() if chunk else ""
                    if not text:
                        continue
                    if self._shutdown.is_set():
                        break
                    # Enter 'speaking' on the FIRST real sentence; hold it for
                    # the rest of the utterance (don't restore between them).
                    if prev_state is None:
                        with self._lock:
                            prev_state = self._state
                            self._state = "speaking"
                    try:
                        audio = self._tts.synthesize(text, voice=voice)
                    except TTSUnavailable as exc:
                        first_error, error_kind = exc, "tts"
                        break
                    spoken.append(text)
                    with self._lock:
                        self._last_response = " ".join(spoken)
                        self._last_response_at = time.time()
                    if not audio.pcm:
                        continue
                    drove_speaker = True
                    try:
                        self._play_pcm(audio)
                    except Exception as exc:  # noqa: BLE001 — surfaced below
                        first_error, error_kind = exc, "playback"
                        break
                    spoke_any = True
                    total_duration += audio.duration_s
            except LLMUnavailable as exc:
                first_error, error_kind = exc, "llm"

            if first_error is None:
                # Success (possibly empty — nothing streamed). Restore state +
                # arm the single post-speak cooldown, only if we actually spoke.
                self._finish_utterance(prev_state, spoke=spoke_any)
                return {
                    "ok": True, "duration_s": total_duration, "spoke_any": spoke_any,
                }

            # Error path: surface it, and arm the cooldown if we drove the
            # speaker at all — even a partial reply can bleed into the shared
            # mic (same contract as speak()'s mid-playback failure).
            self._set_error(f"voice reply failed ({error_kind}): {first_error}")
            if drove_speaker:
                with self._lock:
                    self._speak_ended_at = time.time()
            return {
                "ok": False,
                "error": str(first_error),
                "error_kind": error_kind,
                "duration_s": total_duration,
                "spoke_any": spoke_any,
            }
        finally:
            close = getattr(chunk_iter, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:  # pragma: no cover — defensive teardown
                    logger.debug("chunk generator close raised", exc_info=True)

    def _finish_utterance(
        self, prev_state: Optional[PipelineState], *, spoke: bool,
    ) -> None:
        """Close out a successful utterance: restore the pre-speak state and
        stamp the SINGLE post-speak cooldown. No-op when nothing was spoken
        (prev_state is None → we never entered 'speaking', so there's no
        state to restore and no TTS bleed to guard against)."""
        if prev_state is None:
            return
        with self._lock:
            if self._state == "speaking":
                self._state = (
                    prev_state if prev_state in ("listening", "transcript_ready")
                    else "listening"
                )
            if spoke:
                self._speak_ended_at = time.time()

    def _speak_reply_stream(
        self, transcript: str, *, tool_choice: Optional[ToolChoice],
    ) -> dict[str, Any]:
        """Stream the LLM reply → sentence-chunk it → speak each chunk as a
        single utterance (WARP-626). The generator pulls SSE deltas lazily
        and feeds them through a SentenceChunker, so sentence 1 is
        synthesized + played while later sentences are still arriving. When
        the LLM delivers the whole reply in one delta (today's reality),
        the chunker still splits it into sentences so playback of sentence 1
        starts before the rest is synthesized."""
        def _chunks() -> Iterator[str]:
            chunker = SentenceChunker()
            stream = self._llm.reply_stream(transcript, tool_choice=tool_choice)
            try:
                for delta in stream:
                    for sentence in chunker.push(delta):
                        yield sentence
                for sentence in chunker.flush():
                    yield sentence
            finally:
                # Close the SSE explicitly (not via GC) so an early bail-out
                # tears the orchestrator stream down deterministically — see
                # the WARP-329 note in _run_speak_chunks.
                close = getattr(stream, "close", None)
                if callable(close):
                    close()

        return self._speak_chunks(_chunks())

    # ──────────────────────────────────────────────────────────────
    # Calibration live-apply (WARP-1055)
    # ──────────────────────────────────────────────────────────────

    def set_input_gain(self, gain: float) -> None:
        """Live-apply a calibrated digital input gain.

        Driven by POST /voice/calibration (the wizard's single write)
        and by main.apply_stored_calibration at startup, overriding the
        VOICE_INPUT_GAIN env default. Nonsense values are ignored — a
        bad record must never mute the mic (gain 0) or flip the signal
        (negative). The worker thread reads the float without the lock
        (atomic under the GIL, same as the construct-time value); the
        write takes the lock only to pair with status() reads.
        """
        try:
            g = float(gain)
        except (TypeError, ValueError):
            return
        if not math.isfinite(g) or g <= 0.0:
            logger.warning("set_input_gain(%r) ignored — not a usable gain", gain)
            return
        with self._lock:
            self._input_gain = g
        logger.info("input gain set to %.2f (calibration)", g)

    def set_wake_threshold(self, threshold: float) -> None:
        """Live-apply a calibrated wake threshold (0 < t ≤ 1).

        Same contract as set_input_gain: calibration overrides the
        env/engine default, garbage is ignored so a corrupt record
        can't set an impossible gate (0 fires on everything, >1 never
        fires under either engine's score semantics).
        """
        try:
            t = float(threshold)
        except (TypeError, ValueError):
            return
        if not math.isfinite(t) or not (0.0 < t <= 1.0):
            logger.warning(
                "set_wake_threshold(%r) ignored — outside (0, 1]", threshold,
            )
            return
        with self._lock:
            self._threshold = t
        logger.info("wake threshold set to %.2f (calibration)", t)

    # ──────────────────────────────────────────────────────────────
    # Calibration mode (WARP-1059)
    # ──────────────────────────────────────────────────────────────

    def enter_calibration_mode(
        self, ttl_s: float = DEFAULT_CALIBRATION_MODE_TTL_S,
    ) -> float:
        """Open (or renew) the wizard's suppression window: wake
        DETECTION keeps running and keeps recording last_wake_at/score/
        model, but detected wakes are NOT handled — no STT capture, no
        LLM call, no spoken reply (see _run_wake_detect).

        Fail-safe by construction: the mode is a wall-clock expiry
        computed on read — no timer thread, nothing persisted — so an
        abandoned wizard leaves the assistant deaf for at most `ttl_s`
        and a process restart clears it instantly. Nonsense TTLs fall
        back to the default rather than arming an unbounded window.
        Returns the expiry (epoch seconds) for the API response.
        """
        try:
            ttl = float(ttl_s)
        except (TypeError, ValueError):
            ttl = DEFAULT_CALIBRATION_MODE_TTL_S
        if not math.isfinite(ttl) or ttl <= 0:
            ttl = DEFAULT_CALIBRATION_MODE_TTL_S
        expires = time.time() + ttl
        with self._lock:
            self._calibration_mode_until = expires
        logger.info(
            "calibration mode entered (ttl %.0fs) — wake handling "
            "suppressed, detection still counting", ttl,
        )
        return expires

    def exit_calibration_mode(self) -> None:
        """Explicit exit (wizard closed). Idempotent — the TTL expiry
        is the fail-safe for every path that never calls this."""
        with self._lock:
            was_active = self._calibration_mode_until is not None
            self._calibration_mode_until = None
        if was_active:
            logger.info("calibration mode exited — wake handling restored")

    def _calibration_mode_active(self, now: float) -> bool:
        """Read the mode against a caller-supplied clock. Reading the
        float without the lock is safe (atomic under the GIL); callers
        that pair it with other status fields hold _lock anyway."""
        until = self._calibration_mode_until
        return until is not None and now < until

    # ──────────────────────────────────────────────────────────────
    # Windowed input measurement (WARP-1410)
    # ──────────────────────────────────────────────────────────────

    def _start_measure(self) -> None:
        """Arm the per-frame collector. Raises MeasurementUnavailable if
        the pipeline isn't capturing or a measurement is already running."""
        with self._lock:
            if self._measure_collector is not None:
                raise MeasurementUnavailable(
                    "A measurement is already in progress — try again in "
                    "a moment."
                )
            if self._state in ("error", "no_mic", "idle"):
                raise MeasurementUnavailable(
                    "The microphone isn't capturing right now "
                    f"(state={self._state}) — no live audio to measure."
                )
            self._measure_collector = []

    def _finish_measure(self) -> dict[str, float]:
        """Disarm the collector and reduce it to RMS + peak in dBFS."""
        with self._lock:
            collected = self._measure_collector
            self._measure_collector = None
        if not collected:
            raise MeasurementUnavailable(
                "No audio arrived during the measurement window — the "
                "microphone stopped delivering audio."
            )
        sumsq = math.fsum(c[0] for c in collected)
        samples = sum(c[1] for c in collected)
        peak = max(c[2] for c in collected)
        if samples <= 0:  # pragma: no cover — defensive
            raise MeasurementUnavailable(
                "No audio samples arrived during the measurement window."
            )
        rms = math.sqrt(max(0.0, sumsq) / samples)
        return {
            "rms_dbfs": (
                max(RMS_DBFS_FLOOR, 20.0 * math.log10(rms / _INT16_FULL_SCALE))
                if rms > 0.0
                else RMS_DBFS_FLOOR
            ),
            "peak_dbfs": (
                max(RMS_DBFS_FLOOR, 20.0 * math.log10(peak / _INT16_FULL_SCALE))
                if peak > 0.0
                else RMS_DBFS_FLOOR
            ),
        }

    def measure_input(self, duration_s: float) -> dict[str, float]:
        """Measure the live input over `duration_s`; return RMS + peak dBFS.

        Reads the wake loop's ALREADY-OPEN capture stream rather than
        opening a second one. The reSpeaker's hw device is exclusive, so
        the old `sounddevice.rec` path raised PortAudio -9985 ("Device
        unavailable") for the entire time the assistant was listening —
        i.e. always — which is what dead-ended the calibration wizard's
        "measure the room" step even on a perfectly healthy mic. Note that
        calibration mode (WARP-1059) suppresses wake HANDLING but keeps the
        stream open, so it never freed the device either.

        Values are RAW / pre-gain, the same domain contract as
        `input_rms_dbfs`, so the wizard's noise-floor compare needs no gain
        math. Blocks for the window (called from the API threadpool) and is
        interrupted by stop().
        """
        self._start_measure()
        try:
            self._shutdown.wait(max(0.0, float(duration_s)))
            return self._finish_measure()
        finally:
            # Idempotent teardown: _finish_measure normally clears it, but
            # an interrupted window must never leave the collector armed
            # (it would grow unbounded on the pipeline thread).
            with self._lock:
                self._measure_collector = None

    # ──────────────────────────────────────────────────────────────
    # Status — atomic snapshot
    # ──────────────────────────────────────────────────────────────

    def status(self) -> PipelineStatus:
        with self._lock:
            state = self._state
            now = time.time()
            # Auto-decay 'wake_detected' / 'transcript_ready' back to
            # 'listening' once the visual-pulse window passes. Cheap:
            # just compute on read.
            if (
                state == "wake_detected"
                and self._last_wake_at is not None
                and now - self._last_wake_at > self._visual_decay_s
            ):
                state = "listening"
            elif (
                state == "transcript_ready"
                and self._last_transcript_at is not None
                and now - self._last_transcript_at > self._visual_decay_s
            ):
                state = "listening"

            # Flatline (WARP-1037) — computed on read, no timer thread.
            # Only meaningful while 'listening': error/no_mic already
            # degrade /health on their own, and every other state is a
            # legitimately signal-free or transient window. The clock
            # runs from the later of (last real-audio frame, capture-
            # session start) so a freshly (re)opened stream gets a full
            # window before it can flag.
            input_flatlined = False
            if state == "listening" and self._flatline_window_s > 0:
                refs = [
                    t
                    for t in (self._last_audio_at, self._audio_watch_started_at)
                    if t is not None
                ]
                if refs and now - max(refs) >= self._flatline_window_s:
                    input_flatlined = True

            # Explicit mic-fault projection (WARP-1409) — sourced from the
            # recovery state machine + the live signals, never guessed.
            mic_fault = self._compute_mic_fault(state, input_flatlined)

            return PipelineStatus(
                state=state,
                # `listening` in the API means "actively consuming audio":
                # true for listening, wake_detected, transcribing, and
                # the transient transcript_ready state. False for
                # idle/loading/error/no_mic/speaking — while speaking, the
                # mic isn't actively waking (anti-feedback by design).
                listening=state in (
                    "listening", "wake_detected",
                    "transcribing", "transcript_ready",
                ),
                wake_loaded=self._detector.loaded,
                wake_model=self._detector.model_name,
                requested_wake_word=getattr(
                    self._detector, "requested_wake_word",
                    self._detector.model_name,
                ),
                using_wake_fallback=getattr(
                    self._detector, "using_fallback", False,
                ),
                threshold=self._threshold,
                last_wake_at=self._last_wake_at,
                last_wake_score=self._last_wake_score,
                last_wake_model=self._last_wake_model,
                error_message=self._error_message,
                stt_loaded=self._stt_available,
                last_transcript=self._last_transcript,
                last_transcript_at=self._last_transcript_at,
                tts_loaded=self._tts_available,
                last_response=self._last_response,
                last_response_at=self._last_response_at,
                llm_loaded=self._llm_available,
                input_rms_dbfs=self._input_rms_dbfs,
                last_audio_at=self._last_audio_at,
                input_flatlined=input_flatlined,
                mic_fault=mic_fault,
                dsp_restart_attempts=self._dsp_restart_attempts,
                dsp_last_restart_at=self._dsp_last_restart_at,
                calibration_mode=self._calibration_mode_active(now),
                calibration_mode_expires_at=(
                    self._calibration_mode_until
                    if self._calibration_mode_active(now)
                    else None
                ),
            )

    # ──────────────────────────────────────────────────────────────
    # Worker
    # ──────────────────────────────────────────────────────────────

    def _loop(self) -> None:
        sd = self._sd_module
        if sd is None:
            # Real import — only happens on the worker thread, not
            # at module import time.
            try:
                import sounddevice as _sd  # type: ignore[import-not-found]
                sd = _sd
            except Exception as exc:  # pragma: no cover — host without PortAudio
                self._set_error(f"sounddevice unavailable: {exc}")
                return

        # Supervising loop: one _run_capture_session() == one open-stream
        # lifetime. A recoverable audio-device error (mic re-enumerated,
        # card index shifted, PortAudio handle invalid) raises _DeviceError
        # out of the session; we flip to no_mic, refresh PortAudio's device
        # cache, re-resolve the input index, back off, and reopen — instead
        # of letting the worker thread die. Any OTHER exception is a genuine
        # bug (e.g. in the frame-handling path) and surfaces as 'error'.
        backoff = self._recover_backoff_initial_s
        while not self._shutdown.is_set():
            try:
                self._run_capture_session(sd)
                # Clean return == shutdown requested (or scripted EOF in
                # tests). Nothing to recover; leave the loop.
                return
            except _DeviceError as exc:
                if self._shutdown.is_set():
                    return
                self._note_recover_failure(exc)
                self._set_state("no_mic")
                # Refresh PortAudio's cached device list, then re-resolve
                # the (possibly shifted) input index BEFORE the next open.
                self._refresh_audio_enumeration(sd)
                self._reresolve_input_device()
                # Bounded, interruptible backoff so a genuinely-absent mic
                # doesn't hot-loop. Stays in no_mic while waiting; drops
                # out instantly if stop() fires mid-wait.
                if self._shutdown.wait(backoff):
                    return
                backoff = min(
                    self._recover_backoff_max_s,
                    backoff * 2 if backoff > 0 else self._recover_backoff_max_s,
                ) if self._recover_backoff_max_s > 0 else 0.0
                continue
            except Exception as exc:
                # Non-device error — a real logic bug. Surface loudly; do
                # NOT silently retry forever.
                self._set_error(f"wake loop crashed: {exc}")
                logger.exception("wake pipeline crashed")
                return

    def _run_capture_session(self, sd: Any) -> None:
        """Open the mic, set 'listening', and pump frames until shutdown.

        Recoverable PortAudio/OS device errors raised by the stream open
        or read are re-raised as `_DeviceError` for the supervising loop
        to recover from. Exceptions from `_on_frame` (the detector / STT /
        callback path) are deliberately NOT caught here — they propagate
        so a genuine logic bug surfaces as 'error' rather than being
        masked as a device flap.
        """
        # PortAudioError isn't defined on the injected fake sd used in
        # tests, so look it up defensively. OSError covers ALSA -EPIPE /
        # device-removed cases the binding raises directly.
        pa_error = getattr(sd, "PortAudioError", ())
        device_errors: tuple = (
            (pa_error, OSError) if pa_error else (OSError,)
        )

        # No resolved input device (re-resolution found the mic gone, or
        # it was never present). Treat as a recoverable device error so the
        # supervisor parks in no_mic + backoff and re-resolves next cycle —
        # never opens device=None.
        if self._input_device_index is None:
            raise _DeviceError("no input device resolved")

        # Capture at the device's NATIVE input-channel count. Many USB mic
        # arrays — notably the ReSpeaker XVF3800 — expose ONLY a 2-channel
        # capture interface (no mono altset) and hand back digital silence
        # when opened as mono on the raw hw device. We open the native count
        # (capped at 2) and downmix to a 1-D mono frame, which is what the
        # detector + STT both expect.
        # Best-effort channel-count probe — broad except on purpose: a
        # failure here just falls back to mono (1 ch), it is NOT the
        # device-disconnect trigger (the load-bearing open/read below is).
        in_channels = 1
        try:
            info = sd.query_devices(self._input_device_index)
            in_channels = max(1, min(2, int(info.get("max_input_channels") or 1)))
        except Exception:
            in_channels = 1

        # Capture at a rate the device actually accepts, then resample to
        # WAKE_SAMPLE_RATE below. See CAPTURE_RATE_CANDIDATES.
        open_rate = self._resolve_capture_rate(sd, in_channels)
        read_frames = WAKE_FRAME_SAMPLES * open_rate // WAKE_SAMPLE_RATE

        try:
            stream_cm = sd.InputStream(
                samplerate=open_rate,
                channels=in_channels,
                dtype="int16",
                device=self._input_device_index,
                blocksize=read_frames,
            )
        except device_errors as exc:
            raise _DeviceError(str(exc) or exc.__class__.__name__) from exc

        with stream_cm as stream:
            logger.info(
                "wake pipeline: listening on device %s (%d ch @ %d Hz%s), "
                "model=%s, threshold=%.2f",
                self._input_device_index,
                in_channels,
                open_rate,
                "" if open_rate == WAKE_SAMPLE_RATE
                else f" → {WAKE_SAMPLE_RATE} Hz",
                self._detector.model_name,
                self._threshold,
            )
            # A successful open clears the de-dup latch so a device that
            # recovers and then fails AGAIN logs at WARNING again rather
            # than being swallowed as a repeat.
            self._recover_last_reason = None
            # New capture session (fresh open or post-recovery reopen):
            # restart the flatline clock so stale pre-disconnect
            # timestamps can't instantly flag a recovered stream.
            with self._lock:
                self._audio_watch_started_at = time.time()
            self._set_state("listening")
            while not self._shutdown.is_set():
                # Tight device-I/O scope: ONLY the read is wrapped, so a
                # re-enumeration mid-stream becomes a recoverable
                # _DeviceError. _on_frame() runs outside this scope.
                try:
                    frames, overflowed = stream.read(read_frames)
                except device_errors as exc:
                    raise _DeviceError(str(exc) or exc.__class__.__name__) from exc
                if overflowed:
                    # Capture buffer outran our predict() pace. Common
                    # on first run while ONNX kernels JIT; logs once
                    # to avoid spam.
                    logger.debug("wake pipeline: input buffer overflow")
                # frames is shape (1280, in_channels) int16. Reduce to a
                # mono 1-D frame for the detector + STT: channel 0 by
                # default (the primary/processed channel on mic arrays —
                # see DEFAULT_INPUT_DOWNMIX), mean across channels when
                # configured; a 1-channel device just flattens.
                if frames.ndim > 1 and frames.shape[1] > 1:
                    if self._input_downmix == "mean":
                        mono = frames.mean(axis=1).astype("int16")
                    else:
                        mono = np.ascontiguousarray(frames[:, 0])
                else:
                    mono = frames.reshape(-1)
                # Downmix FIRST, then resample: one channel through the
                # polyphase filter instead of two, for identical output.
                if open_rate != WAKE_SAMPLE_RATE:
                    mono = resample_int16(mono, open_rate, WAKE_SAMPLE_RATE)
                # The RAW mono frame goes to _on_frame; the digital input
                # gain is applied THERE, after level tracking, so
                # input_rms_dbfs stays in the same pre-gain domain as
                # /audio/measure and the stored calibration floor
                # (WARP-1055 — a gained RMS compared against a raw floor
                # read as permanent noise drift on the dashboard).
                self._on_frame(mono)

    # How many consecutive IDENTICAL device failures pass before the
    # supervisor restates the reason. At the 5 s backoff cap that is about
    # one line an hour instead of ~690.
    _RECOVER_RESTATE_EVERY = 720

    def _resolve_capture_rate(self, sd: Any, in_channels: int) -> int:
        """Pick a capture rate this device actually accepts.

        Returns the first entry in CAPTURE_RATE_CANDIDATES that
        `check_input_settings` accepts for this device + channel count.
        WAKE_SAMPLE_RATE is first, so a 16 kHz-capable mic is opened
        exactly as before and never resampled.

        When the binding exposes no `check_input_settings` — the fake
        `sd` the tests inject — this returns WAKE_SAMPLE_RATE, preserving
        the pre-negotiation behaviour for those callers rather than
        inventing a probe the fake cannot answer.

        Raises `_DeviceError` when the device accepts nothing, which the
        supervisor treats as recoverable: it parks in no_mic and retries,
        and a re-plugged device may well accept one next time.
        """
        rate = negotiate_capture_rate(
            self._input_device_index,
            WAKE_SAMPLE_RATE,
            in_channels,
            sd=sd,
            candidates=CAPTURE_RATE_CANDIDATES,
        )
        if rate is None:
            raise _DeviceError(
                f"device {self._input_device_index} accepted none of "
                f"{CAPTURE_RATE_CANDIDATES} at {in_channels} ch",
            )
        return rate

    def _note_recover_failure(self, exc: Exception) -> None:
        """Log a failed recovery attempt without flooding the log.

        The retry CADENCE is deliberately untouched — a hot-plugged
        ReSpeaker must still be picked up within the backoff cap. Only the
        LOGGING is de-duplicated: a changed reason logs at WARNING, an
        unchanged one is restated every `_RECOVER_RESTATE_EVERY` attempts.

        A box with no usable mic was emitting ~690 identical WARNING lines
        an hour. That rotated the container's 10 MB json-file log about
        once a day, so the spam was destroying the diagnostic history of
        every other event in it (WARP-2213).
        """
        reason = str(exc) or exc.__class__.__name__
        if reason != self._recover_last_reason:
            self._recover_last_reason = reason
            self._recover_repeat_count = 0
            logger.warning(
                "wake pipeline: recoverable audio-device error (%s) — "
                "re-resolving + reopening", reason,
            )
            return
        self._recover_repeat_count += 1
        if self._recover_repeat_count % self._RECOVER_RESTATE_EVERY == 0:
            logger.info(
                "wake pipeline: same audio-device error unresolved after "
                "%d attempts (%s)",
                self._recover_repeat_count, reason,
            )

    def _refresh_audio_enumeration(self, sd: Any) -> None:
        """Drop PortAudio's cached device list so a re-enumerated mic
        becomes visible to the next resolve/open. PortAudio snapshots the
        host's devices at first query; without a terminate+initialize the
        re-plugged reSpeaker never reappears. Defensive: a binding without
        the private hooks (or one that raises) must not crash the loop."""
        try:
            self._sd_reinit(sd)
        except Exception:
            logger.exception(
                "wake pipeline: PortAudio re-init failed (continuing)",
            )

    @staticmethod
    def _default_sd_reinit(sd: Any) -> None:
        terminate = getattr(sd, "_terminate", None)
        initialize = getattr(sd, "_initialize", None)
        if callable(terminate):
            terminate()
        if callable(initialize):
            initialize()

    def _reresolve_input_device(self) -> None:
        """Recompute the input device index after a re-enumeration, using
        the injected resolver (main.py wires it to resolve_devices() so the
        scoring in voice/devices.py stays authoritative). On any failure,
        or when no resolver is wired, keep the current index and let the
        next open attempt decide — we never fall through to opening
        device=None."""
        resolver = self._resolve_input_device
        if resolver is None:
            return
        try:
            new_index = resolver()
        except Exception:
            logger.exception(
                "wake pipeline: input re-resolution raised (keeping index %s)",
                self._input_device_index,
            )
            return
        if new_index is None:
            logger.info(
                "wake pipeline: re-resolution found no input device — "
                "staying in no_mic",
            )
            # Drop the stale index so the supervisor doesn't reopen a
            # device that's gone; it keeps retrying re-resolution while
            # parked in no_mic until a real index comes back.
            self._input_device_index = None
            return
        if new_index != self._input_device_index:
            logger.info(
                "wake pipeline: input device index shifted %s → %s after "
                "re-enumeration", self._input_device_index, new_index,
            )
        self._input_device_index = new_index

    def _track_input_level(self, frame: np.ndarray) -> None:
        """Rolling input-level tracking (WARP-1037). Runs on the pipeline
        thread for EVERY captured frame, in every state — so it must stay
        cheap. `np.einsum` reduces the int16 frame to a float64
        sum-of-squares without materialising an intermediate array; the
        rest is scalar math + one uncontended lock acquire at 12.5 fps.

        Publishes `input_rms_dbfs` (rolling RMS over the last
        `rms_window_frames` frames) and refreshes `last_audio_at` whenever
        a frame's own level clears the flatline threshold. status() turns
        those into the read-time `input_flatlined` flag.

        Domain contract (WARP-1055): the frame here is the RAW capture,
        BEFORE the digital input gain — the same domain as
        /audio/measure and the persisted calibration floor, so the
        dashboard can compare the live RMS against the calibrated floor
        without gain math. Flatline semantics are unaffected: a wedged
        DSP emits digital zeros, which are zeros in any gain domain.
        """
        n = int(frame.size)
        if n == 0:
            return
        # Sum of squares in float64 (int16² overflows int16/int32 sums).
        sumsq = float(np.einsum("i,i->", frame, frame, dtype=np.float64))
        frame_rms = math.sqrt(sumsq / n)
        # WARP-1410 — feed an in-flight windowed measurement from this same
        # already-open stream (never a second one). `list.append` is atomic
        # under the GIL, so the pipeline thread needs no lock here; the
        # collector is swapped in/out under _lock by _start/_finish_measure.
        # Peak costs an extra pass, so it's only computed while collecting.
        # Widen to int32 first: abs(-32768) overflows int16.
        collector = self._measure_collector
        if collector is not None:
            collector.append(
                (sumsq, n, float(np.abs(frame.astype(np.int32)).max())),
            )
        frame_dbfs = (
            max(RMS_DBFS_FLOOR, 20.0 * math.log10(frame_rms / _INT16_FULL_SCALE))
            if frame_rms > 0.0
            else RMS_DBFS_FLOOR
        )
        # Rolling-window bookkeeping — pipeline thread is the only writer.
        if len(self._rms_window) >= self._rms_window_frames:
            old_sumsq, old_n = self._rms_window.popleft()
            self._rms_sumsq_total -= old_sumsq
            self._rms_samples_total -= old_n
        self._rms_window.append((sumsq, n))
        self._rms_sumsq_total += sumsq
        self._rms_samples_total += n
        rolling_rms = math.sqrt(
            max(0.0, self._rms_sumsq_total) / self._rms_samples_total
        )
        rolling_dbfs = (
            max(RMS_DBFS_FLOOR, 20.0 * math.log10(rolling_rms / _INT16_FULL_SCALE))
            if rolling_rms > 0.0
            else RMS_DBFS_FLOOR
        )
        now = time.time()
        # Gain-compensated flatline gate (WARP-1060, R1 from the WARP-1055
        # review). The threshold is tuned against the EFFECTIVE signal the
        # detector hears, but the frame here is RAW (pre-gain) — on a box
        # with input_gain > 1 a healthy chain whose raw self-noise sits
        # below the un-compensated -70 dBFS would read as "no signal" and
        # false-flag the DSP wedge after a quiet flatline window. Shift the
        # gate down by the gain (20·log10) so the margin includes the boost.
        # Wedge semantics survive: ±1-count dither is ≈ -90 dBFS, still
        # below the shifted gate at any realistic calibrated gain (×8 →
        # gate ≈ -88). Unlocked read of _input_gain matches _on_frame.
        flatline_gate = (
            self._flatline_dbfs - 20.0 * math.log10(self._input_gain)
        )
        with self._lock:
            self._input_rms_dbfs = rolling_dbfs
            if self._audio_watch_started_at is None:
                # Lazy baseline: first frame ever seen. The capture
                # session normally sets this at stream-open; this covers
                # direct _on_frame use (tests) without special-casing.
                self._audio_watch_started_at = now
            if frame_dbfs > flatline_gate:
                self._last_audio_at = now

    def _on_frame(self, frame: np.ndarray) -> None:
        # Input-level tracking first (WARP-1037): every frame counts,
        # regardless of which state it dispatches to below — a wedged
        # DSP flows silence in ALL states. Tracked on the RAW frame,
        # BEFORE gain (WARP-1055 domain contract — see _track_input_level).
        self._track_input_level(frame)
        # Digital input gain applies AFTER tracking, so the detector /
        # VAD / STT paths below see the boosted signal while the
        # published level stays in the raw capture domain. Clip into
        # int16 so an over-eager gain distorts instead of wrapping.
        if self._input_gain != 1.0:
            frame = np.clip(
                frame.astype(np.float32) * self._input_gain,
                -32768.0,
                32767.0,
            ).astype(np.int16)
        # Apply visual-decay BEFORE dispatch so a stale wake_detected /
        # transcript_ready that should have decayed actually does. status()
        # decays lazily on read, but the worker thread reads _state
        # directly here — without this, a wake without STT would lock the
        # pipeline in wake_detected forever (the read-time decay only
        # affects what status() returns, not what _on_frame branches on).
        self._maybe_decay_state()
        state = self._state

        if state == "transcribing":
            self._capture_frame_for_stt(frame)
            return
        if state == "wake_detected":
            # The state was set by a previous frame's wake fire. If STT
            # is wired up, this frame begins the transcription stream.
            # Otherwise the state sits here until _maybe_decay_state
            # rolls us back to listening on a later frame.
            if self._stt is not None and self._stt_available:
                self._begin_transcription(initial_frame=frame)
            return
        if state == "transcript_ready":
            # Wait for visual-decay; the next frame after that will land
            # in 'listening' again via _maybe_decay_state above.
            return
        if state == "speaking":
            # Anti-feedback: while we're driving the speaker, ignore
            # incoming mic frames entirely. Piper's voice would otherwise
            # tip the wake detector on a self-spoken "hey jarvis ...".
            return
        if state in ("error", "no_mic"):
            # Latched fault states. Do NOT auto-resume wake detection from
            # here: a wake fire would overwrite _state with 'wake_detected'
            # while leaving the now-stale _error_message in place, masking
            # the fault on /voice/status. Recovery is an explicit transition
            # — the supervising _loop re-opens the stream and calls
            # _set_state("listening") after a genuine device recovery; an
            # 'error' is cleared only by a deliberate _set_state/restart.
            # Until then, drop frames silently.
            return

        # state == "listening" (or 'loading' on the first tick — harmless,
        # detector.predict on background audio just returns ~0 scores).
        self._run_wake_detect(frame)

    def _maybe_decay_state(self) -> None:
        """Sync internal _state with the visual-decay rule.

        Mirrors the decay logic in status() so the worker thread's view
        of state matches what callers see via the API. Without this,
        a frame could route to wake_detected even though status() would
        have decayed it back to listening 5 seconds ago.

        When a decay actually returns us to `listening` after a wake /
        transcription excursion, reset the wake detector so a stateful
        recognizer (Vosk) doesn't carry a stale, half-decoded utterance
        into the next turn (WARP-154 review item 1). The reset is done
        OUTSIDE the lock — Vosk's Reset() is cheap but we don't hold the
        status lock across detector calls.
        """
        decayed_to_listening = False
        with self._lock:
            state = self._state
            now = time.time()
            if (
                state == "wake_detected"
                and self._last_wake_at is not None
                and now - self._last_wake_at > self._visual_decay_s
            ):
                self._state = "listening"
                decayed_to_listening = True
            elif (
                state == "transcript_ready"
                and self._last_transcript_at is not None
                and now - self._last_transcript_at > self._visual_decay_s
            ):
                self._state = "listening"
                decayed_to_listening = True
        if decayed_to_listening:
            self._reset_detector()

    def _reset_detector(self) -> None:
        """Reset the wake detector's recognition state. Tolerates a
        detector whose reset() raises so a flaky backend can't crash the
        wake loop on a state transition."""
        try:
            self._detector.reset()
        except Exception:
            logger.exception("wake detector reset() raised")

    def _run_wake_detect(self, frame: np.ndarray) -> None:
        """Wake-word path: predict, threshold-check, debounce, fire."""
        # Post-speak cooldown: drop frames during the brief window after
        # TTS playback ends. The reSpeaker XVF3800 is both mic and speaker
        # on the same USB endpoint, so even with hardware AEC the tail
        # of a Piper reply can score above threshold and re-trigger a
        # turn the user didn't ask for. Cheap fast-path that runs before
        # the detector predict() to skip the inference cost entirely.
        now = time.time()
        if (
            self._speak_ended_at is not None
            and now - self._speak_ended_at < self._post_speak_cooldown_s
        ):
            return

        try:
            scores = self._detector.predict(frame)
        except Exception as exc:
            self._set_error(f"detector.predict raised: {exc}")
            return
        if not scores:
            return
        # Pick the highest-scoring model. We don't currently support
        # multi-model detectors but the data shape allows it.
        model, score = max(scores.items(), key=lambda kv: kv[1])
        if score < self._threshold:
            # Near-miss (WARP-1058): probably the wake word, not loud /
            # clear enough to clear the gate — the §3.4 "Missed wake
            # word" feed row. Debounced like fires (one row per
            # utterance) and suppressed during the wizard's calibration
            # mode (its deliberate wake tests aren't misses).
            if (
                score >= self._threshold * WAKE_MISS_RATIO
                and now - self._last_miss_emit_at >= self._debounce_s
                and not self._calibration_mode_active(now)
            ):
                self._last_miss_emit_at = now
                self._emit_activity(
                    "wake_missed",
                    score=score,
                    threshold=self._threshold,
                    model=model,
                )
            return

        # Debounce.
        if now - self._last_fire_at < self._debounce_s:
            return
        self._last_fire_at = now

        event = WakeEvent(model_name=model, score=score, detected_at=now)
        with self._lock:
            # Calibration mode (WARP-1059): count, don't handle. The
            # wake fields still update — the wizard's step-3 "say it
            # three times" counter rides last_wake_at changes — but the
            # state stays 'listening', so _on_frame never routes into
            # the STT capture path and nothing gets spoken back.
            calibrating = self._calibration_mode_active(now)
            self._last_wake_at = event.detected_at
            self._last_wake_score = event.score
            self._last_wake_model = event.model_name
            if not calibrating:
                self._state = "wake_detected"

        if calibrating:
            logger.info(
                "wake detected in calibration mode (model=%s score=%.3f) — "
                "counted, not handled", event.model_name, event.score,
            )
            # Same rationale as the decay path: don't carry a stateful
            # recognizer's half-decoded utterance into the next try.
            self._reset_detector()
            return

        try:
            self._on_wake(event)
        except Exception:
            logger.exception("wake callback raised")

        # WARP-1058: with STT absent or down the interaction ends at the
        # detection — record the honest outcome now. When STT is up the
        # turn continues and _default_on_transcript resolves the final
        # outcome (answered / ignored / heard) instead, so each wake
        # produces exactly one feed row.
        if self._stt is None or not self._stt_available:
            self._emit_activity(
                "wake_heard",
                score=event.score,
                threshold=self._threshold,
                model=event.model_name,
            )

    # ──────────────────────────────────────────────────────────────
    # STT capture path
    # ──────────────────────────────────────────────────────────────

    def _begin_transcription(self, initial_frame: np.ndarray) -> None:
        """Open a Wyoming session and stream the first frame.

        Called once per wake event. After this returns, _on_frame will
        keep routing frames to _capture_frame_for_stt until the
        max-record window expires.
        """
        try:
            session = self._stt.session()  # type: ignore[union-attr]
        except STTUnavailable as exc:
            self._set_error(f"STT session failed: {exc}")
            # Mark STT unavailable so subsequent wakes don't loop on
            # the same connect-error. Status surfaces the cause.
            self._stt_available = False
            return
        self._stt_session = session
        self._transcribe_started_at = time.time()
        # Reset end-of-speech (VAD) state for this turn.
        self._stt_speech_started = False
        self._stt_silence_s = 0.0
        self._stt_speech_s = 0.0
        with self._lock:
            self._state = "transcribing"
        logger.info("transcribing: capture window opened")
        # Don't lose this frame — it's the first ~80 ms of the user's
        # post-wake speech.
        self._capture_frame_for_stt(initial_frame)

    def _capture_frame_for_stt(self, frame: np.ndarray) -> None:
        """Stream one frame to Wyoming. Closes the session at deadline."""
        session = self._stt_session
        if session is None:
            return  # raced with abort; nothing to do
        try:
            session.send_chunk(frame.astype(np.int16).tobytes())
        except STTUnavailable as exc:
            self._abort_transcription(f"send_chunk: {exc}")
            return

        elapsed = time.time() - self._transcribe_started_at

        # End-of-speech (VAD): once the user has actually started talking,
        # finish as soon as we see a short run of trailing silence — so the
        # box stops listening the moment they finish their statement rather
        # than holding the mic for the whole max-record window.
        rms = (
            float(np.sqrt(np.mean(np.square(frame.astype(np.float64)))))
            if frame.size
            else 0.0
        )
        if rms >= self._vad_speech_rms:
            self._stt_speech_started = True
            self._stt_speech_s += self._frame_s
            self._stt_silence_s = 0.0
        elif self._stt_speech_started:
            self._stt_silence_s += self._frame_s
        # End only once we've heard enough ACTUAL speech (so the brief
        # wake-word tail + any pause before the command don't end the turn
        # prematurely) followed by a run of trailing silence.
        if (
            self._stt_speech_s >= self._vad_min_speech_s
            and self._stt_silence_s >= self._vad_silence_s
        ):
            logger.info(
                "transcribing: end-of-speech (%.1fs speech, %.1fs trailing silence)",
                self._stt_speech_s, self._stt_silence_s,
            )
            self._finish_transcription()
            return

        # Hard cap so a noisy room (VAD never sees a clean silence) or a
        # runaway never holds the mic open forever.
        if elapsed >= self._stt_max_record_s:
            logger.info("transcribing: max-record cap reached (%.1fs)", elapsed)
            self._finish_transcription()

    def _finish_transcription(self) -> None:
        """Send audio-stop, block for transcript, transition state."""
        session = self._stt_session
        self._stt_session = None
        if session is None:
            return
        try:
            transcript = session.finish()
        except STTUnavailable as exc:
            session.close()
            self._abort_transcription(f"finish: {exc}")
            return
        session.close()

        now = time.time()
        with self._lock:
            self._last_transcript = transcript
            self._last_transcript_at = now
            self._state = "transcript_ready"

        logger.info("transcript: %r", transcript)
        try:
            self._on_transcript(transcript)
        except Exception:
            logger.exception("transcript callback raised")

    def _abort_transcription(self, msg: str) -> None:
        """STT failed mid-stream. Drop the session, surface the error."""
        session = self._stt_session
        self._stt_session = None
        if session is not None:
            try:
                session.close()
            except Exception:
                pass
        logger.warning("transcription aborted: %s", msg)
        self._set_error(msg)

    # ──────────────────────────────────────────────────────────────
    # State helpers
    # ──────────────────────────────────────────────────────────────

    def _set_state(self, state: PipelineState) -> None:
        with self._lock:
            self._state = state
            if state != "error":
                self._error_message = None

    def _set_error(self, msg: str) -> None:
        with self._lock:
            self._state = "error"
            self._error_message = msg

    @staticmethod
    def _default_on_wake(event: WakeEvent) -> None:
        logger.info(
            "wake detected: model=%s score=%.3f", event.model_name, event.score,
        )

    def _default_on_transcript(self, transcript: str) -> None:
        """Closed-loop default: send the transcript to the orchestrator's
        LLM, then speak the reply.

        Called from the pipeline thread after `_finish_transcription`
        succeeded. Failures land in /voice/status's error_message; the
        wake loop keeps running so the user can try again.

        Any operator-supplied `on_transcript` callback REPLACES this
        default. Set it via the constructor if you want different
        behaviour (e.g. dashboard-driven dispatch in commit 8).
        """
        # WARP-1058 — the turn's wake context for the outcome row. Read
        # without the lock (GIL-atomic; same discipline as the other
        # single-field reads on this thread).
        wake_score = self._last_wake_score
        wake_model = self._last_wake_model
        if not transcript:
            # Wake fired but the capture heard nothing worth words.
            self._emit_activity(
                "wake_heard",
                score=wake_score, threshold=self._threshold, model=wake_model,
            )
            return
        if not transcript_is_actionable(transcript):
            # Residual false wakes (a phonetic near-collision on the TV —
            # "hey, drop it") capture room fragments like "it." or "uh".
            # A real post-wake command always carries at least one
            # substantive word; don't send fragments to the LLM, and
            # especially don't speak an answer to the television. The
            # transcript still lands in /voice/status for diagnosis.
            logger.info(
                "transcript %r is a fragment, not a command — staying quiet",
                transcript,
            )
            self._emit_activity(
                "wake_ignored",
                score=wake_score, threshold=self._threshold, model=wake_model,
            )
            return
        if self._llm is None or not self._llm_available:
            logger.info(
                "transcript ready (LLM unavailable, not speaking): %r",
                transcript,
            )
            self._emit_activity(
                "wake_heard",
                score=wake_score, threshold=self._threshold, model=wake_model,
            )
            return
        # Intent gate: short-circuit speculative tool calls on greetings,
        # time-of-day, and who-are-you utterances. The orchestrator's
        # agent loop honors tool_choice="none" by advertising zero
        # tools — the model can only answer from the system prompt
        # context, which already carries the live time + location.
        tool_choice = classify_tool_choice(transcript)
        if tool_choice == "none":
            logger.info(
                "intent gate matched (no tools): transcript=%r", transcript,
            )
        # WARP-626 — stream the reply, sentence-chunk it, and speak each
        # chunk so first-audio starts after sentence 1 instead of after the
        # whole reply is synthesized. `_speak_reply_stream` owns the LLM
        # stream + chunker + single-utterance speak: ONE `_speak_lock` hold,
        # ONE 'speaking' state, ONE post-speak cooldown. It catches
        # LLMUnavailable (SSE broke) + TTS/playback failures and surfaces
        # them via /voice/status, so the wake loop keeps running.
        result = self._speak_reply_stream(transcript, tool_choice=tool_choice)
        spoke = bool(result.get("ok") and result.get("spoke_any"))
        if not spoke and result.get("error"):
            logger.warning(
                "voice reply for %r did not complete (%s): %s",
                transcript, result.get("error_kind"), result.get("error"),
            )
        # WARP-1058 — the §3.4 outcome row. "Answered" means the user
        # actually HEARD a reply; a failed / empty / rejected reply is
        # honestly just "Heard the wake word" (the fault itself surfaces via
        # error_message / health, not the feed).
        self._emit_activity(
            "wake_answered" if spoke else "wake_heard",
            score=wake_score, threshold=self._threshold, model=wake_model,
        )
