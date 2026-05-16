"""WARP-154 — Wyoming TTS client contract.

The contract these tests pin:

  - `WyomingTTS.available` opens a TCP probe; returns False (not raise)
    on connect failure. Same shape as the STT side — /health depends
    on it being exception-free.
  - `synthesize()` sends a synthesize event with the text + voice,
    then reads audio-start + audio-chunk(s) + audio-stop and returns
    the concatenated PCM.
  - Empty / whitespace-only text short-circuits to an empty result
    (Piper hangs on empty input).
  - Network errors raise STTUnavailable's sibling TTSUnavailable.
  - `MockTTS.synthesize` records the text and voice for assertions
    and returns deterministic synthetic silence.
  - `build_tts_from_env` honours TTS_URL=__mock__, tcp://, and empty.

In-process Wyoming-protocol server stub does double duty — same wire
format as the STT side, so we can reuse the same approach.
"""
from __future__ import annotations

import json
import socket
import socketserver
import threading
from typing import Optional

import pytest

from voice.stt import _read_exactly, _read_json_line  # reused
from voice.tts import (
    DEFAULT_TTS_PORT,
    MockTTS,
    SynthesizedAudio,
    TTSUnavailable,
    WyomingTTS,
    build_tts_from_env,
)


# ────────────────────────────────────────────────────────────────────
# In-process Wyoming TTS server stub
# ────────────────────────────────────────────────────────────────────

class _PiperStubHandler(socketserver.BaseRequestHandler):
    """Reads one `synthesize` event, then streams back scripted audio:
    audio-start → audio-chunk × N → audio-stop. Captures the synthesize
    event so tests can assert it was wired correctly.
    """

    def handle(self) -> None:
        sock = self.request
        sock.settimeout(2.0)
        server: "_PiperStubServer" = self.server  # type: ignore[assignment]
        try:
            header = _read_json_line(sock)
            if header is None:
                return
            payload_len = int(header.get("payload_length") or 0)
            payload = _read_exactly(sock, payload_len) if payload_len else b""
            server.events.append((header, payload))

            if header.get("type") != "synthesize":
                # We only model the synthesize→audio flow. Drop the connection.
                return

            # Send the canned response.
            self._send_audio_start(sock, server)
            for chunk in server.scripted_chunks:
                self._send_chunk(sock, chunk, server)
            self._send_audio_stop(sock)
        except (TTSUnavailable, OSError, socket.timeout):
            return

    def _send(self, sock, event_type, data=None, payload=b""):
        header = {"type": event_type, "data": data, "payload_length": len(payload)}
        sock.sendall((json.dumps(header) + "\n").encode())
        if payload:
            sock.sendall(payload)

    def _send_audio_start(self, sock, server):
        self._send(sock, "audio-start", {
            "rate": server.sample_rate, "width": 2, "channels": 1,
        })

    def _send_chunk(self, sock, payload, server):
        self._send(sock, "audio-chunk", {
            "rate": server.sample_rate, "width": 2, "channels": 1,
        }, payload=payload)

    def _send_audio_stop(self, sock):
        self._send(sock, "audio-stop", None)


class _PiperStubServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self, addr,
        scripted_chunks: Optional[list[bytes]] = None,
        sample_rate: int = 22050,
    ):
        super().__init__(addr, _PiperStubHandler)
        self.events: list[tuple[dict, bytes]] = []
        self.scripted_chunks = scripted_chunks or [b"\xaa" * 100, b"\xbb" * 100]
        self.sample_rate = sample_rate


@pytest.fixture
def piper_stub():
    srv = _PiperStubServer(("127.0.0.1", 0))
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv, port
    srv.shutdown()
    srv.server_close()


# ────────────────────────────────────────────────────────────────────
# SynthesizedAudio dataclass
# ────────────────────────────────────────────────────────────────────

class TestSynthesizedAudio:
    def test_duration_s_computed_from_rate_width_and_pcm_len(self):
        # 22050 Hz × 2 bytes/sample × 1 channel × 1 second = 44100 bytes
        a = SynthesizedAudio(pcm=b"\x00" * 44100, sample_rate=22050,
                              sample_width=2, channels=1)
        assert a.duration_s == pytest.approx(1.0)

    def test_duration_s_zero_for_empty_pcm(self):
        a = SynthesizedAudio(pcm=b"", sample_rate=22050,
                              sample_width=2, channels=1)
        assert a.duration_s == 0.0

    def test_duration_s_zero_for_zero_rate(self):
        # Defensive: should never happen in practice, but div-by-zero
        # would crash /voice/say.
        a = SynthesizedAudio(pcm=b"\x00" * 1000, sample_rate=0,
                              sample_width=2, channels=1)
        assert a.duration_s == 0.0


# ────────────────────────────────────────────────────────────────────
# WyomingTTS — reachability probe
# ────────────────────────────────────────────────────────────────────

class TestWyomingTTSAvailable:
    def test_available_true_when_server_reachable(self, piper_stub):
        _, port = piper_stub
        client = WyomingTTS(host="127.0.0.1", port=port)
        assert client.available is True

    def test_available_false_when_no_server(self):
        client = WyomingTTS(host="127.0.0.1", port=1, connect_timeout_s=0.5)
        assert client.available is False

    def test_available_never_raises_on_resolution_failure(self):
        client = WyomingTTS(
            host="this-host-does-not-exist.invalid",
            port=10200,
            connect_timeout_s=1.0,
        )
        assert client.available is False


# ────────────────────────────────────────────────────────────────────
# WyomingTTS — synthesize round-trip
# ────────────────────────────────────────────────────────────────────

class TestWyomingTTSSynthesize:
    def test_returns_concatenated_pcm_with_correct_metadata(self, piper_stub):
        srv, port = piper_stub
        srv.scripted_chunks = [b"\x01\x02" * 50, b"\x03\x04" * 50]
        client = WyomingTTS(host="127.0.0.1", port=port,
                             default_voice="en_US-ryan-medium")

        audio = client.synthesize("hello world")
        assert audio.pcm == (b"\x01\x02" * 50) + (b"\x03\x04" * 50)
        assert audio.sample_rate == 22050
        assert audio.sample_width == 2
        assert audio.channels == 1

    def test_synthesize_event_carries_text_and_voice(self, piper_stub):
        srv, port = piper_stub
        client = WyomingTTS(host="127.0.0.1", port=port,
                             default_voice="my_custom_voice")
        client.synthesize("the time is 3 pm")
        assert len(srv.events) == 1
        header, _ = srv.events[0]
        assert header["type"] == "synthesize"
        assert header["data"]["text"] == "the time is 3 pm"
        assert header["data"]["voice"]["name"] == "my_custom_voice"

    def test_per_call_voice_overrides_default(self, piper_stub):
        srv, port = piper_stub
        client = WyomingTTS(host="127.0.0.1", port=port,
                             default_voice="default_voice")
        client.synthesize("hi", voice="override_voice")
        header, _ = srv.events[0]
        assert header["data"]["voice"]["name"] == "override_voice"

    def test_empty_text_short_circuits_no_network(self, piper_stub):
        srv, port = piper_stub
        client = WyomingTTS(host="127.0.0.1", port=port)
        # An empty synthesize would lock Piper; the client returns an
        # empty SynthesizedAudio without touching the network.
        audio = client.synthesize("")
        assert audio.pcm == b""
        assert audio.duration_s == 0.0
        assert srv.events == []  # we never connected

    def test_whitespace_only_text_also_short_circuits(self, piper_stub):
        srv, port = piper_stub
        client = WyomingTTS(host="127.0.0.1", port=port)
        audio = client.synthesize("   \n\t  ")
        assert audio.pcm == b""
        assert srv.events == []


class TestWyomingTTSErrorPaths:
    def test_connect_failure_raises_ttsunavailable(self):
        client = WyomingTTS(host="127.0.0.1", port=1, connect_timeout_s=0.5)
        with pytest.raises(TTSUnavailable, match="connect"):
            client.synthesize("hello")

    def test_synthesize_timeout_raises_ttsunavailable(self):
        class _SilentHandler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                self.request.settimeout(2.0)
                try:
                    while self.request.recv(4096):
                        pass
                except (OSError, socket.timeout):
                    pass

        srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _SilentHandler)
        srv.allow_reuse_address = True
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            client = WyomingTTS(
                host="127.0.0.1", port=port, synthesize_timeout_s=0.3,
            )
            with pytest.raises(TTSUnavailable):
                client.synthesize("hello")
        finally:
            srv.shutdown()
            srv.server_close()

    def test_peer_close_before_audio_stop_raises(self):
        # Server accepts synthesize then closes without sending audio-stop.
        class _NoStopHandler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                self.request.settimeout(2.0)
                try:
                    self.request.recv(4096)
                    # Send audio-start + chunk but never audio-stop.
                    self.request.sendall(
                        (json.dumps({"type": "audio-start",
                                     "data": {"rate": 22050, "width": 2, "channels": 1},
                                     "payload_length": 0}) + "\n").encode()
                    )
                    # No audio-stop. Close immediately.
                except OSError:
                    pass

        srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _NoStopHandler)
        srv.allow_reuse_address = True
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            client = WyomingTTS(
                host="127.0.0.1", port=port, synthesize_timeout_s=2.0,
            )
            with pytest.raises(TTSUnavailable):
                client.synthesize("hi")
        finally:
            srv.shutdown()
            srv.server_close()


# ────────────────────────────────────────────────────────────────────
# MockTTS
# ────────────────────────────────────────────────────────────────────

class TestMockTTS:
    def test_synthesize_records_text(self):
        tts = MockTTS()
        tts.synthesize("hello")
        tts.synthesize("world", voice="ryan")
        assert tts.texts_received == ["hello", "world"]
        assert tts.voices_received == [None, "ryan"]

    def test_synthesize_returns_synthetic_silence(self):
        tts = MockTTS(bytes_per_char=100)
        audio = tts.synthesize("hi")  # 2 chars × 100 = 200 bytes
        assert len(audio.pcm) == 200
        assert audio.pcm == b"\x00" * 200
        assert audio.sample_rate == 22050

    def test_available_true_by_default(self):
        assert MockTTS().available is True

    def test_available_false_when_explicitly_unavailable(self):
        assert MockTTS(available=False).available is False


# ────────────────────────────────────────────────────────────────────
# build_tts_from_env
# ────────────────────────────────────────────────────────────────────

class TestBuildTTSFromEnv:
    def test_default_is_wyoming_against_compose_dns(self, monkeypatch):
        monkeypatch.delenv("TTS_URL", raising=False)
        monkeypatch.delenv("TTS_VOICE", raising=False)
        tts = build_tts_from_env()
        assert isinstance(tts, WyomingTTS)
        assert tts._host == "wyoming-piper"
        assert tts._port == DEFAULT_TTS_PORT
        assert tts._default_voice == "en_US-ryan-medium"

    def test_mock_when_tts_url_double_underscore_mock(self, monkeypatch):
        monkeypatch.setenv("TTS_URL", "__mock__")
        assert isinstance(build_tts_from_env(), MockTTS)

    def test_tcp_url_parsed(self, monkeypatch):
        monkeypatch.setenv("TTS_URL", "tcp://10.0.0.7:9001")
        tts = build_tts_from_env()
        assert isinstance(tts, WyomingTTS)
        assert tts._host == "10.0.0.7"
        assert tts._port == 9001

    def test_voice_override_propagates(self, monkeypatch):
        monkeypatch.delenv("TTS_URL", raising=False)
        monkeypatch.setenv("TTS_VOICE", "en_GB-jenny-medium")
        tts = build_tts_from_env()
        assert tts._default_voice == "en_GB-jenny-medium"

    def test_malformed_url_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("TTS_URL", "nonsense")
        tts = build_tts_from_env()
        assert isinstance(tts, WyomingTTS)
        assert tts._host == "wyoming-piper"
