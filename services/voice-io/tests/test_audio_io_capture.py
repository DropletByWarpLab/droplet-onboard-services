"""WARP-2213 — capture negotiation for the one-shot record() paths.

`record()` backs /audio/test-record, mic calibration and speaker
enrolment. It used to open the mic at exactly the rate and channel count
the caller asked for — invariably 16 kHz mono — with no capability probe.

Two ways that fails on the hardware this appliance actually ships with:

  - RATE. The onboard ALC897 advertises capture at {44100, 48000, 96000}
    and the ReSpeaker XVF3800 runs its USB interface at 48 kHz. A 16 kHz
    open raises PortAudio -9997 on both.
  - CHANNELS. Mic arrays like the XVF3800 expose only a 2-channel capture
    interface with no mono altset, and hand back digital SILENCE when
    opened as mono on the raw hw device. voice/pipeline.py has always
    opened those at their native count and downmixed; these one-shot
    paths did not.

The contract pinned here: negotiation happens INSIDE record(), and the
caller still receives exactly the rate and channel count it requested.
"""
from __future__ import annotations

import numpy as np
import pytest

from voice import audio_io
from voice.audio_io import (
    AudioUnavailable,
    negotiate_capture_channels,
    negotiate_capture_rate,
    record,
)


class _FakeSd:
    """Minimal sounddevice stand-in with a real rate/channel capability
    list, so a capability probe can actually fail."""

    class PortAudioError(Exception):
        pass

    def __init__(self, supported_rates, max_channels=2):
        self.supported_rates = set(supported_rates)
        self.max_channels = max_channels
        self.rec_calls: list[dict] = []
        self.checked: list[int] = []

    def query_devices(self, device=None):
        return {"max_input_channels": self.max_channels}

    def check_input_settings(self, device=None, samplerate=None,
                             channels=None, dtype=None):
        self.checked.append(samplerate)
        if channels > self.max_channels:
            raise self.PortAudioError("Invalid number of channels")
        if samplerate not in self.supported_rates:
            raise self.PortAudioError(
                f"Invalid sample rate [PaErrorCode -9997] ({samplerate})",
            )

    def rec(self, samples, samplerate=None, channels=None, dtype=None,
            device=None):
        self.rec_calls.append(
            {"samples": samples, "samplerate": samplerate,
             "channels": channels},
        )
        # A ramp, not silence — silence would mask a downmix bug.
        ramp = (np.arange(samples) % 97).astype(np.int16) * 300
        return np.tile(ramp.reshape(-1, 1), (1, channels))

    def wait(self):
        pass


@pytest.fixture
def fake_sd(monkeypatch):
    def _install(supported_rates, max_channels=2):
        sd = _FakeSd(supported_rates, max_channels)
        monkeypatch.setattr(audio_io, "_sd", sd)
        return sd
    return _install


class TestNegotiateCaptureRate:
    def test_prefers_the_requested_rate(self, fake_sd):
        sd = fake_sd({16000, 48000})
        assert negotiate_capture_rate(3, 16000, 1, sd=sd) == 16000
        assert sd.checked[0] == 16000, "requested rate must be probed first"

    def test_falls_back_when_requested_rate_is_refused(self, fake_sd):
        sd = fake_sd({44100, 48000, 96000})  # the real ALC897 list
        assert negotiate_capture_rate(3, 16000, 1, sd=sd) == 48000

    def test_returns_none_when_nothing_is_accepted(self, fake_sd):
        sd = fake_sd({22050})
        assert negotiate_capture_rate(3, 16000, 1, sd=sd) is None

    def test_binding_without_probe_yields_requested_rate(self):
        class _NoProbe:
            pass
        assert negotiate_capture_rate(3, 16000, 1, sd=_NoProbe()) == 16000


class TestNegotiateCaptureChannels:
    def test_mono_request_opens_stereo_on_a_2ch_array(self, fake_sd):
        """The XVF3800 trap: a mono open returns digital silence."""
        sd = fake_sd({48000}, max_channels=2)
        assert negotiate_capture_channels(3, 1, sd=sd) == 2

    def test_true_mono_device_stays_mono(self, fake_sd):
        sd = fake_sd({16000}, max_channels=1)
        assert negotiate_capture_channels(3, 1, sd=sd) == 1

    def test_capped_at_two_on_a_6ch_array(self, fake_sd):
        sd = fake_sd({48000}, max_channels=6)
        assert negotiate_capture_channels(3, 1, sd=sd) == 2


class TestRecordNegotiates:
    def test_48k_only_device_is_opened_at_48k_and_returned_at_16k(
        self, fake_sd,
    ):
        """THE REGRESSION: this open used to raise -9997 outright."""
        sd = fake_sd({44100, 48000, 96000}, max_channels=2)
        data = record(
            duration_s=1.0, samplerate=16000, channels=1, device=3,
        )
        assert sd.rec_calls[0]["samplerate"] == 48000
        assert sd.rec_calls[0]["channels"] == 2, (
            "a 2ch array must not be opened as mono — it returns silence"
        )
        # The CALLER still gets what it asked for: 1 s of 16 kHz mono.
        assert data.shape[0] == 16000
        assert data.ndim == 1 or data.shape[1] == 1
        assert data.dtype == np.int16

    def test_16k_capable_device_is_untouched(self, fake_sd):
        sd = fake_sd({16000, 48000}, max_channels=1)
        data = record(
            duration_s=0.5, samplerate=16000, channels=1, device=3,
        )
        assert sd.rec_calls[0]["samplerate"] == 16000
        assert sd.rec_calls[0]["channels"] == 1
        assert data.shape[0] == 8000

    def test_returned_audio_is_not_silence(self, fake_sd):
        """Guards the downmix+resample path against quietly zeroing the
        buffer — the failure mode would otherwise look like a dead mic."""
        fake_sd({48000}, max_channels=2)
        data = record(
            duration_s=1.0, samplerate=16000, channels=1, device=3,
        )
        assert np.abs(data.astype(np.float32)).mean() > 0.0

    def test_device_supporting_nothing_raises_audio_unavailable(
        self, fake_sd,
    ):
        fake_sd({22050}, max_channels=2)
        with pytest.raises(AudioUnavailable, match="supports none of"):
            record(duration_s=0.5, samplerate=16000, channels=1, device=3)

    def test_no_device_still_raises_before_probing(self, fake_sd):
        fake_sd({48000})
        with pytest.raises(AudioUnavailable, match="no input device"):
            record(duration_s=0.5, samplerate=16000, channels=1, device=None)
