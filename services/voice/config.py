"""
Configuration for the voice service.

Everything is env-driven so the operator can swap audio + GPIO + STT + TTS
backends without code changes. Defaults are the safest options:

  - audio backend: `mock` (no real I/O — useful for CI and dev)
  - gpio backend: `noop` (no pin manipulation — safe before pins are wired)
  - STT engine: `whisper-tiny` (fast, CPU-friendly)
  - TTS engine: `piper-en_us-amy-low` (fast, CPU-friendly)

To activate real hardware on the Jetson, set:
  VOICE_AUDIO_BACKEND=alsa
  VOICE_GPIO_BACKEND=jetson  # once pin mapping is decided
  VOICE_MIC_DEVICE=hw:1,0    # output of `arecord -l`
  VOICE_SPEAKER_DEVICE=hw:2,0
  VOICE_MIC_MUTE_GPIO=18     # board-pin number
  VOICE_MUTE_LED_GPIO=22
  VOICE_PTT_BUTTON_GPIO=24
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env_str(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class VoiceConfig:
    # ── Service ──
    listen_host: str
    listen_port: int
    log_level: str

    # ── Audio I/O ──
    audio_backend: str         # "mock" | "alsa"
    sample_rate_hz: int
    mic_device: str | None     # ALSA device, e.g. "hw:1,0". None = default
    speaker_device: str | None
    mic_channels: int

    # ── STT (speech → text) ──
    stt_backend: str           # "mock" | "whisper"
    whisper_model: str         # "tiny.en" | "base.en" | "small.en" | path
    whisper_device: str        # "cpu" | "cuda" | "auto"

    # ── TTS (text → speech) ──
    tts_backend: str           # "mock" | "piper"
    piper_voice: str           # voice model name or path

    # ── Wake-word ──
    # Off by default in v1 because openWakeWord needs a downloaded model file
    # at boot. Push-to-talk via the GPIO button or POST /voice/listen is the
    # default trigger.
    wake_word_enabled: bool
    wake_word_model: str       # openWakeWord model filename

    # ── Hardware GPIO ──
    gpio_backend: str          # "noop" | "jetson"
    mic_mute_gpio: int | None      # MOSFET on mic VDD line. HIGH = muted (cuts power)
    mute_led_gpio: int | None      # red LED indicator
    ptt_button_gpio: int | None    # push-to-talk momentary button (active-low)

    # ── Orchestrator integration ──
    orchestrator_url: str
    voice_token: str | None    # Bearer token for orchestrator → voice calls


def load_config() -> VoiceConfig:
    return VoiceConfig(
        listen_host=_env_str("VOICE_LISTEN_HOST", "0.0.0.0"),
        listen_port=_env_int("VOICE_LISTEN_PORT", 8090),
        log_level=_env_str("VOICE_LOG_LEVEL", "INFO"),

        audio_backend=_env_str("VOICE_AUDIO_BACKEND", "mock"),
        sample_rate_hz=_env_int("VOICE_SAMPLE_RATE_HZ", 16000),
        mic_device=os.environ.get("VOICE_MIC_DEVICE") or None,
        speaker_device=os.environ.get("VOICE_SPEAKER_DEVICE") or None,
        mic_channels=_env_int("VOICE_MIC_CHANNELS", 1),

        stt_backend=_env_str("VOICE_STT_BACKEND", "mock"),
        whisper_model=_env_str("VOICE_WHISPER_MODEL", "tiny.en"),
        whisper_device=_env_str("VOICE_WHISPER_DEVICE", "auto"),

        tts_backend=_env_str("VOICE_TTS_BACKEND", "mock"),
        piper_voice=_env_str("VOICE_PIPER_VOICE", "en_US-amy-low"),

        wake_word_enabled=_env_bool("VOICE_WAKE_WORD_ENABLED", False),
        wake_word_model=_env_str("VOICE_WAKE_WORD_MODEL", "hey_droplet.onnx"),

        gpio_backend=_env_str("VOICE_GPIO_BACKEND", "noop"),
        mic_mute_gpio=_env_int_optional("VOICE_MIC_MUTE_GPIO"),
        mute_led_gpio=_env_int_optional("VOICE_MUTE_LED_GPIO"),
        ptt_button_gpio=_env_int_optional("VOICE_PTT_BUTTON_GPIO"),

        orchestrator_url=_env_str("VOICE_ORCHESTRATOR_URL", "http://orchestrator:3000"),
        voice_token=os.environ.get("VOICE_TOKEN") or None,
    )


def _env_int_optional(name: str) -> int | None:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return None
    try:
        return int(raw)
    except ValueError:
        return None
