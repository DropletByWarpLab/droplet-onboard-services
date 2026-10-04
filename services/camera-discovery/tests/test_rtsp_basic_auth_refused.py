"""WARP-3597 — the prober never sends a password in clear (RTSP Basic).

A host that answers on the camera subnet and asks for Basic auth must receive no
credentials. Digest still works, and a camera the operator listed in
CAMERA_RTSP_BASIC_ALLOW_IPS may be answered with Basic. URLs published to MQTT or
returned by the API carry no ``user:pass@``.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib

import pytest

import main
import rtsp_prober

PASSWORD = "S3cretSitePw"
BASIC = b'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm="cam"\r\n\r\n'
DIGEST = (b'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n'
          b'WWW-Authenticate: Digest realm="r", nonce="n"\r\n\r\n')
BOTH = (b'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n'
        b'WWW-Authenticate: Basic realm="cam"\r\n'
        b'WWW-Authenticate: Digest realm="r", nonce="n"\r\n\r\n')
OK = b"RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n"


class StubServer:
    """Answers every unauthenticated DESCRIBE with `challenge`, 200 once an
    Authorization header arrives, and records every header block it saw."""

    def __init__(self, challenge: bytes):
        self.challenge = challenge
        self.seen: list[str] = []

    async def _handle(self, reader, writer):
        try:
            while True:
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = await reader.read(1024)
                    if not chunk:
                        return
                    data += chunk
                text = data.decode("utf-8", errors="ignore")
                self.seen.append(text)
                writer.write(OK if "authorization:" in text.lower() else self.challenge)
                await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            with contextlib.suppress(Exception):
                writer.close()

    async def __aenter__(self):
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        self._server.close()
        await self._server.wait_closed()

    @property
    def sent_authorization(self) -> bool:
        return any("authorization:" in s.lower() for s in self.seen)

    @property
    def sent_password(self) -> bool:
        b64 = base64.b64encode(f"admin:{PASSWORD}".encode()).decode()
        return any(PASSWORD in s or b64 in s for s in self.seen)


@pytest.fixture(autouse=True)
def _site_password(monkeypatch):
    monkeypatch.setenv("CAMERA_DEFAULT_USERNAME", "admin")
    monkeypatch.setenv("CAMERA_DEFAULT_PASSWORD", PASSWORD)
    monkeypatch.delenv("CAMERA_RTSP_BASIC_ALLOW_IPS", raising=False)


@pytest.mark.asyncio
async def test_basic_challenge_receives_no_credentials():
    async with StubServer(BASIC) as srv:
        ok = await rtsp_prober._try_credentials_once(
            "127.0.0.1", srv.port, "/live", "admin", PASSWORD)
    assert ok is False
    assert not srv.sent_authorization


@pytest.mark.asyncio
async def test_credential_sweep_sends_nothing_to_a_basic_only_host():
    async with StubServer(BASIC) as srv:
        assert await rtsp_prober.probe_rtsp_with_credentials("127.0.0.1", srv.port) is None
    assert not srv.sent_authorization
    assert not srv.sent_password


@pytest.mark.asyncio
async def test_verify_stream_does_not_send_basic_either():
    async with StubServer(BASIC) as srv:
        ok = await rtsp_prober.verify_stream(
            f"rtsp://admin:{PASSWORD}@127.0.0.1:{srv.port}/live")
    assert ok is False
    assert not srv.sent_password


@pytest.mark.asyncio
async def test_digest_still_authenticates_and_never_puts_the_password_on_the_wire():
    async with StubServer(DIGEST) as srv:
        ok = await rtsp_prober._try_credentials_once(
            "127.0.0.1", srv.port, "/live", "admin", PASSWORD)
    assert ok is True
    assert srv.sent_authorization and not srv.sent_password
    assert any("authorization: digest" in s.lower() for s in srv.seen)


@pytest.mark.asyncio
async def test_digest_is_preferred_when_a_host_offers_both():
    async with StubServer(BOTH) as srv:
        ok = await rtsp_prober._try_credentials_once(
            "127.0.0.1", srv.port, "/live", "admin", PASSWORD)
    assert ok is True
    assert not srv.sent_password
    assert not any("authorization: basic" in s.lower() for s in srv.seen)


@pytest.mark.asyncio
async def test_basic_is_sent_only_to_an_explicitly_listed_camera(monkeypatch):
    monkeypatch.setenv("CAMERA_RTSP_BASIC_ALLOW_IPS", "10.9.9.9, 127.0.0.1")
    async with StubServer(BASIC) as srv:
        ok = await rtsp_prober._try_credentials_once(
            "127.0.0.1", srv.port, "/live", "admin", PASSWORD)
    assert ok is True
    assert srv.sent_password


def test_redact_rtsp_url():
    r = rtsp_prober.redact_rtsp_url
    assert r("rtsp://admin:pw@10.0.0.5:554/live") == "rtsp://10.0.0.5:554/live"
    assert r("rtsp://admin:p@ss@10.0.0.5/live") == "rtsp://10.0.0.5/live"
    assert r("rtsp://10.0.0.5:554/a@b") == "rtsp://10.0.0.5:554/a@b"
    assert r(None) is None and r("") == ""


def test_public_camera_view_has_no_userinfo_and_flags_it():
    cam = {"ip": "10.0.0.5", "rtsp_url": "rtsp://admin:pw@10.0.0.5:554/live"}
    pub = main.public_camera(cam)
    assert "pw" not in str(pub) and "@" not in pub["rtsp_url"]
    assert pub["has_credentials"] is True
    assert cam["rtsp_url"].startswith("rtsp://admin:pw@")  # internal record untouched for Frigate
    assert main.public_camera({"ip": "x", "rtsp_url": "rtsp://10.0.0.5/live"})["has_credentials"] is False


def test_mqtt_payload_has_no_userinfo(monkeypatch):
    sent = []

    class _Mqtt:
        def publish(self, topic, payload, qos=0):
            sent.append(payload)

    monkeypatch.setattr(main, "mqtt_client", _Mqtt())
    main.publish_discovery({"event": "camera_accepted",
                            "camera": {"rtsp_url": "rtsp://admin:pw@10.0.0.5:554/live"}})
    assert len(sent) == 1 and "pw" not in sent[0] and "admin" not in sent[0]
