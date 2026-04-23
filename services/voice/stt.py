"""
Speech → text engine wrappers.

Two backends:
  - mock — returns a deterministic placeholder. Used in CI and as the
    safe default before the user downloads a Whisper model.
  - whisper — uses faster-whisper (CT2 inference). Lazy-imports + lazy-
    loads the model on the first call so service boot stays fast.

The Whisper model is loaded onto VOICE_WHISPER_DEVICE ("cpu", "cuda",
"auto"). On the Jetson Orin, "cuda" gets ~5x speedup over CPU but
requires the CUDA runtime in the container — see the Dockerfile.

Input contract: 16-bit signed mono PCM at the sample rate configured
in the voice service (default 16 kHz). Whisper resamples internally if
the rate doesn't match.
"""

from __future__ import annotations

import io
import logging
import wave
from typing import Protocol

from config import VoiceConfig

logger = logging.getLogger("voice.stt")


class SttBackend(Protocol):
    def transcribe_pcm(self, pcm: bytes, sample_rate: int) -> str: ...


class MockStt:
    """Returns a deterministic placeholder. The placeholder includes the
    audio length so tests can assert that audio actually flowed."""

    def transcribe_pcm(self, pcm: bytes, sample_rate: int) -> str:
        secs = len(pcm) / 2 / sample_rate
        return f"[mock transcription of {secs:.2f}s of audio]"


class WhisperStt:
    """faster-whisper wrapper. Lazy-loaded on first call."""

    def __init__(self, cfg: VoiceConfig):
        self._cfg = cfg
        self._model = None  # loaded on first transcribe call

    def _load(self):
        try:
            from faster_whisper import WhisperModel  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "faster-whisper not installed. Set VOICE_STT_BACKEND=mock for dev "
                "or install requirements.txt."
            ) from e
        device = self._cfg.whisper_device
        if device == "auto":
            try:
                import torch  # type: ignore[import-not-found]
                device = "cuda" if torch.cuda.is_available() else "cpu"
            except ImportError:
                device = "cpu"
        compute_type = "int8" if device == "cpu" else "float16"
        logger.info(
            "whisper: loading model %s on %s (compute_type=%s)",
            self._cfg.whisper_model, device, compute_type,
        )
        self._model = WhisperModel(self._cfg.whisper_model, device=device, compute_type=compute_type)

    def transcribe_pcm(self, pcm: bytes, sample_rate: int) -> str:
        if self._model is None:
            self._load()
        # faster-whisper accepts a WAV path, a bytes-like, or a NumPy array.
        # Building a WAV in-memory is simplest and matches the rest of the
        # service's "PCM is the lingua franca" convention.
        wav = io.BytesIO()
        with wave.open(wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm)
        wav.seek(0)
        segments, _info = self._model.transcribe(wav, beam_size=1, language="en")
        return " ".join(seg.text.strip() for seg in segments).strip()


def make_stt(cfg: VoiceConfig) -> SttBackend:
    backend = (cfg.stt_backend or "mock").lower()
    if backend == "mock":
        return MockStt()
    if backend == "whisper":
        try:
            return WhisperStt(cfg)
        except RuntimeError as exc:
            logger.warning("whisper init failed (%s) — falling back to mock", exc)
            return MockStt()
    logger.warning("unknown stt backend %r — falling back to mock", backend)
    return MockStt()
