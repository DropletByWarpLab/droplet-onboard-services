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
import re
import threading
import time
from dataclasses import asdict, dataclass
from typing import Any, Callable, Optional

import numpy as np

from voice.llm import LLMClient, LLMUnavailable, ToolChoice
from voice.stt import STTUnavailable, StreamingSTT
from voice.tts import SynthesizedAudio, TextToSpeech, TTSUnavailable
from voice.wake import (
    WAKE_FRAME_SAMPLES,
    WAKE_SAMPLE_RATE,
    WakeEvent,
    WakeWordDetector,
)

logger = logging.getLogger("voice.pipeline")


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
    # Greetings and check-ins — whole utterance only. The optional
    # wake-word prefix ("hey jarvis", "hey droplet") matches the way
    # users naturally re-trigger after the wake fires.
    re.compile(
        r"^\s*(hi|hello|hey|hey there|hi there|yo|sup|"
        r"hey\s+(jarvis|droplet|assistant)|"
        r"hello\s+(jarvis|droplet|assistant))"
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
    # Liveness check-ins: "can you hear me?" / "are you there?" with
    # optional wake-word prefix.
    re.compile(
        r"^\s*(hey\s+(jarvis|droplet|assistant)[,\s]+)?"
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
    # answers.
    re.compile(
        r"^\s*(who are you|what(?:'s|s| is)? your name|"
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

# Default tuning. Overridable via env at construct time (read by
# main.py's wiring, not by this module directly).
DEFAULT_THRESHOLD = 0.3
DEFAULT_DEBOUNCE_S = 2.0
DEFAULT_VISUAL_DECAY_S = 2.0
DEFAULT_STT_MAX_RECORD_S = 5.0  # captured audio per wake (no VAD yet — fixed window)
DEFAULT_UPSTREAM_PROBE_INTERVAL_S = 30.0  # how often to re-probe STT/TTS/LLM
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
DEFAULT_VAD_SILENCE_S = 0.8       # trailing silence (s) that ends the turn
DEFAULT_VAD_SPEECH_RMS = 300.0    # int16 frame RMS above which = "speech"
DEFAULT_VAD_MIN_SPEECH_S = 0.3    # min capture before VAD may fire

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
        self._sd_module = sd_module  # dependency injection for tests

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
        """Spawn the worker. Idempotent."""
        if self._thread is not None and self._thread.is_alive():
            return
        if self._input_device_index is None:
            self._set_state("no_mic")
            logger.info("WakePipeline: no input device — not starting worker")
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

    def stop(self, timeout: float = 5.0) -> None:
        """Signal shutdown and join the threads. Idempotent."""
        self._shutdown.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=timeout)
        self._thread = None
        pt = self._probe_thread
        if pt is not None and pt.is_alive():
            pt.join(timeout=timeout)
        self._probe_thread = None
        self._set_state("idle")

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
        `upstream_probe_interval_s`. Exits when shutdown is set."""
        while not self._shutdown.wait(self._upstream_probe_interval_s):
            try:
                self._probe_upstreams()
            except Exception:  # pragma: no cover
                logger.exception("upstream probe loop iteration crashed")

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

        # Capture at the device's NATIVE input-channel count. Many USB mic
        # arrays — notably the ReSpeaker XVF3800 — expose ONLY a 2-channel
        # capture interface (no mono altset) and hand back digital silence
        # when opened as mono on the raw hw device. We open the native count
        # (capped at 2) and downmix to a 1-D mono frame, which is what the
        # detector + STT both expect.
        in_channels = 1
        try:
            info = sd.query_devices(self._input_device_index)
            in_channels = max(1, min(2, int(info.get("max_input_channels") or 1)))
        except Exception:
            in_channels = 1
        try:
            with sd.InputStream(
                samplerate=WAKE_SAMPLE_RATE,
                channels=in_channels,
                dtype="int16",
                device=self._input_device_index,
                blocksize=WAKE_FRAME_SAMPLES,
            ) as stream:
                logger.info(
                    "wake pipeline: listening on device %s (%d ch), model=%s, threshold=%.2f",
                    self._input_device_index,
                    in_channels,
                    self._detector.model_name,
                    self._threshold,
                )
                self._set_state("listening")
                while not self._shutdown.is_set():
                    frames, overflowed = stream.read(WAKE_FRAME_SAMPLES)
                    if overflowed:
                        # Capture buffer outran our predict() pace. Common
                        # on first run while ONNX kernels JIT; logs once
                        # to avoid spam.
                        logger.debug("wake pipeline: input buffer overflow")
                    # frames is shape (1280, in_channels) int16. Downmix to a
                    # mono 1-D frame (mean across channels) for the detector
                    # + STT; a 1-channel device just flattens.
                    if frames.ndim > 1 and frames.shape[1] > 1:
                        mono = frames.mean(axis=1).astype("int16")
                    else:
                        mono = frames.reshape(-1)
                    self._on_frame(mono)
        except Exception as exc:
            self._set_error(f"wake loop crashed: {exc}")
            logger.exception("wake pipeline crashed")

    def _on_frame(self, frame: np.ndarray) -> None:
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

        # state == "listening" (or 'loading' on the first tick — harmless,
        # detector.predict on background audio just returns ~0 scores).
        self._run_wake_detect(frame)

    def _maybe_decay_state(self) -> None:
        """Sync internal _state with the visual-decay rule.

        Mirrors the decay logic in status() so the worker thread's view
        of state matches what callers see via the API. Without this,
        a frame could route to wake_detected even though status() would
        have decayed it back to listening 5 seconds ago.
        """
        with self._lock:
            state = self._state
            now = time.time()
            if (
                state == "wake_detected"
                and self._last_wake_at is not None
                and now - self._last_wake_at > self._visual_decay_s
            ):
                self._state = "listening"
            elif (
                state == "transcript_ready"
                and self._last_transcript_at is not None
                and now - self._last_transcript_at > self._visual_decay_s
            ):
                self._state = "listening"

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
            return

        # Debounce.
        if now - self._last_fire_at < self._debounce_s:
            return
        self._last_fire_at = now

        event = WakeEvent(model_name=model, score=score, detected_at=now)
        with self._lock:
            self._last_wake_at = event.detected_at
            self._last_wake_score = event.score
            self._last_wake_model = event.model_name
            self._state = "wake_detected"

        try:
            self._on_wake(event)
        except Exception:
            logger.exception("wake callback raised")

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
            self._stt_silence_s = 0.0
        elif self._stt_speech_started:
            self._stt_silence_s += self._frame_s
        if (
            self._stt_speech_started
            and elapsed >= self._vad_min_speech_s
            and self._stt_silence_s >= self._vad_silence_s
        ):
            logger.info(
                "transcribing: end-of-speech (%.1fs spoken, %.1fs trailing silence)",
                elapsed, self._stt_silence_s,
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
        if not transcript:
            return
        if self._llm is None or not self._llm_available:
            logger.info(
                "transcript ready (LLM unavailable, not speaking): %r",
                transcript,
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
        try:
            reply = self._llm.reply(transcript, tool_choice=tool_choice)
        except LLMUnavailable as exc:
            self._set_error(f"LLM call failed: {exc}")
            logger.warning("LLM call failed for transcript %r: %s", transcript, exc)
            return

        if not reply:
            logger.info("LLM returned empty reply for %r", transcript)
            return

        # Speak the reply. speak() handles its own state transitions +
        # last_response field + post-speak state restoration.
        result = self.speak(reply)
        if not result.get("ok"):
            logger.warning("speak after LLM reply failed: %s", result.get("error"))
