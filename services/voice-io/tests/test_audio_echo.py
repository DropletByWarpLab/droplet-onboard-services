"""WARP-1055 — pure tone-detection math behind /audio/echo-check.

`detect_tone` gets the raw simultaneous-capture buffer and answers
"did the played tone actually arrive at the mic?" via an FFT band
comparison — energy in a narrow band around the tone frequency vs the
broadband floor. Pure numpy, no sounddevice, so it's directly unit-
testable with synthetic signals.
"""
from __future__ import annotations

import numpy as np

from voice.audio_io import detect_tone

SAMPLE_RATE = 16000
TONE_HZ = 440.0


def _sine(freq: float, seconds: float, amplitude: float) -> np.ndarray:
    t = np.linspace(0, seconds, int(seconds * SAMPLE_RATE), endpoint=False)
    return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _noise(seconds: float, amplitude: float, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(seconds * SAMPLE_RATE)
    return (amplitude * rng.standard_normal(n)).astype(np.float32)


def test_detects_tone_over_quiet_room():
    rec = _sine(TONE_HZ, 2.0, 0.1) + _noise(2.0, 0.002)
    result = detect_tone(rec, samplerate=SAMPLE_RATE, frequency_hz=TONE_HZ)
    assert result["heard"] is True
    assert result["tone_dbfs"] > result["floor_dbfs"]


def test_silence_is_not_heard():
    rec = np.zeros(SAMPLE_RATE * 2, dtype=np.float32)
    result = detect_tone(rec, samplerate=SAMPLE_RATE, frequency_hz=TONE_HZ)
    assert result["heard"] is False


def test_broadband_noise_without_tone_is_not_heard():
    rec = _noise(2.0, 0.05)
    result = detect_tone(rec, samplerate=SAMPLE_RATE, frequency_hz=TONE_HZ)
    assert result["heard"] is False


def test_off_frequency_tone_is_not_heard():
    # Strong 2 kHz content must not count as the 440 Hz test tone.
    rec = _sine(2000.0, 2.0, 0.2) + _noise(2.0, 0.002)
    result = detect_tone(rec, samplerate=SAMPLE_RATE, frequency_hz=TONE_HZ)
    assert result["heard"] is False


def test_int16_capture_is_accepted():
    rec_f = _sine(TONE_HZ, 2.0, 0.1)
    rec_i16 = (rec_f * 32767.0).astype(np.int16)
    result = detect_tone(rec_i16, samplerate=SAMPLE_RATE, frequency_hz=TONE_HZ)
    assert result["heard"] is True


def test_reports_rounded_dbfs_values():
    rec = _sine(TONE_HZ, 2.0, 0.1) + _noise(2.0, 0.002)
    result = detect_tone(rec, samplerate=SAMPLE_RATE, frequency_hz=TONE_HZ)
    # One decimal place, JSON-safe floats (matches measure_input_level).
    assert result["tone_dbfs"] == round(result["tone_dbfs"], 1)
    assert result["floor_dbfs"] == round(result["floor_dbfs"], 1)
