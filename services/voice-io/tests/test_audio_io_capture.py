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
    CAPTURE_RATE_CANDIDATES,
    DEFAULT_INPUT_DOWNMIX,
    AudioUnavailable,
    make_int16_resampler,
    negotiate_capture_channels,
    negotiate_capture_rate,
    record,
    resample_int16,
)


class _FakeSd:
    """Minimal sounddevice stand-in with a real rate/channel capability
    list, so a capability probe can actually fail."""

    class PortAudioError(Exception):
        pass

    def __init__(self, supported_rates, max_channels=2,
                 channel_values=None):
        self.supported_rates = set(supported_rates)
        self.max_channels = max_channels
        # When set, channel c is a CONSTANT channel_values[c]. That is how
        # a first-channel downmix is told apart from a mean one: a ramp
        # tiled across channels averages to itself and hides the
        # difference.
        self.channel_values = channel_values
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
        if self.channel_values is not None:
            block = np.zeros((samples, channels), dtype=np.int16)
            for c in range(channels):
                block[:, c] = self.channel_values[
                    c % len(self.channel_values)
                ]
            return block
        # A ramp, not silence — silence would mask a downmix bug.
        ramp = (np.arange(samples) % 97).astype(np.int16) * 300
        return np.tile(ramp.reshape(-1, 1), (1, channels))

    def wait(self):
        pass


@pytest.fixture
def fake_sd(monkeypatch):
    def _install(supported_rates, max_channels=2, channel_values=None):
        sd = _FakeSd(supported_rates, max_channels, channel_values)
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

    def test_stereo_request_narrows_to_a_mono_device(self, fake_sd):
        """The exported contract is 'what to OPEN with', so it can never
        name more channels than the device has. A 2-channel request
        against a mono device used to return 2 — an open that PortAudio
        refuses outright."""
        sd = fake_sd({48000}, max_channels=1)
        assert negotiate_capture_channels(3, 2, sd=sd) == 1

    def test_explicit_multichannel_request_is_not_capped_to_two(
        self, fake_sd,
    ):
        """The 2-channel cap exists to stop us WIDENING a mono request to
        a 6-mic array's full count — it is not a ceiling on a caller that
        genuinely asked for more."""
        sd = fake_sd({48000}, max_channels=6)
        assert negotiate_capture_channels(3, 4, sd=sd) == 4


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


class TestRecordDownmixPolicy:
    """record() must use the SAME channel policy as the wake loop.

    The reSpeaker XVF3800 carries beamformed voice on channel 0 and AEC
    *residual* on channel 1. Averaging them halves the voice and mixes in
    the residual — about 6 dB of effective sensitivity, which is exactly
    the regression voice/pipeline.py moved away from when it adopted
    DEFAULT_INPUT_DOWNMIX = "first". record() backs /speaker/enroll,
    /speaker/match and mic calibration, so it must not diverge.
    """

    def test_stereo_downmix_takes_channel_zero_not_the_mean(self, fake_sd):
        fake_sd({16000}, max_channels=2, channel_values=(1000, 0))
        data = record(
            duration_s=0.1, samplerate=16000, channels=1, device=3,
        )
        # A mean-of-channels downmix would deliver 500 — half the voice.
        assert int(data.reshape(-1)[0]) == 1000

    def test_residual_channel_is_not_mixed_into_the_voice(self, fake_sd):
        """Channel 1 noise must not reach the caller at all."""
        fake_sd({16000}, max_channels=2, channel_values=(0, 8000))
        data = record(
            duration_s=0.1, samplerate=16000, channels=1, device=3,
        )
        assert int(np.abs(data).max()) == 0

    def test_the_wake_loop_shares_this_exact_helper(self):
        """pipeline.py must not carry a second copy of the policy — the
        wake loop and the one-shot paths desyncing is the bug.

        Asserted on the FUNCTION object, not the constant: "first" is an
        interned string literal, so an identity check on the constant
        would pass even with two independent definitions.
        """
        from voice import pipeline

        assert DEFAULT_INPUT_DOWNMIX == "first"
        assert pipeline.downmix_to_mono is audio_io.downmix_to_mono
        assert pipeline.DEFAULT_INPUT_DOWNMIX == DEFAULT_INPUT_DOWNMIX


class TestCachedResampler:
    """The wake loop resamples one ~80 ms block ~12x a second for the life
    of the box, and resample_int16 re-designs a Kaiser FIR on every call
    (8821 taps for 44.1 kHz). The rate pair is fixed for a capture
    session, so the filter is designed once per stream-open — and the
    output has to stay sample-identical."""

    @staticmethod
    def _block(src_rate: int) -> np.ndarray:
        rng = np.random.default_rng(2213)
        n = 1280 * src_rate // 16000
        return rng.integers(-20000, 20000, n).astype(np.int16)

    def test_matches_the_uncached_helper_for_every_candidate(self):
        for src in CAPTURE_RATE_CANDIDATES:
            block = self._block(src)
            cached = make_int16_resampler(src, 16000)(block)
            uncached = resample_int16(block, src, 16000)
            assert np.array_equal(cached, uncached), (
                f"cached resampler diverged from resample_int16 at {src} Hz"
            )

    def test_reused_across_calls_without_drifting(self):
        resample = make_int16_resampler(48000, 16000)
        block = self._block(48000)
        first = resample(block)
        for _ in range(5):
            assert np.array_equal(resample(block), first), (
                "the cached filter must not be mutated by use"
            )

    def test_identity_when_the_rates_already_match(self):
        block = np.arange(16, dtype=np.int16)
        assert make_int16_resampler(16000, 16000)(block) is block

    def test_falls_back_to_the_uncached_helper_if_design_fails(
        self, monkeypatch,
    ):
        """A scipy that changed its filter-design defaults must degrade to
        'slower', never to 'different audio'."""
        def _boom(*a, **k):
            raise RuntimeError("no firwin here")

        monkeypatch.setattr(audio_io, "_design_polyphase_taps", _boom)
        block = self._block(48000)
        assert np.array_equal(
            make_int16_resampler(48000, 16000)(block),
            resample_int16(block, 48000, 16000),
        )
