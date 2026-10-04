"""WARP-3505 — the password a camera receives is the password that was typed.

QA found that the URL we wrote into Frigate carried the password
percent-encoded (``C%40mera!2024``) while Frigate 0.17 percent-encodes the
password itself before ffmpeg URL-decodes it once: encoded twice, so the camera
was sent ``C%40mera!2024``, answered 401 on every retry, and a Hanwha locked the
account. Every assertion here is made on what the CAMERA receives — the path
Frigate is given, run through Frigate's own escape and ffmpeg's single decode
(``frigate_emulator``) — never on the string we stored, which is how this got
through.

The Frigate boundary (``FrigateClient.add_camera``) is the one place an internal
stream URL becomes Frigate's, so every caller is covered: the credentials
endpoint, the default-credentials auto-adopt and the manual accept.
"""

from __future__ import annotations

import json
import logging

import httpx
import pytest

import rtsp_url
from frigate_client import FrigateClient
from tests.frigate_emulator import camera_connects_to, camera_receives
from tests.test_camera_credentials import MAC, _Req, _Server, _fresh_main

IP = "192.168.9.5"
PATH = "/profile2/media.smp"

# QA's four, then the characters each layer treats specially.
PASSWORDS = [
    "C@mera!2024",
    "Qa@2024#x",
    "p:ss/w?rd",
    "WarpLab123!",
    "100%sure",
    "a+b=c&d",
    "x@y@z",
    "ünïcode✓pw",
]
USERS = ["admin", "john.doe"]  # Frigate's regex matches the first, not the second


class FakeFrigate:
    """Frigate 0.17's config API: records what is PUT, answers as configured."""

    def __init__(self, put_status=200, put_body=None):
        self.put_status = put_status
        self.put_body = {"success": True} if put_body is None else put_body
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/api/config/set":
            if isinstance(self.put_body, str):
                return httpx.Response(self.put_status, text=self.put_body)
            return httpx.Response(self.put_status, json=self.put_body)
        if request.url.path == "/api/config":
            return httpx.Response(200, json={})
        return httpx.Response(200, json={})

    def puts(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "PUT"]

    def stored_paths(self) -> list[str]:
        paths: list[str] = []
        for request in self.puts():
            body = json.loads(request.content)
            for camera in body["config_data"].get("cameras", {}).values():
                paths += [i["path"] for i in camera["ffmpeg"]["inputs"]]
        return paths


def frigate_with(fake: FakeFrigate) -> FrigateClient:
    client = FrigateClient("http://frigate.test")
    client._client = httpx.AsyncClient(
        base_url="http://frigate.test", transport=httpx.MockTransport(fake)
    )
    return client


class TestBoundary:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("pw", PASSWORDS)
    @pytest.mark.parametrize("user", USERS)
    async def test_what_frigate_is_given_reaches_the_camera_as_typed(self, user, pw):
        fake = FakeFrigate()
        client = frigate_with(fake)

        added = await client.add_camera("front", rtsp_url.internal_url(user, pw, IP, 554, PATH))

        assert added is True
        (stored,) = fake.stored_paths()
        assert camera_receives(stored) == (user, pw)
        if user == "admin":  # a name Frigate's regex matches: stored RAW, Frigate encodes it
            assert f"admin:{pw}@{IP}" in stored

    @pytest.mark.asyncio
    async def test_the_four_passwords_named_in_review(self):
        for pw in ("C@mera!2024", "Qa@2024#x", "p:ss/w?rd", "WarpLab123!"):
            fake = FakeFrigate()
            await frigate_with(fake).add_camera("front", rtsp_url.internal_url("admin", pw, IP, 554, PATH))
            assert camera_receives(fake.stored_paths()[0]) == ("admin", pw)

    @pytest.mark.asyncio
    async def test_a_default_credentials_url_from_the_prober_is_converted_too(self):
        """probe_camera writes the WARP-1873 form; the auto-adopt and the manual
        accept hand it to add_camera unchanged."""
        fake = FakeFrigate()
        prober_url = f"rtsp://admin:T3stCamPw!@{IP}:554{PATH}"  # as probe_camera builds it
        await frigate_with(fake).add_camera("front", prober_url)
        assert camera_receives(fake.stored_paths()[0]) == ("admin", "T3stCamPw!")

    @pytest.mark.asyncio
    async def test_a_url_with_no_sign_in_is_stored_as_given(self):
        fake = FakeFrigate()
        url = f"rtsp://{IP}:554{PATH}"
        assert await frigate_with(fake).add_camera("front", url) is True
        assert fake.stored_paths() == [url]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("path", ["/{FRIGATE_CAMERA_X_PASSWORD}", "/a b", "/}"])
    async def test_template_or_whitespace_characters_in_the_address_are_never_written(self, path):
        """SEC-INJ-5 on this side: an ONVIF device chooses its own path, and Frigate
        expands {FRIGATE_*} in it — or fails to start on a lone brace."""
        fake = FakeFrigate()
        assert await frigate_with(fake).add_camera("front", f"rtsp://{IP}:554{path}") is False
        assert fake.puts() == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("pw", ["has space", "brace{", "{FRIGATE_X}"])
    async def test_a_password_that_cannot_be_stored_is_refused_not_written_broken(self, pw, caplog):
        caplog.set_level(logging.DEBUG)
        fake = FakeFrigate()
        added = await frigate_with(fake).add_camera("front", rtsp_url.internal_url("admin", pw, IP, 554, PATH))
        assert added is False
        assert fake.puts() == []  # a broken config would stop Frigate starting
        assert pw not in caplog.text


class TestAtSignInTheAddress:
    """QA-N1, at the Frigate boundary: what the camera receives AND where ffmpeg dials.

    For a username Frigate's pattern matches, an '@' in the path or query makes it
    treat the host as part of the password, and ffmpeg then connects to whatever
    follows that '@' — with the account's credentials. Refused rather than written."""

    TAILS = ["/a@b", "/stream?token=a@b", "/@evil.lan"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("tail", TAILS)
    async def test_a_username_frigate_matches_is_refused_not_written(self, tail, caplog):
        caplog.set_level(logging.DEBUG)
        fake = FakeFrigate()
        added = await frigate_with(fake).add_camera(
            "front", rtsp_url.internal_url("admin", "C@mera!2024", IP, 554, tail)
        )
        assert added is False
        assert fake.puts() == []
        assert "mera!2024" not in caplog.text

    @pytest.mark.asyncio
    @pytest.mark.parametrize("pw", PASSWORDS)
    @pytest.mark.parametrize("tail", TAILS)
    async def test_any_other_username_reaches_the_camera_and_only_the_camera(self, tail, pw):
        fake = FakeFrigate()
        added = await frigate_with(fake).add_camera(
            "front", rtsp_url.internal_url("john.doe", pw, IP, 554, tail)
        )
        assert added is True
        (stored,) = fake.stored_paths()
        assert camera_receives(stored) == ("john.doe", pw)
        assert camera_connects_to(stored) == f"{IP}:554"

    @pytest.mark.asyncio
    async def test_a_url_with_no_sign_in_may_carry_an_at_sign(self):
        fake = FakeFrigate()
        url = f"rtsp://{IP}:554/a@b"
        assert await frigate_with(fake).add_camera("front", url) is True
        assert fake.stored_paths() == [url]


class TestNoCredentialsInLogs:
    LEAK = "C@mera!2024"

    @pytest.mark.asyncio
    async def test_an_http_error_that_echoes_the_config_path(self, caplog):
        caplog.set_level(logging.DEBUG)
        fake = FakeFrigate(
            put_status=400,
            put_body=f"Invalid input path: rtsp://admin:{self.LEAK}@{IP}:554{PATH} for camera front",
        )
        added = await frigate_with(fake).add_camera("front", rtsp_url.internal_url("admin", self.LEAK, IP, 554, PATH))
        assert added is False
        assert "mera!2024" not in caplog.text
        assert "Invalid input path" in caplog.text  # the rest of the message is kept

    @pytest.mark.asyncio
    async def test_a_rejection_message_that_echoes_the_config_path(self, caplog):
        caplog.set_level(logging.DEBUG)
        fake = FakeFrigate(
            put_body={"success": False, "message": f"bad path rtsp://admin:{self.LEAK}@{IP}:554{PATH}"}
        )
        added = await frigate_with(fake).add_camera("front", rtsp_url.internal_url("admin", self.LEAK, IP, 554, PATH))
        assert added is False
        assert "mera!2024" not in caplog.text

    @pytest.mark.asyncio
    async def test_the_birdseye_convergence_reply_too(self, caplog):
        """Frigate's config errors can quote ANY camera's path, so every message
        it sends back is scrubbed, not only the add-camera one."""
        caplog.set_level(logging.DEBUG)
        fake = FakeFrigate(
            put_status=400,
            put_body={"message": f"invalid config near rtsp://admin:{self.LEAK}@{IP}/x"},
        )
        assert await frigate_with(fake).ensure_birdseye() is False
        assert "mera!2024" not in caplog.text


    @pytest.mark.asyncio
    async def test_the_scan_loop_logs_a_rejected_url_without_its_credentials(self, monkeypatch, caplog):
        """An ONVIF/RTSP result for an address outside the camera subnet is dropped
        with a warning; the URL it names carries the camera's password."""
        import importlib

        import main

        main = importlib.reload(main)
        caplog.set_level(logging.DEBUG)

        async def leases():
            return [{"ipaddr": "192.168.100.50", "macaddr": "aa:bb:cc:dd:ee:ff",
                     "hostname": "cam", "source": "dhcp"}]

        async def no_onvif_devices():
            return []

        async def no_onvif_probe(ip):
            return None

        async def probe(ip):
            return {"ip": ip, "port": 554, "detection_method": "rtsp_default_credentials",
                    "rtsp_url": f"rtsp://admin:{self.LEAK}@8.8.8.8:554/x"}

        monkeypatch.setattr(main, "fetch_dhcp_leases", leases)
        monkeypatch.setattr(main, "discover_cameras", no_onvif_devices)
        monkeypatch.setattr(main, "probe_onvif_device", no_onvif_probe)
        monkeypatch.setattr(main, "probe_camera", probe)
        monkeypatch.setattr(main, "_is_camera_hostname", lambda h: False)
        monkeypatch.setattr(main, "_camera_network", None)
        monkeypatch.setattr(main, "publish_discovery", lambda *_a, **_k: None)
        main.known_cameras.clear()
        main.pending_cameras.clear()

        await main.scan_and_discover()

        assert "Rejecting unsafe RTSP URL" in caplog.text
        assert "mera!2024" not in caplog.text


class TestEndToEnd:
    """submit_camera_credentials -> the real FrigateClient -> Frigate's escape -> ffmpeg."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("pw", PASSWORDS)
    @pytest.mark.parametrize("user", USERS)
    async def test_the_camera_receives_exactly_what_the_operator_typed(self, monkeypatch, user, pw):
        async with _Server(username=user, password=pw) as srv:
            main, _, _ = _fresh_main(monkeypatch, srv.port)
            fake = FakeFrigate()
            monkeypatch.setattr(main, "frigate", frigate_with(fake))

            out = await main.submit_camera_credentials(MAC, _Req({"username": user, "password": pw}))

        assert out["status"] == "accepted"
        (stored,) = fake.stored_paths()
        assert camera_receives(stored) == (user, pw)
        assert stored.endswith(f":{srv.port}/profile2/media.smp")

    @pytest.mark.asyncio
    async def test_the_manual_accept_of_a_pending_camera_is_converted_too(self, monkeypatch):
        """accept_camera hands the pending record's internal URL to add_camera."""
        main, _, _ = _fresh_main(monkeypatch, 554)
        fake = FakeFrigate()
        monkeypatch.setattr(main, "frigate", frigate_with(fake))

        async def verified(url):
            return True

        monkeypatch.setattr(main, "verify_stream", verified)
        main.pending_cameras[MAC]["rtsp_url"] = rtsp_url.internal_url("admin", "C@mera!2024", IP, 554, PATH)

        out = await main.accept_camera(MAC, _Req({}))

        assert out["status"] == "accepted"
        assert camera_receives(fake.stored_paths()[0]) == ("admin", "C@mera!2024")

    @pytest.mark.asyncio
    async def test_a_frigate_error_that_quotes_the_path_does_not_reach_the_log(self, monkeypatch, caplog):
        from fastapi import HTTPException

        caplog.set_level(logging.DEBUG)
        pw = "C@mera!2024"
        async with _Server(password=pw) as srv:
            main, _, _ = _fresh_main(monkeypatch, srv.port)
            fake = FakeFrigate(put_status=400, put_body=f"Invalid input path: rtsp://admin:{pw}@127.0.0.1/x")
            monkeypatch.setattr(main, "frigate", frigate_with(fake))
            with pytest.raises(HTTPException) as ei:
                await main.submit_camera_credentials(MAC, _Req({"username": "admin", "password": pw}))
        assert ei.value.status_code == 500
        assert "mera!2024" not in caplog.text
        assert pw not in str(ei.value.detail)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("pw", PASSWORDS)
    async def test_an_onvif_path_with_an_at_sign_reaches_the_camera_for_another_username(self, monkeypatch, pw):
        """The stream path is the DEVICE's to name; the host it dials must stay the camera's."""
        user = "john.doe"
        async with _Server(good_paths=("/cam@b",), username=user, password=pw) as srv:
            main, _, _ = _fresh_main(monkeypatch, srv.port)
            fake = FakeFrigate()
            monkeypatch.setattr(main, "frigate", frigate_with(fake))

            async def onvif(ip, port, username, password):
                return ("ok", f"rtsp://{ip}:{srv.port}/cam@b")

            monkeypatch.setattr(main, "onvif_stream_uri", onvif)
            out = await main.submit_camera_credentials(MAC, _Req({"username": user, "password": pw}))

        assert out["status"] == "accepted"
        (stored,) = fake.stored_paths()
        assert camera_receives(stored) == (user, pw)
        assert camera_connects_to(stored) == f"127.0.0.1:{srv.port}"

    @pytest.mark.asyncio
    async def test_an_onvif_path_with_an_at_sign_is_refused_for_a_username_frigate_would_misread(self, monkeypatch):
        pw = "C@mera!2024"
        async with _Server(good_paths=("/cam@evil.lan",), password=pw) as srv:
            main, _, _ = _fresh_main(monkeypatch, srv.port)
            fake = FakeFrigate()
            monkeypatch.setattr(main, "frigate", frigate_with(fake))

            async def onvif(ip, port, username, password):
                return ("ok", f"rtsp://{ip}:{srv.port}/cam@evil.lan")

            monkeypatch.setattr(main, "onvif_stream_uri", onvif)
            with pytest.raises(main.CredentialsRejected) as rejected:
                await main.submit_camera_credentials(MAC, _Req({"username": "admin", "password": pw}))

        assert rejected.value.status_code == 400
        assert rejected.value.code == "unsupported_stream_address"
        resp = await main._credentials_rejected_handler(_Req({}), rejected.value)
        assert resp.status_code == 400
        assert json.loads(resp.body)["code"] == "unsupported_stream_address"
        assert pw not in resp.body.decode()
        assert fake.puts() == []  # nothing was written for Frigate to misread
        assert MAC in main.pending_cameras and MAC not in main.known_cameras
        assert not main.accepting_macs  # the in-flight claim was released
