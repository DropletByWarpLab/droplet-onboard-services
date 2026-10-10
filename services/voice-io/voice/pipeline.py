"""Wake-detection + STT pipeline — background thread that streams mic
audio into a wake-word detector, then on detection streams the next
utterance to a Wyoming-protocol STT sidecar and emits a
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
      │                       → on end-of-speech or STT_MAX_RECORD_S,
      │                         send audio-stop and await transcript
      │                       → state=transcript_ready
      │
      └─ state=transcript_ready → ignore until visual-decay; status()
                                  reports it for the dashboard's pulse,
                                  decays back to 'listening' after
                                  WAKE_VISUAL_DECAY_S.

Single thread. The Wyoming `finish()` call blocks for the final
transcript event (bounded by the STT client's CPU inference budget); during that
window the mic stream isn't being drained and may overflow into a
log line. We don't bridge to asyncio
because the wake loop is already a blocking thread and the gain
isn't worth the threading-model complication. The one exception is a
spoken reply: while it plays on this thread, a short-lived per-turn
'voice-synth' producer reads the reply stream and synthesizes the next
sentence (WARP-3124 synth-ahead, see `_run_speak_chunks`); it touches no
pipeline state and ends with the utterance.

Debounce: a single utterance produces many 80 ms frames above
threshold (the wake-word audio is ~600 ms). Without a debounce window
we'd fire 10+ WakeEvents back-to-back. `WAKE_DEBOUNCE_S` enforces a
minimum gap between events — defaults to 2 s. Once we transition into
transcribing, the wake detector is paused entirely, so debounce only
matters for the wake→wake re-fire window (which becomes very rare in
practice since wake detection pauses for the captured utterance).

Status:
  state ∈ {idle, loading, listening, wake_detected, transcribing,
           transcript_ready, error, no_mic}
  last_wake_at / last_wake_score / last_wake_model
  last_transcript / last_transcript_at
  stt_loaded — true iff the STT server was reachable at startup
  error_message — the latched fault in 'error'; otherwise why the last
    voice turn failed (TTS / playback / LLM stream — the pipeline keeps
    listening, WARP-3199), cleared by the next wake

`wake_detected` and `transcript_ready` are transient UI hints that
auto-decay to `listening` after `WAKE_VISUAL_DECAY_S` seconds (2 s by
default) so the dashboard's wake + transcript pulse animations have
time to play.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import sys
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from typing import Any, Callable, Iterable, Iterator, Optional, Union

import numpy as np
from apscheduler.schedulers.background import BackgroundScheduler

from voice.activity import ActivityReporter
from voice.audio_io import (
    CAPTURE_RATE_CANDIDATES,
    DEFAULT_INPUT_DOWNMIX,
    downmix_to_mono,
    make_int16_resampler,
    negotiate_capture_rate,
)
from voice.intents import VolumeIntent, classify_volume_intent
from voice.llm import LLMClient, LLMUnavailable, SpokenCue, ToolChoice
from voice.stt import STTUnavailable, StreamingSTT
from voice.text_chunk import (
    DEFAULT_CLAUSE_SOFT_MAX_CHARS,
    DEFAULT_FIRST_CLAUSE_MIN_CHARS,
    SentenceChunker,
)
from voice.tts import SynthesizedAudio, TextToSpeech, TTSUnavailable
from voice.volume import VolumeController, apply_gain
from voice.wake import (
    WAKE_FRAME_SAMPLES,
    WAKE_SAMPLE_RATE,
    WakeEvent,
    WakeWordDetector,
)

logger = logging.getLogger("voice.pipeline")

# What a TTS server fault looks like from WyomingTTS.synthesize — it reuses
# stt.py's wire helpers, so a mid-event drop is STTUnavailable. Any other
# exception out of synthesize is a bug and is logged with its traceback.
_TTS_WIRE_FAULTS = (TTSUnavailable, STTUnavailable)


class _DeviceError(Exception):
    """Internal marker for a RECOVERABLE audio-device failure (mic
    re-enumeration, shifted ALSA card index, invalidated PortAudio
    handle). Raised inside the capture session from the stream open/read
    and caught by the supervising loop, which re-resolves + reopens. Kept
    private — callers see the public state machine (state='no_mic' while
    recovering), never this type."""


class _ReopenRequested(_DeviceError):
    """WARP-3710 — raised out of a healthy capture session when something
    asked for the input to be re-enumerated + reopened in-process (the
    flatline self-heal on a non-XVF device, a hot-plug rescan, or an
    operator's POST /voice/mic/restart). A subclass of `_DeviceError` so
    any code that treats a device error as "close the stream" stays true,
    but the supervisor handles it WITHOUT the no_mic backoff: nothing is
    broken, the stream is being swapped on purpose."""


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


def strip_wake_prefix(transcript: str, wake_words: str) -> str:
    """Remove one configured wake address at the start of a transcript.

    Capture can include the wake phrase's tail. Keep mentions inside the
    actual command and words that only begin with the configured phrase.
    """
    phrases = [spec.replace("_", " ").strip() for spec in wake_words.split(",")]
    for phrase in sorted(phrases, key=len, reverse=True):
        if not phrase:
            continue
        pattern = r"^\s*" + r"\s+".join(re.escape(word) for word in phrase.split())
        pattern += r"(?=$|[\s,.:;!?])[\s,.:;!?]*"
        match = re.match(pattern, transcript, re.IGNORECASE)
        if match:
            return transcript[match.end():].strip()
    return transcript

# Default tuning. Overridable via env at construct time (read by
# main.py's wiring, not by this module directly).
DEFAULT_THRESHOLD = 0.3
DEFAULT_DEBOUNCE_S = 2.0
DEFAULT_VISUAL_DECAY_S = 2.0
# End-of-speech VAD finishes ordinary commands sooner. The hard cap allows
# longer requests and still bounds noisy-room captures. STT_MAX_RECORD_S
# overrides this default in main.py.
DEFAULT_STT_MAX_RECORD_S = 30.0
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

# Warm on wake (WARP-3127). A fired wake asks the orchestrator to start
# loading the chat model (LLMClient.warm → POST /api/llm/warm), so a reload
# after WARP-1826's 5 min residency overlaps the person speaking + STT
# instead of starting once the transcript lands. At most one warm per this
# window: a conversation's back-to-back wakes find the model resident
# anyway, and the orchestrator side is probe-first and in-flight-guarded.
# Monotonic, so a wall-clock step can't suppress or double the warm.
DEFAULT_LLM_WARM_DEBOUNCE_S = 60.0

# End-of-speech (VAD) for the STT capture window. Once the user has
# actually started talking, the capture ends after a short run of
# trailing silence — so the box stops listening the moment they finish
# their statement instead of always holding the mic for the full
# max-record window. Energy-based on frame RMS; the max-record window
# stays the hard cap for noisy rooms where a clean silence never arrives.
#
# WARP-3729: every seconds knob here is quantized to whole 80 ms capture
# frames at construction (`_vad_frames`: ceil of the exact ratio, so 0.6 s
# is 8 frames = 640 ms, 0.5 s is 7 = 560 ms, 0.8 s is 10 = 800 ms) and the
# per-turn counters are integers, so a tail is the same number of frames
# on every box instead of depending on float accumulation.
DEFAULT_VAD_SILENCE_S = 0.6       # trailing silence (s) that ends the turn
                                  # after a longer utterance (voiced span over
                                  # VAD_SHORT_UTTERANCE_S) or one with a
                                  # mid-sentence pause. WARP-1434: trimmed
                                  # 1.0 → 0.6 — a full second of dead air used
                                  # to end every turn; 0.6 s still rides out a
                                  # natural pause but stops promptly once the
                                  # speaker finishes. Per-room via VAD_SILENCE_S.
DEFAULT_VAD_SILENCE_SHORT_S = 0.48  # WARP-3729: tail after a SHORT, pause-free
                                  # command (6 frames = 480 ms, 160 ms sooner
                                  # than the long tail). A hesitation inside a
                                  # short command is the exposure, so 0.48
                                  # ships (not 0.4) until the box data says
                                  # otherwise. <= 0 disables (short = long);
                                  # never longer than VAD_SILENCE_S.
VAD_SHORT_UTTERANCE_S = 1.2       # voiced span (first → last speech frame) up
                                  # to which the short tail applies.
VAD_PAUSE_S = 0.24                # a silence run this long INSIDE the utterance
                                  # means the speaker pauses mid-sentence: the
                                  # long tail applies for the rest of the turn.
VAD_WAKE_TAIL_S = 0.16            # the first two capture frames. Vosk fires on
                                  # the partial hypothesis and the capture opens
                                  # on the next frame, so the end of the wake
                                  # phrase lands here by construction: it never
                                  # starts the VAD or counts toward the gate
                                  # (WARP-3729), so a pause before the command
                                  # is judged like a capture with no speech.
DEFAULT_VAD_SPEECH_RMS = 700.0    # int16 frame RMS above which a frame = "speech",
                                  # compared AFTER the calibration input gain —
                                  # relative to the calibrated -12 dBFS speech
                                  # peak, like the detector (sits between a
                                  # typical room floor ~400 and normal speech
                                  # ~1000+; tune per-room via VAD_SPEECH_RMS).
DEFAULT_VAD_MIN_SPEECH_S = 0.24   # min CUMULATIVE speech before end-of-speech
                                  # may fire. WARP-3729: 0.4 → 0.24 (3 frames)
                                  # now that the wake tail is excluded by the
                                  # window above — speech straight after the
                                  # wake still needs five loud frames from
                                  # capture-open, and a one-word command after
                                  # a pause ("stop") ends on the normal tail
                                  # instead of running to the cap.
DEFAULT_VAD_NO_SPEECH_S = 6.0     # WARP-3729: nothing over the threshold this
                                  # long after capture-open ends the capture
                                  # (vad_end "no_speech", NOT transcribed) — a
                                  # false wake or nobody speaking used to hold
                                  # the mic for the 30 s cap and hand 30 s of
                                  # room noise to STT. Also the patience after
                                  # the last loud frame when the min-speech
                                  # gate was never met ("short_speech", still
                                  # transcribed). Trade-off: the box gives no
                                  # audible wake cue, so someone who waits
                                  # longer than this before speaking gets an
                                  # empty turn; shorter = quicker recovery from
                                  # false wakes. 0 disables both (cap only).


def _vad_frames(seconds: float, frame_s: float) -> int:
    """Whole capture frames for a VAD seconds knob (WARP-3729): ceil of the
    exact ratio, so 0.2/0.4/0.48/0.5/0.6 s are 3/5/6/7/8 frames — the counts
    the old float accumulation produced — and 0.8 s is 10 (it used to be 11).
    Never raises: a non-finite or non-positive value is 0 frames, and each
    caller decides what 0 means (disabled, or the floor of one frame)."""
    if not math.isfinite(seconds) or seconds <= 0.0:
        return 0
    return math.ceil(round(seconds / frame_s, 6))


# Spoken cues (WARP-3124). A tool question is two serial generations plus a
# dispatch — 8-15 s of silence on the box — and a cold model load can be
# longer. When the orchestrator reports a `tool_call` or `model_loading`, the
# box says one short, plain phrase so the user knows it heard them. At most
# one cue per turn, never once the answer has started. main.py's warm-up
# pre-synthesizes both (WakePipeline.prime_cues) so a cue costs no Piper
# round trip. Never states a model name or a size — the box doesn't always
# know them (DMR reports no size).
TOOL_CALL_CUE_TEXT = "Let me check."
MODEL_LOADING_CUE_TEXT = "One moment."
CUE_PHRASES: dict[str, str] = {
    "tool_call": TOOL_CALL_CUE_TEXT,
    "model_loading": MODEL_LOADING_CUE_TEXT,
}

# Synth-ahead (WARP-3124). While sentence N plays on the turn thread, a
# per-turn producer thread keeps reading the reply stream and synthesizing
# N+1. The hand-off holds at most this many finished sentences, so the
# producer is never more than one sentence ahead of the speaker plus the one
# it is synthesizing — a failed playback discards little work.
SYNTH_AHEAD_DEPTH = 1
# How long the turn thread waits for the producer to wind down after the
# utterance ends or bails. The producer owns closing the reply stream (a
# generator can only be closed by the thread running it), so normally this
# join is instant; if the producer is mid-synthesis or parked on a slow SSE
# read, the turn moves on and the producer closes the stream the moment
# that step returns.
SYNTH_PRODUCER_JOIN_TIMEOUT_S = 2.0

# Multichannel capture → mono for the detector + STT. Both the policy
# constant (DEFAULT_INPUT_DOWNMIX) and the downmix_to_mono() helper live
# in voice/audio_io.py and are imported above, so the always-on wake loop
# and the one-shot record() paths cannot drift apart — the reSpeaker
# XVF3800's beamformed-voice-on-L / AEC-residual-on-R layout costs ~6 dB
# if either of them averages the channels.

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

# Capture-rate negotiation (WARP-2213) — why the wake loop opens the mic
# at CAPTURE_RATE_CANDIDATES (imported from voice/audio_io.py) rather than
# at WAKE_SAMPLE_RATE flat.
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
# detector sees it. WAKE_SAMPLE_RATE is passed as the desired rate and is
# therefore probed FIRST, so a device that genuinely supports 16 kHz (the
# ReSpeaker USB 4-Mic Array does) keeps the existing zero-resample path.
#
# The candidate list is SHARED with the one-shot record() paths — one
# tuple, so a rate added for a new device cannot reach only half the
# service. Every candidate divides WAKE_FRAME_SAMPLES exactly
# (1280 * rate / 16000 is a whole number for all of them), so one read
# always yields exactly one detector frame — no carry buffer, no drift,
# no partial frames. TestCaptureRateCandidatesAreShared pins both.

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
# Capture-liveness watchdog (WARP-3934). When the USB mic drops off the bus,
# Debian's libportaudio2 19.6.0 ALSA host API does NOT raise from
# `stream.read()` - it busy-spins in C on the deleted device node, so the
# read loop never gets control back and no in-process recovery (the reopen
# flag, `_DeviceError`, the WARP-1409 DSP reboot budget) can ever run. The
# capture thread stamps `_capture_io_since` right before EVERY PortAudio
# call it makes (device probe + open, each read, the close, the
# re-enumeration) and clears it when the call returns; a healthy read
# returns every ~80 ms, so one call still in flight after 15 s means
# PortAudio is wedged. The stamp - not the pipeline state - is what is
# judged: the device can drop mid-capture (`transcribing`) as easily as
# while `listening`, and a voice turn (which runs inside `_on_frame`,
# outside any PortAudio call) is never judged however long it takes.
# 0 disables. Env: VOICE_CAPTURE_STALL_S.
DEFAULT_CAPTURE_STALL_S = 15.0
# Exit code used when the watchdog gives up (EX_SOFTWARE); compose's
# `restart: always` brings voice-io back on the re-enumerated device.
CAPTURE_STALL_EXIT_CODE = 70
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
# min-word-confidence ~0.85 gate). Misses are debounced on the same
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
    # Per-turn latency (WARP-3124): the same fields as the last
    # `voice_turn_timing` log line (see _TurnTiming.summary). None until the
    # first turn completes.
    last_turn_timing: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _close_quietly(iterator: Any) -> None:
    """Close a generator-like iterator (tearing down the reply SSE behind
    it, WARP-329). Teardown path: never raises."""
    close = getattr(iterator, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # pragma: no cover — defensive teardown
            logger.debug("chunk generator close raised", exc_info=True)


def _ms(start: Optional[float], end: Optional[float]) -> Optional[int]:
    """Whole milliseconds between two time.monotonic() stamps; None when
    either stage did not happen this turn."""
    if start is None or end is None:
        return None
    return round((end - start) * 1000)


@dataclass
class _TurnTiming:
    """time.monotonic() stamps for ONE voice turn (WARP-3124).

    Created at the wake (or at capture-open when a test drives STT
    directly), filled in on the capture thread as the turn moves on, and
    summarised once — as the `voice_turn_timing` log line and
    /voice/status `last_turn_timing` — when _default_on_transcript ends
    the turn. The speak-side stamps come back in the speak result dict.
    """

    wake_at: Optional[float] = None
    capture_open_at: Optional[float] = None
    capture_end_at: Optional[float] = None
    speech_s: Optional[float] = None
    vad_end: Optional[str] = None  # "silence" | "short_speech" | "no_speech" | "cap"
    vad_tail: Optional[str] = None  # "short" | "long" | "fallback"; None when no
                                    # VAD tail ended the capture (WARP-3729)
    transcript_at: Optional[float] = None

    def summary(
        self, *, outcome: str, speak: Optional[dict[str, Any]], ended_at: float,
    ) -> dict[str, Any]:
        speak = speak or {}
        return {
            "outcome": outcome,
            "wake_to_capture_ms": _ms(self.wake_at, self.capture_open_at),
            "speech_ms": (
                None if self.speech_s is None else round(self.speech_s * 1000)
            ),
            "capture_ms": _ms(self.capture_open_at, self.capture_end_at),
            "vad_end": self.vad_end,
            "vad_tail": self.vad_tail,
            "stt_ms": _ms(self.capture_end_at, self.transcript_at),
            "first_delta_ms": _ms(self.transcript_at, speak.get("first_delta_at")),
            "first_audio_ms": _ms(self.transcript_at, speak.get("first_audio_at")),
            "first_answer_audio_ms": _ms(
                self.transcript_at, speak.get("first_answer_audio_at"),
            ),
            "total_ms": _ms(self.wake_at, ended_at),
            "cue": speak.get("cue"),
            "sentences": speak.get("sentences", 0),
            "first_chunk_chars": speak.get("first_chunk_chars"),
            "error_kind": speak.get("error_kind"),
        }


@dataclass(frozen=True)
class _SpeechItem:
    """One synthesized piece of an utterance, handed from the synth-ahead
    producer to the turn thread (WARP-3124). Exactly one of `text` (an
    answer sentence) or `cue` (a cue kind) is set."""

    audio: SynthesizedAudio
    text: Optional[str] = None
    cue: Optional[str] = None


@dataclass(frozen=True)
class _SpeakFailure:
    """The producer's terminal error, delivered in order after everything
    it already queued. `kind` is "tts" or "llm"."""

    kind: str
    error: BaseException


class _SynthAheadChannel:
    """Bounded, closable hand-off between the synth-ahead producer and the
    turn thread that plays (WARP-3124).

    Not a queue.Queue: that can't be closed on Python 3.12 (Queue.shutdown
    is 3.13+), and a producer parked in put() on a full queue must wake the
    moment the turn thread bails out — or the producer never reaches the
    point where it closes the reply stream. A deque under a Condition does
    both, with no polling.
    """

    def __init__(self, depth: int):
        self._depth = max(1, int(depth))
        self._items: deque[Any] = deque()
        self._cond = threading.Condition()
        self._closed = False    # turn thread is done: refuse + drop items
        self._finished = False  # producer is done: nothing after the queue

    @property
    def closed(self) -> bool:
        return self._closed

    def put(self, item: _SpeechItem) -> bool:
        """Queue one item, waiting while the channel is full. False once
        the turn thread has closed the channel — the producer's cue to
        stop."""
        with self._cond:
            while len(self._items) >= self._depth and not self._closed:
                self._cond.wait()
            if self._closed:
                return False
            self._items.append(item)
            self._cond.notify_all()
            return True

    def finish(self, failure: Optional[_SpeakFailure] = None) -> None:
        """The producer is done. `failure`, if any, is delivered after the
        items already queued. Never blocks, so the producer always exits."""
        with self._cond:
            if failure is not None and not self._closed:
                self._items.append(failure)
            self._finished = True
            self._cond.notify_all()

    def close(self) -> None:
        """The turn thread is done: drop queued audio and wake a producer
        parked in put()."""
        with self._cond:
            self._closed = True
            self._items.clear()
            self._cond.notify_all()

    def __iter__(self) -> Iterator[Any]:
        """Items in order, until the producer has finished and the queue is
        empty (or the channel was closed)."""
        item = self._take()
        while item is not None:
            yield item
            item = self._take()

    def _take(self) -> Optional[Any]:
        with self._cond:
            while not self._items and not self._finished and not self._closed:
                self._cond.wait()
            if not self._items:
                return None
            item = self._items.popleft()
            self._cond.notify_all()  # room for a producer parked in put()
            return item


def pcm_level_dbfs(pcm: np.ndarray) -> tuple[float, float]:
    """(rms_dbfs, peak_dbfs) of an int16 buffer, floored at
    RMS_DBFS_FLOOR for pure digital silence (WARP-3710 mic test)."""
    if pcm.size == 0:
        return RMS_DBFS_FLOOR, RMS_DBFS_FLOOR
    wide = pcm.astype(np.float64)
    rms = math.sqrt(float(np.mean(wide * wide)))
    peak = float(np.abs(pcm.astype(np.int32)).max())

    def _db(v: float) -> float:
        if v <= 0.0:
            return RMS_DBFS_FLOOR
        return max(RMS_DBFS_FLOOR, 20.0 * math.log10(v / _INT16_FULL_SCALE))

    return _db(rms), _db(peak)


def _exit_for_capture_stall(reason: str) -> None:
    """Default ``on_capture_stall`` (WARP-3934): log loudly, flush, and exit
    the process so the container supervisor restarts voice-io.

    Nothing in-process can interrupt a C call that is spinning inside
    PortAudio, so this is deliberately crash-only. ``os._exit`` skips
    atexit / thread joins, which would block on the very thread that is
    stuck."""
    logger.critical("capture stall - exiting for supervisor restart: %s", reason)
    for handler in list(logging.getLogger().handlers) + list(logger.handlers):
        try:
            handler.flush()  # the CRITICAL line must reach `docker logs`
        except Exception:  # pragma: no cover - defensive
            pass
    os._exit(CAPTURE_STALL_EXIT_CODE)


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
        vad_silence_short_s: float = DEFAULT_VAD_SILENCE_SHORT_S,
        vad_no_speech_s: float = DEFAULT_VAD_NO_SPEECH_S,
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
        volume: Optional[VolumeController] = None,
        active_device_is_xvf: Optional[Callable[[], bool]] = None,
        device_fingerprint: Optional[Callable[[], Any]] = None,
        device_rescan_interval_s: float = 0.0,
        capture_stall_s: float = DEFAULT_CAPTURE_STALL_S,
        on_capture_stall: Optional[Callable[[str], None]] = None,
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
        # Speaker output volume — the SAME controller main.py hands the
        # /voice/volume endpoints, so a dashboard change and a spoken "turn
        # it up" act on one state. None = unity gain and no spoken volume
        # commands (every pre-volume constructor call is unchanged).
        self._volume = volume
        # LLM — commit 7. None disables the closed-loop behaviour;
        # transcript still lands in /voice/status but isn't spoken.
        self._llm = llm
        # Warm on wake (WARP-3127) — monotonic stamp of the last warm handed
        # off, and the daemon thread carrying it. Written only from the
        # 'wake-pipeline' thread (_run_wake_detect → _maybe_warm_llm).
        self._llm_warm_at: Optional[float] = None
        self._llm_warm_thread: Optional[threading.Thread] = None
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
        # in _begin_transcription). The seconds knobs are kept as given
        # (tests and status read them) and quantized once to whole frames
        # (WARP-3729); every per-turn counter below is an integer.
        self._vad_silence_s = vad_silence_s
        self._vad_silence_short_s = vad_silence_short_s
        self._vad_speech_rms = vad_speech_rms
        self._vad_min_speech_s = vad_min_speech_s
        self._vad_no_speech_s = vad_no_speech_s
        self._frame_s = WAKE_FRAME_SAMPLES / float(WAKE_SAMPLE_RATE)
        self._vad_silence_frames = max(1, _vad_frames(vad_silence_s, self._frame_s))
        # <= 0 (or a malformed value) means no short tail: short = long.
        short_frames = _vad_frames(vad_silence_short_s, self._frame_s)
        self._vad_silence_short_frames = (
            self._vad_silence_frames if short_frames <= 0
            else min(short_frames, self._vad_silence_frames)
        )
        self._vad_min_speech_frames = _vad_frames(vad_min_speech_s, self._frame_s)
        self._vad_no_speech_frames = _vad_frames(vad_no_speech_s, self._frame_s)  # 0 = off
        self._vad_short_utterance_frames = _vad_frames(VAD_SHORT_UTTERANCE_S, self._frame_s)
        self._vad_pause_frames = max(1, _vad_frames(VAD_PAUSE_S, self._frame_s))
        self._vad_wake_tail_frames = _vad_frames(VAD_WAKE_TAIL_S, self._frame_s)
        # Pre-gain RMS of the frame in flight, stashed by _track_input_level
        # for the VAD so the level is computed once per frame (capture
        # thread only: written and read inside the same _on_frame call).
        self._raw_frame_rms = 0.0
        self._stt_speech_started = False
        self._stt_capture_frames = 0   # frames sent this capture
        self._stt_speech_frames = 0    # loud frames the gate counted
        self._stt_silence_frames = 0   # run since the last counted loud frame
        self._stt_voiced_frames = 0    # frames since the first counted loud frame
        self._stt_pause_seen = False   # a >= VAD_PAUSE_S gap inside the utterance
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
        # WARP-3193 QUAL-12: the periodic upstream re-probe is an
        # APScheduler interval job, not a `while not event.wait()` loop.
        # `_probe_lock` is held for the whole of each tick so stop() can
        # wait for an in-flight tick with a bounded budget.
        self._probe_scheduler: Optional[BackgroundScheduler] = None
        self._rescan_scheduler: Optional[BackgroundScheduler] = None
        self._probe_lock = threading.Lock()
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
        # WARP-3934 - capture-liveness watchdog. `_capture_io_since`
        # (monotonic) is set by the capture thread right before it enters a
        # PortAudio call and cleared when that call returns - None means the
        # thread is outside PortAudio (running a voice turn, backing off in
        # no_mic, or not started). `_check_capture_liveness` (scheduler
        # ticks) fires `_on_capture_stall` once if one call has been in
        # flight for longer than `capture_stall_s`. <= 0 disables.
        self._capture_stall_s = float(capture_stall_s)
        self._on_capture_stall = on_capture_stall or _exit_for_capture_stall
        self._capture_io_since: Optional[float] = None
        self._capture_stall_fired = False
        # WARP-3710 — in-process input self-heal. The `xvf_host` reboot
        # only means something when the ACTIVE device is an XVF3800: on
        # the motherboard codec it exits 8 ("could not connect") three
        # times, latches `wedged_escalated` and asks for a power cycle
        # that would not have helped. `_active_is_xvf` tells the pipeline
        # which case it is (None = unknown → the legacy DSP-only path);
        # when it is NOT an XVF a flatline re-picks the device instead.
        self._active_is_xvf = active_device_is_xvf
        # Hot-plug rescan: a cheap ALSA-card fingerprint polled by an
        # APScheduler job. PortAudio can only be re-enumerated while NO
        # stream is open (a process-wide terminate/initialize under a live
        # stream is the WARP-1619 hazard), so a CHANGED fingerprint does
        # not poll PortAudio — it asks the capture loop to close its
        # stream, re-init, re-pick and reopen (see `request_reopen`).
        self._device_fingerprint = device_fingerprint
        self._device_rescan_interval_s = max(0.0, device_rescan_interval_s)
        self._last_fingerprint: Any = None
        self._repick_last_at: Optional[float] = None
        # Reopen handshake. `_reopen_requested` is read by the capture
        # loop between frames; `_session_generation` counts successful
        # stream opens so an API caller can wait for the NEXT one.
        self._reopen_requested = threading.Event()
        self._reopen_reason: Optional[str] = None
        self._reopen_reset_recovery: bool = False
        self._session_generation: int = 0
        self._session_cv = threading.Condition(self._lock)
        # Raw-PCM tap for POST /voice/mic/test (None = not capturing).
        self._capture_tap: Optional[list[np.ndarray]] = None
        # Calibration mode (WARP-1059) — wall-clock expiry of the
        # wizard's suppression window; None = off. Deliberately
        # in-memory only: a restart must never come back deaf.
        self._calibration_mode_until: Optional[float] = None

        # STT capture session — only set while state=='transcribing'.
        # The pipeline thread is the sole writer; reads from status()
        # happen under _lock so the field is coherent across threads.
        self._stt_session = None  # type: ignore[var-annotated]
        self._transcribe_started_at: float = 0.0
        # Mono 16 kHz samples handed to the STT session this turn - the
        # audio-time side of the capture cap (see _capture_frame_for_stt).
        self._stt_audio_samples: int = 0

        # WARP-3124 — per-turn latency. `_turn_timing` is the turn in
        # flight (capture thread only); `_last_turn_timing` is the finished
        # summary /voice/status serves (guarded by _lock).
        self._turn_timing: Optional[_TurnTiming] = None
        self._last_turn_timing: Optional[dict[str, Any]] = None
        # WARP-3124 — pre-synthesized cue PCM by cue kind (guarded by _lock:
        # filled by prime_cues on the warm-up thread, read by the synth
        # producer).
        self._cue_cache: dict[str, SynthesizedAudio] = {}
        self._cue_voice_cache_key: Optional[str] = None

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
        # Daemon scheduler thread — process exit doesn't wait on it.
        # max_instances=1 + coalesce: a slow tick never stacks up behind
        # itself, matching the old sequential loop.
        if self._upstream_probe_interval_s > 0:
            sched = BackgroundScheduler(daemon=True)
            sched.add_job(
                self._probe_tick,
                "interval",
                seconds=self._upstream_probe_interval_s,
                id="upstream-probe",
                max_instances=1,
                coalesce=True,
            )
            sched.start()
            self._probe_scheduler = sched
        self._start_rescan_job()

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
        rescan = self._rescan_scheduler
        if rescan is not None:
            if rescan.running:
                rescan.shutdown(wait=False)
            self._rescan_scheduler = None
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=timeout)
        # No new ticks after this; then wait (bounded) for an in-flight
        # one. Once the lock is ours, _shutdown is already set, so any
        # tick the executor still starts returns without probing.
        sched = self._probe_scheduler
        probe_idle = True
        if sched is not None:
            if sched.running:
                sched.shutdown(wait=False)
            probe_idle = self._probe_lock.acquire(timeout=timeout)
            if probe_idle:
                self._probe_lock.release()
        # Forget only a thread that is genuinely gone. A live one still
        # holds something the next caller must not race.
        joined = True
        if t is not None and t.is_alive():
            joined = False
        else:
            self._thread = None
        if not probe_idle:
            joined = False
        else:
            self._probe_scheduler = None
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
        start(), then periodically by `_probe_tick` so the user-visible
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

    def _probe_tick(self) -> None:
        """Scheduler job: re-probe upstreams, run every
        `upstream_probe_interval_s` while the pipeline is started. A tick
        that starts after stop() set shutdown does nothing.

        Also the flatline edge-detector's clock (WARP-1058): the
        `input_flatlined` flag is computed on status() reads, so this is
        the one place inside voice-io that periodically observes it and
        can emit the dsp_wedge / dsp_recovered transition events.
        """
        self._check_capture_liveness()
        with self._probe_lock:
            if self._shutdown.is_set():
                return
            try:
                self._probe_upstreams()
            except Exception:  # pragma: no cover
                logger.exception("upstream probe tick crashed")
            try:
                self._check_flatline_transition()
            except Exception:  # pragma: no cover
                logger.exception("flatline transition check crashed")
            try:
                self._maybe_repick_flatlined_input()
            except Exception:  # pragma: no cover
                logger.exception("input re-pick tick crashed")
            try:
                self._maybe_auto_recover_dsp()
            except Exception:  # pragma: no cover
                logger.exception("dsp auto-recovery tick crashed")

    def _check_capture_liveness(self) -> None:
        """Exit the process when the capture thread is wedged inside
        PortAudio (WARP-3934).

        Ticked from `_rescan_tick` (5 s) and `_probe_tick` (30 s) - both
        APScheduler jobs, so it still runs while the capture thread is stuck
        in C. The capture thread stamps `_capture_io_since` before every
        PortAudio call (device probe + open, each `stream.read()`, the
        close, the re-enumeration) and clears it when the call returns; a
        healthy read returns every ~80 ms. If one call has been in flight
        for more than `capture_stall_s`, the ALSA host API is spinning on a
        removed / re-enumerated USB device (libportaudio2 19.6.0 never
        raises there), the reopen flag and `_DeviceError` path can never
        run, and only a process restart recovers. One-shot: fires at most
        once.

        Judged in every pipeline state: the device drops mid-capture
        (`transcribing`, where the loop is still draining the stream for
        the sidecar) as easily as while `listening`, and judging only
        `listening` left that wedge deaf forever. A voice turn itself
        (`transcript_ready` / `speaking`, and the STT finish) is never
        judged: it runs inside `_on_frame`, outside any PortAudio call, so
        the stamp is clear for its whole duration however long it takes.
        no_mic / error / idle / loading hold no PortAudio call either."""
        if self._capture_stall_s <= 0:
            return
        with self._lock:
            if self._capture_stall_fired:
                return
            since = self._capture_io_since
            if since is None:
                return
            stalled_for = time.monotonic() - since
            if stalled_for <= self._capture_stall_s:
                return
            self._capture_stall_fired = True
            state = self._state
        reason = (
            f"capture thread made no progress for {stalled_for:.0f}s "
            f"(state={state}) - PortAudio is wedged on a removed/re-enumerated "
            "device; exiting so the container supervisor restarts voice-io"
        )
        logger.error(reason)
        # No activity event: the orchestrator's voiceEventSchema is a fixed
        # enum (see voice/activity.py EVENT_TYPES) and the process is about
        # to exit anyway.
        try:
            self._on_capture_stall(reason)
        except Exception:  # pragma: no cover - defensive
            logger.exception("capture-stall handler raised")

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

    # ──────────────────────────────────────────────────────────────
    # Warm on wake (WARP-3127)
    # ──────────────────────────────────────────────────────────────

    def _maybe_warm_llm(self) -> None:
        """Ask the LLM backend to start loading its model — off-thread.

        Called from the wake-fire site on the 'wake-pipeline' capture thread,
        so it must never block and never raise: the warm itself runs on a
        short-lived daemon thread ('llm-warm') and this returns as soon as
        that thread is started. Skipped when:

          - there is no LLM (nothing to warm);
          - STT is absent or unreachable: the interaction ends at the
            detection (wake_heard), no turn follows, so a load would only
            take the GPU;
          - a warm was handed off less than DEFAULT_LLM_WARM_DEBOUNCE_S ago
            (monotonic), or the previous one is still running.

        Every failure is swallowed at DEBUG: a missed warm only loses the
        head start — the turn itself still loads the model.
        """
        try:
            llm = self._llm
            if llm is None:
                return
            if self._stt is None or not self._stt_available:
                return
            now = time.monotonic()
            if (
                self._llm_warm_at is not None
                and now - self._llm_warm_at < DEFAULT_LLM_WARM_DEBOUNCE_S
            ):
                return
            previous = self._llm_warm_thread
            if previous is not None and previous.is_alive():
                return
            self._llm_warm_at = now
            thread = threading.Thread(
                target=self._warm_llm_worker, args=(llm,),
                name="llm-warm", daemon=True,
            )
            self._llm_warm_thread = thread
            thread.start()
        except Exception:
            logger.debug("llm warm hand-off failed (ignored)", exc_info=True)

    @staticmethod
    def _warm_llm_worker(llm: LLMClient) -> None:
        """Body of the 'llm-warm' thread. Never lets an exception escape."""
        try:
            llm.warm()
        except Exception:
            logger.debug("llm warm raised (ignored)", exc_info=True)

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
        drops off USB and re-enumerates. On this PortAudio (Debian
        libportaudio2 19.6.0) the blocked ``stream.read()`` then spins in C
        instead of erroring (WARP-3934), so the in-process self-heal cannot
        run; the capture-liveness watchdog (``_check_capture_liveness``)
        detects the stall and restarts the process on the new device.

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
        if self._active_is_xvf is not None and not self._active_is_xvf():
            # WARP-3710 - `xvf_host REBOOT 1` can only reach an XVF3800.
            # Anything else (the onboard codec picked before the USB array
            # enumerated) is handled by `_maybe_repick_flatlined_input`:
            # re-pick the device, never burn the bounded DSP budget on a
            # reboot that exits 8 and latch a power-cycle escalation.
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
    # In-process input self-heal (WARP-3710)
    # ──────────────────────────────────────────────────────────────

    def request_reopen(self, reason: str, reset_recovery: bool = False) -> int:
        """Ask the capture loop to close its stream, re-initialise
        PortAudio, re-pick the best input and reopen - in this process.

        Thread-safe and non-blocking: it only records the request and
        sets the flag the capture loop polls between frames (~80 ms). The
        stream is NEVER torn down from the caller's thread, so the
        process-wide `sd._terminate()` always runs with no stream open.
        Returns the current session generation; pass it to
        `wait_for_session` to block until the replacement stream is up.
        `reset_recovery` clears the wedge latch + attempt counters once
        the reopen lands (an operator restart, or a flatline re-pick)."""
        with self._lock:
            generation = self._session_generation
            self._reopen_reason = reason
            self._reopen_reset_recovery = (
                self._reopen_reset_recovery or reset_recovery
            )
            # Keep this under the same lock as the session-ready handshake.
            # Otherwise a fresh stream can be counted as ready in the small
            # gap between publishing the request and setting its event.
            self._reopen_requested.set()
        return generation

    def _consume_reopen_request(self) -> tuple[str, bool]:
        with self._lock:
            reason = self._reopen_reason or "reopen requested"
            reset = self._reopen_reset_recovery
            self._reopen_reason = None
            self._reopen_reset_recovery = False
            self._reopen_requested.clear()
        return reason, reset

    def wait_for_session(self, after_generation: int, timeout: float) -> bool:
        """Block until a capture session newer than `after_generation` is
        listening. False on timeout or shutdown."""
        deadline = time.monotonic() + max(0.0, timeout)
        with self._session_cv:
            while self._session_generation <= after_generation:
                if self._shutdown.is_set():
                    return False
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._session_cv.wait(remaining)
            return True

    def _reset_recovery_state(self, why: str) -> None:
        """Back to nominal: clears `wedged_escalated` / the attempt
        counters (and so `mic_fault`) after a successful re-pick."""
        with self._lock:
            had_state = (
                self._dsp_recovery != "nominal" or self._dsp_restart_attempts
            )
            self._dsp_recovery = "nominal"
            self._dsp_restart_attempts = 0
            self._dsp_last_restart_at = None
        if had_state:
            logger.info(
                "voice mic fault cleared and DSP restart counters reset (%s)",
                why,
            )

    def _maybe_repick_flatlined_input(self) -> None:
        """A flatlined input on a device that is NOT an XVF3800 is the
        wrong-device wedge (WARP-3710): the onboard analog codec was picked
        because the USB array had not enumerated yet, and it is silent.
        There is no DSP to reboot, so re-run device selection instead -
        bounded by the same cooldown as the DSP path. No-op when the
        pipeline doesn't know what the device is (legacy wiring)."""
        if self._active_is_xvf is None:
            return
        if not self.status().input_flatlined:
            # A healthy stream ends the retry cooldown. A reopen that
            # found the same silent device must preserve it or the probe
            # loop would tear down that stream again on every tick.
            with self._lock:
                self._repick_last_at = None
            return
        if self._active_is_xvf():
            return  # a real XVF - the DSP path owns this
        now = time.time()
        with self._lock:
            last = self._repick_last_at
            if last is not None and now - last < self._dsp_recovery_cooldown_s:
                return
            self._repick_last_at = now
        logger.warning(
            "voice input flatlined on a device that is not an XVF3800 - "
            "re-running device selection instead of a DSP reboot",
        )
        self.request_reopen(
            "input flatlined on a non-XVF device", reset_recovery=True,
        )

    def _start_rescan_job(self) -> None:
        """Hot-plug rescan as an APScheduler interval job (no `while`
        loop). Needs a fingerprint source and an interval."""
        if (
            self._device_fingerprint is None
            or self._device_rescan_interval_s <= 0
        ):
            return
        try:
            self._last_fingerprint = self._device_fingerprint()
        except Exception:  # pragma: no cover - defensive
            self._last_fingerprint = None
        sched = BackgroundScheduler(daemon=True)
        sched.add_job(
            self._rescan_tick,
            "interval",
            seconds=self._device_rescan_interval_s,
            id="device-rescan",
            max_instances=1,
            coalesce=True,
        )
        sched.start()
        self._rescan_scheduler = sched

    def _rescan_tick(self) -> None:
        """Scheduler job: when the host's audio-card set changed (a USB
        array enumerated late, or re-enumerated), re-pick. Cheap - one
        sysfs listing; PortAudio is only re-initialised by the capture
        loop once its stream is closed.

        Also the capture-liveness watchdog's fast clock (WARP-3934): it runs
        first, before the early returns, so it ticks even with no
        fingerprint source wired."""
        self._check_capture_liveness()
        if self._shutdown.is_set() or self._device_fingerprint is None:
            return
        try:
            fingerprint = self._device_fingerprint()
        except Exception:  # pragma: no cover - defensive
            logger.debug("device fingerprint raised", exc_info=True)
            return
        if fingerprint is None:
            return  # sysfs unavailable - can't tell, don't churn
        if self._last_fingerprint is None:
            self._last_fingerprint = fingerprint
            return
        if fingerprint == self._last_fingerprint:
            return
        logger.info(
            "audio hardware changed (%s -> %s) - rescanning input devices",
            self._last_fingerprint, fingerprint,
        )
        self._last_fingerprint = fingerprint
        self.request_reopen("audio hardware changed")

    @property
    def input_device_index(self) -> Optional[int]:
        return self._input_device_index

    def set_output_device_index(self, index: Optional[int]) -> None:
        """Follow a re-enumeration on the output side: PortAudio indices
        shift when cards come and go, and the speaker path would otherwise
        keep playing to a stale index."""
        if index is None:
            return
        if index != self._output_device_index:
            logger.info(
                "wake pipeline: output device index %s -> %s",
                self._output_device_index, index,
            )
        self._output_device_index = index

    @property
    def flatline_gate_dbfs(self) -> float:
        """The raw-domain level at/below which a capture counts as
        digital silence (gain-compensated, same gate as the watchdog)."""
        return self._flatline_dbfs - 20.0 * math.log10(self._input_gain)

    def capture_input(self, duration_s: float) -> np.ndarray:
        """Tap `duration_s` of RAW mono 16 kHz int16 off the wake loop's
        already-open stream (never a second PortAudio stream - the mic is
        exclusive). Safe while the wake pipeline runs: the loop just
        copies frames into the tap. Raises MeasurementUnavailable."""
        with self._lock:
            if self._capture_tap is not None:
                raise MeasurementUnavailable(
                    "A mic test is already in progress - try again in a moment."
                )
            if self._state in ("error", "no_mic", "idle"):
                raise MeasurementUnavailable(
                    "The microphone isn't capturing right now "
                    f"(state={self._state}) - no live audio to test."
                )
            self._capture_tap = []
        try:
            self._shutdown.wait(max(0.0, float(duration_s)))
        finally:
            with self._lock:
                frames = self._capture_tap
                self._capture_tap = None
        if not frames:
            raise MeasurementUnavailable(
                "No audio arrived during the test window - the microphone "
                "stopped delivering audio."
            )
        pcm = np.concatenate(frames)
        if pcm.size < 0.5 * duration_s * WAKE_SAMPLE_RATE:
            raise MeasurementUnavailable(
                "The microphone delivered only part of the test window."
            )
        return pcm

    def play_capture(self, pcm: np.ndarray) -> bool:
        """Play a captured clip (16 kHz int16 mono) through the output at
        the current volume, wake detection suppressed while it plays (the
        speaker bleeding into the mic must not fire the wake word).
        False when something else is speaking."""
        from voice.audio_io import play as _play
        if not self._speak_lock.acquire(blocking=False):
            return False
        try:
            with self._lock:
                prev_state = self._state
                if prev_state not in ("error", "no_mic"):
                    self._state = "speaking"
            try:
                out = pcm
                if self._volume is not None:
                    gain = self._volume.gain()
                    if gain <= 0.0:
                        return True
                    out = apply_gain(pcm, gain)
                _play(
                    out,
                    samplerate=WAKE_SAMPLE_RATE,
                    device=self._output_device_index,
                )
            finally:
                self._restore_state_after_speak(prev_state)
            return True
        finally:
            self._speak_lock.release()

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
                # A latched fault already drops every frame, so anti-feedback
                # holds without 'speaking' — and entering it would let the
                # restore / _fail_turn below report a deaf pipeline as
                # 'listening' with /health 200 (WARP-3199).
                if prev_state not in ("error", "no_mic"):
                    self._state = "speaking"
                self._last_response = text
                self._last_response_at = time.time()

            try:
                audio = self._tts.synthesize(text, voice=voice)
            except Exception as exc:  # noqa: BLE001 — any synth failure ends the turn
                # Not just TTSUnavailable: WyomingTTS reuses stt.py's wire
                # helpers, so Piper dropping mid-event raises STTUnavailable.
                # Escaping here stranded the pipeline in 'speaking' (WARP-3199).
                # Anything else is a bug — keep its traceback.
                logger.warning(
                    "TTS synthesize failed: %r", exc,
                    exc_info=not isinstance(exc, _TTS_WIRE_FAULTS),
                )
                self._fail_turn(f"TTS synthesize failed: {exc}")
                return {"ok": False, "error": str(exc), "duration_s": 0.0}

            # Play. Skip if the synthesized audio is empty (e.g. empty text).
            if not audio.pcm:
                self._restore_state_after_speak(prev_state)
                return {"ok": True, "duration_s": 0.0, "sample_rate": audio.sample_rate}

            try:
                self._play_pcm(audio)
            except Exception as exc:
                # Mid-playback failure still drove the speaker for some of
                # the reply, so the same anti-feedback window applies: the
                # partial Piper output can bleed into the mic and score
                # above threshold. Arm the post-speak cooldown here too —
                # _restore_state_after_speak (which normally sets it) does
                # NOT run on this path.
                self._fail_turn(f"playback failed: {exc}", drove_speaker=True)
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
        """Hand the PCM to sounddevice at the current output volume.
        Blocking.

        The one playback choke point — speak(), every streamed sentence and
        every spoken cue land here — so this is where the volume gain goes:
        on the int16 array, before audio_io.play (whose signature is
        unchanged). The gain is read per call, so a change lands on the
        next sentence. When the output is silent (muted, or an explicit
        level 0) nothing is played at all; the callers' state transitions
        and post-speak cooldown run exactly as for an audible reply.
        """
        # sounddevice wants a numpy array. We get int16 mono from Piper —
        # the playback driver in audio_io.play handles dtype + rate.
        import numpy as _np
        from voice.audio_io import play as _play
        pcm = _np.frombuffer(audio.pcm, dtype=_np.int16)
        if audio.channels > 1:
            pcm = pcm.reshape(-1, audio.channels)
        if self._volume is not None:
            gain = self._volume.gain()
            if gain <= 0.0:
                return
            pcm = apply_gain(pcm, gain)
        _play(pcm, samplerate=audio.sample_rate, device=self._output_device_index)

    def _output_audible(self) -> bool:
        """Whether speech played now would be heard (not muted, level > 0)."""
        return self._volume is None or self._volume.gain() > 0.0

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
        self,
        chunks: Iterable[Union[str, SpokenCue]],
        voice: Optional[str] = None,
    ) -> dict[str, Any]:
        """Synthesize + play a STREAM of sentence chunks as ONE utterance.

        The multi-sentence sibling of speak(). Everything the shared
        reSpeaker mic/speaker needs is held ONCE for the whole utterance,
        never per-sentence:

          * ONE non-blocking `_speak_lock` acquire — a concurrent
            POST /voice/say (or a second wake→speak) sees `already_speaking`,
            not a per-sentence race.
          * State goes to 'speaking' at the first audio (a cue or a
            sentence) and stays there until the last; the pipeline thread is
            busy here so wake detection can't run, and status() reports
            'speaking' throughout.
          * `_speak_ended_at` is stamped ONCE at the true end, so the 2 s
            post-speak cooldown fires once after the LAST sentence.

        Synth-ahead (WARP-3124): a per-turn producer thread reads `chunks`
        and synthesizes while this thread plays, so sentence N+1 is
        synthesized (and the reply stream keeps being read) while sentence
        N plays — see `_run_speak_chunks`. `SpokenCue` items in `chunks`
        become a short cue phrase (at most one per utterance, never once
        the answer has started).

        `chunks` is consumed lazily and MAY raise LLMUnavailable mid-stream
        (the SSE broke) — that's surfaced like a synth failure. Returns a
        result dict: ok / duration_s / spoke_any (an ANSWER sentence played)
        / error / error_kind (tts | playback | llm, or busy when another
        utterance holds the speaker), plus the turn-timing fields
        first_audio_at / first_answer_audio_at (time.monotonic) / cue /
        sentences (answer chunks played — a first clause split off under
        WARP-3729 counts as one) / first_chunk_chars.
        """
        if self._tts is None or not self._tts_available:
            return {
                "ok": False, "error": "TTS unavailable", "error_kind": "tts",
                "duration_s": 0.0, "spoke_any": False,
            }
        # ONE lock for the WHOLE utterance. Non-blocking so a second speaker
        # never queues audio to play out of order (same contract as speak()).
        if not self._speak_lock.acquire(blocking=False):
            return {
                "ok": False, "error": "already_speaking", "error_kind": "busy",
                "duration_s": 0.0, "spoke_any": False,
            }
        try:
            return self._run_speak_chunks(chunks, voice)
        finally:
            self._speak_lock.release()

    def _run_speak_chunks(
        self, chunks: Iterable[Union[str, SpokenCue]], voice: Optional[str],
    ) -> dict[str, Any]:
        """Run one utterance as producer + consumer (WARP-3124 synth-ahead)
        under the already-held `_speak_lock`. Caller (`_speak_chunks`) owns
        the lock lifecycle.

        The producer ('voice-synth' thread, `_produce_speech`) pulls
        `chunks`, synthesizes, and hands `_SpeechItem`s over a bounded
        `_SynthAheadChannel`; this (turn) thread plays them in order
        (`_play_utterance`). The producer is the ONLY thread that advances
        the chunk generator, so it is also the one that closes it —
        Python refuses to close a generator another thread is running.
        Closing it propagates GeneratorExit into the reply stream, which
        tears down the in-flight SSE, so the orchestrator sees the client
        disconnect and ABORTS its agent loop (WARP-329) instead of finishing
        a reply nobody will hear. On any exit this thread closes the
        channel (waking a producer parked in put()) and joins the producer,
        bounded by SYNTH_PRODUCER_JOIN_TIMEOUT_S."""
        chunk_iter = iter(chunks)
        channel = _SynthAheadChannel(SYNTH_AHEAD_DEPTH)
        producer = threading.Thread(
            target=self._produce_speech,
            args=(chunk_iter, voice, channel),
            name="voice-synth",
            daemon=True,
        )
        try:
            producer.start()
        except RuntimeError as exc:  # thread exhaustion
            # The generator never ran on another thread, so closing it
            # here is safe — and still aborts the orchestrator turn.
            _close_quietly(chunk_iter)
            self._fail_turn(f"voice reply failed (tts): synth thread: {exc}")
            return {
                "ok": False, "error": str(exc), "error_kind": "tts",
                "duration_s": 0.0, "spoke_any": False, "sentences": 0,
            }
        try:
            return self._play_utterance(channel)
        finally:
            channel.close()
            producer.join(SYNTH_PRODUCER_JOIN_TIMEOUT_S)
            if producer.is_alive():
                logger.warning(
                    "voice synth producer still busy %.1fs after the utterance "
                    "ended — it closes the reply stream as soon as its current "
                    "step returns",
                    SYNTH_PRODUCER_JOIN_TIMEOUT_S,
                )

    def _produce_speech(
        self,
        chunk_iter: Iterator[Union[str, SpokenCue]],
        voice: Optional[str],
        channel: _SynthAheadChannel,
    ) -> None:
        """Synth-ahead producer — runs on the per-turn 'voice-synth' thread.

        Bounded: one pass over `chunk_iter`, ending when the reply stream
        ends, the turn thread closes the channel, or shutdown is signalled.
        Touches no pipeline state (the turn thread owns state, lock and
        cooldown); its only outputs are channel items and the terminal
        `_SpeakFailure`. Cue rules live here because this is where the
        answer is first seen: a cue is queued at most once per utterance,
        and never after an answer sentence has been taken from the stream.
        """
        failure: Optional[_SpeakFailure] = None
        cue_taken = False
        answer_started = False
        try:
            for item in chunk_iter:  # may raise LLMUnavailable (SSE broke)
                if channel.closed or self._shutdown.is_set():
                    break
                if isinstance(item, SpokenCue):
                    if cue_taken or answer_started:
                        continue
                    cue_taken = True
                    audio = self._cue_audio(item.kind)
                    if audio is not None and not channel.put(
                        _SpeechItem(audio=audio, cue=item.kind),
                    ):
                        break
                    continue
                text = item.strip() if item else ""
                if not text:
                    continue
                answer_started = True
                try:
                    audio = self._tts.synthesize(text, voice=voice)  # type: ignore[union-attr]
                except _TTS_WIRE_FAULTS as exc:
                    # WyomingTTS raises STTUnavailable when Piper drops the
                    # socket mid-event (WARP-3199) — a wire fault, not a bug.
                    failure = _SpeakFailure("tts", exc)
                    break
                except Exception as exc:  # noqa: BLE001 — see below
                    # The turn thread is waiting on this channel: an escaped
                    # exception would strand it. Surface it as a TTS fault.
                    logger.exception("voice synthesis raised unexpectedly")
                    failure = _SpeakFailure("tts", exc)
                    break
                if not channel.put(_SpeechItem(audio=audio, text=text)):
                    break
        except LLMUnavailable as exc:
            failure = _SpeakFailure("llm", exc)
        except Exception as exc:  # noqa: BLE001 — same reason as above
            logger.exception("voice reply stream raised unexpectedly")
            failure = _SpeakFailure("llm", exc)
        finally:
            # Close BEFORE finishing the channel, so by the time the turn
            # thread sees the end (or the failure) the SSE is already torn
            # down. A no-op when the stream ran to completion.
            _close_quietly(chunk_iter)
            channel.finish(failure)

    def _play_utterance(self, channel: _SynthAheadChannel) -> dict[str, Any]:
        """The consumer half: play every item the producer hands over, in
        order, on the turn thread. Owns 'speaking', `_last_response`, the
        error surface and the single cooldown."""
        prev_state: Optional[PipelineState] = None  # None until first item
        spoke_any = False       # an ANSWER sentence reached the speaker
        drove_speaker = False   # any audio (cue or answer) reached it
        total_duration = 0.0
        spoken: list[str] = []
        first_error: Optional[BaseException] = None
        error_kind: Optional[str] = None
        first_audio_at: Optional[float] = None
        first_answer_audio_at: Optional[float] = None
        cue: Optional[str] = None
        # Answer CHUNKS played. Since WARP-3729 the chunker may split the
        # first clause off, so a one-sentence reply can count 2 here;
        # first_chunk_chars (length of the chunk behind the first answer
        # audio) lets the box timing be read by whether that happened.
        sentences = 0
        first_chunk_chars: Optional[int] = None
        for item in channel:
            if isinstance(item, _SpeakFailure):
                first_error, error_kind = item.error, item.kind
                break
            if self._shutdown.is_set():
                break
            # Enter 'speaking' at the FIRST audio item — a cue or a sentence —
            # and hold it for the rest of the utterance.
            if prev_state is None:
                with self._lock:
                    prev_state = self._state
                    self._state = "speaking"
            if item.text is not None:
                spoken.append(item.text)
                with self._lock:
                    self._last_response = " ".join(spoken)
                    self._last_response_at = time.time()
            if not item.audio.pcm:
                continue
            drove_speaker = True
            started = time.monotonic()
            if first_audio_at is None:
                first_audio_at = started
            if item.cue is not None:
                cue = item.cue
            elif first_answer_audio_at is None:
                first_answer_audio_at = started
                first_chunk_chars = len(item.text or "")
            try:
                self._play_pcm(item.audio)
            except Exception as exc:  # noqa: BLE001 — surfaced below
                first_error, error_kind = exc, "playback"
                break
            total_duration += item.audio.duration_s
            if item.cue is None:
                spoke_any = True
                sentences += 1

        timing = {
            "first_audio_at": first_audio_at,
            "first_answer_audio_at": first_answer_audio_at,
            "cue": cue,
            "sentences": sentences,
            "first_chunk_chars": first_chunk_chars,
        }
        if first_error is None:
            # Success (possibly empty — nothing streamed). Restore state +
            # arm the single post-speak cooldown if anything reached the
            # speaker — a cue alone can bleed into the mic too.
            self._finish_utterance(prev_state, spoke=drove_speaker)
            return {
                "ok": True, "duration_s": total_duration, "spoke_any": spoke_any,
                **timing,
            }

        # Error path: surface it, and arm the cooldown if we drove the
        # speaker at all — even a partial reply can bleed into the shared
        # mic (same contract as speak()'s mid-playback failure).
        self._fail_turn(
            f"voice reply failed ({error_kind}): {first_error}",
            drove_speaker=drove_speaker,
        )
        return {
            "ok": False,
            "error": str(first_error),
            "error_kind": error_kind,
            "duration_s": total_duration,
            "spoke_any": spoke_any,
            **timing,
        }

    # ──────────────────────────────────────────────────────────────
    # Spoken cues (WARP-3124)
    # ──────────────────────────────────────────────────────────────

    def prime_cues(self) -> int:
        """Pre-synthesize and cache every cue phrase, so a cue plays with no
        Piper round trip. main.py calls this once from its warm-up thread,
        after the Piper voice is loaded. Best-effort and never raises;
        skipped while TTS is unreachable (a cue then synthesizes on first
        use). Returns how many cues are cached."""
        if self._tts is None or not self._tts_available:
            return 0
        for kind in CUE_PHRASES:
            self._synthesize_cue(kind)
        with self._lock:
            return len(self._cue_cache)

    def _cue_audio(self, kind: str) -> Optional[SynthesizedAudio]:
        """The cue's PCM — cached, else synthesized now. None when it can't
        be had: a cue is optional and never fails a turn."""
        voice_key = getattr(self._tts, "voice_cache_key", None)
        with self._lock:
            if voice_key != self._cue_voice_cache_key:
                self._cue_cache.clear()
                self._cue_voice_cache_key = voice_key
            cached = self._cue_cache.get(kind)
        if cached is not None:
            return cached
        return self._synthesize_cue(kind)

    def _synthesize_cue(self, kind: str) -> Optional[SynthesizedAudio]:
        text = CUE_PHRASES.get(kind)
        if not text or self._tts is None:
            return None
        voice_key = getattr(self._tts, "voice_cache_key", None)
        try:
            audio = self._tts.synthesize(text)
        except Exception as exc:  # noqa: BLE001 — a cue is optional
            logger.info("voice cue %r not synthesized: %s", kind, exc)
            return None
        if not audio.pcm:
            return None
        # A settings save may arrive while synthesis is in progress. That
        # utterance can finish, but its audio must not become the new voice's cue.
        if voice_key != getattr(self._tts, "voice_cache_key", None):
            return audio
        with self._lock:
            if voice_key != self._cue_voice_cache_key:
                self._cue_cache.clear()
                self._cue_voice_cache_key = voice_key
            self._cue_cache[kind] = audio
        return audio

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
        the LLM delivers the whole reply in one delta, the chunker still
        splits it into sentences so playback of sentence 1 starts before the
        rest is synthesized. WARP-3729: the first chunk may be the first
        CLAUSE of the answer (', ' at >= 24 chars; ';'/':' at >= 12) —
        the persona's one-sentence replies otherwise make the first chunk
        the whole reply, so first audio waited for all of it.

        WARP-3124: reads `reply_events`, so `SpokenCue` markers pass through
        in order — straight to the speak path, never into the chunker — and
        the result carries `first_delta_at` (time.monotonic of the first
        content delta) for the turn timing. The generator runs on the
        synth-ahead producer thread; `first_delta` is written there once and
        read here only after the utterance is over."""
        first_delta: list[float] = []

        def _chunks() -> Iterator[Union[str, SpokenCue]]:
            # WARP-3729: passed explicitly so the only knob — a code
            # constant, no env var — is visible where it takes effect.
            # first_clause_min_chars=None is the one-line rollback to
            # sentence-only first chunks.
            chunker = SentenceChunker(
                first_clause_min_chars=DEFAULT_FIRST_CLAUSE_MIN_CHARS,
                soft_max_chars=DEFAULT_CLAUSE_SOFT_MAX_CHARS,
            )
            stream = self._llm.reply_events(transcript, tool_choice=tool_choice)  # type: ignore[union-attr]
            try:
                for item in stream:
                    if isinstance(item, SpokenCue):
                        yield item
                        continue
                    if item and not first_delta:
                        first_delta.append(time.monotonic())
                    for sentence in chunker.push(item):
                        yield sentence
                for sentence in chunker.flush():
                    yield sentence
            finally:
                # Close the SSE explicitly (not via GC) so an early bail-out
                # tears the orchestrator stream down deterministically — see
                # the WARP-329 note in _run_speak_chunks.
                _close_quietly(stream)

        result = self._speak_chunks(_chunks())
        result["first_delta_at"] = first_delta[0] if first_delta else None
        return result

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
                # A copy: the snapshot must not alias pipeline state.
                last_turn_timing=(
                    dict(self._last_turn_timing)
                    if self._last_turn_timing is not None
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
            except _ReopenRequested:
                if self._shutdown.is_set():
                    return
                # WARP-3710 - a deliberate swap, not a fault: the stream
                # context already closed on the way out, so NOW (and only
                # now) PortAudio can be re-initialised safely. Re-init,
                # re-pick (best score wins - voice/devices.py stays
                # authoritative) and go round again with no backoff.
                reason, reset_recovery = self._consume_reopen_request()
                previous = self._input_device_index
                logger.info(
                    "wake pipeline: reopening the input in-process (%s)",
                    reason,
                )
                self._set_state("loading")
                self._refresh_audio_enumeration(sd)
                self._reresolve_input_device()
                if reset_recovery or self._input_device_index != previous:
                    # A fresh device (or an operator's explicit restart)
                    # voids the old wedge history: clear the latch and the
                    # attempt counters so mic_fault can read healthy again.
                    self._reset_recovery_state(reason)
                backoff = self._recover_backoff_initial_s
                continue
            except _DeviceError as exc:
                if self._shutdown.is_set():
                    return
                self._note_recover_failure(exc)
                self._set_state("no_mic")
                # Refresh PortAudio's cached device list, then re-resolve
                # the (possibly shifted) input index BEFORE the next open.
                previous = self._input_device_index
                self._refresh_audio_enumeration(sd)
                self._reresolve_input_device()
                if self._reopen_requested.is_set():
                    # An operator can request a restart while the stream
                    # is already absent. No live session can raise
                    # _ReopenRequested in that state, so consume the
                    # request here instead of skipping backoff forever
                    # with a permanently-set flag.
                    reason, reset_recovery = self._consume_reopen_request()
                    if reset_recovery or self._input_device_index != previous:
                        self._reset_recovery_state(reason)
                    backoff = self._recover_backoff_initial_s
                    continue
                # Bounded, interruptible backoff so a genuinely-absent mic
                # doesn't hot-loop. Stays in no_mic while waiting; drops
                # out instantly if stop() fires mid-wait.
                if not self._reopen_requested.is_set() and self._shutdown.wait(
                    backoff
                ):
                    return
                if self._shutdown.is_set():
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

        # Everything from here to the first frame is PortAudio - the channel
        # probe, the rate negotiation, the open and the start. Stamp the
        # window so a device that wedges while being opened trips the
        # liveness watchdog exactly like a wedged read (WARP-3934).
        self._capture_io_since = time.monotonic()
        try:
            # Capture at the device's NATIVE input-channel count. Many USB
            # mic arrays — notably the ReSpeaker XVF3800 — expose ONLY a
            # 2-channel capture interface (no mono altset) and hand back
            # digital silence when opened as mono on the raw hw device. We
            # open the native count (capped at 2) and downmix to a 1-D mono
            # frame, which is what the detector + STT both expect.
            # Best-effort channel-count probe — broad except on purpose: a
            # failure here just falls back to mono (1 ch), it is NOT the
            # device-disconnect trigger (the load-bearing open/read is).
            in_channels = 1
            try:
                info = sd.query_devices(self._input_device_index)
                in_channels = max(
                    1, min(2, int(info.get("max_input_channels") or 1)),
                )
            except Exception:
                in_channels = 1

            # Capture at a rate the device actually accepts, then resample
            # to WAKE_SAMPLE_RATE below. See CAPTURE_RATE_CANDIDATES.
            open_rate = self._resolve_capture_rate(sd, in_channels)
            read_frames = WAKE_FRAME_SAMPLES * open_rate // WAKE_SAMPLE_RATE
            # Design the polyphase filter ONCE for this session. The rate
            # pair is fixed until the stream is reopened, and the read loop
            # below runs ~12 times a second forever — re-deriving the ratio
            # and re-designing a Kaiser FIR per frame is pure waste (8821
            # taps on a 44.1 kHz device). Identity function at 16 kHz.
            resample_to_wake_rate = make_int16_resampler(
                open_rate, WAKE_SAMPLE_RATE,
            )

            # Open + start explicitly rather than through `with`, so the
            # stop/close on the way out (PortAudio calls too) can sit inside
            # their own watchdog window below.
            try:
                stream_cm = sd.InputStream(
                    samplerate=open_rate,
                    channels=in_channels,
                    dtype="int16",
                    device=self._input_device_index,
                    blocksize=read_frames,
                )
                stream = stream_cm.__enter__()
            except device_errors as exc:
                raise _DeviceError(str(exc) or exc.__class__.__name__) from exc
        finally:
            self._capture_io_since = None

        try:
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
            with self._lock:
                # A mic restart can arrive while the supervisor is retrying
                # an absent device. Do not tell its waiter that this stream
                # is ready if it was opened against the pre-restart device
                # cache and a re-pick is still pending. The context manager
                # closes this stream before the supervisor re-initializes
                # PortAudio and resolves the current device list.
                reopen_pending = self._reopen_requested.is_set()
                if not reopen_pending:
                    self._session_generation += 1
                    self._session_cv.notify_all()
            if reopen_pending:
                raise _ReopenRequested(
                    self._reopen_reason or "reopen requested",
                )
            while not self._shutdown.is_set():
                if self._reopen_requested.is_set():
                    raise _ReopenRequested(
                        self._reopen_reason or "reopen requested",
                    )
                # Tight device-I/O scope: ONLY the read is wrapped, so a
                # re-enumeration mid-stream becomes a recoverable
                # _DeviceError. _on_frame() runs outside this scope - and
                # outside the WARP-3934 watchdog window, which covers
                # exactly the time spent inside PortAudio.
                self._capture_io_since = time.monotonic()
                try:
                    frames, overflowed = stream.read(read_frames)
                except device_errors as exc:
                    raise _DeviceError(str(exc) or exc.__class__.__name__) from exc
                finally:
                    self._capture_io_since = None
                if overflowed:
                    # Capture buffer outran our predict() pace. Common
                    # on first run while ONNX kernels JIT; logs once
                    # to avoid spam.
                    logger.debug("wake pipeline: input buffer overflow")
                # frames is shape (read_frames, in_channels) int16.
                # Reduce to a mono 1-D frame for the detector + STT:
                # channel 0 by default (the primary/processed channel on
                # mic arrays — see DEFAULT_INPUT_DOWNMIX), mean across
                # channels when configured; a 1-channel device just
                # flattens. Same helper the one-shot record() path uses.
                #
                # Downmix FIRST, then resample: one channel through the
                # polyphase filter instead of two, for identical output.
                mono = downmix_to_mono(frames, self._input_downmix)
                mono = resample_to_wake_rate(mono)
                # The RAW mono frame goes to _on_frame; the digital input
                # gain is applied THERE, after level tracking, so
                # input_rms_dbfs stays in the same pre-gain domain as
                # /audio/measure and the stored calibration floor
                # (WARP-1055 — a gained RMS compared against a raw floor
                # read as permanent noise drift on the dashboard).
                self._on_frame(mono)
        finally:
            # Stop + close are PortAudio calls as well: a close that spins
            # on a dead device node must trip the watchdog like a read.
            self._capture_io_since = time.monotonic()
            try:
                stream_cm.__exit__(*sys.exc_info())
            finally:
                self._capture_io_since = None

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

        The restatement stays at WARNING. Throttling the volume is the
        point; demoting the level is not, because the restatement is then
        the only remaining signal that the mic is STILL dead, and alerting
        keyed on level=WARNING would go quiet on an ongoing fault.

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
            logger.warning(
                "wake pipeline: same audio-device error unresolved after "
                "%d attempts (%s)",
                self._recover_repeat_count, reason,
            )

    def _refresh_audio_enumeration(self, sd: Any) -> None:
        """Drop PortAudio's cached device list so a re-enumerated mic
        becomes visible to the next resolve/open. PortAudio snapshots the
        host's devices at first query; without a terminate+initialize the
        re-plugged reSpeaker never reappears. Defensive: a binding without
        the private hooks (or one that raises) must not crash the loop.
        Inside the WARP-3934 watchdog window: terminate/initialize are
        PortAudio calls that can wedge on a half-gone device too."""
        self._capture_io_since = time.monotonic()
        try:
            self._sd_reinit(sd)
        except Exception:
            logger.exception(
                "wake pipeline: PortAudio re-init failed (continuing)",
            )
        finally:
            self._capture_io_since = None

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

        The end-of-speech VAD (_capture_frame_for_stt) reads the per-frame
        RMS stashed here, scaled by the gain, later in the same _on_frame
        call — one RMS pass per frame, threshold still post-gain (WARP-3729).
        """
        n = int(frame.size)
        if n == 0:
            self._raw_frame_rms = 0.0
            return
        # Sum of squares in float64 (int16² overflows int16/int32 sums).
        sumsq = float(np.einsum("i,i->", frame, frame, dtype=np.float64))
        frame_rms = math.sqrt(sumsq / n)
        self._raw_frame_rms = frame_rms  # pre-gain level for the VAD
        # WARP-1410 — feed an in-flight windowed measurement from this same
        # already-open stream (never a second one). `list.append` is atomic
        # under the GIL, so the pipeline thread needs no lock here; the
        # collector is swapped in/out under _lock by _start/_finish_measure.
        # Peak costs an extra pass, so it's only computed while collecting.
        # Widen to int32 first: abs(-32768) overflows int16.
        tap = self._capture_tap
        if tap is not None:
            tap.append(frame.copy())
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
        if self._detector.load_error:
            self._set_error(self._detector.load_error)
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
            # mode (its deliberate wake tests aren't misses) and while a
            # capture tap is armed (a scripted enrollment line isn't one).
            if (
                score >= self._threshold * WAKE_MISS_RATIO
                and now - self._last_miss_emit_at >= self._debounce_s
                and not self._calibration_mode_active(now)
                and self._capture_tap is None
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
            # The same while a capture tap is armed (a mic test, an
            # enrollment line, the echo check — WARP-1056/WARP-1410):
            # the person is reading "Hey Droplet, ..." off a script into
            # a capture that must keep flowing, not starting a turn.
            calibrating = self._calibration_mode_active(now)
            capturing = self._capture_tap is not None
            self._last_wake_at = event.detected_at
            self._last_wake_score = event.score
            self._last_wake_model = event.model_name
            if not (calibrating or capturing):
                self._state = "wake_detected"
                # A new turn starts clean: drop the last failed turn's
                # note (WARP-3199). A latched 'error' never reaches here —
                # _on_frame drops its frames.
                self._error_message = None
                # WARP-3124 — a handled wake starts the turn's timing.
                self._turn_timing = _TurnTiming(wake_at=time.monotonic())

        if calibrating or capturing:
            logger.info(
                "wake detected %s (model=%s score=%.3f) — counted, not handled",
                "in calibration mode" if calibrating
                else "while a capture is in progress",
                event.model_name, event.score,
            )
            # Same rationale as the decay path: don't carry a stateful
            # recognizer's half-decoded utterance into the next try.
            self._reset_detector()
            return

        # WARP-3127: start loading the chat model now, while the person is
        # still speaking. At the fire site (not in _default_on_wake) so an
        # injected on_wake can't bypass it; hands off and returns at once.
        self._maybe_warm_llm()

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
            # Mark STT unavailable so subsequent wakes don't loop on the
            # same connect-error: they end at the detection (wake_heard)
            # until the periodic probe sees the sidecar back - typically
            # within one probe interval of a Qwen restart. The turn itself
            # fails like a speak-side fault (WARP-3199): report why and keep
            # listening. Latching 'error' here left the box deaf for good,
            # because nothing ever cleared it once the probe re-detected STT.
            self._stt_available = False
            self._fail_capture(f"STT session failed: {exc}")
            return
        self._stt_session = session
        self._transcribe_started_at = time.time()
        self._stt_audio_samples = 0
        # WARP-3124 — capture-open stamp (a turn with no wake stamp, e.g. a
        # test driving STT directly, still gets a timing record).
        if self._turn_timing is None:
            self._turn_timing = _TurnTiming()
        self._turn_timing.capture_open_at = time.monotonic()
        # Reset end-of-speech (VAD) state for this turn.
        self._stt_speech_started = False
        self._stt_capture_frames = 0
        self._stt_speech_frames = 0
        self._stt_silence_frames = 0
        self._stt_voiced_frames = 0
        self._stt_pause_seen = False
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

        # Audio-time cap, checked BEFORE the send. The wall-clock cap below
        # used to be the only one and ran after the send, so a capture that
        # went the distance handed the sidecar 30.08-30.16 s of audio - and
        # the Qwen sidecar refuses anything past its 30 s input maximum, so
        # the whole turn failed with "Audio exceeds 30 seconds" exactly when
        # someone had the most to say. Count the samples actually sent and
        # finish on the frame that would cross the cap, without sending it.
        # The first frame always goes, so the sidecar never sees an empty
        # request.
        frame_samples = int(frame.size)
        cap_samples = int(self._stt_max_record_s * WAKE_SAMPLE_RATE)
        if (
            self._stt_audio_samples > 0
            and self._stt_audio_samples + frame_samples > cap_samples
        ):
            logger.info(
                "transcribing: max-record cap reached (%.1fs of audio)",
                self._stt_audio_samples / WAKE_SAMPLE_RATE,
            )
            self._mark_capture_end("cap")
            self._finish_transcription()
            return

        try:
            session.send_chunk(frame.astype(np.int16).tobytes())
        except STTUnavailable as exc:
            self._abort_transcription(f"send_chunk: {exc}")
            return
        self._stt_audio_samples += frame_samples
        self._stt_capture_frames += 1

        elapsed = time.time() - self._transcribe_started_at

        # End-of-speech (VAD): once the user has actually started talking,
        # finish as soon as we see a short run of trailing silence — so the
        # box stops listening the moment they finish their statement rather
        # than holding the mic for the whole max-record window. Decided on
        # the pre-gain RMS _track_input_level stashed for this frame, times
        # the input gain: the same post-calibration level the detector
        # hears (a box calibrated to gain 8 speaks at ~100-200 raw), without
        # a second RMS pass over the gained frame (WARP-3729).
        loud = self._raw_frame_rms * self._input_gain >= self._vad_speech_rms
        if loud and self._stt_capture_frames <= self._vad_wake_tail_frames:
            loud = False  # the wake phrase's own tail (VAD_WAKE_TAIL_S)
        if loud:
            if (
                self._stt_speech_started
                and self._stt_silence_frames >= self._vad_pause_frames
            ):
                self._stt_pause_seen = True
            self._stt_speech_started = True
            self._stt_speech_frames += 1
            self._stt_silence_frames = 0
        elif self._stt_speech_started:
            self._stt_silence_frames += 1
        if self._stt_speech_started:
            self._stt_voiced_frames += 1
            # A short, fluent command (voiced span up to 1.2 s, no pause
            # inside it) ends after the short tail; anything longer, or a
            # speaker who already paused mid-sentence, keeps the long one.
            voiced_span = self._stt_voiced_frames - self._stt_silence_frames
            short = (
                self._vad_silence_short_frames < self._vad_silence_frames
                and voiced_span <= self._vad_short_utterance_frames
                and not self._stt_pause_seen
            )
            tail = self._vad_silence_short_frames if short else self._vad_silence_frames
            if self._stt_speech_frames >= self._vad_min_speech_frames:
                # Enough ACTUAL speech that a pause before the command can't
                # be mistaken for its end, followed by the trailing run.
                if self._stt_silence_frames >= tail:
                    logger.info(
                        "transcribing: end-of-speech (%.2fs speech, %.2fs trailing silence, %s tail)",
                        self._stt_speech_frames * self._frame_s,
                        self._stt_silence_frames * self._frame_s,
                        "short" if short else "long",
                    )
                    self._mark_capture_end("silence", "short" if short else "long")
                    self._finish_transcription()
                    return
            elif (
                self._vad_no_speech_frames
                and self._stt_silence_frames >= self._vad_no_speech_frames
            ):
                # A loud frame or two that never grew into a command (a
                # blip, a word too soft to count): the same patience as a
                # capture with no speech, then transcribe what there is.
                # This used to run to the 30 s cap.
                logger.info(
                    "transcribing: end-of-speech below min speech (%.2fs speech) after %.2fs silence (fallback tail)",
                    self._stt_speech_frames * self._frame_s,
                    self._stt_silence_frames * self._frame_s,
                )
                self._mark_capture_end("short_speech", "fallback")
                self._finish_transcription()
                return
        elif (
            self._vad_no_speech_frames
            and self._stt_capture_frames >= self._vad_no_speech_frames
        ):
            # Nothing crossed the threshold since the wake (a false wake,
            # nobody spoke): end the capture and skip STT — the sidecar
            # would only decode room noise, and the detector was paused
            # the whole time. The turn ends "empty" like a blank transcript.
            logger.info(
                "transcribing: no speech within %.1fs of the wake, not transcribing",
                self._stt_capture_frames * self._frame_s,
            )
            self._mark_capture_end("no_speech")
            self._discard_transcription()
            return

        # Hard cap so a noisy room (VAD never sees a clean silence) or a
        # runaway never holds the mic open forever.
        if elapsed >= self._stt_max_record_s:
            logger.info("transcribing: max-record cap reached (%.1fs)", elapsed)
            self._mark_capture_end("cap")
            self._finish_transcription()

    def _mark_capture_end(
        self, vad_end: str, vad_tail: Optional[str] = None,
    ) -> None:
        """WARP-3124 — stamp why and when the capture window closed, and
        which VAD tail ended it (WARP-3729; None when none did)."""
        timing = self._turn_timing
        if timing is None:
            return
        timing.capture_end_at = time.monotonic()
        timing.speech_s = self._stt_speech_frames * self._frame_s
        timing.vad_end = vad_end
        timing.vad_tail = vad_tail

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
        self._deliver_transcript(transcript)

    def _discard_transcription(self) -> None:
        """A capture with no speech in it (WARP-3729): close the session
        WITHOUT audio-stop, so the sidecar drops the connection instead of
        decoding seconds of room noise (and never answers nobody), and end
        the turn on an empty transcript through the same path a blank
        sidecar result takes — outcome "empty", one feed row,
        transcript_ready and its decay back to listening."""
        session = self._stt_session
        self._stt_session = None
        if session is None:
            return
        try:
            session.close()
        except Exception:
            pass
        self._deliver_transcript("")

    def _deliver_transcript(self, transcript: str) -> None:
        """Publish the capture's transcript and hand it to on_transcript
        (the tail of _finish_transcription, shared with the no-speech path)."""
        wake_words = getattr(self._detector, "requested_wake_word", None)
        transcript = strip_wake_prefix(
            transcript, wake_words or self._detector.model_name,
        )
        if self._turn_timing is not None:
            self._turn_timing.transcript_at = time.monotonic()  # WARP-3124

        now = time.time()
        with self._lock:
            self._last_transcript = transcript
            self._last_transcript_at = now
            self._state = "transcript_ready"

        # WARP-3193 SEC-DATA-9: the text is what the user said (PII, health
        # details, spoken passwords) and INFO logs ship in support bundles.
        # INFO carries the length; the text needs the LOG_LEVEL=DEBUG opt-in.
        logger.info("transcript ready len=%d", len(transcript))
        logger.debug("transcript: %r", transcript)
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
        self._fail_capture(msg)

    def _fail_capture(self, msg: str) -> None:
        """The capture half of a turn failed - the STT session could not be
        opened, a chunk could not be sent, or the sidecar answered an error
        instead of a transcript. The capture-side twin of `_fail_turn`
        (WARP-3199): report why on /voice/status, then keep listening.

        These faults are transient by nature - the Qwen sidecar restarting
        or still loading, a dropped socket, a request it refused - and the
        next wake is a fresh try against a dependency that has usually
        come back. Latching 'error' here (the pre-WARP-3729 posture, from
        the days of a queueing Whisper sidecar) left the assistant deaf
        until somebody restarted the container: /health went 503, but
        nothing restarts a merely unhealthy container, and the periodic
        probe that re-detected STT could not clear the latch. Stuck faults
        (the detector, the capture loop) still use _set_error, and one that
        landed mid-turn keeps its state and message.

        The turn still ends with exactly ONE `voice_turn_timing` line
        (outcome "error", error_kind "stt") and one feed row (wake_heard -
        the user was heard, nothing was answered), like every other turn.
        """
        with self._lock:
            wake_score = self._last_wake_score
            wake_model = self._last_wake_model
            latched = self._state == "error"
            if not latched:
                if self._state in ("wake_detected", "transcribing"):
                    self._state = "listening"
                self._error_message = msg
        if latched:
            return
        # Back to listening after a wake excursion: same reset the decay
        # path does, so a stateful recognizer (Vosk) doesn't carry the
        # half-decoded wake into the next turn.
        self._reset_detector()
        timing = self._turn_timing or _TurnTiming()
        self._turn_timing = None
        if timing.transcript_at is None:
            timing.transcript_at = time.monotonic()
        self._record_turn_timing(timing, "error", {"error_kind": "stt"})
        self._emit_activity(
            "wake_heard",
            score=wake_score, threshold=self._threshold, model=wake_model,
        )

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

    def _fail_turn(self, msg: str, *, drove_speaker: bool = False) -> None:
        """One voice turn failed — TTS, playback, or the LLM reply stream
        (WARP-3199). Report why on /voice/status, then keep listening: the
        next wake is a fresh try against a dependency that has usually come
        back (a TTS timeout, a dropped SSE). Latching 'error' here left the
        assistant deaf and /audio/measure refusing until voice-io restarted.
        Stuck faults (the detector, the capture loop) still use _set_error,
        and one that landed mid-turn keeps its state and message.

        `drove_speaker` arms the post-speak cooldown in the same lock hold
        as the flip to 'listening', so no frame reaches the detector in
        between (a partial reply can bleed into the mic)."""
        with self._lock:
            if drove_speaker:
                self._speak_ended_at = time.time()
            if self._state == "error":
                return
            if self._state in ("speaking", "transcript_ready"):
                self._state = "listening"
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

        WARP-3124: every turn that reaches here — answered, fragment,
        empty, no LLM, or failed — ends with exactly ONE `voice_turn_timing`
        INFO line (and /voice/status `last_turn_timing`).
        """
        timing = self._turn_timing or _TurnTiming()
        self._turn_timing = None
        if timing.transcript_at is None:
            timing.transcript_at = time.monotonic()
        outcome: str = "error"
        speak: Optional[dict[str, Any]] = None
        try:
            outcome, speak = self._answer_transcript(transcript)
        finally:
            self._record_turn_timing(timing, outcome, speak)

    def _record_turn_timing(
        self,
        timing: _TurnTiming,
        outcome: str,
        speak: Optional[dict[str, Any]],
    ) -> None:
        """Log the turn's ONE `voice_turn_timing` INFO line (JSON, ms
        fields, null where a stage didn't happen) and keep it for
        /voice/status (WARP-3124)."""
        summary = timing.summary(
            outcome=outcome, speak=speak, ended_at=time.monotonic(),
        )
        summary["ended_at"] = round(time.time(), 3)
        with self._lock:
            self._last_turn_timing = summary
        logger.info("voice_turn_timing %s", json.dumps(summary))

    def _answer_transcript(
        self, transcript: str,
    ) -> tuple[str, Optional[dict[str, Any]]]:
        """The default turn: gate the transcript, stream the LLM reply,
        speak it. Returns (outcome, speak result) for the turn timing:
        answered | no_reply | error (speak ran) or empty | fragment |
        no_llm (it didn't), or volume (a spoken volume command handled
        locally, see _answer_volume_intent)."""
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
            return "empty", None
        if not transcript_is_actionable(transcript):
            # Residual false wakes (a phonetic near-collision on the TV —
            # "hey, drop it") capture room fragments like "it." or "uh".
            # A real post-wake command always carries at least one
            # substantive word; don't send fragments to the LLM, and
            # especially don't speak an answer to the television. The
            # transcript still lands in /voice/status for diagnosis.
            logger.info(
                "transcript len=%d is a fragment, not a command — staying quiet",
                len(transcript),
            )
            self._emit_activity(
                "wake_ignored",
                score=wake_score, threshold=self._threshold, model=wake_model,
            )
            return "fragment", None
        # Spoken volume commands are handled HERE, before the LLM check and
        # the intent gate: local device control on the shared controller,
        # so "turn it up" works with the model (or the orchestrator) down.
        if self._volume is not None:
            volume_intent = classify_volume_intent(transcript)
            if volume_intent is not None:
                return self._answer_volume_intent(
                    self._volume, volume_intent,
                    wake_score=wake_score, wake_model=wake_model,
                )
        if self._llm is None or not self._llm_available:
            logger.info(
                "transcript ready (LLM unavailable, not speaking): len=%d",
                len(transcript),
            )
            self._emit_activity(
                "wake_heard",
                score=wake_score, threshold=self._threshold, model=wake_model,
            )
            return "no_llm", None
        # Intent gate: short-circuit speculative tool calls on greetings,
        # time-of-day, and who-are-you utterances. The orchestrator's
        # agent loop honors tool_choice="none" by advertising zero
        # tools — the model can only answer from its prompt, whose user
        # turn opens with the live time + location (llm.build_turn_context).
        tool_choice = classify_tool_choice(transcript)
        if tool_choice == "none":
            logger.info(
                "intent gate matched (no tools): transcript len=%d",
                len(transcript),
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
                "voice reply for transcript len=%d did not complete (%s): %s",
                len(transcript), result.get("error_kind"), result.get("error"),
            )
        # WARP-1058 — the §3.4 outcome row. "Answered" means the user
        # actually HEARD a reply; a failed / empty / rejected reply is
        # honestly just "Heard the wake word" (the fault itself surfaces via
        # error_message, not the feed). So is a reply played into a muted
        # speaker.
        self._emit_activity(
            "wake_answered" if spoke and self._output_audible() else "wake_heard",
            score=wake_score, threshold=self._threshold, model=wake_model,
        )
        if spoke:
            return "answered", result
        return ("error" if result.get("error") else "no_reply"), result

    def _answer_volume_intent(
        self,
        volume: VolumeController,
        intent: VolumeIntent,
        *,
        wake_score: Optional[float],
        wake_model: Optional[str],
    ) -> tuple[str, Optional[dict[str, Any]]]:
        """Execute a spoken volume command locally and acknowledge it.

        No LLM, no orchestrator. The acknowledgement goes through speak(),
        so it plays at the NEW level ("Volume 40."); a mute is applied
        silently; an unmute says "Unmuted." at the restored level. The
        change applies even when TTS is down. Turn outcome: "volume".
        """
        ack: Optional[str]
        if intent.kind == "set":
            ack = f"Volume {volume.set_level(intent.value).current.level}."
        elif intent.kind == "change":
            ack = f"Volume {volume.change(intent.value).current.level}."
        elif intent.kind == "mute":
            volume.set_muted(True)
            ack = None
        elif intent.kind == "unmute":
            volume.set_muted(False)
            ack = "Unmuted."
        else:  # query
            ack = f"Volume is {volume.state().level}."
        state = volume.state()
        # Length-free: the kind and the resulting state say everything, and
        # the transcript text never reaches INFO (WARP-3193 SEC-DATA-9).
        logger.info(
            "spoken volume command handled locally: %s → level=%d muted=%s",
            intent.kind, state.level, state.muted,
        )
        speak = self.speak(ack) if ack is not None else None
        if speak is not None and not speak.get("ok"):
            logger.info("volume acknowledgement not spoken: %s", speak.get("error"))
        heard = bool(
            speak is not None
            and speak.get("ok")
            and speak.get("duration_s")
            and self._output_audible()
        )
        # No volume-specific activity type exists; reuse the honest pair.
        self._emit_activity(
            "wake_answered" if heard else "wake_heard",
            score=wake_score, threshold=self._threshold, model=wake_model,
        )
        return "volume", speak
