"""WARP-1812 — RTSP credential prober must authenticate qop=auth digest cameras.

The Hanwha XNV-C8083R challenges with ``Digest realm="iPOLiS", qop="auth"`` and
(a) rejects the legacy qop-less RFC 2069 digest the prober used to send, and
(b) binds the nonce to the TCP connection, so the authenticated retry must run
on the *same* socket as the challenge. Both were true live: a qop-less digest
401'd, a proper RFC 2617 qop=auth digest on the same connection returned 200.

These tests drive real fake RTSP servers that validate the digest math:
  * qop=auth + connection-bound nonce (the real camera) → authenticates.
  * qop-less challenge (older cameras) → still authenticates (RFC 2069 path).
  * hard-close-after-401 firmware → falls back to a fresh connection.
  * wrong password → never authenticates.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import re

import pytest

import rtsp_prober

USER, PW, REALM = "admin", "Droplet123!", "iPOLiS"


def _md5(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()


def _auth_params(header: str) -> dict:
    out = {}
    for m in re.finditer(r'(\w+)=(?:"([^"]*)"|([^,\s]+))', header):
        out[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)
    return out


class FakeDigestServer:
    """RTSP responder that enforces a real digest handshake.

    modes:
      * ``qop`` — challenge carries ``qop="auth"``; nonce is bound to the
        connection (auth must arrive on the same socket that was challenged).
      * ``qopless`` — challenge has no qop; nonce still connection-bound.
      * ``hardclose`` — challenge has ``qop="auth"`` then the socket is closed
        after the 401; the auth is accepted on a fresh connection reusing the
        same nonce (stateless-nonce firmware).
    """

    def __init__(self, mode: str = "qop", password: str = PW):
        self.mode = mode
        self.password = password
        self.port: int | None = None
        self._server = None
        self._seq = 0
        self.issued: set[str] = set()

    def _issue(self) -> str:
        self._seq += 1
        n = f"nonce{self._seq:016x}"
        self.issued.add(n)
        return n

    def _challenge(self, nonce: str) -> str:
        if self.mode == "qopless":
            return f'Digest realm="{REALM}", nonce="{nonce}"'
        return f'Digest realm="{REALM}", nonce="{nonce}", qop="auth"'

    def _math_ok(self, p: dict) -> bool:
        if p.get("username") != USER:
            return False
        uri = p.get("uri", "")
        ha1 = _md5(f"{USER}:{REALM}:{self.password}")
        ha2 = _md5(f"DESCRIBE:{uri}")
        if "qop" in p:
            expect = _md5(
                f'{ha1}:{p.get("nonce","")}:{p.get("nc","")}:'
                f'{p.get("cnonce","")}:{p["qop"]}:{ha2}'
            )
        else:
            expect = _md5(f'{ha1}:{p.get("nonce","")}:{ha2}')
        return p.get("response") == expect

    async def _handle(self, reader, writer):
        conn_nonce: str | None = None
        try:
            while True:
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = await reader.read(1024)
                    if not chunk:
                        return
                    data += chunk
                text = data.decode("iso-8859-1")
                auth = ""
                for ln in text.split("\r\n"):
                    if ln.lower().startswith("authorization:"):
                        auth = ln.split(":", 1)[1].strip()
                        break

                if not auth:
                    conn_nonce = self._issue()
                    writer.write(
                        f"RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n"
                        f"WWW-Authenticate: {self._challenge(conn_nonce)}\r\n\r\n".encode()
                    )
                    await writer.drain()
                    if self.mode == "hardclose":
                        return  # drop the socket after the 401
                    continue

                p = _auth_params(auth)
                nonce_ok = (
                    p.get("nonce") in self.issued
                    if self.mode == "hardclose"
                    else p.get("nonce") == conn_nonce
                )
                ok = nonce_ok and self._math_ok(p)
                writer.write(
                    f"RTSP/1.0 {'200 OK' if ok else '401 Unauthorized'}\r\nCSeq: 2\r\n\r\n".encode()
                )
                await writer.drain()
                if ok:
                    return
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()

    async def __aenter__(self):
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        self._server.close()
        await self._server.wait_closed()


class TestDigestHeader:
    def test_qop_auth_emits_rfc2617_fields(self):
        h = rtsp_prober._digest_header(
            USER, PW, "DESCRIBE", "rtsp://x/y",
            {"scheme": "digest", "realm": REALM, "nonce": "abc", "qop": "auth"},
        )
        assert "qop=auth" in h and "cnonce=" in h and "nc=00000001" in h

    def test_no_qop_stays_rfc2069(self):
        h = rtsp_prober._digest_header(
            USER, PW, "DESCRIBE", "rtsp://x/y",
            {"scheme": "digest", "realm": REALM, "nonce": "abc"},
        )
        assert "qop" not in h and "cnonce" not in h and "response=" in h


class TestTryCredentials:
    @pytest.mark.asyncio
    async def test_qop_auth_connection_bound_authenticates(self):
        async with FakeDigestServer("qop") as srv:
            ok = await rtsp_prober._try_credentials_once(
                "127.0.0.1", srv.port, "/profile2/media.smp", USER, PW
            )
        assert ok is True

    @pytest.mark.asyncio
    async def test_qopless_still_authenticates(self):
        async with FakeDigestServer("qopless") as srv:
            ok = await rtsp_prober._try_credentials_once(
                "127.0.0.1", srv.port, "/live", USER, PW
            )
        assert ok is True

    @pytest.mark.asyncio
    async def test_hardclose_falls_back_to_fresh_connection(self):
        async with FakeDigestServer("hardclose") as srv:
            ok = await rtsp_prober._try_credentials_once(
                "127.0.0.1", srv.port, "/profile2/media.smp", USER, PW
            )
        assert ok is True

    @pytest.mark.asyncio
    async def test_wrong_password_rejected(self):
        async with FakeDigestServer("qop", password="not-the-password") as srv:
            ok = await rtsp_prober._try_credentials_once(
                "127.0.0.1", srv.port, "/profile2/media.smp", USER, PW
            )
        assert ok is False


class TestProbeCameraEndToEnd:
    @pytest.mark.asyncio
    async def test_qop_camera_is_adopted_with_credentials(self, monkeypatch):
        """probe_camera returns a credentialed rtsp_default_credentials result
        for a qop=auth camera when the operator password is in the ladder —
        the live XNV-C8083R adoption path."""
        monkeypatch.setattr(rtsp_prober, "get_credentials", lambda: [(USER, PW)])
        async with FakeDigestServer("qop") as srv:
            async def only_our_port(ip, ports=None, timeout=2.0):
                return [srv.port]

            monkeypatch.setattr(rtsp_prober, "scan_ports", only_our_port)
            info = await rtsp_prober.probe_camera("127.0.0.1")

        assert info is not None
        assert info["detection_method"] == "rtsp_default_credentials"
        assert info["username"] == USER
        assert f":{srv.port}" in info["rtsp_url"]
