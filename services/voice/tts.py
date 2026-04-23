"""
Text → speech engine wrappers.

Two backends:
  - mock — returns a 0.5s sine-wave PCM placeholder. Used in CI and as
    the safe default before the user downloads a Piper voice model.
  - piper — uses the Python `piper-tts` package + a downloaded voice.
    Lazy-loaded.

Output contract: 16-bit signed mono PCM at the voice service's configured
sample rate. The HTTP /speak endpoint wraps this in WAV before returning.
"""

from __future__ import annotations

import logging
import math
import struct
from typing import Protocol

from config import VoiceConfig

logger = logging.getLogger("voice.tts")


class TtsBackend(Protocol):
    def synthesize(self, text: str) -> bytes: ...
    def sample_rate_hz(self) -> int: ...


class MockTts:
    """Returns a deterministic 0.5s 440 Hz sine wave for any input. Tests
    can assert on byte length matching `expected_bytes(0.5)`."""

    def __init__(self, cfg: VoiceConfig):
        self._sample_rate = cfg.sample_rate_hz

    def synthesize(self, text: str) -> bytes:
        n = int(self._sample_rate * 0.5)
        amp = int(0.3 * 32767)
        out = bytearray()
        for i in range(n):
            t = i / self._sample_rate
            out.extend(struct.pack("<h", int(amp * math.sin(2 * math.pi * 440 * t))))
        # Touch text so the mock is deterministic given the same input —
        # makes tests easier without making the output meaningful.
        if text and len(text) > 0:
            pass
        return bytes(out)

    def sample_rate_hz(self) -> int:
        return self._sample_rate


class PiperTts:
    """piper-tts wrapper. Lazy-loaded on first call. Piper synthesizes at
    the model's native rate (typically 22050 Hz); we expose that via
    sample_rate_hz()."""

    def __init__(self, cfg: VoiceConfig):
        self._cfg = cfg
        self._voice = None
        self._native_rate: int | None = None

    def _load(self):
        try:
            from piper.voice import PiperVoice  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "piper-tts not installed. Set VOICE_TTS_BACKEND=mock for dev "
                "or install requirements.txt."
            ) from e
        # piper-tts looks for <voice>.onnx next to <voice>.onnx.json. The
        # model files have to be downloaded and placed in /data/voices in
        # the container — see services/voice/README.md.
        voice_path = f"/data/voices/{self._cfg.piper_voice}.onnx"
        logger.info("piper: loading voice %s", voice_path)
        self._voice = PiperVoice.load(voice_path)
        self._native_rate = self._voice.config.sample_rate

    def synthesize(self, text: str) -> bytes:
        if self._voice is None:
            self._load()
        out = bytearray()
        for chunk in self._voice.synthesize_stream_raw(text):  # type: ignore[union-attr]
            out.extend(chunk)
        return bytes(out)

    def sample_rate_hz(self) -> int:
        if self._native_rate is None:
            # Sane default before _load() runs — Piper's most common voices
            # are 22050 Hz.
            return 22050
        return self._native_rate


def make_tts(cfg: VoiceConfig) -> TtsBackend:
    backend = (cfg.tts_backend or "mock").lower()
    if backend == "mock":
        return MockTts(cfg)
    if backend == "piper":
        try:
            return PiperTts(cfg)
        except RuntimeError as exc:
            logger.warning("piper init failed (%s) — falling back to mock", exc)
            return MockTts(cfg)
    logger.warning("unknown tts backend %r — falling back to mock", backend)
    return MockTts(cfg)
