"""WARP-1806 — auth-challenging cameras must not be classified "not a camera".

Live failure this pins: a Hanwha Wisenet (XNV-C8083R) answers the bare-path
``OPTIONS rtsp://ip:554/`` with ``400 Bad Request`` + un-echoed ``CSeq: 0`` —
byte-for-byte the TP-Link-AP not-a-camera fingerprint ``is_rtsp_server``
rejects — while a ``DESCRIBE`` on a real stream path returns a well-formed
``401 Unauthorized`` with a ``WWW-Authenticate: Digest`` challenge. The old
classifier stopped at the OPTIONS shape, so ``probe_camera`` returned ``None``
and the scan loop dropped the camera entirely: an installed, powered camera
that never appeared in the discovered list, not even as needs-setup.

The fix: when the bare-path OPTIONS is rejecting/ambiguous, fall back to
anonymous DESCRIBEs on the first few known stream paths. Accept 200, a 401
that carries a challenge, 403, and Hanwha's non-standard 490 "Account
Blocked"; keep rejecting challenge-less 400s (the TP-Link AP), HTTP
responders, and silence. Anonymous requests carry no Authorization header, so
the fallback can never consume a vendor's failed-login lockout budget.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib
from urllib.parse import urlsplit

import pytest

import rtsp_prober


class FakeRtspServer:
    """Minimal scripted RTSP responder on 127.0.0.1:<ephemeral>.

    ``respond(method, path) -> bytes`` scripts the reply. Serves any number
    of requests per connection (the prober's digest retry reuses none, but
    robustness here keeps the tests honest about connection handling).
    """

    def __init__(self, respond):
        self.respond = respond
        self.requests: list[tuple[str, str]] = []
        self._server: asyncio.AbstractServer | None = None
        self.port: int | None = None

    async def _handle(self, reader, writer):
        try:
            while True:
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = await reader.read(1024)
                    if not chunk:
                        return
                    data += chunk
                head = data.decode("utf-8", errors="ignore").split("\r\n", 1)[0]
                parts = head.split(" ")
                method = parts[0] if parts else ""
                url = parts[1] if len(parts) > 1 else ""
                path = urlsplit(url).path if url.startswith("rtsp") else url
                self.requests.append((method, path))
                writer.write(self.respond(method, path))
                await writer.drain()
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


_NOT_A_CAMERA_400 = b"RTSP/1.0 400 Bad Request\r\nCSeq: 0\r\n\r\n"


def _hanwha_like(method: str, path: str) -> bytes:
    """Bare-path OPTIONS rejected; any DESCRIBE auth-challenges (observed live)."""
    if method == "OPTIONS":
        return _NOT_A_CAMERA_400
    return (
        b"RTSP/1.0 401 Unauthorized\r\n"
        b"CSeq: 1\r\n"
        b'WWW-Authenticate: Digest realm="iPOLiS", nonce="deadbeef", qop="auth"\r\n'
        b"\r\n"
    )


def _hanwha_locked(method: str, path: str) -> bytes:
    """Mid-lockout Hanwha: OPTIONS still 400s, DESCRIBE answers 490."""
    if method == "OPTIONS":
        return _NOT_A_CAMERA_400
    return b"RTSP/1.0 490 Account Blocked\r\nCSeq: 1\r\n\r\n"


def _tplink_like(method: str, path: str) -> bytes:
    """Port-554-open non-camera: challenge-less 400 on everything."""
    return _NOT_A_CAMERA_400


def _http_responder(method: str, path: str) -> bytes:
    return b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"


def _challengeless_401(method: str, path: str) -> bytes:
    """401 without WWW-Authenticate — not a real RTSP auth flow."""
    if method == "OPTIONS":
        return _NOT_A_CAMERA_400
    return b"RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n"


def _open_camera(method: str, path: str) -> bytes:
    return (
        b"RTSP/1.0 200 OK\r\nCSeq: 1\r\n"
        b"Public: OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY\r\n\r\n"
    )


class TestIsRtspServer:
    @pytest.mark.asyncio
    async def test_auth_challenging_camera_is_rtsp(self):
        async with FakeRtspServer(_hanwha_like) as srv:
            assert await rtsp_prober.is_rtsp_server("127.0.0.1", srv.port) is True
        # The fallback actually issued anonymous DESCRIBEs after the OPTIONS.
        methods = [m for m, _ in srv.requests]
        assert methods[0] == "OPTIONS"
        assert "DESCRIBE" in methods

    @pytest.mark.asyncio
    async def test_locked_out_camera_is_rtsp(self):
        async with FakeRtspServer(_hanwha_locked) as srv:
            assert await rtsp_prober.is_rtsp_server("127.0.0.1", srv.port) is True

    @pytest.mark.asyncio
    async def test_tplink_ap_fingerprint_still_rejected(self):
        async with FakeRtspServer(_tplink_like) as srv:
            assert await rtsp_prober.is_rtsp_server("127.0.0.1", srv.port) is False

    @pytest.mark.asyncio
    async def test_http_responder_still_rejected(self):
        async with FakeRtspServer(_http_responder) as srv:
            assert await rtsp_prober.is_rtsp_server("127.0.0.1", srv.port) is False

    @pytest.mark.asyncio
    async def test_401_without_challenge_rejected(self):
        async with FakeRtspServer(_challengeless_401) as srv:
            assert await rtsp_prober.is_rtsp_server("127.0.0.1", srv.port) is False

    @pytest.mark.asyncio
    async def test_clean_options_fast_path_skips_fallback(self):
        async with FakeRtspServer(_open_camera) as srv:
            assert await rtsp_prober.is_rtsp_server("127.0.0.1", srv.port) is True
        assert [m for m, _ in srv.requests] == ["OPTIONS"]

    @pytest.mark.asyncio
    async def test_fallback_probes_known_stream_paths_anonymously(self):
        """The fallback must try real stream paths (Hanwha's are first) and
        never send an Authorization header — a wrong guess there would burn
        the vendor's failed-login lockout budget."""
        seen_paths: list[str] = []
        seen_auth: list[bool] = []

        def respond(method: str, path: str) -> bytes:
            if method == "DESCRIBE":
                seen_paths.append(path)
            return _NOT_A_CAMERA_400

        class RecordingServer(FakeRtspServer):
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
                        if text.startswith("DESCRIBE"):
                            seen_auth.append("authorization:" in text.lower())
                        head = text.split("\r\n", 1)[0]
                        parts = head.split(" ")
                        method = parts[0] if parts else ""
                        url = parts[1] if len(parts) > 1 else ""
                        path = urlsplit(url).path if url.startswith("rtsp") else url
                        self.requests.append((method, path))
                        writer.write(self.respond(method, path))
                        await writer.drain()
                except (ConnectionResetError, BrokenPipeError):
                    pass
                finally:
                    with contextlib.suppress(Exception):
                        writer.close()
                        await writer.wait_closed()

        async with RecordingServer(respond) as srv:
            await rtsp_prober.is_rtsp_server("127.0.0.1", srv.port)

        expected = rtsp_prober.STREAM_PATHS[: rtsp_prober._DESCRIBE_FALLBACK_PATHS]
        assert seen_paths == list(expected)
        assert seen_paths[0] == "/profile2/media.smp"  # Hanwha path leads
        assert seen_auth and not any(seen_auth)


class TestProbeCameraEndToEnd:
    @pytest.mark.asyncio
    async def test_auth_gated_camera_surfaces_as_needs_credentials(self, monkeypatch):
        """probe_camera must emit the rtsp_port_open placeholder (→ pending /
        needs-setup in the scan loop) for a camera whose every path demands
        credentials — the live Hanwha case that used to vanish entirely."""
        async with FakeRtspServer(_hanwha_like) as srv:

            async def fake_scan_ports(ip):
                return [srv.port]

            monkeypatch.setattr(rtsp_prober, "scan_ports", fake_scan_ports)
            info = await rtsp_prober.probe_camera("127.0.0.1")

        assert info is not None, "auth-gated camera must not be dropped"
        assert info["detection_method"] == "rtsp_port_open"
        assert info["port"] == srv.port

    @pytest.mark.asyncio
    async def test_non_camera_with_554_open_still_dropped(self, monkeypatch):
        async with FakeRtspServer(_tplink_like) as srv:

            async def fake_scan_ports(ip):
                return [srv.port]

            monkeypatch.setattr(rtsp_prober, "scan_ports", fake_scan_ports)
            info = await rtsp_prober.probe_camera("127.0.0.1")

        assert info is None


class TestHanwhaHostnames:
    def _fresh_main(self):
        import main

        return importlib.reload(main)

    def test_wisenet_lease_hostname_is_likely_camera(self):
        main = self._fresh_main()
        # The live lease hostname that classified as not-a-camera.
        assert main._is_camera_hostname("XNV-C8083R-E43022502AFD") is True
        assert main._is_camera_hostname("wisenet-garage") is True
        assert main._is_camera_hostname("HANWHA-PNM-9031RV") is True

    def test_non_camera_hostnames_unchanged(self):
        main = self._fresh_main()
        assert main._is_camera_hostname("stefs_laptop") is False
        assert main._is_camera_hostname("iPhone") is False
        assert main._is_camera_hostname("droplet-ap") is False
        assert main._is_camera_hostname("android-4c3a") is False
