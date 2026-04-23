"""Audio backend + WAV codec round-trip tests."""

import io
import wave

import pytest

from audio import MockAudio, pcm_to_wav, wav_to_pcm
from config import VoiceConfig


def make_cfg(**overrides) -> VoiceConfig:
    """Build a VoiceConfig with all required fields filled — overrides
    take precedence so tests can vary just one field."""
    base = dict(
        listen_host="0.0.0.0", listen_port=8090, log_level="INFO",
        audio_backend="mock", sample_rate_hz=16000,
        mic_device=None, speaker_device=None, mic_channels=1,
        stt_backend="mock", whisper_model="tiny.en", whisper_device="auto",
        tts_backend="mock", piper_voice="en_US-amy-low",
        wake_word_enabled=False, wake_word_model="hey_droplet.onnx",
        gpio_backend="noop", mic_mute_gpio=None, mute_led_gpio=None, ptt_button_gpio=None,
        orchestrator_url="http://orchestrator:3000", voice_token=None,
    )
    base.update(overrides)
    return VoiceConfig(**base)


def test_mock_record_returns_correct_byte_count():
    audio = MockAudio(make_cfg(sample_rate_hz=16000))
    pcm = audio.record_seconds(1.0)
    # 16-bit mono at 16kHz = 32000 bytes/sec.
    assert len(pcm) == 32000


def test_mock_record_clamps_minimum_duration():
    """Asking for 0s shouldn't return 0 bytes — clamp to 50ms so the
    pipeline always has SOMETHING to process."""
    audio = MockAudio(make_cfg(sample_rate_hz=16000))
    pcm = audio.record_seconds(0.0)
    assert len(pcm) >= 1600  # 50ms * 16kHz * 2 bytes


def test_mock_record_produces_valid_pcm():
    """The mock should emit real 16-bit PCM that downstream STT can parse,
    not random bytes. Verify by wrapping in WAV and re-reading."""
    audio = MockAudio(make_cfg(sample_rate_hz=16000))
    pcm = audio.record_seconds(0.5)
    wav = pcm_to_wav(pcm, 16000)
    decoded_pcm, decoded_rate = wav_to_pcm(wav)
    assert decoded_rate == 16000
    assert decoded_pcm == pcm


def test_pcm_to_wav_round_trip():
    pcm = bytes([0, 0, 1, 0, 2, 0, 3, 0])  # 4 samples
    wav = pcm_to_wav(pcm, 8000)
    decoded, rate = wav_to_pcm(wav)
    assert rate == 8000
    assert decoded == pcm


def test_wav_to_pcm_rejects_stereo():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 100)
    with pytest.raises(ValueError, match="mono"):
        wav_to_pcm(buf.getvalue())


def test_wav_to_pcm_rejects_24bit():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(3)  # 24-bit
        w.setframerate(16000)
        w.writeframes(b"\x00\x00\x00" * 100)
    with pytest.raises(ValueError, match="16-bit"):
        wav_to_pcm(buf.getvalue())
