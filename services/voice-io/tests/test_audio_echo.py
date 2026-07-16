"""WARP-1055 — pure tone-detection math behind /audio/echo-check.

`detect_tone` gets the raw simultaneous-capture buffer and answers
"did the played tone actually arrive at the mic?" via an FFT band
comparison — energy in a narrow band around the tone frequency vs the
broadband floor. Pure numpy, no sounddevice, so it's directly unit-
testable with synthetic signals.
"""
from __future__ import annotations

import numpy as np
import pytest

from voice import audio_io
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


# ── samplerate fallback (WARP-1055 review F4) ───────────────────────
#
# play() in this module resamples when the sink rejects the source
# rate; echo_check needs the equivalent or a 48 kHz-only speaker can
# NEVER pass step 4 (while /voice/say works fine) — forcing the user
# into "Skip this check" forever.

class _EchoFakeSd:
    """Fake sounddevice for the full-duplex echo path."""

    class PortAudioError(Exception):
        pass

    def __init__(self, reject_rates=(), default_out_rate=48000.0,
                 reject_input_rates=()):
        self.reject_rates = set(reject_rates)
        # Input-only rejections, ON TOP of the pair-wide reject_rates —
        # models a 16 kHz-only mic next to a 48 kHz-only sink (WARP-1060).
        self.reject_input_rates = set(reject_input_rates)
        self.default_out_rate = default_out_rate
        self.playrec_calls: list[dict] = []

    def _check(self, samplerate):
        if samplerate in self.reject_rates:
            raise self.PortAudioError(
                f"Invalid sample rate [PaErrorCode -9997]: {samplerate}",
            )

    def check_output_settings(self, device=None, samplerate=None,
                              channels=None, dtype=None):
        self._check(samplerate)

    def check_input_settings(self, device=None, samplerate=None,
                             channels=None, dtype=None):
        self._check(samplerate)
        if samplerate in self.reject_input_rates:
            raise self.PortAudioError(
                f"Invalid sample rate [PaErrorCode -9997]: {samplerate}",
            )

    def query_devices(self, device=None):
        return {"default_samplerate": self.default_out_rate}

    def playrec(self, tone, samplerate=None, channels=None, dtype=None,
                device=None):
        self.playrec_calls.append({
            "samples": int(len(tone)),
            "samplerate": samplerate,
            "device": device,
        })
        # Simulate the mic hearing the played tone in a quiet room.
        n = len(tone)
        t = np.arange(n, dtype=np.float64) / samplerate
        rec = (0.1 * np.sin(2 * np.pi * TONE_HZ * t)).astype(np.float32)
        return rec.reshape(-1, 1)

    def wait(self):
        pass


def test_echo_check_falls_back_when_pair_rejects_16k(monkeypatch):
    fake = _EchoFakeSd(reject_rates={16000})
    monkeypatch.setattr(audio_io, "_sd", fake)
    result = audio_io.echo_check(
        duration_s=1.0, samplerate=16000, input_device=1, output_device=2,
    )
    call = fake.playrec_calls[0]
    assert call["samplerate"] == 48000
    # The tone is regenerated at the fallback rate — 1.0 s of 48 kHz.
    assert call["samples"] == 48000
    assert call["device"] == (1, 2)
    assert result["heard"] is True


def test_echo_check_keeps_requested_rate_when_supported(monkeypatch):
    fake = _EchoFakeSd()
    monkeypatch.setattr(audio_io, "_sd", fake)
    result = audio_io.echo_check(
        duration_s=1.0, samplerate=16000, input_device=1, output_device=2,
    )
    call = fake.playrec_calls[0]
    assert call["samplerate"] == 16000
    assert call["samples"] == 16000
    assert result["heard"] is True


# ── input side re-validated at the fallback rate (WARP-1060, R3) ────
#
# The fallback rate comes from the OUTPUT device's default; a 16 kHz-
# only input next to a 48 kHz-only output has no shared full-duplex
# rate. That must surface as AudioUnavailable (→ an honest 503 with an
# explanation) rather than reaching playrec and failing with a bare
# PortAudioError.

def test_echo_check_raises_when_input_rejects_fallback_rate(monkeypatch):
    fake = _EchoFakeSd(
        reject_rates={16000},          # pair rejects the requested 16 kHz…
        reject_input_rates={48000},    # …and the mic also rejects the 48 kHz fallback
    )
    monkeypatch.setattr(audio_io, "_sd", fake)
    with pytest.raises(audio_io.AudioUnavailable, match="no supported sample rate"):
        audio_io.echo_check(
            duration_s=1.0, samplerate=16000, input_device=1, output_device=2,
        )
    # Never reached the hardware with a rate the pair can't do.
    assert fake.playrec_calls == []


def test_echo_check_fallback_still_works_when_input_accepts_it(monkeypatch):
    # Output-driven fallback + an input that accepts it — unchanged
    # behaviour from the F4 fix, now with the input explicitly probed.
    fake = _EchoFakeSd(reject_rates={16000}, reject_input_rates={44100})
    monkeypatch.setattr(audio_io, "_sd", fake)
    result = audio_io.echo_check(
        duration_s=1.0, samplerate=16000, input_device=1, output_device=2,
    )
    assert fake.playrec_calls[0]["samplerate"] == 48000
    assert result["heard"] is True
