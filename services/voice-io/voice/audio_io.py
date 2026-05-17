"""Thin wrappers around sounddevice for capture + playback.

The wrappers exist so the rest of the voice pipeline (wake / STT / TTS)
can be tested with synthetic numpy buffers without touching real
hardware. Both functions raise `AudioUnavailable` when sounddevice
isn't loadable or no device is wired — callers translate that to a
503 / warning.
"""
from __future__ import annotations

import logging
from typing import Optional

import numpy as np

try:
    import sounddevice as _sd  # type: ignore[import-not-found]
except (ImportError, OSError):  # pragma: no cover
    _sd = None  # type: ignore[assignment]

logger = logging.getLogger("voice.audio_io")


class AudioUnavailable(RuntimeError):
    """Audio subsystem isn't usable. Surfaced to /health + /audio/test-*."""


def _require_sd() -> None:
    if _sd is None:
        raise AudioUnavailable(
            "sounddevice not loaded — install libportaudio2 + sounddevice",
        )


def record(
    duration_s: float,
    samplerate: int,
    channels: int,
    device: Optional[int],
) -> np.ndarray:
    """Capture `duration_s` seconds of mic audio.

    Returns an int16 numpy array of shape (samples, channels). int16 is
    faster-whisper's preferred input format; we'd convert in the STT
    layer regardless, so capturing as int16 saves a copy.
    """
    _require_sd()
    if device is None:
        raise AudioUnavailable("no input device resolved")
    samples = int(duration_s * samplerate)
    logger.debug(
        "recording %.2fs @ %d Hz / %d ch from device %s",
        duration_s, samplerate, channels, device,
    )
    data = _sd.rec(
        samples, samplerate=samplerate, channels=channels,
        dtype="int16", device=device,
    )
    _sd.wait()
    return data


def play(
    audio: np.ndarray,
    samplerate: int,
    device: Optional[int],
) -> None:
    """Blocking playback. Accepts int16 or float32; sounddevice handles
    both. If the output device rejects the source samplerate (common
    when Piper outputs 22050 Hz to a 16 kHz / 48 kHz-only USB sink),
    we resample to the device's native rate via scipy and retry.
    """
    _require_sd()
    if device is None:
        raise AudioUnavailable("no output device resolved")
    logger.debug(
        "playing %d samples @ %d Hz to device %s",
        len(audio), samplerate, device,
    )

    # Pre-check: does the device accept this samplerate? `check_output_settings`
    # raises PortAudioError(-9997) when not. We catch that, resample, retry.
    channels = 1 if audio.ndim == 1 else int(audio.shape[1])
    try:
        _sd.check_output_settings(
            device=device, samplerate=samplerate, channels=channels,
            dtype=str(audio.dtype),
        )
        play_audio = audio
        play_rate = samplerate
    except Exception as exc:
        # Resample to the device's preferred rate. If query_devices fails
        # (very rare on Linux ALSA), fall back to 48000 — a near-universal
        # USB-audio default.
        try:
            info = _sd.query_devices(device)
            target_rate = int(info.get("default_samplerate") or 48000)
        except Exception:
            target_rate = 48000
        logger.info(
            "playback: device %s rejects %d Hz (%s); resampling to %d Hz",
            device, samplerate, exc, target_rate,
        )
        play_audio = _resample_int16(audio, samplerate, target_rate)
        play_rate = target_rate

    _sd.play(play_audio, samplerate=play_rate, device=device)
    _sd.wait()


def _resample_int16(
    audio: np.ndarray, src_rate: int, dst_rate: int,
) -> np.ndarray:
    """Resample int16 PCM from src_rate to dst_rate via scipy's
    polyphase filter. Preserves int16 dtype so PortAudio still gets
    the type it expects.

    scipy.signal.resample_poly is the right tool for integer-ratio
    rate conversion (22050→48000 = 480/220.5, but poly_resample handles
    arbitrary up/down factors via L/M reduction). Quality is sufficient
    for spoken TTS — we're not chasing audiophile fidelity here.
    """
    if src_rate == dst_rate:
        return audio
    from scipy.signal import resample_poly
    # scipy works in float; convert + scale to avoid clipping.
    as_float = audio.astype(np.float32) / 32768.0
    resampled = resample_poly(as_float, dst_rate, src_rate, axis=0)
    # Clamp to int16 range and convert back.
    np.clip(resampled, -1.0, 1.0, out=resampled)
    return (resampled * 32767.0).astype(np.int16)


def test_tone(
    duration_s: float = 1.0,
    samplerate: int = 16000,
    frequency_hz: float = 440.0,
    device: Optional[int] = None,
) -> None:
    """Play a 440 Hz sine for `duration_s`. Used by /audio/test-tone."""
    t = np.linspace(
        0, duration_s, int(duration_s * samplerate), endpoint=False,
    )
    # 0.3 amplitude so accidental headphone-on-table playback isn't a
    # surprise blast.
    audio = (0.3 * np.sin(2 * np.pi * frequency_hz * t)).astype(np.float32)
    play(audio, samplerate=samplerate, device=device)


def measure_input_level(
    duration_s: float,
    samplerate: int,
    channels: int,
    device: Optional[int],
) -> dict[str, float]:
    """Record briefly and return RMS + peak in dBFS. /audio/test-record."""
    data = record(duration_s, samplerate, channels, device)
    # int16 → float in [-1, 1].
    f = data.astype(np.float32) / 32768.0
    if f.size == 0:
        return {"rms_dbfs": -120.0, "peak_dbfs": -120.0, "samples": 0}
    rms = float(np.sqrt(np.mean(f * f)))
    peak = float(np.max(np.abs(f)))
    # Tiny floor to avoid -inf dBFS on perfect silence.
    rms_db = 20.0 * np.log10(max(rms, 1e-6))
    peak_db = 20.0 * np.log10(max(peak, 1e-6))
    return {
        "rms_dbfs": round(rms_db, 1),
        "peak_dbfs": round(peak_db, 1),
        "samples": int(f.shape[0]),
    }
