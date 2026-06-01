"""Wake-word detection — pluggable detector interface + openWakeWord adapter.

The wake loop in `voice.pipeline` doesn't know or care which detector
is wired up; it just calls `predict()` on every 80 ms frame and acts
on the returned scores. Three concrete detectors live here:

  - **VoskWakeWordDetector** — production default. Recognizes ANY
    in-vocabulary phrase (incl. "hey droplet") out of the box via a
    grammar-constrained Vosk model — no per-phrase training, no
    licensing fee, fully offline. Selected by `WAKE_ENGINE=vosk`
    (the default).

  - **OpenWakeWordDetector** — bundled-ONNX engine (hey_jarvis, alexa,
    hey_mycroft). Used when `WAKE_ENGINE=openwakeword`, or as the
    automatic fallback when the Vosk model isn't on disk. ONNX backend
    (NOT TFLite — `tflite-runtime` has no Python 3.12 wheel for x86_64
    and openWakeWord supports ONNX natively).

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
import json
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

# Default on-disk location (a directory) of the bundled Vosk model. The
# Dockerfile extracts vosk-model-small-en-us-0.15 here under this stable
# name. Overridable via the VOSK_MODEL_PATH env var.
VOSK_DEFAULT_MODEL_DIRNAME = "vosk-model-small-en-us"


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

    # When the configured wake-word has neither a custom .onnx on disk
    # nor a matching bundled model name, fall back to this so wake
    # detection stays online while the custom model is in flight.
    # Picked openwakeword's bundled 'hey_jarvis' because it's the
    # closest phonetic shape to 'hey droplet' among the bundled set
    # — both are two syllables starting with 'hey' followed by a hard
    # consonant. Operators see the original wake word in /voice/status
    # via `requested_wake_word`; the actively-loaded model is in
    # `model_name` so the dashboard can surface "using hey_jarvis as
    # fallback for hey_droplet" honestly.
    FALLBACK_WAKE_WORD = "hey_jarvis"

    def __init__(
        self,
        wake_word: str = "hey_droplet",
        models_dir: str = "/app/models",
    ):
        # `requested_wake_word` is what the operator asked for via
        # WAKE_WORD env. `_wake_word` is what we actually loaded
        # (may equal the fallback when the requested model isn't on disk).
        self._requested_wake_word = wake_word
        self._wake_word = wake_word
        self._models_dir = models_dir
        self._loaded = False
        self._using_fallback = False
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

            # Resolution order: custom ONNX on disk → bundled model →
            # bundled fallback (last-resort so the system stays armed).
            custom_path = os.path.join(self._models_dir, f"{self._wake_word}.onnx")
            if os.path.exists(custom_path):
                logger.info(
                    "openwakeword: loading custom ONNX from %s", custom_path,
                )
                self._model = Model(
                    wakeword_models=[custom_path],
                    inference_framework="onnx",
                )
                self._loaded = True
                return

            # Try the wake-word name against openwakeword's bundled set.
            # The library raises on unknown names — catch into the
            # fallback branch so the system stays armed.
            try:
                logger.info(
                    "openwakeword: loading bundled model %r (ONNX backend)",
                    self._wake_word,
                )
                self._model = Model(
                    wakeword_models=[self._wake_word],
                    inference_framework="onnx",
                )
                self._loaded = True
                return
            except Exception as exc:
                # Custom-name path: no .onnx on disk AND not bundled.
                # If the operator asked for the fallback already, give
                # up — would loop infinitely. Otherwise fall back.
                if self._wake_word == self.FALLBACK_WAKE_WORD:
                    raise
                logger.warning(
                    "openwakeword: %r not a bundled model and no .onnx "
                    "on disk — falling back to %r so wake stays armed. "
                    "Drop a trained %s.onnx into %s to switch over.",
                    self._wake_word, self.FALLBACK_WAKE_WORD,
                    self._requested_wake_word, self._models_dir,
                )
                self._using_fallback = True
                self._wake_word = self.FALLBACK_WAKE_WORD
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
        """Currently-loaded model name. Equals `requested_wake_word`
        unless we fell back — then it's the fallback name so the
        dashboard sees what's actually being matched."""
        return self._wake_word

    @property
    def requested_wake_word(self) -> str:
        """What WAKE_WORD asked for. Differs from model_name iff we
        fell back. The dashboard surfaces both so operators see
        "configured: hey_droplet, currently: hey_jarvis (fallback)"."""
        return self._requested_wake_word

    @property
    def using_fallback(self) -> bool:
        return self._using_fallback

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
# Vosk — recognizes arbitrary phrases (incl. "hey droplet") out of the box
# ────────────────────────────────────────────────────────────────────

class VoskWakeWordDetector(WakeWordDetector):
    """Vosk (Kaldi) keyword spotting — recognizes ANY in-vocabulary
    phrase with no per-phrase model training.

    This is how "hey droplet" becomes a first-class wake word for every
    customer without shipping a trained .onnx: a small general English
    acoustic model runs grammar-constrained to just the wake phrase plus
    "[unk]" (everything else). Each 80 ms frame is fed to a
    KaldiRecognizer; when an utterance endpoint is reached and the
    recognized text contains the wake phrase, we fire with the averaged
    per-word confidence as the [0, 1] score the pipeline thresholds.

    Apache-2.0, fully offline, no AccessKey, no licensing fee. CPU cost
    of the small model is negligible on Droplet-class hosts (Ryzen /
    Jetson Orin).

    Lazy-loads on first predict() (like OpenWakeWordDetector) so FastAPI
    startup isn't blocked by the model load. Unlike openWakeWord there is
    no phrase fallback — the whole point is that the requested phrase is
    what's actually matched — so `using_fallback` is always False and
    `model_name` is the configured wake word.
    """

    def __init__(
        self,
        wake_word: str = "hey_droplet",
        model_path: str = "/app/models/" + VOSK_DEFAULT_MODEL_DIRNAME,
        sample_rate: int = WAKE_SAMPLE_RATE,
    ):
        self._requested_wake_word = wake_word
        self._wake_word = wake_word
        # Spoken form of the phrase: "hey_droplet" -> "hey droplet".
        self._phrase = wake_word.replace("_", " ").strip().lower()
        self._model_path = model_path
        self._sample_rate = sample_rate
        self._loaded = False
        self._load_attempted = False
        self._rec: Any = None

    def _ensure_loaded(self) -> None:
        if self._loaded or self._load_attempted:
            return
        self._load_attempted = True
        # Cheap on-disk check first so a missing model doesn't pay the
        # import cost and the error message is precise.
        if not os.path.isdir(self._model_path):
            logger.error(
                "vosk: model dir %s not found — wake detection disabled",
                self._model_path,
            )
            self._loaded = False
            return
        try:
            # Lazy import — keeps the module importable on dev boxes
            # without vosk installed (tests inject a fake module).
            from vosk import KaldiRecognizer, Model  # type: ignore[import-not-found]

            logger.info(
                "vosk: loading model %s (phrase=%r)",
                self._model_path, self._phrase,
            )
            model = Model(self._model_path)
            # Grammar-constrain recognition to the wake phrase + [unk].
            # This biases the recognizer hard toward the phrase and keeps
            # CPU + false-accepts down vs. open-vocabulary decoding.
            grammar = json.dumps([self._phrase, "[unk]"])
            self._rec = KaldiRecognizer(model, self._sample_rate, grammar)
            self._rec.SetWords(True)  # per-word confidences for scoring
            self._loaded = True
        except Exception as exc:
            logger.error(
                "vosk failed to load (%s) — wake detection disabled", exc,
            )
            self._loaded = False

    @property
    def model_name(self) -> str:
        return self._wake_word

    @property
    def requested_wake_word(self) -> str:
        return self._requested_wake_word

    @property
    def using_fallback(self) -> bool:
        # Vosk recognizes the requested phrase directly — never a
        # substitute. "hey droplet" really means "hey droplet".
        return False

    @property
    def loaded(self) -> bool:
        return self._loaded

    def predict(self, audio_frame: np.ndarray) -> dict[str, float]:
        if not self._load_attempted:
            self._ensure_loaded()
        if self._rec is None:
            return {}
        try:
            pcm = np.ascontiguousarray(audio_frame, dtype=np.int16).tobytes()
            # Continuous keyword spotting: check the partial hypothesis on
            # every frame and fire the moment the phrase appears — don't
            # wait for an utterance endpoint (silence), which a wake word
            # in a noisy room may never produce. On a true endpoint we also
            # get a final Result with per-word confidences for a better
            # score.
            if self._rec.AcceptWaveform(pcm):
                res = json.loads(self._rec.Result())
                text = (res.get("text") or "").strip().lower()
                is_final = True
            else:
                res = json.loads(self._rec.PartialResult())
                text = (res.get("partial") or "").strip().lower()
                is_final = False
        except Exception as exc:
            logger.warning("vosk predict error: %s", exc)
            return {}

        if not text:
            return {}
        if self._phrase not in text:
            # Diagnostic: surface what Vosk actually heard on completed
            # utterances so misrecognitions are visible in the logs without
            # spamming a line per partial frame.
            if is_final:
                logger.info("vosk: heard %r (no wake match)", text)
            return {}

        # Matched the wake phrase. A final Result carries per-word
        # confidences (SetWords); a partial does not, so use a high
        # constant that clears any sane threshold.
        score = 1.0
        if is_final:
            words = res.get("result") or []
            phrase_tokens = set(self._phrase.split())
            confs = [
                float(w["conf"])
                for w in words
                if isinstance(w, dict) and w.get("word") in phrase_tokens and "conf" in w
            ]
            if confs:
                score = sum(confs) / len(confs)
        else:
            score = 0.9
        logger.info(
            "vosk: WAKE match on %r (score=%.2f, final=%s)", text, score, is_final,
        )
        # Reset so the matched phrase doesn't linger in the next partial
        # and re-fire every subsequent frame (the pipeline debounce is a
        # second guard).
        try:
            self._rec.Reset()
        except Exception:
            pass
        return {self._wake_word: score}


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

    `WAKE_WORD` defaults to "hey_droplet" — the product's branded wake
    phrase.

    `WAKE_ENGINE` (default "vosk") selects the backend:
      - "vosk" — recognizes the WAKE_WORD phrase out of the box via a
        grammar-constrained Vosk model, no per-phrase training. This is
        how "hey droplet" works for every customer with no licensing
        fee. Falls back to openWakeWord if the Vosk model dir isn't
        present, so a stripped image still wakes (on the bundled
        hey_jarvis model) rather than going silent.
      - "openwakeword" — the bundled-ONNX engine (hey_jarvis, alexa,
        hey_mycroft), with its own runtime fallback to a bundled model
        when the requested phrase has no .onnx.

    Set `WAKE_WORD=__mock__` for a dev box with no wake runtime
    available (forces the MockWakeWordDetector).
    """
    wake_word = os.environ.get("WAKE_WORD", "hey_droplet").strip()
    if wake_word == "__mock__":
        logger.info("WAKE_WORD=__mock__ → MockWakeWordDetector (dev only)")
        return MockWakeWordDetector()

    engine = os.environ.get("WAKE_ENGINE", "vosk").strip().lower()
    if engine in ("openwakeword", "oww"):
        return OpenWakeWordDetector(wake_word=wake_word)
    if engine and engine != "vosk":
        logger.warning("unknown WAKE_ENGINE=%r — using vosk", engine)

    # Vosk path (default). A cheap on-disk check decides Vosk vs. the
    # openWakeWord fallback WITHOUT importing vosk or loading the model,
    # so FastAPI startup stays fast.
    models_dir = os.environ.get("WAKE_MODELS_DIR", "/app/models")
    vosk_model_path = os.environ.get(
        "VOSK_MODEL_PATH",
        os.path.join(models_dir, VOSK_DEFAULT_MODEL_DIRNAME),
    )
    if os.path.isdir(vosk_model_path):
        logger.info(
            "WAKE_ENGINE=vosk → VoskWakeWordDetector (phrase=%r, model=%s)",
            wake_word, vosk_model_path,
        )
        return VoskWakeWordDetector(
            wake_word=wake_word, model_path=vosk_model_path,
        )

    logger.warning(
        "WAKE_ENGINE=vosk but no Vosk model at %s — falling back to "
        "openWakeWord (wake will use its bundled fallback until the Vosk "
        "model is present)", vosk_model_path,
    )
    return OpenWakeWordDetector(wake_word=wake_word)
