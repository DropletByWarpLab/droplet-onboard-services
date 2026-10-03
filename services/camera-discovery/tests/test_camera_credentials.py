"""WARP-3505 — operator-supplied camera credentials for a discovered camera.

A camera that was found on the LAN but whose password is NOT a factory default
could never be added: the credential ladder (default_credentials.py) only tries
well-known defaults, and the dashboard had nowhere to type the real ones. The
service now exposes ``POST /cameras/discovered/{mac}/credentials`` which takes
``{username, password}``, re-runs ONVIF GetStreamUri + the RTSP path probe with
THOSE credentials, and on success commits the camera to Frigate with the
credentials embedded server-side.

Pinned here:
  * outcome classification — ok / auth_failed / locked / no_path / unreachable —
    so the operator is told which thing is wrong;
  * a wrong password burns ONE auth attempt, not one per stream path (Hanwha
    locks the account after ~5 failures);
  * a Hanwha-style qop=auth digest camera works end to end;
  * NET-05: the password never appears in the response, the logs, or the
    MQTT event payload;
  * credentials are URL-encoded the way ffmpeg needs (WARP-1873) and inputs that
    could inject RTSP headers are rejected.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import json
import logging
import time

import pytest

import rtsp_prober
from tests.test_rtsp_digest_qop import FakeDigestServer, _auth_params

SECRET = "pytest-fake-secret"
USER, PW = "admin", "s3cret!"
MAC = "aa:bb:cc:dd:ee:ff"
GOOD_PATH = "/profile2/media.smp"


class _Server(FakeDigestServer):
    """Digest server that, like a real Hanwha, 400s any path it doesn't serve
    and (optionally) answers a failed auth with a vendor lockout status."""

    def __init__(self, good_paths=(GOOD_PATH,), mode="qop", password=PW,
                 fail_line="401 Unauthorized", delay=0.0):
        super().__init__(mode, password)
        self.good_paths = set(good_paths)
        self.fail_line = fail_line
        self.delay = delay  # seconds a slow camera takes to answer each request
        self.auth_attempts = 0
        self.paths_seen: list[str] = []

    async def _handle(self, reader, writer):
        conn_nonce = None
        try:
            while True:
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = await reader.read(1024)
                    if not chunk:
                        return
                    data += chunk
                text = data.decode("iso-8859-1")
                uri = text.split("\r\n", 1)[0].split(" ")[1]
                # rtsp://host:port/path -> /path
                rest = uri.split("://", 1)[1]
                path = "/" + rest.split("/", 1)[1] if "/" in rest else "/"
                self.paths_seen.append(path)
                if self.delay:
                    await asyncio.sleep(self.delay)
                if path not in self.good_paths:
                    writer.write(b"RTSP/1.0 400 Bad Request\r\nCSeq: 1\r\n\r\n")
                    await writer.drain()
                    return
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
                    continue
                self.auth_attempts += 1
                p = _auth_params(auth)
                ok = p.get("nonce") == conn_nonce and self._math_ok(p)
                line = "200 OK" if ok else self.fail_line
                writer.write(f"RTSP/1.0 {line}\r\nCSeq: 2\r\n\r\n".encode())
                await writer.drain()
                return
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()


async def _closed_port() -> int:
    server = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    server.close()
    await server.wait_closed()
    return port


# --- prober: outcome classification ----------------------------------------


class TestOutcome:
    @pytest.mark.asyncio
    async def test_ok(self):
        async with _Server() as srv:
            out = await rtsp_prober.describe_outcome("127.0.0.1", srv.port, GOOD_PATH, USER, PW)
        assert out == "ok"

    @pytest.mark.asyncio
    async def test_wrong_password_is_auth_failed(self):
        async with _Server() as srv:
            out = await rtsp_prober.describe_outcome("127.0.0.1", srv.port, GOOD_PATH, USER, "nope")
        assert out == "auth_failed"

    @pytest.mark.asyncio
    async def test_lockout_status_is_locked(self):
        async with _Server(fail_line="490 Account Blocked") as srv:
            out = await rtsp_prober.describe_outcome("127.0.0.1", srv.port, GOOD_PATH, USER, "nope")
        assert out == "locked"

    @pytest.mark.asyncio
    async def test_unknown_path_is_no_path(self):
        async with _Server() as srv:
            out = await rtsp_prober.describe_outcome("127.0.0.1", srv.port, "/stream1", USER, PW)
        assert out == "no_path"

    @pytest.mark.asyncio
    async def test_closed_port_is_unreachable(self):
        port = await _closed_port()
        out = await rtsp_prober.describe_outcome("127.0.0.1", port, GOOD_PATH, USER, PW, timeout=1.0)
        assert out == "unreachable"


class TestProbeWithCredentials:
    @pytest.mark.asyncio
    async def test_finds_the_real_path_with_hanwha_qop_digest(self):
        async with _Server() as srv:
            res = await rtsp_prober.probe_with_credentials("127.0.0.1", srv.port, USER, PW)
        assert res == ("ok", GOOD_PATH)

    @pytest.mark.asyncio
    async def test_hint_path_is_tried_first(self):
        async with _Server(good_paths=("/custom/main",)) as srv:
            res = await rtsp_prober.probe_with_credentials(
                "127.0.0.1", srv.port, USER, PW, hint_paths=["/custom/main"]
            )
            first = srv.paths_seen[0]
        assert res == ("ok", "/custom/main")
        assert first == "/custom/main"

    @pytest.mark.asyncio
    async def test_wrong_password_burns_exactly_one_auth_attempt(self):
        """Hanwha locks the account after ~5 bad passwords; once a path proves
        the camera is asking for credentials and they are wrong, stop."""
        async with _Server() as srv:
            res = await rtsp_prober.probe_with_credentials("127.0.0.1", srv.port, USER, "nope")
            attempts = srv.auth_attempts
        assert res == ("auth_failed", None)
        assert attempts == 1

    @pytest.mark.asyncio
    async def test_no_known_path_is_no_path(self):
        async with _Server(good_paths=("/totally/custom/vendor/path",)) as srv:
            res = await rtsp_prober.probe_with_credentials("127.0.0.1", srv.port, USER, PW)
        assert res == ("no_path", None)

    @pytest.mark.asyncio
    async def test_nothing_listening_is_unreachable(self):
        port = await _closed_port()
        res = await rtsp_prober.probe_with_credentials("127.0.0.1", port, USER, PW, timeout=1.0)
        assert res == ("unreachable", None)

    @pytest.mark.asyncio
    async def test_budget_bounds_how_long_the_path_walk_can_run(self):
        """A slow camera must not turn "up to a minute" into several: the walk
        stops once its time budget is spent, however many paths remain."""
        async with _Server(good_paths=("/totally/custom/vendor/path",), delay=0.2) as srv:
            started = time.monotonic()
            res = await rtsp_prober.probe_with_credentials(
                "127.0.0.1", srv.port, USER, PW, max_seconds=0.5
            )
            elapsed = time.monotonic() - started
            walked = len(srv.paths_seen)
        assert res == ("no_path", None)
        assert elapsed < 2.0
        assert walked < len(rtsp_prober.STREAM_PATHS)

    @pytest.mark.asyncio
    async def test_budget_does_not_cut_off_a_walk_that_fits(self):
        async with _Server() as srv:
            res = await rtsp_prober.probe_with_credentials(
                "127.0.0.1", srv.port, USER, PW, max_seconds=30.0
            )
        assert res == ("ok", GOOD_PATH)

    def test_quote_in_username_cannot_break_the_digest_header(self):
        """A username containing a double quote must not be able to smuggle
        extra digest parameters into the Authorization header."""
        h = rtsp_prober._digest_header(
            'ad"min', "pw", "DESCRIBE", "rtsp://x/y",
            {"scheme": "digest", "realm": "r", "nonce": "n", "qop": "auth"},
        )
        assert 'username="ad\\"min"' in h


# --- prober: qop parsing -----------------------------------------------------


class TestQopParsing:
    def test_qop_list_with_auth_second_still_selects_auth(self):
        info = rtsp_prober._parse_www_authenticate(
            'Digest realm="iPOLiS", nonce="abc", qop="auth-int,auth"'
        )
        assert info["qop"] == "auth-int,auth"
        h = rtsp_prober._digest_header(USER, PW, "DESCRIBE", "rtsp://x/y", info)
        assert "qop=auth," in h and "cnonce=" in h and "nc=00000001" in h

    def test_realm_with_comma_survives(self):
        info = rtsp_prober._parse_www_authenticate(
            'Digest realm="Acme, Inc", nonce="abc", qop="auth"'
        )
        assert info["realm"] == "Acme, Inc"
        assert info["nonce"] == "abc"
        assert info["qop"] == "auth"


# --- endpoint ----------------------------------------------------------------


class _Req:
    def __init__(self, body, token=SECRET):
        self.headers = {"Authorization": f"Bearer {token}"}
        self._body = body

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


async def _no_ports(*a, **k):
    return []


def _fresh_main(monkeypatch, port):
    import main

    main = importlib.reload(main)
    main.known_cameras.clear()
    main.pending_cameras.clear()
    main.rejected_macs.clear()
    main.accepting_macs.clear()
    main.pending_cameras[MAC] = {
        "mac": MAC,
        "ip": "127.0.0.1",
        "port": port,
        "name": "xnv_c8083r",
        "manufacturer": "Hanwha",
        "model": "XNV-C8083R",
        "rtsp_url": "rtsp://127.0.0.1:554/stream1",
        "detection_method": "rtsp_port_open",
        "status": "needs_setup",
    }
    added: list[tuple[str, str]] = []

    async def fake_add(name, url):
        added.append((name, url))
        return True

    async def no_onvif(*a, **k):
        return None

    published: list[dict] = []
    monkeypatch.setattr(main.frigate, "add_camera", fake_add)
    monkeypatch.setattr(main, "probe_onvif_device", no_onvif)
    monkeypatch.setattr(main, "publish_discovery", lambda payload: published.append(payload))
    return main, added, published


def _body(resp):
    return json.loads(resp.body)


@pytest.mark.asyncio
async def test_success_adds_camera_with_encoded_credentials(monkeypatch):
    async with _Server() as srv:
        main, added, published = _fresh_main(monkeypatch, srv.port)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))

    assert out["status"] == "accepted"
    assert len(added) == 1
    name, url = added[0]
    assert name == "xnv_c8083r"
    # `!` is a legal userinfo sub-delim and ffmpeg does not percent-decode, so
    # it must go on the wire literally (WARP-1873).
    assert url == f"rtsp://{USER}:{PW}@127.0.0.1:{srv.port}{GOOD_PATH}"
    assert MAC in main.known_cameras and MAC not in main.pending_cameras
    assert main.known_cameras[MAC]["status"] == "active"


@pytest.mark.asyncio
async def test_userinfo_delimiters_in_password_are_encoded(monkeypatch):
    tricky = "p@ss/w:rd#1"
    async with _Server(password=tricky) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": tricky}))
    assert out["status"] == "accepted"
    url = added[0][1]
    userinfo = url.split("://", 1)[1].rsplit("@", 1)[0]
    assert userinfo == f"{USER}:p%40ss%2Fw%3Ard%231"


@pytest.mark.asyncio
async def test_wrong_password_is_auth_failed_and_camera_stays_pending(monkeypatch):
    async with _Server() as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": "wrong"}))
    assert resp.status_code == 422
    assert _body(resp)["code"] == "auth_failed"
    assert added == []
    assert MAC in main.pending_cameras and MAC not in main.known_cameras


@pytest.mark.asyncio
async def test_locked_account_is_reported_as_locked(monkeypatch):
    async with _Server(fail_line="490 Account Blocked") as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": "wrong"}))
    assert resp.status_code == 423
    assert _body(resp)["code"] == "locked"
    assert added == []


@pytest.mark.asyncio
async def test_unknown_stream_path_is_no_stream_path(monkeypatch):
    async with _Server(good_paths=("/totally/custom/vendor/path",)) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert resp.status_code == 422
    assert _body(resp)["code"] == "no_stream_path"
    assert added == []


@pytest.mark.asyncio
async def test_unreachable_camera_is_reported_as_unreachable(monkeypatch):
    port = await _closed_port()
    main, added, _ = _fresh_main(monkeypatch, port)
    monkeypatch.setattr(main, "scan_ports", _no_ports)
    resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert resp.status_code == 502
    assert _body(resp)["code"] == "unreachable"
    assert added == []


@pytest.mark.asyncio
async def test_onvif_stream_uri_path_is_used_when_available(monkeypatch):
    async with _Server(good_paths=("/onvif-media/main",)) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)

        async def onvif(ip, port=80, username="admin", password=""):
            assert (username, password) == (USER, PW)  # creds reach GetStreamUri
            return {"ip": ip, "rtsp_url": f"rtsp://{ip}:{srv.port}/onvif-media/main"}

        monkeypatch.setattr(main, "probe_onvif_device", onvif)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert out["status"] == "accepted"
    assert added[0][1].endswith("/onvif-media/main")


@pytest.mark.asyncio
async def test_slow_onvif_cannot_stall_the_rtsp_probe(monkeypatch):
    """ONVIF is best effort and bounded, so a camera whose ONVIF service hangs
    still gets its RTSP walk — the whole submit stays inside "up to a minute"."""
    async with _Server() as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        monkeypatch.setattr(main, "_CRED_ONVIF_TIMEOUT_S", 0.2)

        async def hangs(*a, **k):
            await asyncio.sleep(30)

        monkeypatch.setattr(main, "probe_onvif_device", hangs)
        started = time.monotonic()
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
        elapsed = time.monotonic() - started
    assert out["status"] == "accepted"
    assert elapsed < 5.0
    assert len(added) == 1


@pytest.mark.asyncio
async def test_rtsp_walk_is_given_a_bounded_budget(monkeypatch):
    """ONVIF (<= 10 s) + the RTSP budget (<= 30 s) + one in-flight DESCRIBE must
    stay under the orchestrator's 60 s wait, or a camera that WAS added reads as
    a timeout."""
    main, _, _ = _fresh_main(monkeypatch, 1)
    seen = {}

    async def spy(ip, port, user, pw, hint_paths=None, timeout=3.0, max_seconds=None):
        seen["max_seconds"] = max_seconds
        return ("no_path", None)

    monkeypatch.setattr(main, "probe_with_credentials", spy)
    await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert seen["max_seconds"] == main._CRED_RTSP_BUDGET_S
    assert main._CRED_ONVIF_TIMEOUT_S + main._CRED_RTSP_BUDGET_S + 12 < 60


@pytest.mark.asyncio
async def test_frigate_failure_keeps_camera_pending(monkeypatch):
    from fastapi import HTTPException

    async with _Server() as srv:
        main, _, _ = _fresh_main(monkeypatch, srv.port)

        async def refuse(name, url):
            return False

        monkeypatch.setattr(main.frigate, "add_camera", refuse)
        with pytest.raises(HTTPException) as ei:
            await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert ei.value.status_code == 500
    assert MAC in main.pending_cameras and MAC not in main.known_cameras


@pytest.mark.asyncio
async def test_requires_device_secret(monkeypatch):
    from fastapi import HTTPException

    main, _, _ = _fresh_main(monkeypatch, 1)
    with pytest.raises(HTTPException) as ei:
        await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}, token="bad"))
    assert ei.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {},
        {"username": "", "password": PW},
        {"username": USER},
        {"username": 5, "password": PW},
        {"username": "ad\r\nmin", "password": PW},
        {"username": USER, "password": "pw\r\nCSeq: 9"},
        {"username": "a" * 200, "password": PW},
        {"username": USER, "password": "p" * 500},
        ValueError("bad json"),
        ["not", "a", "dict"],
    ],
)
async def test_invalid_input_is_400(monkeypatch, body):
    from fastapi import HTTPException

    main, added, _ = _fresh_main(monkeypatch, 1)
    with pytest.raises(HTTPException) as ei:
        await main.submit_camera_credentials(MAC, _Req(body))
    assert ei.value.status_code == 400
    assert added == []


@pytest.mark.asyncio
async def test_mac_lookup_is_case_insensitive(monkeypatch):
    """The orchestrator addresses a candidate by its upper-cased MAC; the
    pending map is keyed lower-case."""
    async with _Server() as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        out = await main.submit_camera_credentials(MAC.upper(), _Req({"username": USER, "password": PW}))
    assert out["status"] == "accepted"
    assert len(added) == 1


@pytest.mark.asyncio
async def test_unknown_mac_is_404(monkeypatch):
    from fastapi import HTTPException

    main, _, _ = _fresh_main(monkeypatch, 1)
    with pytest.raises(HTTPException) as ei:
        await main.submit_camera_credentials("11:22:33:44:55:66", _Req({"username": USER, "password": PW}))
    assert ei.value.status_code == 404


# --- NET-05: the password never leaves the service ---------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", ["success", "auth_failed", "no_path"])
async def test_password_never_in_response_logs_or_mqtt(monkeypatch, caplog, scenario):
    caplog.set_level(logging.DEBUG)
    kwargs = {}
    pw_sent = PW
    if scenario == "auth_failed":
        pw_sent = "wr0ng-s3cret!"
    if scenario == "no_path":
        kwargs["good_paths"] = ("/totally/custom/vendor/path",)
    async with _Server(**kwargs) as srv:
        main, added, published = _fresh_main(monkeypatch, srv.port)
        res = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": pw_sent}))

    wire = res.body.decode() if hasattr(res, "body") else json.dumps(res)
    assert pw_sent not in wire
    assert "s3cret" not in caplog.text
    assert "s3cret" not in json.dumps(published)
    # The success path hands the credentialed URL to Frigate (that is its job)
    # but never back to the caller.
    assert "rtsp_url" not in wire
    if scenario == "success":
        assert PW in added[0][1]
