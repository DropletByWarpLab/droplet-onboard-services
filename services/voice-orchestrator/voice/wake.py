"""Wake-word detection — pluggable detector interface + openWakeWord adapter.

The wake loop in `voice.pipeline` doesn't know or care which detector
is wired up; it just calls `predict()` on every 80 ms frame and acts
on the returned scores. Three concrete detectors live here:

  - **OpenWakeWordDetector** — production. Uses openWakeWord with the
    ONNX backend (NOT TFLite — `tflite-runtime` has no Python 3.12 wheel
    for x86_64 and openWakeWord supports ONNX natively).

  - **MockWakeWordDetector** — drives scripted score sequences from
    tests; also useful as a "press the button to wake" dev shim before
    real audio is wired up.

  - **DisabledWakeWordDetector** — a no-op for "we couldn't load any
    wake word" fallback. Keeps the pipeline running so /voice/status
    has something to return instead of crashing.

Custom wake words: drop a trained ONNX model into
`/app/models/<name>.onnx` and set `WAKE_WORD=<name>`. openWakeWord
auto-discovers .onnx files in its models dir. The training pipeline
that produces such a model lives in openWakeWord's repo and is its
own workstream (notebook + ~50 recordings of the phrase).

Threshold: a single value applied to whichever model fires highest.
0.5 is a defensible default for openWakeWord — its model heads tend
to sit near 0 on background audio and spike near 0.9-1.0 on a clean
utterance. Lower the threshold to make wake-up more eager (more
false positives); raise it to make it pickier.
"""
from __future__ import annotations

import dataclasses
import logging
import os
import time
from abc import ABC, abstractmethod
from typing import Any, Optional

import numpy as np

logger = logging.getLogger("voice.wake")


# openWakeWord expects 80 ms windows at 16 kHz mono int16 → 1280 samples.
# Exported so the pipeline can size its capture buffer to match.
WAKE_FRAME_SAMPLES = 1280
WAKE_SAMPLE_RATE = 16_000


@dataclasses.dataclass(frozen=True)
class WakeEvent:
    """One wake-word detection. Fired by the pipeline to callbacks."""

    model_name: str
    score: float
    detected_at: float  # unix epoch, set at fire time


class WakeWordDetector(ABC):
    """Abstract detector. Implementations wrap whichever ML runtime is in
    play (openWakeWord, a future replacement, or a mock)."""

    @property
    @abstractmethod
    def model_name(self) -> str:
        """Human-readable name shown in /voice/status + the dashboard."""

    @property
    @abstractmethod
    def loaded(self) -> bool:
        """True iff the model is ready to predict. False during the brief
        loading window after construction, or when the runtime failed to
        initialise (in which case the pipeline falls back to no-op
        listening)."""

    @abstractmethod
    def predict(self, audio_frame: np.ndarray) -> dict[str, float]:
        """Return {model_name: confidence in [0, 1]} for the given frame.

        `audio_frame` is int16 mono at 16 kHz, length WAKE_FRAME_SAMPLES.
        Implementations should be thread-safe for sequential calls — the
        pipeline serialises predicts on its own thread.
        """


# ────────────────────────────────────────────────────────────────────
# OpenWakeWord — production detector
# ────────────────────────────────────────────────────────────────────

class OpenWakeWordDetector(WakeWordDetector):
    """openWakeWord, ONNX backend.

    Lazy-loads on first `predict()` call so FastAPI startup isn't
    blocked by the ~1 s model-load (and so an early /health hit
    succeeds even before the first wake-loop tick).

    Custom .onnx models: drop into `models_dir` and pass its filename
    (minus `.onnx`) as `wake_word`. openWakeWord's `Model` constructor
    accepts either a bundled model name (e.g. "hey_jarvis") or a path
    to a custom .onnx; we resolve which to pass based on whether the
    file exists.
    """

    def __init__(
        self,
        wake_word: str = "hey_jarvis",
        models_dir: str = "/app/models",
    ):
        self._wake_word = wake_word
        self._models_dir = models_dir
        self._loaded = False
        self._model: Any = None
        self._load_attempted = False

    def _ensure_loaded(self) -> None:
        if self._loaded or self._load_attempted:
            return
        self._load_attempted = True
        try:
            # Lazy import — keeps the module importable on dev boxes
            # without openwakeword installed (where tests run with the
            # MockWakeWordDetector instead).
            from openwakeword.model import Model  # type: ignore[import-not-found]

            custom_path = os.path.join(self._models_dir, f"{self._wake_word}.onnx")
            if os.path.exists(custom_path):
                logger.info(
                    "openwakeword: loading custom ONNX from %s", custom_path,
                )
                self._model = Model(
                    wakeword_models=[custom_path],
                    inference_framework="onnx",
                )
            else:
                logger.info(
                    "openwakeword: loading bundled model %r (ONNX backend)",
                    self._wake_word,
                )
                self._model = Model(
                    wakeword_models=[self._wake_word],
                    inference_framework="onnx",
                )
            self._loaded = True
        except Exception as exc:
            logger.error(
                "openwakeword failed to load %r: %s — wake detection disabled",
                self._wake_word, exc,
            )
            self._loaded = False

    @property
    def model_name(self) -> str:
        return self._wake_word

    @property
    def loaded(self) -> bool:
        return self._loaded

    def predict(self, audio_frame: np.ndarray) -> dict[str, float]:
        if not self._load_attempted:
            self._ensure_loaded()
        if self._model is None:
            return {}
        # openWakeWord returns a dict {model_id: float_score}; the model_id
        # may differ from our `wake_word` string when a bundled name like
        # "hey_jarvis" maps to "hey_jarvis_v0.1" internally. We pass scores
        # through unchanged — the pipeline cares about the max value, not
        # the exact key.
        result = self._model.predict(audio_frame)
        # openWakeWord may return numpy floats; coerce to plain float for
        # JSON-safe payloads downstream.
        return {k: float(v) for k, v in result.items()}


# ────────────────────────────────────────────────────────────────────
# Mock — tests + dev mode
# ────────────────────────────────────────────────────────────────────

class MockWakeWordDetector(WakeWordDetector):
    """Returns scripted score sequences. Tests inject this directly; the
    runtime never picks it unless `WAKE_WORD=__mock__` is set explicitly
    (useful when no real wake model is available, e.g. on a stripped-down
    dev box).
    """

    def __init__(
        self,
        model_name: str = "mock_wake",
        scripted_scores: Optional[list[dict[str, float]]] = None,
    ):
        self._model_name = model_name
        self._scripted = scripted_scores or []
        self._index = 0

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def loaded(self) -> bool:
        return True

    def predict(self, audio_frame: np.ndarray) -> dict[str, float]:
        if self._index < len(self._scripted):
            r = self._scripted[self._index]
            self._index += 1
            return dict(r)
        return {self._model_name: 0.0}


# ────────────────────────────────────────────────────────────────────
# Disabled — last-resort fallback
# ────────────────────────────────────────────────────────────────────

class DisabledWakeWordDetector(WakeWordDetector):
    """No-op. Used when no real detector could be constructed; the
    pipeline still pumps audio so /audio/test-record works, but no
    wake events ever fire. /voice/status reports `wakeLoaded: false`
    so the dashboard can surface "Voice assistant is degraded"."""

    @property
    def model_name(self) -> str:
        return "disabled"

    @property
    def loaded(self) -> bool:
        return False

    def predict(self, audio_frame: np.ndarray) -> dict[str, float]:
        return {}


# ────────────────────────────────────────────────────────────────────
# Factory — picks the right detector for the current env.
# ────────────────────────────────────────────────────────────────────

def build_detector_from_env() -> WakeWordDetector:
    """Resolve env config → detector instance.

    `WAKE_WORD` defaults to "hey_jarvis" (a generic dev wake phrase
    that ships with openWakeWord). Set to "__mock__" for a dev box
    without a real wake model. Anything else is treated as either a
    bundled openWakeWord name or a filename in /app/models.
    """
    wake_word = os.environ.get("WAKE_WORD", "hey_jarvis").strip()
    if wake_word == "__mock__":
        logger.info("WAKE_WORD=__mock__ → MockWakeWordDetector (dev only)")
        return MockWakeWordDetector()
    return OpenWakeWordDetector(wake_word=wake_word)
