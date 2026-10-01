"""Playback's resampling fallback must not turn float audio into silence.

`audio_io.play()` resamples through `resample_int16` whenever the output
device rejects the source rate — the normal case on a 48 kHz-only sink
such as the ReSpeaker XVF3800. `resample_int16` scaled its input by
1/32768 unconditionally, which is right for int16 PCM and wrong for a
float32 buffer already in [-1, 1]: a 0.3-amplitude sine came out with an
int16 peak of 0. `test_tone()` (POST /audio/test-tone) synthesises
exactly that float32 sine, so the speaker test was silent on the one
sink it most needs to work on. Piper speech is int16 and was never
affected — pinned below so the fix does not move it.
"""
from __future__ import annotations

import numpy as np
import pytest

from voice import audio_io
from voice.audio_io import resample_int16, test_tone as play_test_tone


class _OutputFakeSd:
    """sounddevice stand-in whose output device only accepts 48 kHz."""

    class PortAudioError(Exception):
        pass

    def __init__(self, supported_rate: int = 48000):
        self.supported_rate = supported_rate
        self.played: list[tuple[np.ndarray, int]] = []

    def check_output_settings(self, device=None, samplerate=None,
                              channels=None, dtype=None):
        if samplerate != self.supported_rate:
            raise self.PortAudioError(
                f"Invalid sample rate [PaErrorCode -9997] ({samplerate})",
            )

    def query_devices(self, device=None):
        return {"default_samplerate": float(self.supported_rate)}

    def play(self, audio, samplerate=None, device=None):
        self.played.append((np.asarray(audio), samplerate))

    def wait(self):
        pass


def _sine(amplitude: float, rate: int = 16000, dtype=np.float32) -> np.ndarray:
    t = np.arange(rate // 10) / rate
    return (amplitude * np.sin(2 * np.pi * 440.0 * t)).astype(dtype)


class TestResampleInt16:
    def test_float32_input_keeps_its_level(self):
        out = resample_int16(_sine(0.3), 16000, 48000)
        assert out.dtype == np.int16
        # 0.3 of full scale ≈ 9830; the polyphase filter ripples a little.
        assert 9000 < int(np.abs(out).max()) < 10500

    def test_int16_input_is_unchanged_by_the_fix(self):
        pcm = (_sine(0.3) * 32767).astype(np.int16)
        out = resample_int16(pcm, 16000, 48000)
        assert out.dtype == np.int16
        assert 9000 < int(np.abs(out).max()) < 10500

    def test_float_input_is_clipped_not_wrapped(self):
        out = resample_int16(_sine(1.5), 16000, 48000)
        assert int(out.max()) <= 32767 and int(out.min()) >= -32768
        assert int(np.abs(out).max()) > 30000


class TestPlaybackFallback:
    @pytest.fixture
    def fake_sd(self, monkeypatch):
        sd = _OutputFakeSd()
        monkeypatch.setattr(audio_io, "_sd", sd)
        return sd

    def test_test_tone_on_a_48k_only_sink_is_audible(self, fake_sd):
        play_test_tone(duration_s=0.1, samplerate=16000, device=3)
        (audio, rate), = fake_sd.played
        assert rate == 48000
        assert int(np.abs(audio).max()) > 9000

    def test_supported_rate_plays_untouched(self, fake_sd):
        pcm = (_sine(0.3, rate=48000) * 32767).astype(np.int16)
        audio_io.play(pcm, samplerate=48000, device=3)
        (audio, rate), = fake_sd.played
        assert rate == 48000
        assert audio is pcm
