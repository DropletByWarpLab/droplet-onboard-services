"""Installed voice allowlist, persistence, live defaults and temporary previews."""
import json
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import main
from voice.speaking_voice import InvalidSpeakingVoice, SpeakingVoiceStore, SpeakingVoiceTTS
from voice.tts import MockTTS, TTSUnavailable


class CatalogTTS(MockTTS):
    @property
    def default_voice(self):
        return "af_heart"

    def describe(self):
        if not self.available:
            raise TTSUnavailable("unreachable")
        return {"tts": [{"name": "kokoro", "installed": True, "default_voice": "af_heart", "voices": [
            {"name": "af_heart", "description": "Heart", "installed": True},
            {"name": "bm_george", "description": "George", "installed": True},
            {"name": "not_installed", "installed": False},
        ]}]}


@pytest.fixture
def speech(tmp_path):
    backend = CatalogTTS()
    store = SpeakingVoiceStore(str(tmp_path / "speaking-voice.json"))
    return SpeakingVoiceTTS(backend, store), backend, store


def test_selection_survives_restart_and_previews_never_change_it(speech):
    tts, backend, store = speech
    tts.choose("bm_george")
    tts.synthesize("a reply")
    tts.synthesize("a temporary preview", voice="af_heart")
    tts.synthesize("another reply")
    assert backend.voices_received == ["bm_george", "af_heart", "bm_george"]
    assert json.loads(store.path.read_text()) == {"voice": "bm_george"}
    assert SpeakingVoiceTTS(backend, store).snapshot()["voice"] == "bm_george"
    assert list(store.path.parent.glob("*.tmp")) == []


@pytest.mark.parametrize("voice", ["../arbitrary", "", "not_installed", "invented", "https://voice.example/model"])
def test_only_installed_advertised_voices_can_be_saved_or_previewed(speech, voice):
    tts, backend, store = speech
    with pytest.raises(InvalidSpeakingVoice):
        tts.choose(voice)
    with pytest.raises(InvalidSpeakingVoice):
        tts.synthesize("preview", voice=voice)
    assert not store.path.exists()
    assert not backend.texts_received


def test_failed_save_keeps_previous_choice(speech, monkeypatch):
    tts, backend, store = speech
    tts.choose("af_heart")
    monkeypatch.setattr(store, "save", Mock(side_effect=OSError("disk full")))
    with pytest.raises(OSError):
        tts.choose("bm_george")
    tts.synthesize("reply")
    assert backend.voices_received == ["af_heart"]


def test_unavailable_runtime_reports_no_choices_and_refuses_change(speech):
    tts, backend, store = speech
    backend._available = False
    result = tts.snapshot()
    assert result["available"] is False and result["voices"] == []
    with pytest.raises(TTSUnavailable):
        tts.choose("af_heart")
    assert not store.path.exists()


def test_legacy_server_never_receives_saved_kokoro_voice(speech, monkeypatch):
    tts, backend, store = speech
    tts.choose("bm_george")
    monkeypatch.setattr(backend, "describe", lambda: {"tts": [{"name": "piper", "installed": True,
        "voices": [{"name": "en_US-ryan-medium", "installed": True}]}]})
    legacy = SpeakingVoiceTTS(backend, store)
    assert legacy.snapshot()["selectable"] is False
    legacy.synthesize("reply")
    assert backend.voices_received == [""]
    with pytest.raises(InvalidSpeakingVoice):
        legacy.choose("bm_george")


def test_corrupt_state_uses_default_with_visible_fault(speech):
    tts, backend, store = speech
    store.path.write_text("{not json")
    result = SpeakingVoiceTTS(backend, store).snapshot()
    assert result["voice"] == "af_heart"
    assert result["fault"]


def test_fresh_speech_with_legacy_piper_config_uses_actual_kokoro_default(speech):
    _, backend, store = speech
    class OldConfig(CatalogTTS):
        @property
        def default_voice(self):
            return "en_US-ryan-medium"
    old = OldConfig()
    tts = SpeakingVoiceTTS(old, store)
    tts.synthesize("first reply, before a dashboard visit")
    assert old.voices_received == ["af_heart"]
    assert tts.snapshot()["voice"] == "af_heart"
    assert not store.path.exists()


def test_piper_rollback_keeps_installed_configured_voice_and_ignores_saved_kokoro(speech):
    _, backend, store = speech
    store.save("bm_george")
    class Piper(CatalogTTS):
        @property
        def default_voice(self):
            return "en_US-ryan-medium"
        def describe(self):
            return {"tts": [{"name": "piper", "installed": True,
                "voices": [{"name": "en_US-ryan-medium", "installed": True}]}]}
    legacy = Piper()
    tts = SpeakingVoiceTTS(legacy, store)
    tts.synthesize("reply after rollback")
    assert legacy.voices_received == ["en_US-ryan-medium"]
    assert tts.snapshot()["selectable"] is False


@pytest.mark.parametrize("info", [{"asr": []}, {"tts": None}, {"tts": []}, {"tts": [{"voices": None}]}])
def test_malformed_or_wrong_service_catalog_is_unavailable(speech, monkeypatch, info):
    tts, backend, store = speech
    monkeypatch.setattr(backend, "describe", lambda: info)
    assert tts.snapshot()["available"] is False
    assert tts.snapshot()["voices"] == []


def test_http_selection_and_preview(speech, monkeypatch):
    tts, backend, store = speech
    monkeypatch.setattr(main, "_speaking_tts", tts)
    pipeline = Mock()
    def speak(text, voice=None):
        tts.synthesize(text, voice)
        return {"ok": True, "duration_s": 1, "sample_rate": 22050}
    pipeline.speak.side_effect = speak
    monkeypatch.setattr(main, "_pipeline", pipeline)
    client = TestClient(main.app)
    assert client.get("/voice/speaking-voice").json()["voice"] == "af_heart"
    assert client.post("/voice/speaking-voice", json={"voice": "bm_george"}).json()["voice"] == "bm_george"
    assert client.post("/voice/say", json={"text": "preview", "voice": "af_heart"}).status_code == 200
    assert client.get("/voice/speaking-voice").json()["voice"] == "bm_george"
    assert backend.voices_received == ["af_heart"]
    assert client.post("/voice/speaking-voice", json={"voice": "unknown"}).status_code == 400
    assert client.post("/voice/say", json={"text": "preview", "voice": "unknown"}).status_code == 400
    assert client.post("/voice/speaking-voice", json={"voice": "../file"}).status_code == 400
    assert client.post("/voice/speaking-voice", json={"voice": "af_heart", "extra": True}).status_code == 422


def test_get_selection_works_while_pipeline_off(speech, monkeypatch):
    tts, backend, store = speech
    monkeypatch.setattr(main, "_speaking_tts", tts)
    monkeypatch.setattr(main, "_pipeline", None)
    client = TestClient(main.app)
    assert client.post("/voice/speaking-voice", json={"voice": "bm_george"}).status_code == 200
    assert client.get("/voice/speaking-voice").json()["voice"] == "bm_george"
