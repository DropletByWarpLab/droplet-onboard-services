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
  * a wrong password costs ONE failed sign-in in total: RTSP is tried first and
    stops at the first path that refuses it, and ONVIF (a second protocol, a
    second failed sign-in) only runs when RTSP found no stream path at all
    (Hanwha locks the account after ~5 failures);
  * a camera that is ALREADY locked is reported as locked on the first reply;
  * a Hanwha-style qop=auth digest camera works end to end;
  * NET-05: the password never appears in the response, the logs, or the
    MQTT event payload;
  * the stream address is guarded (an ONVIF device chooses its own path) and a
    bad port in a record is a clean answer, not a 500;
  * inputs that could inject RTSP headers, or that cannot be expressed in a
    Frigate stream URL, are refused with a code before any attempt is spent.

What Frigate and ffmpeg then do to the stored URL is pinned in
test_frigate_credentials.py (the password must reach the camera as typed).
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
from tests.test_rtsp_digest_qop import REALM, FakeDigestServer, _auth_params, _md5

SECRET = "pytest-fake-secret"
USER, PW = "admin", "s3cret!"
MAC = "aa:bb:cc:dd:ee:ff"
GOOD_PATH = "/profile2/media.smp"


class _Server(FakeDigestServer):
    """Digest server that, like a real Hanwha, 400s any path it doesn't serve
    and (optionally) answers a failed auth with a vendor lockout status."""

    def __init__(self, good_paths=(GOOD_PATH,), mode="qop", password=PW,
                 fail_line="401 Unauthorized", delay=0.0, username=USER,
                 anonymous_line=None):
        super().__init__(mode, password)
        self.good_paths = set(good_paths)
        self.fail_line = fail_line
        self.delay = delay  # seconds a slow camera takes to answer each request
        self.username = username
        # What an already-locked camera answers to a DESCRIBE that carries no
        # Authorization header at all, e.g. "490 Account Blocked".
        self.anonymous_line = anonymous_line
        self.auth_attempts = 0
        self.paths_seen: list[str] = []

    def _math_ok(self, p: dict) -> bool:
        if p.get("username") != self.username:
            return False
        ha1 = _md5(f"{self.username}:{REALM}:{self.password}")
        ha2 = _md5(f"DESCRIBE:{p.get('uri', '')}")
        if "qop" in p:
            expect = _md5(
                f'{ha1}:{p.get("nonce","")}:{p.get("nc","")}:{p.get("cnonce","")}:{p["qop"]}:{ha2}'
            )
        else:
            expect = _md5(f'{ha1}:{p.get("nonce","")}:{ha2}')
        return p.get("response") == expect

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
                if not auth and self.anonymous_line:
                    writer.write(f"RTSP/1.0 {self.anonymous_line}\r\nCSeq: 1\r\n\r\n".encode())
                    await writer.drain()
                    return
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
    async def test_already_locked_camera_is_locked_on_the_first_anonymous_reply(self):
        """A Hanwha that is already blocked answers even the unauthenticated
        DESCRIBE with 490; that is a lockout, not 'this path does not exist'."""
        async with _Server(anonymous_line="490 Account Blocked") as srv:
            out = await rtsp_prober.describe_outcome("127.0.0.1", srv.port, GOOD_PATH, USER, PW)
            attempts = srv.auth_attempts
        assert out == "locked"
        assert attempts == 0  # no sign-in was spent finding that out

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
    async def test_already_locked_camera_stops_the_walk_at_the_first_path(self):
        async with _Server(anonymous_line="490 Account Blocked") as srv:
            res = await rtsp_prober.probe_with_credentials("127.0.0.1", srv.port, USER, PW)
            walked = list(srv.paths_seen)
        assert res == ("locked", None)
        assert len(walked) == 1

    @pytest.mark.asyncio
    async def test_the_walk_can_be_limited_to_the_hint_paths(self):
        """After ONVIF names a path, only THAT path is worth another request."""
        async with _Server(good_paths=("/onvif/only",)) as srv:
            res = await rtsp_prober.probe_with_credentials(
                "127.0.0.1", srv.port, USER, PW,
                hint_paths=["/onvif/only"], include_known_paths=False,
            )
            walked = list(srv.paths_seen)
        assert res == ("ok", "/onvif/only")
        assert walked and set(walked) == {"/onvif/only"}

    @pytest.mark.asyncio
    async def test_success_does_not_log_the_username_at_info(self, caplog):
        caplog.set_level(logging.INFO)
        async with _Server(username="svc_operator") as srv:
            res = await rtsp_prober.probe_with_credentials("127.0.0.1", srv.port, "svc_operator", PW)
        assert res == ("ok", GOOD_PATH)
        assert "svc_operator" not in caplog.text

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
        # What the prober's placeholder looks like: the guess carries the port that
        # was actually open.
        "rtsp_url": f"rtsp://127.0.0.1:{port}/stream1",
        "detection_method": "rtsp_port_open",
        "status": "needs_setup",
    }
    added: list[tuple[str, str]] = []

    async def fake_add(name, url):
        added.append((name, url))
        return True

    async def no_onvif(*a, **k):
        return ("unsupported", None)

    published: list[dict] = []
    monkeypatch.setattr(main.frigate, "add_camera", fake_add)
    monkeypatch.setattr(main, "onvif_stream_uri", no_onvif)
    monkeypatch.setattr(main, "publish_discovery", lambda payload: published.append(payload))
    # The fake cameras listen on loopback, which the real guard (rightly) refuses.
    monkeypatch.setattr(main, "is_safe_ip", lambda ip: True)
    return main, added, published


def _body(resp):
    return json.loads(resp.body)


@pytest.mark.asyncio
async def test_success_adds_the_camera_with_its_credentials(monkeypatch):
    async with _Server() as srv:
        main, added, published = _fresh_main(monkeypatch, srv.port)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))

    assert out["status"] == "accepted"
    assert len(added) == 1
    name, url = added[0]
    assert name == "xnv_c8083r"
    # The INTERNAL form (what discovery keeps and hands to Frigate's boundary,
    # which rewrites it into what Frigate must hold — test_frigate_credentials.py).
    assert url == f"rtsp://{USER}:{PW}@127.0.0.1:{srv.port}{GOOD_PATH}"
    assert MAC in main.known_cameras and MAC not in main.pending_cameras
    assert main.known_cameras[MAC]["status"] == "active"


@pytest.mark.asyncio
async def test_the_record_keeps_a_url_that_parses_and_can_be_redacted(monkeypatch):
    """The orchestrator strips userinfo with a regex that stops at '/' and '@', and
    verify_stream URL-decodes it, so the INTERNAL url must encode those. (What
    Frigate is then given is a different form — test_frigate_credentials.py.)"""
    from urllib.parse import unquote, urlsplit

    tricky = "p@ss/w:rd#1"
    async with _Server(password=tricky) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": tricky}))
    assert out["status"] == "accepted"
    for url in (added[0][1], main.known_cameras[MAC]["rtsp_url"]):
        userinfo = url.split("://", 1)[1].rsplit("@", 1)[0]
        assert userinfo == f"{USER}:p%40ss%2Fw%3Ard%231"
        parts = urlsplit(url)
        assert (unquote(parts.username), unquote(parts.password)) == (USER, tricky)
        assert parts.hostname == "127.0.0.1" and parts.path == GOOD_PATH


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


# --- RTSP first, ONVIF only when RTSP found no path (a wrong password = ONE failed login)


@pytest.mark.asyncio
async def test_a_wrong_password_never_reaches_onvif(monkeypatch):
    """ONVIF is a second protocol and so a second failed sign-in on the same
    account. A password RTSP already refused must not be tried on it."""
    async with _Server() as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        onvif_calls = []

        async def onvif(*a, **k):
            onvif_calls.append(a)
            return ("ok", f"rtsp://127.0.0.1:{srv.port}{GOOD_PATH}")

        monkeypatch.setattr(main, "onvif_stream_uri", onvif)
        resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": "wrong"}))
        attempts = srv.auth_attempts
    assert resp.status_code == 422 and _body(resp)["code"] == "auth_failed"
    assert onvif_calls == []
    assert attempts == 1  # the whole attempt cost the camera exactly one failed login
    assert added == []


@pytest.mark.asyncio
async def test_a_successful_rtsp_probe_never_runs_onvif_either(monkeypatch):
    async with _Server() as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        onvif_calls = []

        async def onvif(*a, **k):
            onvif_calls.append(a)
            return ("unsupported", None)

        monkeypatch.setattr(main, "onvif_stream_uri", onvif)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert out["status"] == "accepted" and onvif_calls == []


@pytest.mark.asyncio
async def test_onvif_names_the_path_when_the_known_list_has_none(monkeypatch):
    async with _Server(good_paths=("/onvif-media/main",)) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        calls = []

        async def onvif(ip, port, username, password):
            calls.append((ip, port, username, password))
            return ("ok", f"rtsp://{ip}:{srv.port}/onvif-media/main")

        monkeypatch.setattr(main, "onvif_stream_uri", onvif)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
        walked = list(srv.paths_seen)
    assert out["status"] == "accepted"
    assert added[0][1].endswith("/onvif-media/main")
    assert calls == [("127.0.0.1", 80, USER, PW)]  # the credentials reach GetStreamUri
    # RTSP's own walk came first; the hint was then probed once, on its own.
    assert "/profile2/media.smp" in walked and walked[-1] == "/onvif-media/main"


@pytest.mark.asyncio
async def test_onvif_refusing_the_credentials_is_auth_failed_not_no_stream_path(monkeypatch):
    """RTSP found no path, so nothing has checked the password yet; ONVIF is the
    first thing that did, and it said no. That is a wrong password."""
    async with _Server(good_paths=("/totally/custom/vendor/path",)) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)

        async def onvif(*a, **k):
            return ("auth_failed", None)

        monkeypatch.setattr(main, "onvif_stream_uri", onvif)
        resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert resp.status_code == 422 and _body(resp)["code"] == "auth_failed"
    assert added == []


@pytest.mark.asyncio
async def test_onvif_not_supported_stays_no_stream_path(monkeypatch):
    async with _Server(good_paths=("/totally/custom/vendor/path",)) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)  # onvif -> ("unsupported", None)
        resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert resp.status_code == 422 and _body(resp)["code"] == "no_stream_path"


@pytest.mark.asyncio
async def test_slow_onvif_cannot_stall_the_answer(monkeypatch):
    """ONVIF is best effort and bounded: a camera whose ONVIF service hangs still
    gets a prompt no_stream_path, not a hang."""
    async with _Server(good_paths=("/totally/custom/vendor/path",)) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        monkeypatch.setattr(main, "_CRED_ONVIF_TIMEOUT_S", 0.2)

        async def hangs(*a, **k):
            await asyncio.sleep(30)

        monkeypatch.setattr(main, "onvif_stream_uri", hangs)
        started = time.monotonic()
        resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
        elapsed = time.monotonic() - started
    assert resp.status_code == 422 and _body(resp)["code"] == "no_stream_path"
    assert elapsed < 5.0


@pytest.mark.asyncio
async def test_rtsp_walk_is_given_a_bounded_budget(monkeypatch):
    main, _, _ = _fresh_main(monkeypatch, 1)
    seen = []

    async def spy(ip, port, user, pw, hint_paths=None, timeout=3.0, max_seconds=None,
                  include_known_paths=True):
        seen.append(max_seconds)
        return ("unreachable", None)

    monkeypatch.setattr(main, "probe_with_credentials", spy)
    await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert seen and all(s == main._CRED_RTSP_BUDGET_S for s in seen)


def test_the_whole_probe_stays_inside_the_orchestrators_wait():
    """The orchestrator gives up at 60 s (camera-candidates.service.ts). The probing
    phase has a HARD deadline; the Frigate commit that follows is sub-second."""
    import main

    assert main._CRED_ONVIF_TIMEOUT_S + main._CRED_RTSP_BUDGET_S < main._CRED_TOTAL_BUDGET_S
    assert main._CRED_TOTAL_BUDGET_S <= 45 < 60


@pytest.mark.asyncio
async def test_a_probe_that_outlasts_its_deadline_is_a_timeout_not_a_hang(monkeypatch):
    main, added, _ = _fresh_main(monkeypatch, 1)
    monkeypatch.setattr(main, "_CRED_TOTAL_BUDGET_S", 0.2)

    async def stuck(*a, **k):
        await asyncio.sleep(30)

    monkeypatch.setattr(main, "probe_with_credentials", stuck)
    started = time.monotonic()
    resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert time.monotonic() - started < 5.0
    assert resp.status_code == 504 and _body(resp)["code"] == "timeout"
    assert added == []
    assert MAC in main.pending_cameras and not main.accepting_macs  # the claim was released


# --- the address and ports come from a device / a record: never trusted blindly


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_path",
    ["/{FRIGATE_CAMERA_X_PASSWORD}", "/has space", "/ctl\x01", "/}", "no-leading-slash"],
)
async def test_an_onvif_path_with_template_or_whitespace_characters_is_never_used(monkeypatch, bad_path):
    """SEC-INJ-5: Frigate expands {FRIGATE_*} in a stream path. ONVIF is a device
    telling us what to write into Frigate's config."""
    async with _Server(good_paths=("/totally/custom/vendor/path",)) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)

        async def onvif(ip, port, username, password):
            return ("ok", f"rtsp://{ip}:{srv.port}{bad_path}")

        monkeypatch.setattr(main, "onvif_stream_uri", onvif)
        resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
        walked = list(srv.paths_seen)
    assert resp.status_code == 422 and _body(resp)["code"] == "no_stream_path"
    assert added == []
    assert bad_path not in walked  # never even sent to the camera


@pytest.mark.asyncio
async def test_an_onvif_uri_for_another_host_is_not_followed(monkeypatch):
    async with _Server(good_paths=("/totally/custom/vendor/path",)) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)

        async def onvif(ip, port, username, password):
            return ("ok", f"rtsp://10.9.9.9:{srv.port}/totally/custom/vendor/path")

        monkeypatch.setattr(main, "onvif_stream_uri", onvif)
        resp = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert resp.status_code == 422 and _body(resp)["code"] == "no_stream_path"
    assert added == []


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_ip", ["8.8.8.8", "127.0.0.1", "169.254.1.1", "not-an-ip"])
async def test_a_record_whose_address_is_not_a_safe_lan_ip_is_refused_before_any_probe(monkeypatch, bad_ip):
    from fastapi import HTTPException

    import main as main_module

    main = importlib.reload(main_module)  # the real is_safe_ip, not the loopback-friendly test one
    main.known_cameras.clear()
    main.pending_cameras.clear()
    main.accepting_macs.clear()
    main.pending_cameras[MAC] = {"mac": MAC, "ip": bad_ip, "name": "x", "status": "needs_setup"}
    probed = []

    async def spy(*a, **k):
        probed.append(a)
        return ("ok", "/x")

    monkeypatch.setattr(main, "probe_with_credentials", spy)
    with pytest.raises(HTTPException) as ei:
        await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert ei.value.status_code == 400
    assert probed == []
    assert not main.accepting_macs  # the claim was released


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "record",
    [
        {"port": 99999},
        {"port": "not-a-number"},
        {"port": -1},
        {"port": None, "rtsp_url": "rtsp://127.0.0.1:99999/x"},
        {"port": None, "rtsp_url": "rtsp://127.0.0.1:abc/x"},
    ],
)
async def test_a_bad_port_in_the_record_is_ignored_not_a_500(monkeypatch, record):
    """urlparse().port raises ValueError for a bad port; a corrupt record must not
    turn into an unhandled 500."""
    async with _Server() as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        main.pending_cameras[MAC].update(record)

        async def scan(ip, ports=None, timeout=2.0):
            return [srv.port]

        monkeypatch.setattr(main, "scan_ports", scan)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert out["status"] == "accepted"


@pytest.mark.asyncio
async def test_an_onvif_records_own_port_is_the_onvif_port_not_an_rtsp_one(monkeypatch):
    """For a record an ONVIF/WS-Discovery probe made, `port` is the ONVIF HTTP port
    (80). Pointing an RTSP DESCRIBE at it finds a web server and a bogus
    'no stream path'; the stream URI's own port is the RTSP one."""
    async with _Server() as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        main.pending_cameras[MAC].update(
            {"detection_method": "onvif", "port": 80, "rtsp_url": f"rtsp://127.0.0.1:{srv.port}/profile2/media.smp"}
        )
        ports = []
        real = main.probe_with_credentials

        async def spy(ip, port, *a, **k):
            ports.append(port)
            return await real(ip, port, *a, **k)

        monkeypatch.setattr(main, "probe_with_credentials", spy)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert out["status"] == "accepted"
    assert ports == [srv.port]


@pytest.mark.asyncio
async def test_a_bad_port_in_an_onvif_uri_is_ignored_not_a_500(monkeypatch):
    async with _Server(good_paths=("/onvif-media/main",)) as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)

        async def onvif(ip, port, username, password):
            return ("ok", f"rtsp://{ip}:99999/onvif-media/main")

        monkeypatch.setattr(main, "onvif_stream_uri", onvif)
        out = await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": PW}))
    assert out["status"] == "accepted"
    assert added[0][1].endswith(f":{srv.port}/onvif-media/main")


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
        {"username": "   ", "password": PW},          # whitespace-only username
        {"username": USER, "password": "bad\ud800pw"},  # lone surrogate: not UTF-8
        {"username": "bad\udfffname", "password": PW},
        {"username": "ad:min", "password": PW},        # ffmpeg splits the decoded userinfo at ':'
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
@pytest.mark.parametrize("pw", ["has space", "tab\there", "brace{", "{FRIGATE_X}", "}"])
async def test_a_password_that_cannot_be_written_into_a_frigate_url_is_refused_up_front(monkeypatch, pw):
    """Frigate str.format()s its config (braces) and its userinfo regex stops at
    whitespace, so for a username it matches the password cannot be stored. It is
    refused BEFORE any sign-in is spent on the camera, with a code the dashboard
    can explain."""
    main, added, _ = _fresh_main(monkeypatch, 1)
    probed = []

    async def spy(*a, **k):
        probed.append(a)
        return ("ok", "/x")

    monkeypatch.setattr(main, "probe_with_credentials", spy)
    with pytest.raises(main.CredentialsRejected) as ei:
        await main.submit_camera_credentials(MAC, _Req({"username": USER, "password": pw}))
    assert ei.value.status_code == 400
    assert ei.value.code == "unsupported_password"
    assert pw not in str(ei.value.detail)
    assert probed == [] and added == []


@pytest.mark.asyncio
async def test_that_limit_does_not_apply_to_a_username_frigate_does_not_match(monkeypatch):
    """Percent-encoded, so spaces and braces are fine — for john.doe the camera
    receives them as typed (test_frigate_credentials.py proves it)."""
    async with _Server(username="john.doe", password="has space{") as srv:
        main, added, _ = _fresh_main(monkeypatch, srv.port)
        out = await main.submit_camera_credentials(
            MAC, _Req({"username": "john.doe", "password": "has space{"})
        )
    assert out["status"] == "accepted"


def test_rejections_are_rendered_with_their_code(monkeypatch):
    """The orchestrator reads {detail, code}; an HTTPException alone has no code."""
    from fastapi.testclient import TestClient

    main, _, _ = _fresh_main(monkeypatch, 1)
    client = TestClient(main.app)
    resp = client.post(
        f"/cameras/discovered/{MAC}/credentials",
        headers={"Authorization": f"Bearer {SECRET}"},
        json={"username": USER, "password": "has space"},
    )
    assert resp.status_code == 400
    assert resp.json()["code"] == "unsupported_password"
    assert "has space" not in resp.text


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
