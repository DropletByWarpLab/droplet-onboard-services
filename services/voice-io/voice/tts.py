"""TTS via Wyoming protocol — symmetric to voice.stt for the reply path.

The pipeline calls `tts.synthesize(text)` to turn the LLM's reply
into PCM bytes, then hands the bytes to the speaker via
`voice.audio_io.play()`. We use Piper (Apache 2.0) for the same
reason we used openWakeWord + faster-whisper: all-OSS, on-device,
no licensing/cloud round-trips. `rhasspy/wyoming-piper` is the
official image — same Wyoming protocol as the STT side, just
flipped (we send `synthesize`, server streams `audio-chunk` back).

Wire format:

    → {"type": "synthesize", "data": {"text": "hello world"},
       "payload_length": 0}\\n
    ← {"type": "audio-start", "data": {"rate": 22050, "width": 2,
       "channels": 1}, "payload_length": 0}\\n
    ← {"type": "audio-chunk", "data": {...}, "payload_length": N}\\n
      <N bytes of int16 PCM at server's rate>
    ... more chunks ...
    ← {"type": "audio-stop", "data": null, "payload_length": 0}\\n

Piper's default voice is `en_US-ryan-medium` (~70 MB, sounds natural,
fast on CPU). The Wyoming-Piper image lets us swap voices via env;
production may pick a different one — the operator only has to set
`PIPER_VOICE` and restart.

`SynthesizedAudio` returned from `synthesize()` carries the rate +
width along with the PCM bytes, so the caller (pipeline.speak)
doesn't have to assume 16/22.05/24 kHz — Piper voices vary, and
the speaker driver in audio_io.play handles any rate sounddevice
accepts.

Threading + isolation same as STT: sync sockets, the wake-pipeline
thread blocks for the duration of synthesize() + play(). On CPU that's
~300-500 ms for typical replies; the dropped mic frames during that
window are harmless (we're not listening for wake while speaking
anyway — that's anti-feedback by design).
"""
from __future__ import annotations

import json
import logging
import socket
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

from voice.stt import (  # reuse the wire-helpers — same Wyoming protocol
    _read_event,
    _read_exactly,
    _read_json_line,
)

logger = logging.getLogger("voice.tts")


# Wyoming defaults. Override via env in main.py.
DEFAULT_TTS_HOST = "wyoming-piper"
DEFAULT_TTS_PORT = 10200
DEFAULT_TTS_VOICE = "en_US-ryan-medium"
DEFAULT_CONNECT_TIMEOUT_S = 5.0
DEFAULT_SYNTHESIZE_TIMEOUT_S = 15.0  # generous — Piper is fast but warm-up takes time


class TTSUnavailable(Exception):
    """Raised when the TTS server isn't reachable or returns an error."""


@dataclass(frozen=True)
class SynthesizedAudio:
    """One TTS result. The caller plays this via sounddevice."""

    pcm: bytes
    sample_rate: int  # server-determined; varies by voice (16k / 22.05k / 24k)
    sample_width: int  # bytes per sample, almost always 2 (int16)
    channels: int  # always 1 for Piper

    @property
    def duration_s(self) -> float:
        """Approximate playback length — useful for the pipeline's
        'speaking' state-decay window."""
        if self.sample_rate <= 0 or self.sample_width <= 0:
            return 0.0
        n_samples = len(self.pcm) // (self.sample_width * self.channels)
        return n_samples / self.sample_rate


# ────────────────────────────────────────────────────────────────────
# Abstract interface
# ────────────────────────────────────────────────────────────────────

class TextToSpeech(ABC):
    """Interface for text→PCM synthesis. WyomingTTS is production;
    MockTTS is the test seam + dev-mode no-server fallback."""

    @abstractmethod
    def synthesize(self, text: str, voice: Optional[str] = None) -> SynthesizedAudio:
        """Block until the server returns the full PCM payload.

        `voice` overrides the configured default. Piper accepts the
        empty voice (uses server default) or a specific voice name.
        """

    @property
    @abstractmethod
    def available(self) -> bool:
        """True iff the TTS server is reachable. Probed at startup."""


# ────────────────────────────────────────────────────────────────────
# Wyoming — production client
# ────────────────────────────────────────────────────────────────────

class WyomingTTS(TextToSpeech):
    def __init__(
        self,
        host: str = DEFAULT_TTS_HOST,
        port: int = DEFAULT_TTS_PORT,
        default_voice: str = DEFAULT_TTS_VOICE,
        connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S,
        synthesize_timeout_s: float = DEFAULT_SYNTHESIZE_TIMEOUT_S,
    ):
        self._host = host
        self._port = port
        self._default_voice = default_voice
        self._connect_timeout_s = connect_timeout_s
        self._synthesize_timeout_s = synthesize_timeout_s

    @property
    def available(self) -> bool:
        try:
            with socket.create_connection(
                (self._host, self._port), timeout=self._connect_timeout_s,
            ):
                return True
        except OSError as exc:
            logger.info("wyoming TTS %s:%d unreachable: %s", self._host, self._port, exc)
            return False

    def synthesize(
        self, text: str, voice: Optional[str] = None,
    ) -> SynthesizedAudio:
        if not text.strip():
            # Defensive: Piper hangs on an empty synthesize request in
            # some versions. Short-circuit with an empty audio result.
            return SynthesizedAudio(pcm=b"", sample_rate=22050, sample_width=2, channels=1)
        chosen_voice = (voice or self._default_voice).strip()

        try:
            sock = socket.create_connection(
                (self._host, self._port), timeout=self._connect_timeout_s,
            )
        except OSError as exc:
            raise TTSUnavailable(
                f"connect to wyoming TTS {self._host}:{self._port} failed: {exc}"
            ) from exc

        try:
            sock.settimeout(self._synthesize_timeout_s)
            # Piper accepts an optional `voice` key in synthesize.data.
            # Empty string ⇒ server-default voice.
            data: dict = {"text": text}
            if chosen_voice:
                data["voice"] = {"name": chosen_voice}
            self._send_event(sock, "synthesize", data)
            return self._read_audio_until_stop(sock)
        except (OSError, socket.timeout) as exc:
            raise TTSUnavailable(f"synthesize failed: {exc}") from exc
        finally:
            try:
                sock.close()
            except OSError:
                pass

    # ── wire helpers ─────────────────────────────────────────────

    @staticmethod
    def _send_event(
        sock: socket.socket,
        event_type: str,
        data: Optional[dict] = None,
        payload: bytes = b"",
    ) -> None:
        header = {"type": event_type, "data": data, "payload_length": len(payload)}
        line = (json.dumps(header) + "\n").encode("utf-8")
        sock.sendall(line)
        if payload:
            sock.sendall(payload)

    def _read_audio_until_stop(self, sock: socket.socket) -> SynthesizedAudio:
        """Drain server events until `audio-stop`. Concatenates chunks
        into one buffer for sounddevice playback.

        Server event order: audio-start (carries rate/width/channels),
        then any number of audio-chunk, then audio-stop. We tolerate
        the metadata being absent (some Piper versions emit it on
        each chunk instead) by reading it from whichever event has it.
        """
        chunks: list[bytes] = []
        rate, width, channels = 22050, 2, 1  # Piper default for ryan-medium
        while True:
            event = _read_event(sock)
            if event is None:
                raise TTSUnavailable("server closed before audio-stop")
            header, payload = event
            data = header.get("data") or {}
            event_type = header.get("type")

            if event_type == "audio-start":
                rate = int(data.get("rate", rate))
                width = int(data.get("width", width))
                channels = int(data.get("channels", channels))
                continue

            if event_type == "audio-chunk":
                # Some servers stamp rate/width/channels on each chunk —
                # if the audio-start was missing, pick them up here.
                rate = int(data.get("rate", rate))
                width = int(data.get("width", width))
                channels = int(data.get("channels", channels))
                if payload:
                    chunks.append(payload)
                continue

            if event_type == "audio-stop":
                # Payload (if any) already drained by _read_event.
                break

            # Unknown / informational event — _read_event already drained
            # its payload, so we can just loop.

        return SynthesizedAudio(
            pcm=b"".join(chunks),
            sample_rate=rate,
            sample_width=width,
            channels=channels,
        )


# ────────────────────────────────────────────────────────────────────
# Mock — tests + dev-mode no-TTS-server fallback
# ────────────────────────────────────────────────────────────────────

class MockTTS(TextToSpeech):
    """Returns canned silence (or scripted PCM) for tests. The
    `texts_received` list is exposed so callers can assert what got
    synthesized."""

    def __init__(
        self,
        available: bool = True,
        sample_rate: int = 22050,
        bytes_per_char: int = 100,  # synthesize_length proxy
    ):
        self._available = available
        self._sample_rate = sample_rate
        self._bytes_per_char = bytes_per_char
        self.texts_received: list[str] = []
        self.voices_received: list[Optional[str]] = []

    @property
    def available(self) -> bool:
        return self._available

    def synthesize(
        self, text: str, voice: Optional[str] = None,
    ) -> SynthesizedAudio:
        self.texts_received.append(text)
        self.voices_received.append(voice)
        # Deterministic synthetic silence — len roughly proportional
        # to text length, so duration_s tests are predictable.
        n = max(1, len(text)) * self._bytes_per_char
        return SynthesizedAudio(
            pcm=b"\x00" * n,
            sample_rate=self._sample_rate,
            sample_width=2,
            channels=1,
        )


# ────────────────────────────────────────────────────────────────────
# Factory — picks the right TTS for the current env.
# ────────────────────────────────────────────────────────────────────

def build_tts_from_env() -> TextToSpeech:
    """Resolve env config → TTS client.

    `TTS_URL`:
      - `tcp://host:port` → WyomingTTS
      - `__mock__`        → MockTTS (dev mode, silent playback)
      - empty/unset       → WyomingTTS against compose default DNS

    `TTS_VOICE` overrides the default Piper voice name.
    """
    import os
    import urllib.parse

    raw = (os.environ.get("TTS_URL") or "").strip()
    voice = (os.environ.get("TTS_VOICE") or DEFAULT_TTS_VOICE).strip() or DEFAULT_TTS_VOICE
    if raw == "__mock__":
        logger.info("TTS_URL=__mock__ → MockTTS (dev only, silent playback)")
        return MockTTS()
    if not raw:
        return WyomingTTS(default_voice=voice)
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "tcp" or not parsed.hostname or not parsed.port:
        logger.warning(
            "TTS_URL=%r not in tcp://host:port form; falling back to default", raw,
        )
        return WyomingTTS(default_voice=voice)
    return WyomingTTS(
        host=parsed.hostname, port=parsed.port, default_voice=voice,
    )
