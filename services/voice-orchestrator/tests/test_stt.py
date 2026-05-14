"""WARP-154 — Wyoming STT client contract.

The contract these tests pin:

  - `WyomingSTT.available` opens a TCP probe to the server; returns
    False (not raise) on connect failure. Status endpoints depend on
    this never throwing.
  - `WyomingSTT.session()` raises STTUnavailable on a missing peer.
  - A successful session sends events in this order:
      transcribe → audio-start → audio-chunk... → audio-stop
    and receives a transcript event back.
  - `send_chunk` writes a JSON header followed by exactly the right
    payload-length bytes.
  - `finish()` blocks until a `transcript` event arrives; intermediate
    events of other types are drained quietly.
  - `_read_json_line` survives newline-buffered receives + raises
    cleanly on a peer that closes mid-line.
  - `build_stt_from_env` honours STT_URL=__mock__, tcp://, and empty.

We spin up a tiny in-process Wyoming "server" via socketserver to
exercise the real wire format. No external network or container.
"""
from __future__ import annotations

import json
import socket
import socketserver
import threading
import time
from typing import Optional

import pytest

from voice.stt import (
    DEFAULT_STT_PORT,
    MockSTT,
    STTUnavailable,
    WyomingSTT,
    _read_exactly,
    _read_json_line,
    build_stt_from_env,
)


# ────────────────────────────────────────────────────────────────────
# In-process Wyoming server stub
# ────────────────────────────────────────────────────────────────────

class _WyomingStubHandler(socketserver.BaseRequestHandler):
    """Reads Wyoming events from the client, then sends a scripted
    transcript event. Captures every event for assertions.
    """

    def handle(self) -> None:
        sock = self.request
        sock.settimeout(2.0)
        server: "_WyomingStubServer" = self.server  # type: ignore[assignment]
        try:
            while True:
                header = _read_json_line(sock)
                if header is None:
                    break
                payload_len = int(header.get("payload_length") or 0)
                payload = _read_exactly(sock, payload_len) if payload_len else b""
                server.events.append((header, payload))
                if header.get("type") == "audio-stop":
                    # Build the scripted transcript response.
                    text = server.scripted_transcript
                    resp = (
                        json.dumps({
                            "type": "transcript",
                            "data": {"text": text},
                            "payload_length": 0,
                        }) + "\n"
                    ).encode()
                    sock.sendall(resp)
                    break
        except (STTUnavailable, OSError, socket.timeout):
            return


class _WyomingStubServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, addr, scripted_transcript: str = "hello world"):
        super().__init__(addr, _WyomingStubHandler)
        self.events: list[tuple[dict, bytes]] = []
        self.scripted_transcript = scripted_transcript


@pytest.fixture
def wyoming_stub():
    """Start a Wyoming-protocol stub on an ephemeral port."""
    srv = _WyomingStubServer(("127.0.0.1", 0))
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv, port
    srv.shutdown()
    srv.server_close()


# ────────────────────────────────────────────────────────────────────
# WyomingSTT — reachability probe
# ────────────────────────────────────────────────────────────────────

class TestWyomingAvailable:
    def test_available_true_when_server_reachable(self, wyoming_stub):
        _, port = wyoming_stub
        client = WyomingSTT(host="127.0.0.1", port=port)
        assert client.available is True

    def test_available_false_when_no_server(self):
        # Port 1 is reserved; nothing listens, fast refusal.
        client = WyomingSTT(host="127.0.0.1", port=1, connect_timeout_s=0.5)
        assert client.available is False

    def test_available_never_raises_on_resolution_failure(self):
        client = WyomingSTT(
            host="this-host-does-not-exist.invalid",
            port=10300,
            connect_timeout_s=1.0,
        )
        # The point: `available` is consulted on every /health hit; it
        # MUST be exception-free or the dashboard sees 500s.
        assert client.available is False


# ────────────────────────────────────────────────────────────────────
# WyomingSTT — session round-trip
# ────────────────────────────────────────────────────────────────────

class TestWyomingSession:
    def test_session_sends_transcribe_then_audio_start_then_returns_transcript(
        self, wyoming_stub,
    ):
        srv, port = wyoming_stub
        srv.scripted_transcript = "what time is it"
        client = WyomingSTT(host="127.0.0.1", port=port)
        with client.session() as session:
            session.send_chunk(b"\x00" * 2560)  # one 80 ms frame at 16 kHz
            session.send_chunk(b"\x01" * 2560)
            transcript = session.finish()
        assert transcript == "what time is it"
        # Verify event order
        types = [e[0]["type"] for e in srv.events]
        assert types == ["transcribe", "audio-start", "audio-chunk", "audio-chunk", "audio-stop"]
        # Verify the payload-length headers match the actual payloads
        for header, payload in srv.events:
            assert header["payload_length"] == len(payload)

    def test_transcribe_event_carries_language(self, wyoming_stub):
        srv, port = wyoming_stub
        client = WyomingSTT(host="127.0.0.1", port=port, language="es")
        with client.session() as session:
            session.finish()
        first = srv.events[0][0]
        assert first["type"] == "transcribe"
        assert first["data"]["language"] == "es"

    def test_audio_chunk_metadata_correct(self, wyoming_stub):
        srv, port = wyoming_stub
        client = WyomingSTT(host="127.0.0.1", port=port)
        with client.session() as session:
            session.send_chunk(b"\x00" * 100)
            session.finish()
        chunk_events = [h for h, _ in srv.events if h["type"] == "audio-chunk"]
        assert chunk_events[0]["data"] == {"rate": 16000, "width": 2, "channels": 1}

    def test_transcript_strips_whitespace(self, wyoming_stub):
        srv, port = wyoming_stub
        srv.scripted_transcript = "   hello there\n"
        client = WyomingSTT(host="127.0.0.1", port=port)
        with client.session() as session:
            t = session.finish()
        assert t == "hello there"

    def test_close_is_idempotent(self, wyoming_stub):
        _, port = wyoming_stub
        client = WyomingSTT(host="127.0.0.1", port=port)
        session = client.session()
        session.finish()
        session.close()
        session.close()  # must not raise


class TestWyomingSessionErrorPaths:
    def test_connect_failure_raises_sttunavailable(self):
        client = WyomingSTT(host="127.0.0.1", port=1, connect_timeout_s=0.5)
        with pytest.raises(STTUnavailable, match="connect"):
            client.session()

    def test_finish_timeout_raises_sttunavailable(self):
        # Spin up a server that accepts the connection but NEVER replies.
        class _SilentHandler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                # Drain inputs, hold the socket open without ever
                # responding. Wyoming clients must time out cleanly.
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
            client = WyomingSTT(
                host="127.0.0.1", port=port, transcript_timeout_s=0.3,
            )
            with client.session() as session:
                with pytest.raises(STTUnavailable, match="transcript timeout"):
                    session.finish()
        finally:
            srv.shutdown()
            srv.server_close()

    def test_peer_close_before_transcript_raises(self):
        # Server accepts then closes immediately after the first read.
        class _CloseHandler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                self.request.settimeout(2.0)
                try:
                    self.request.recv(4096)
                except OSError:
                    pass
                # close on scope exit

        srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _CloseHandler)
        srv.allow_reuse_address = True
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            client = WyomingSTT(
                host="127.0.0.1", port=port, transcript_timeout_s=2.0,
            )
            with client.session() as session:
                with pytest.raises(STTUnavailable):
                    session.finish()
        finally:
            srv.shutdown()
            srv.server_close()


# ────────────────────────────────────────────────────────────────────
# MockSTT — tests + dev fallback
# ────────────────────────────────────────────────────────────────────

class TestMockSTT:
    def test_replays_scripted_transcripts_in_order(self):
        mock = MockSTT(scripted_transcripts=["one", "two", "three"])
        assert mock.available is True
        for expected in ("one", "two", "three"):
            with mock.session() as s:
                s.send_chunk(b"\x00" * 100)
                assert s.finish() == expected

    def test_returns_empty_string_when_script_exhausted(self):
        mock = MockSTT(scripted_transcripts=["once"])
        with mock.session() as s:
            s.finish()
        with mock.session() as s:
            assert s.finish() == ""

    def test_available_false_when_explicitly_unavailable(self):
        # Useful as a "STT degraded" stand-in in dev mode.
        mock = MockSTT(available=False)
        assert mock.available is False

    def test_sessions_opened_counter_tracks_lifecycle(self):
        mock = MockSTT()
        assert mock.sessions_opened == 0
        with mock.session():
            pass
        with mock.session():
            pass
        assert mock.sessions_opened == 2


# ────────────────────────────────────────────────────────────────────
# build_stt_from_env
# ────────────────────────────────────────────────────────────────────

class TestBuildSTTFromEnv:
    def test_default_is_wyoming_against_compose_dns(self, monkeypatch):
        monkeypatch.delenv("STT_URL", raising=False)
        monkeypatch.delenv("STT_LANGUAGE", raising=False)
        stt = build_stt_from_env()
        assert isinstance(stt, WyomingSTT)
        assert stt._host == "wyoming-faster-whisper"
        assert stt._port == DEFAULT_STT_PORT

    def test_mock_when_stt_url_double_underscore_mock(self, monkeypatch):
        monkeypatch.setenv("STT_URL", "__mock__")
        stt = build_stt_from_env()
        assert isinstance(stt, MockSTT)

    def test_tcp_url_parsed(self, monkeypatch):
        monkeypatch.setenv("STT_URL", "tcp://10.0.0.5:9999")
        stt = build_stt_from_env()
        assert isinstance(stt, WyomingSTT)
        assert stt._host == "10.0.0.5"
        assert stt._port == 9999

    def test_malformed_url_falls_back_to_default(self, monkeypatch):
        # Operator typo shouldn't take down the service.
        monkeypatch.setenv("STT_URL", "not a url at all")
        stt = build_stt_from_env()
        assert isinstance(stt, WyomingSTT)
        # falls back to compose default
        assert stt._host == "wyoming-faster-whisper"

    def test_language_override_propagates(self, monkeypatch):
        monkeypatch.delenv("STT_URL", raising=False)
        monkeypatch.setenv("STT_LANGUAGE", "es")
        stt = build_stt_from_env()
        assert isinstance(stt, WyomingSTT)
        assert stt._language == "es"


# ────────────────────────────────────────────────────────────────────
# Wire helpers
# ────────────────────────────────────────────────────────────────────

class TestWireHelpers:
    def test_read_json_line_handles_byte_by_byte_arrival(self):
        """Even slow networks shouldn't break the parser."""
        rsock, wsock = socket.socketpair()
        rsock.settimeout(1.0)
        try:
            # Send the bytes one at a time
            payload = b'{"type": "transcript", "data": {"text": "ok"}, "payload_length": 0}\n'
            for byte in payload:
                wsock.sendall(bytes([byte]))
            header = _read_json_line(rsock)
            assert header == {"type": "transcript", "data": {"text": "ok"}, "payload_length": 0}
        finally:
            rsock.close()
            wsock.close()

    def test_read_json_line_returns_none_on_clean_close(self):
        rsock, wsock = socket.socketpair()
        wsock.close()
        try:
            assert _read_json_line(rsock) is None
        finally:
            rsock.close()

    def test_read_exactly_blocks_for_full_payload(self):
        rsock, wsock = socket.socketpair()
        try:
            wsock.sendall(b"abcdefghij")
            wsock.close()
            data = _read_exactly(rsock, 10)
            assert data == b"abcdefghij"
        finally:
            rsock.close()
