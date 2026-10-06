"""One persisted speaking voice for every reply, with temporary previews.

Only installed voices advertised by the running Kokoro service can be chosen.
Legacy Wyoming servers keep their configured default and cannot receive an
old Kokoro selection. State uses the existing /data volume, no database.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tempfile
import threading
from typing import Optional

from voice.tts import SynthesizedAudio, TextToSpeech, TTSUnavailable

VOICE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}\Z")
DEFAULT_PATH = "/data/speaking-voice.json"


class InvalidSpeakingVoice(ValueError):
    pass


class SpeakingVoiceStore:
    def __init__(self, path: Optional[str] = None):
        self.path = Path(path or os.environ.get("SPEAKING_VOICE_PATH") or DEFAULT_PATH)

    def read(self) -> tuple[Optional[str], Optional[str]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            voice = data.get("voice") if isinstance(data, dict) else None
            if not isinstance(voice, str) or not VOICE_ID.fullmatch(voice):
                raise ValueError("invalid voice")
            return voice, None
        except FileNotFoundError:
            return None, None
        except (OSError, ValueError):
            return None, "The saved speaking voice could not be read. Droplet is using its default voice."

    def save(self, voice: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(dir=self.path.parent, prefix=".speaking-voice-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump({"voice": voice}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.path)
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise


class SpeakingVoiceTTS(TextToSpeech):
    """Wrap the synthesis choke point, including streamed replies and cues."""

    def __init__(self, tts: TextToSpeech, store: SpeakingVoiceStore):
        self._tts = tts
        self._store = store
        self._lock = threading.Lock()
        self._voice, self._fault = store.read()
        self._choices: Optional[dict[str, dict]] = None
        self._effective_default: Optional[str] = None

    @property
    def available(self) -> bool:
        return self._tts.available

    @property
    def default_voice(self) -> str:
        return self._effective_default if self._effective_default is not None else self._tts.default_voice

    @property
    def voice_cache_key(self) -> str:
        with self._lock:
            return self._voice if self._choices and self._voice in self._choices else self.default_voice

    def describe(self) -> dict:
        return self._tts.describe()

    def snapshot(self) -> dict:
        try:
            info = self._tts.describe()
            engines = info.get("tts")
            if not isinstance(engines, list) or not engines:
                raise TTSUnavailable("No installed speech service was advertised.")
            for engine in engines:
                if not isinstance(engine, dict) or not isinstance(engine.get("voices", []), list):
                    raise TTSUnavailable("The speaking voice catalog could not be read.")
        except TTSUnavailable:
            with self._lock:
                self._choices = None
                self._effective_default = ""  # Leave the running server's default intact.
                return {"available": False, "selectable": False, "voice": self._voice,
                        "voices": [], "fault": "Speaking voices are unavailable. Try again in a moment."}
        choices: dict[str, dict] = {}
        installed: set[str] = set()
        server_default = ""
        for engine in engines:
            if engine.get("installed") is not True:
                continue
            engine_voices: dict[str, dict] = {}
            for entry in engine.get("voices", []):
                if not isinstance(entry, dict) or entry.get("installed") is not True:
                    continue
                name = entry.get("name")
                if not isinstance(name, str) or not VOICE_ID.fullmatch(name):
                    continue
                label = entry.get("description")
                engine_voices[name] = {"id": name, "label": label if isinstance(label, str) else name}
            installed.update(engine_voices)
            advertised_default = engine.get("default_voice")
            if isinstance(advertised_default, str) and advertised_default in engine_voices:
                server_default = advertised_default
            if engine.get("name") == "kokoro":
                choices.update(engine_voices)
        with self._lock:
            self._choices = choices
            configured = self._tts.default_voice
            # Existing boxes may still configure a Piper voice while now
            # connecting to Kokoro. Resolve even on the first reply, before
            # anybody visits the dashboard or saves a speaking voice.
            self._effective_default = configured if configured in installed else server_default
            chosen = self._voice or self.default_voice
            fault = self._fault
            if self._voice and choices and self._voice not in choices:
                chosen = self.default_voice
                fault = "The saved speaking voice is unavailable. Droplet is using its default voice."
            return {"available": True, "selectable": bool(choices),
                    "voice": chosen if chosen in choices else None,
                    "voices": list(choices.values()), "fault": fault}

    def validate(self, voice: str) -> None:
        if not isinstance(voice, str) or not VOICE_ID.fullmatch(voice):
            raise InvalidSpeakingVoice("Choose one of the available speaking voices.")
        snapshot = self.snapshot()
        if not snapshot["available"]:
            raise TTSUnavailable("Speaking voices are unavailable. Try again in a moment.")
        if voice not in {entry["id"] for entry in snapshot["voices"]}:
            raise InvalidSpeakingVoice("Choose one of the available speaking voices.")

    def choose(self, voice: str) -> dict:
        self.validate(voice)
        with self._lock:
            # Persist first. A failed save must not claim a lasting change.
            self._store.save(voice)
            self._voice = voice
            self._fault = None
            return {"voice": voice, "fault": None}

    def synthesize(self, text: str, voice: Optional[str] = None) -> SynthesizedAudio:
        if voice is not None:
            self.validate(voice)
            return self._tts.synthesize(text, voice=voice)
        with self._lock:
            needs_catalog = self._choices is None
        if needs_catalog:
            self.snapshot()
        with self._lock:
            chosen = self._voice if self._choices and self._voice in self._choices else self.default_voice
        return self._tts.synthesize(text, voice=chosen)
