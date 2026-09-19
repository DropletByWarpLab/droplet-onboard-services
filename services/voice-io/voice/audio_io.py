"""Thin wrappers around sounddevice for capture + playback.

The wrappers exist so the rest of the voice pipeline (wake / STT / TTS)
can be tested with synthetic numpy buffers without touching real
hardware. Both functions raise `AudioUnavailable` when sounddevice
isn't loadable or no device is wired — callers translate that to a
503 / warning.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional

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


# Capture-rate negotiation (WARP-2213).
#
# Most capture hardware does not offer 16 kHz: the appliance's onboard
# ALC897 advertises {44100, 48000, 96000} and the ReSpeaker XVF3800 runs
# its USB interface at 48 kHz. Opening at an unsupported rate fails with
# PortAudio -9997, so every capture path must ask the device what it
# accepts and resample, rather than assume.
#
# The caller's desired rate is always probed FIRST, so hardware that does
# support it is opened exactly as before and never resampled.
#
# SHARED with voice/pipeline.py's always-on wake loop, which imports this
# tuple rather than keeping a second copy — the two paths negotiating
# against different lists would mean a rate added for one device leaves
# the other still refusing it.
#
# Invariant the wake loop depends on: every candidate divides a 16 kHz
# wake frame exactly (1280 * rate / 16000 is a whole number for all of
# them), so one read yields exactly one detector frame — no carry buffer,
# no drift. Pinned by test_pipeline.py::TestCaptureRateCandidatesAreShared.
CAPTURE_RATE_CANDIDATES = (16000, 48000, 32000, 44100, 96000)

# Multichannel capture → mono for the detector, STT and the one-shot
# capture paths.
#
# "first" (default): consume CHANNEL 0 only. Mic arrays put the primary
# processed signal there — the reSpeaker XVF3800 ships beamformed voice
# on L and AEC *residual* on R, so a mean-of-channels downmix halves the
# voice amplitude and mixes in residual noise. That cost ~6 dB of
# effective sensitivity ("you have to talk really loud") and fed the
# VAD/wake/STT a dirtier signal. "mean" stays available via
# VOICE_INPUT_DOWNMIX for plain stereo mics where both channels carry
# the room.
#
# Lives HERE, not in pipeline.py, because the one-shot record() path
# (/audio/test-record, mic calibration, /speaker/enroll, /speaker/match)
# has to apply the same policy — and pipeline.py already imports from
# this module, so this is the only direction that does not cycle.
DEFAULT_INPUT_DOWNMIX = "first"


def downmix_to_mono(
    frames: np.ndarray, policy: str = DEFAULT_INPUT_DOWNMIX,
) -> np.ndarray:
    """Reduce a multichannel int16 capture block to a 1-D mono frame.

    `policy` is "first" (channel 0, the default — see
    DEFAULT_INPUT_DOWNMIX) or "mean". Anything else falls back to the
    default rather than raising: the value reaches here from an env var.
    A 1-channel block just flattens.
    """
    if frames.ndim <= 1 or frames.shape[1] <= 1:
        return frames.reshape(-1)
    if policy == "mean":
        return frames.mean(axis=1).astype(np.int16)
    return np.ascontiguousarray(frames[:, 0])


def negotiate_capture_rate(
    device: Optional[int],
    desired_rate: int,
    channels: int,
    sd: Any = None,
    candidates: tuple[int, ...] = CAPTURE_RATE_CANDIDATES,
) -> Optional[int]:
    """Return a capture rate `device` accepts, preferring `desired_rate`.

    Returns None when the device accepts none of them — the caller
    decides whether that is fatal or recoverable.

    A binding without `check_input_settings` (the fake `sd` injected by
    the pipeline tests) yields `desired_rate` unchanged, preserving the
    pre-negotiation behaviour rather than inventing a probe it cannot
    answer.
    """
    sd = sd if sd is not None else _sd
    check = getattr(sd, "check_input_settings", None)
    if not callable(check):
        return desired_rate
    ordered = (desired_rate,) + tuple(
        r for r in candidates if r != desired_rate
    )
    for rate in ordered:
        try:
            check(
                device=device, samplerate=rate,
                channels=channels, dtype="int16",
            )
        except Exception:
            continue
        return rate
    return None


def negotiate_capture_channels(
    device: Optional[int], desired_channels: int, sd: Any = None,
) -> int:
    """Channel count to OPEN with, which may exceed what the caller wants.

    Many USB mic arrays — notably the ReSpeaker XVF3800 — expose ONLY a
    2-channel capture interface (no mono altset) and hand back digital
    SILENCE when opened as mono on the raw hw device. voice/pipeline.py
    already opens such a device at its native count and downmixes; this
    applies the same rule to the one-shot capture paths (/audio/*, mic
    calibration, speaker enrolment), which were still opening mono and
    would have recorded silence from the array.

    Three rules, in order:

      - never name more channels than the device HAS. This is a count to
        hand PortAudio, and an open for more than the device offers is
        refused outright;
      - never fewer than the caller asked for, when the device can serve
        them;
      - widen a smaller request up to the device's native count, but only
        as far as 2 — enough to defeat the mono-altset trap without
        opening all six mics of an array to answer a mono request.
    """
    sd = sd if sd is not None else _sd
    try:
        info = sd.query_devices(device)
        native = int(info.get("max_input_channels") or 1)
    except Exception:
        return desired_channels
    available = max(1, native)
    wanted = max(1, desired_channels)
    return min(available, max(wanted, min(2, available)))


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

    # Open at something the device actually supports (WARP-2213), then
    # convert back to exactly what the caller asked for. Callers are
    # unchanged: they still get `channels` channels at `samplerate`.
    open_channels = negotiate_capture_channels(device, channels)
    open_rate = negotiate_capture_rate(device, samplerate, open_channels)
    if open_rate is None:
        raise AudioUnavailable(
            f"device {device} supports none of {CAPTURE_RATE_CANDIDATES} Hz "
            f"at {open_channels} ch",
        )

    samples = int(duration_s * open_rate)
    logger.debug(
        "recording %.2fs @ %d Hz / %d ch from device %s "
        "(caller asked %d Hz / %d ch)",
        duration_s, open_rate, open_channels, device, samplerate, channels,
    )
    data = _sd.rec(
        samples, samplerate=open_rate, channels=open_channels,
        dtype="int16", device=device,
    )
    _sd.wait()

    # Downmix BEFORE resampling — one channel through the polyphase
    # filter instead of several, for identical output. The mono case uses
    # the SAME policy as the wake loop (DEFAULT_INPUT_DOWNMIX): channel 0,
    # not the mean. Averaging an array's beamformed voice with its AEC
    # residual costs ~6 dB and dirties the signal, and these callers are
    # speaker enrolment and mic calibration — the two places a quiet,
    # noisier capture does the most damage.
    if data.ndim > 1 and data.shape[1] > channels:
        if channels == 1:
            data = downmix_to_mono(data).reshape(-1, 1)
        else:
            data = np.ascontiguousarray(data[:, :channels])
    if open_rate != samplerate:
        data = resample_int16(data, open_rate, samplerate)
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
        play_audio = resample_int16(audio, samplerate, target_rate)
        play_rate = target_rate

    _sd.play(play_audio, samplerate=play_rate, device=device)
    _sd.wait()


def resample_int16(
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


def _design_polyphase_taps(src_rate: int, dst_rate: int) -> np.ndarray:
    """The exact FIR `scipy.signal.resample_poly` would design for this
    rate pair, so it can be built ONCE and handed back on every call.

    Mirrors scipy's own defaults: reduce up/down by their gcd, cutoff
    1/max(up, down) of Nyquist, half-length 10·max(up, down), Kaiser β=5.
    float32 because that is the dtype of the signal we pass in — scipy
    casts a filter it designs itself to the signal's dtype, but uses an
    array `window` at ITS OWN dtype, so the cast has to happen here for
    the two paths to agree bit-for-bit.
    """
    import math

    from scipy.signal import firwin

    common = math.gcd(int(dst_rate), int(src_rate))
    up = int(dst_rate) // common
    down = int(src_rate) // common
    max_rate = max(up, down)
    half_len = 10 * max_rate
    taps = firwin(
        2 * half_len + 1, 1.0 / max_rate, window=("kaiser", 5.0),
    )
    return np.asarray(taps, dtype=np.float32)


def make_int16_resampler(
    src_rate: int, dst_rate: int,
) -> Callable[[np.ndarray], np.ndarray]:
    """Return a resampler for a FIXED rate pair that reuses one filter.

    `resample_int16` re-derives the ratio and re-designs a Kaiser FIR on
    every call. That is fine for the one-shot paths, but the wake loop
    resamples one ~80 ms block at a time, ~12 times a second, for the
    life of the box — and on a 44.1 kHz device the reduced ratio is
    160/441, so each call designs an 8821-tap filter it then throws away
    (~6 ms per frame, vs ~0.5 ms reusing it). Non-16 kHz hardware is
    exactly the case this whole capture path exists to serve.

    The rate pair is fixed for the life of a capture session, so the
    filter is designed once at stream-open and passed to `resample_poly`
    as its `window`. scipy still does all the padding and trimming; only
    the redundant design is skipped, so the output is sample-identical to
    `resample_int16` (pinned by TestCachedResampler).

    If the filter cannot be designed — a scipy that changed its design
    defaults, say — fall back to the uncached helper. This must degrade
    to "slower", never to "different audio".
    """
    if src_rate == dst_rate:
        return lambda audio: audio
    try:
        taps = _design_polyphase_taps(src_rate, dst_rate)
    except Exception:
        logger.warning(
            "resampler: cannot precompute the %d → %d Hz filter; "
            "falling back to per-call design",
            src_rate, dst_rate, exc_info=True,
        )
        return lambda audio: resample_int16(audio, src_rate, dst_rate)

    from scipy.signal import resample_poly

    def _resample(audio: np.ndarray) -> np.ndarray:
        as_float = audio.astype(np.float32) / 32768.0
        resampled = resample_poly(
            as_float, dst_rate, src_rate, axis=0, window=taps,
        )
        np.clip(resampled, -1.0, 1.0, out=resampled)
        return (resampled * 32767.0).astype(np.int16)

    return _resample


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


def detect_tone(
    recording: np.ndarray,
    samplerate: int,
    frequency_hz: float,
    band_hz: float = 30.0,
    margin_db: float = 12.0,
    min_tone_dbfs: float = -55.0,
) -> dict[str, float | bool]:
    """Did a played test tone actually arrive in this capture? (WARP-1055)

    Pure numpy so /audio/echo-check's judgment is unit-testable without
    hardware. Hann-windowed FFT; the tone's single-sided amplitude is
    the max bin inside ``frequency_hz ± band_hz``; the floor is the
    median bin amplitude across the speech band (100 Hz – 4 kHz)
    OUTSIDE that band, so one loud off-frequency source can't fake a
    detection. "Heard" requires the tone to clear the floor by
    ``margin_db`` AND an absolute level gate (``min_tone_dbfs``) — a
    dead speaker into a silent room yields a huge relative margin over
    a ~-120 dB floor, which the absolute gate rejects.
    """
    x = np.asarray(recording)
    if x.ndim > 1:
        x = x[:, 0]
    if x.dtype == np.int16:
        x = x.astype(np.float32) / 32768.0
    else:
        x = x.astype(np.float32)
    n = int(x.size)
    if n == 0:
        return {"heard": False, "tone_dbfs": -120.0, "floor_dbfs": -120.0}

    window = np.hanning(n)
    spectrum = np.abs(np.fft.rfft(x * window))
    # Single-sided sine-amplitude estimate under a Hann window:
    # |X(f0)| = A·n/4  →  A = 4|X|/n. (Scalloping loss ≤1.4 dB — noise
    # next to the 12 dB margin.)
    amp = spectrum * (4.0 / n)
    freqs = np.fft.rfftfreq(n, 1.0 / samplerate)

    band = (freqs >= frequency_hz - band_hz) & (freqs <= frequency_hz + band_hz)
    floor_mask = (
        (freqs >= 100.0)
        & (freqs <= min(4000.0, samplerate / 2.0))
        & ~band
    )

    def _db(a: float) -> float:
        return 20.0 * float(np.log10(a)) if a > 0.0 else -120.0

    tone_amp = float(amp[band].max()) if band.any() else 0.0
    floor_amp = float(np.median(amp[floor_mask])) if floor_mask.any() else 0.0
    tone_dbfs = max(-120.0, _db(tone_amp))
    floor_dbfs = max(-120.0, _db(floor_amp))
    heard = tone_dbfs >= min_tone_dbfs and tone_dbfs >= floor_dbfs + margin_db
    return {
        "heard": bool(heard),
        "tone_dbfs": round(tone_dbfs, 1),
        "floor_dbfs": round(floor_dbfs, 1),
    }


def _resolve_duplex_samplerate(
    samplerate: int,
    input_device: int,
    output_device: int,
) -> int:
    """Pick a samplerate the full-duplex pair actually accepts.

    Mirrors play()'s fallback: many USB sinks are 48 kHz-only and
    reject the voice pipeline's 16 kHz (PortAudioError -9997) — without
    this, /voice/say works (play() resamples) but the echo check could
    NEVER pass on such hardware, forcing the user into "Skip this
    check" forever. Falls back to the output device's default rate
    (48 kHz when even that can't be queried).

    The fallback is re-validated on the INPUT side too (WARP-1060, R3
    from the WARP-1055 review): full-duplex playrec needs ONE rate both
    ends accept, so a 16 kHz-only input + 48 kHz-only output pair has no
    usable rate — raise AudioUnavailable with the honest explanation
    instead of letting playrec fail with a bare PortAudioError.
    """
    try:
        _sd.check_output_settings(
            device=output_device, samplerate=samplerate, channels=1,
            dtype="float32",
        )
        _sd.check_input_settings(
            device=input_device, samplerate=samplerate, channels=1,
            dtype="float32",
        )
        return samplerate
    except Exception as exc:
        try:
            info = _sd.query_devices(output_device)
            target = int(info.get("default_samplerate") or 48000)
        except Exception:
            target = 48000
        logger.info(
            "echo check: device pair rejects %d Hz (%s); using %d Hz",
            samplerate, exc, target,
        )
        try:
            _sd.check_input_settings(
                device=input_device, samplerate=target, channels=1,
                dtype="float32",
            )
        except Exception as input_exc:
            raise AudioUnavailable(
                f"echo check: input device rejects the fallback rate "
                f"{target} Hz too ({input_exc}) — the mic/speaker pair "
                f"shares no supported sample rate for a full-duplex check",
            ) from input_exc
        return target


def echo_check(
    duration_s: float = 2.0,
    samplerate: int = 16000,
    frequency_hz: float = 440.0,
    input_device: Optional[int] = None,
    output_device: Optional[int] = None,
) -> dict[str, float | bool]:
    """Play the test tone and record SIMULTANEOUSLY, then ask
    `detect_tone` whether the tone made it back in. /audio/echo-check.

    Uses sounddevice's full-duplex `playrec` so the capture window is
    guaranteed to overlap the playback — a sequential play-then-record
    would race the room's decay and mostly measure silence. Mirrors
    /audio/test-record's mono-capture convention (channels=1). The
    samplerate falls back to the device pair's supported rate when the
    requested one is rejected (see _resolve_duplex_samplerate).
    """
    _require_sd()
    if input_device is None:
        raise AudioUnavailable("no input device resolved")
    if output_device is None:
        raise AudioUnavailable("no output device resolved")
    rate = _resolve_duplex_samplerate(samplerate, input_device, output_device)
    t = np.linspace(
        0, duration_s, int(duration_s * rate), endpoint=False,
    )
    # Same 0.3 amplitude as test_tone — audible, not a blast.
    tone = (0.3 * np.sin(2 * np.pi * frequency_hz * t)).astype(np.float32)
    logger.debug(
        "echo check: %.2fs %.0f Hz @ %d Hz, in=%s out=%s",
        duration_s, frequency_hz, rate, input_device, output_device,
    )
    # Device pair order per sounddevice: (input, output).
    recording = _sd.playrec(
        tone,
        samplerate=rate,
        channels=1,
        dtype="float32",
        device=(input_device, output_device),
    )
    _sd.wait()
    return detect_tone(
        np.asarray(recording).reshape(-1),
        samplerate=rate,
        frequency_hz=frequency_hz,
    )


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
