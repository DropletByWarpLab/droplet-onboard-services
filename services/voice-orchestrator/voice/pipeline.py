"""Wake-detection pipeline — background thread that streams mic audio
into a wake-word detector and emits WakeEvents to a callback.

Architecture:

  capture (sounddevice InputStream)
      │
      ▼ 1280-sample (80 ms @ 16 kHz mono int16) chunks
  pipeline._loop (this module's background thread)
      │
      ▼ detector.predict() → {model_id: score}
  threshold check (any score > WAKE_THRESHOLD?)
      │
      ▼ if yes
  build WakeEvent + apply debounce + invoke callback
      │
      └─ subsequent commits hook this into STT.

Single thread. We don't async/await the predict() because openWakeWord
is CPU-bound + synchronous; the event loop would just spin. A
threading.Event signals shutdown.

Debounce: a single utterance produces many 80 ms frames above
threshold (the wake-word audio is ~600 ms). Without a debounce window
we'd fire 10+ WakeEvents back-to-back. `WAKE_DEBOUNCE_S` enforces a
minimum gap between events — defaults to 2 s, long enough that a
real user can't intentionally re-trigger but short enough that the
second call after the first response works.

Status:
  state ∈ {idle, loading, listening, wake_detected, error, no_mic}
  last_wake_at / last_wake_score / last_wake_model
  error_message (only set in 'error' state)

`wake_detected` is a transient UI hint — it auto-decays to
`listening` after `WAKE_VISUAL_DECAY_S` seconds (2 s by default) so
the dashboard's "wake detected" pulse animation has time to play.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import asdict, dataclass
from typing import Any, Callable, Optional

import numpy as np

from voice.wake import (
    WAKE_FRAME_SAMPLES,
    WAKE_SAMPLE_RATE,
    WakeEvent,
    WakeWordDetector,
)

logger = logging.getLogger("voice.pipeline")

# Default tuning. Overridable via env at construct time (read by
# main.py's wiring, not by this module directly).
DEFAULT_THRESHOLD = 0.5
DEFAULT_DEBOUNCE_S = 2.0
DEFAULT_VISUAL_DECAY_S = 2.0

PipelineState = str  # idle | loading | listening | wake_detected | error | no_mic


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
        sd_module: Any = None,
    ):
        self._detector = detector
        self._input_device_index = input_device_index
        self._threshold = threshold
        self._debounce_s = debounce_s
        self._visual_decay_s = visual_decay_s
        self._on_wake = on_wake or self._default_on_wake
        self._sd_module = sd_module  # dependency injection for tests

        self._thread: Optional[threading.Thread] = None
        self._shutdown = threading.Event()
        self._lock = threading.Lock()

        # Status snapshot — guarded by _lock for atomic /voice/status reads.
        self._state: PipelineState = "idle"
        self._last_wake_at: Optional[float] = None
        self._last_wake_score: Optional[float] = None
        self._last_wake_model: Optional[str] = None
        self._error_message: Optional[str] = None
        self._last_fire_at: float = 0.0  # debounce tracking

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
        self._shutdown.clear()
        self._set_state("loading")
        self._thread = threading.Thread(
            target=self._loop, name="wake-pipeline", daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        """Signal shutdown and join the thread. Idempotent."""
        self._shutdown.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=timeout)
        self._thread = None
        self._set_state("idle")

    # ──────────────────────────────────────────────────────────────
    # Status — atomic snapshot
    # ──────────────────────────────────────────────────────────────

    def status(self) -> PipelineStatus:
        with self._lock:
            state = self._state
            # Auto-decay 'wake_detected' back to 'listening' once the
            # visual-pulse window passes. Cheap: just compute on read.
            if (
                state == "wake_detected"
                and self._last_wake_at is not None
                and time.time() - self._last_wake_at > self._visual_decay_s
            ):
                state = "listening"

            return PipelineStatus(
                state=state,
                listening=state == "listening" or state == "wake_detected",
                wake_loaded=self._detector.loaded,
                wake_model=self._detector.model_name,
                threshold=self._threshold,
                last_wake_at=self._last_wake_at,
                last_wake_score=self._last_wake_score,
                last_wake_model=self._last_wake_model,
                error_message=self._error_message,
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

        try:
            with sd.InputStream(
                samplerate=WAKE_SAMPLE_RATE,
                channels=1,
                dtype="int16",
                device=self._input_device_index,
                blocksize=WAKE_FRAME_SAMPLES,
            ) as stream:
                logger.info(
                    "wake pipeline: listening on device %s, model=%s, threshold=%.2f",
                    self._input_device_index,
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
                    # frames is shape (1280, 1) int16; flatten for openWakeWord.
                    self._on_frame(frames.flatten())
        except Exception as exc:
            self._set_error(f"wake loop crashed: {exc}")
            logger.exception("wake pipeline crashed")

    def _on_frame(self, frame: np.ndarray) -> None:
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
        now = time.time()
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
