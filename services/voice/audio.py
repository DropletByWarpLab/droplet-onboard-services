"""
Audio I/O abstraction.

Two backends:
  - mock — produces / consumes synthetic 16-bit PCM. Used in tests and on
    dev machines without a sound card. record_seconds() returns 200ms of
    sine wave; play_pcm() just logs the byte count.
  - alsa — uses sounddevice (libportaudio binding) for real capture +
    playback. Lazy-imported so dev environments don't need the system
    libportaudio package.

Both backends produce / consume raw 16-bit signed mono PCM at the rate set
by VoiceConfig.sample_rate_hz. The HTTP layer wraps PCM in WAV when
returning to a client.
"""

from __future__ import annotations

import io
import logging
import math
import struct
import wave
from typing import Protocol

from config import VoiceConfig

logger = logging.getLogger("voice.audio")


class AudioBackend(Protocol):
    def record_seconds(self, seconds: float) -> bytes: ...
    def play_pcm(self, pcm: bytes) -> None: ...


def pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    """Wrap raw 16-bit signed mono PCM into a WAV container so HTTP clients
    can decode it without knowing our sample rate. The voice service's
    /speak endpoint returns this shape."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def wav_to_pcm(wav_bytes: bytes) -> tuple[bytes, int]:
    """Inverse: pull raw PCM + the wav's sample rate out of a WAV blob.
    Used by /transcribe to accept WAV uploads from the dashboard or a
    phone."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        if w.getnchannels() != 1:
            raise ValueError("only mono WAV is accepted")
        if w.getsampwidth() != 2:
            raise ValueError("only 16-bit WAV is accepted")
        rate = w.getframerate()
        return w.readframes(w.getnframes()), rate


class MockAudio:
    """Synthetic audio I/O — used in CI and on machines without a sound card.
    record_seconds() returns a 440 Hz sine wave so the rest of the pipeline
    can exercise its code paths against deterministic, valid PCM."""

    def __init__(self, cfg: VoiceConfig):
        self._sample_rate = cfg.sample_rate_hz

    def record_seconds(self, seconds: float) -> bytes:
        n_samples = int(self._sample_rate * max(0.05, seconds))
        # 440 Hz sine, ~30% amplitude.
        amp = int(0.3 * 32767)
        out = bytearray()
        for i in range(n_samples):
            t = i / self._sample_rate
            sample = int(amp * math.sin(2 * math.pi * 440.0 * t))
            out.extend(struct.pack("<h", sample))
        return bytes(out)

    def play_pcm(self, pcm: bytes) -> None:
        # Don't actually play — log the duration so test assertions can
        # verify the right amount of data flowed through.
        secs = len(pcm) / 2 / self._sample_rate
        logger.info("mock audio: would play %.2fs of PCM (%d bytes)", secs, len(pcm))


class AlsaAudio:
    """Real audio via sounddevice. Imported lazily — sounddevice depends
    on libportaudio being present on the host."""

    def __init__(self, cfg: VoiceConfig):
        try:
            import sounddevice as sd  # type: ignore[import-not-found]
            import numpy as np         # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "sounddevice/numpy not installed. Set VOICE_AUDIO_BACKEND=mock for dev "
                "or install the deps from requirements.txt on the device."
            ) from e
        self._sd = sd
        self._np = np
        self._cfg = cfg

    def record_seconds(self, seconds: float) -> bytes:
        n_samples = int(self._cfg.sample_rate_hz * max(0.05, seconds))
        buf = self._sd.rec(
            n_samples,
            samplerate=self._cfg.sample_rate_hz,
            channels=self._cfg.mic_channels,
            dtype="int16",
            device=self._cfg.mic_device,
        )
        self._sd.wait()
        # If channels > 1, downmix by averaging.
        if buf.ndim > 1 and buf.shape[1] > 1:
            buf = buf.mean(axis=1).astype("int16")
        return bytes(buf.tobytes())

    def play_pcm(self, pcm: bytes) -> None:
        arr = self._np.frombuffer(pcm, dtype=self._np.int16)
        self._sd.play(
            arr,
            samplerate=self._cfg.sample_rate_hz,
            device=self._cfg.speaker_device,
        )
        self._sd.wait()


def make_audio(cfg: VoiceConfig) -> AudioBackend:
    backend = (cfg.audio_backend or "mock").lower()
    if backend == "mock":
        return MockAudio(cfg)
    if backend == "alsa":
        try:
            return AlsaAudio(cfg)
        except RuntimeError as exc:
            logger.warning("alsa audio init failed (%s) — falling back to mock", exc)
            return MockAudio(cfg)
    logger.warning("unknown audio backend %r — falling back to mock", backend)
    return MockAudio(cfg)
