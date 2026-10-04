"""WARP-3508 — the default-credential ladder must not hammer a camera every sweep.

Every 30 s sweep re-ran the whole ladder against any camera still pending: ONVIF as
admin/blank, then up to ~14 factory-default logins per stream path. Hanwha / Axis /
some Hikvision firmware lock the admin account after ~5 failed logins and answer
HTTP/RTSP 490 "Account Blocked" for several minutes (default_credentials.py, WARP-1873),
so a camera still waiting for the operator's password was held in permanent lockout by
the service that was supposed to adopt it — and the operator could not sign in either.

The ladder now keeps a small per-IP budget:

* at most ``LADDER_FAILED_AUTH_BUDGET`` REJECTED logins per run (below every known
  lockout threshold), then it stands down for ``LADDER_RETRY_SECONDS``;
* the next run RESUMES at the next credential rather than restarting at the first —
  otherwise the later defaults (and the operator's own) would never be reached;
* a 490 stops it at once, for ``LADDER_COOLDOWN_SECONDS``;
* once every credential has been rejected it waits ``LADDER_COOLDOWN_SECONDS`` before
  starting a new pass: the camera has a password we do not know, and only the
  operator can supply it;
* a path that does not exist, or does not challenge, costs one anonymous DESCRIBE and
  no login attempt (it used to cost one per credential).

While the ladder is quiet the ONVIF admin/blank login — one more failed login per
sweep — is skipped too (``credential_probing_paused``).

The fake camera below counts authenticated DESCRIBEs, which is the number that matters:
anonymous requests never consume a vendor's failed-login budget.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
from urllib.parse import urlsplit

import pytest

import rtsp_prober

IP = "127.0.0.1"
CREDENTIALS = [("admin", f"wrong{i}") for i in range(6)]  # none of them is right


class _Clock:
    """A controllable monotonic clock — the budget is about elapsed time, not sleeping."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class _ScriptedCamera:
    """A scripted RTSP camera on 127.0.0.1:<ephemeral>.

    * every DESCRIBE on an existing path is challenged with Basic auth;
    * ``good`` is the one credential it accepts (None: it accepts nothing);
    * ``paths`` limits which stream paths exist (None: all of them); others 404;
    * ``lock_after`` — after that many REJECTED logins it locks like a Hanwha and
      answers 490 to everything, anonymous requests included;
    * ``locked`` — start already locked out.
    """

    def __init__(self, *, good=None, paths=None, lock_after=None, locked=False):
        self.good = good
        self.paths = paths
        self.lock_after = lock_after
        self.locked = locked
        self.logins: list[tuple[str, str]] = []  # every authenticated DESCRIBE, in order
        self.anonymous = 0  # DESCRIBEs without credentials that reached a stream path
        self.rejected = 0
        self.requests = 0  # every DESCRIBE received, whatever the answer
        self.port: int | None = None
        self._server: asyncio.AbstractServer | None = None

    def _respond(self, method: str, path: str, headers: dict[str, str]) -> bytes:
        if method != "DESCRIBE":
            return b"RTSP/1.0 400 Bad Request\r\nCSeq: 0\r\n\r\n"
        self.requests += 1
        if self.locked:
            return b"RTSP/1.0 490 Account Blocked\r\nCSeq: 1\r\n\r\n"
        if self.paths is not None and path not in self.paths:
            self.anonymous += 1
            return b"RTSP/1.0 404 Not Found\r\nCSeq: 1\r\n\r\n"
        authorization = headers.get("authorization", "")
        if not authorization:
            self.anonymous += 1
            return (
                b"RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n"
                b'WWW-Authenticate: Basic realm="cam"\r\n\r\n'
            )
        user, _, password = base64.b64decode(authorization.split(" ", 1)[1]).decode().partition(":")
        self.logins.append((user, password))
        if self.good == (user, password):
            return b"RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n"
        self.rejected += 1
        if self.lock_after is not None and self.rejected >= self.lock_after:
            self.locked = True
        return b"RTSP/1.0 401 Unauthorized\r\nCSeq: 2\r\n\r\n"

    async def _handle(self, reader, writer):
        try:
            while True:
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = await reader.read(2048)
                    if not chunk:
                        return
                    data += chunk
                head, *header_lines = data.decode("utf-8", errors="ignore").split("\r\n")
                parts = head.split(" ")
                method = parts[0]
                url = parts[1] if len(parts) > 1 else ""
                path = urlsplit(url).path if url.startswith("rtsp") else url
                headers = {
                    k.strip().lower(): v.strip()
                    for k, _, v in (line.partition(":") for line in header_lines if ":" in line)
                }
                writer.write(self._respond(method, path, headers))
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


@pytest.fixture(autouse=True)
def _fresh_budget(monkeypatch):
    # The local scripted camera deliberately uses Basic. Production stays Digest-only.
    monkeypatch.setenv("CAMERA_RTSP_BASIC_ALLOW_IPS", IP)
    rtsp_prober._ladder.clear()
    monkeypatch.setattr(rtsp_prober, "get_credentials", lambda: list(CREDENTIALS))
    clock = _Clock()
    monkeypatch.setattr(rtsp_prober, "_clock", clock)
    yield clock
    rtsp_prober._ladder.clear()


async def _ladder(camera: _ScriptedCamera):
    return await rtsp_prober.probe_rtsp_with_credentials(IP, camera.port)


class TestTheBudget:
    @pytest.mark.asyncio
    async def test_a_basic_only_camera_gets_no_login_without_an_explicit_allowance(self, monkeypatch):
        monkeypatch.setenv("CAMERA_RTSP_BASIC_ALLOW_IPS", "")
        async with _ScriptedCamera() as camera:
            assert await _ladder(camera) is None
        assert camera.logins == []
        assert camera.requests == 1
        assert rtsp_prober._ladder[IP].next_credential == 0

    @pytest.mark.asyncio
    async def test_a_run_spends_at_most_the_failed_login_budget(self):
        async with _ScriptedCamera() as camera:
            assert await _ladder(camera) is None

        assert len(camera.logins) == rtsp_prober.LADDER_FAILED_AUTH_BUDGET
        assert camera.logins == CREDENTIALS[: rtsp_prober.LADDER_FAILED_AUTH_BUDGET]

    @pytest.mark.asyncio
    async def test_the_budget_is_below_the_lockout_threshold_it_exists_to_respect(self):
        # default_credentials.py: Hanwha / Axis / some Hikvision lock after ~5 failures.
        assert 1 <= rtsp_prober.LADDER_FAILED_AUTH_BUDGET < 5

    @pytest.mark.asyncio
    async def test_it_stays_quiet_between_runs_without_touching_the_camera(self, _fresh_budget):
        async with _ScriptedCamera() as camera:
            await _ladder(camera)
            seen = camera.requests
            assert rtsp_prober.credential_probing_paused(IP) is True

            _fresh_budget.advance(rtsp_prober.LADDER_RETRY_SECONDS - 1)
            assert await _ladder(camera) is None

        assert camera.requests == seen, "the ladder poked the camera during its quiet period"
        assert rtsp_prober.credential_probing_paused(IP) is True

    @pytest.mark.asyncio
    async def test_the_next_run_resumes_where_the_last_one_stopped(self, _fresh_budget):
        """Restarting at the first credential would never reach the later defaults —
        or the operator's own, which is prepended to the list."""
        budget = rtsp_prober.LADDER_FAILED_AUTH_BUDGET
        async with _ScriptedCamera() as camera:
            await _ladder(camera)
            _fresh_budget.advance(rtsp_prober.LADDER_RETRY_SECONDS + 1)
            assert rtsp_prober.credential_probing_paused(IP) is False
            await _ladder(camera)

        assert camera.logins == CREDENTIALS[: budget * 2]

    @pytest.mark.asyncio
    async def test_a_credential_that_works_is_found_on_a_later_run_and_clears_the_state(self, _fresh_budget):
        budget = rtsp_prober.LADDER_FAILED_AUTH_BUDGET
        good = CREDENTIALS[budget]  # the first one the SECOND run reaches
        async with _ScriptedCamera(good=good) as camera:
            assert await _ladder(camera) is None
            _fresh_budget.advance(rtsp_prober.LADDER_RETRY_SECONDS + 1)
            found = await _ladder(camera)

        assert found is not None
        _path, user, password = found
        assert (user, password) == good
        assert rtsp_prober.credential_probing_paused(IP) is False
        assert IP not in rtsp_prober._ladder

    @pytest.mark.asyncio
    async def test_the_budget_is_per_ip(self):
        async with _ScriptedCamera() as camera:
            await _ladder(camera)
        assert rtsp_prober.credential_probing_paused(IP) is True
        assert rtsp_prober.credential_probing_paused("127.0.0.2") is False


class TestLockout:
    @pytest.mark.asyncio
    async def test_a_camera_that_is_already_locked_gets_no_login_at_all(self, _fresh_budget):
        async with _ScriptedCamera(locked=True) as camera:
            assert await _ladder(camera) is None

            assert camera.logins == []
            assert rtsp_prober.credential_probing_paused(IP) is True

            # A retry window is not enough after a lockout — only the full cooldown.
            seen = camera.requests
            _fresh_budget.advance(rtsp_prober.LADDER_RETRY_SECONDS + 1)
            assert await _ladder(camera) is None
            assert camera.requests == seen
            assert rtsp_prober.credential_probing_paused(IP) is True

            _fresh_budget.advance(rtsp_prober.LADDER_COOLDOWN_SECONDS)
            assert rtsp_prober.credential_probing_paused(IP) is False

    @pytest.mark.asyncio
    async def test_a_lockout_seen_mid_run_stops_it_immediately(self, _fresh_budget):
        async with _ScriptedCamera(lock_after=1) as camera:
            assert await _ladder(camera) is None

            # One rejected login, then the camera answers 490: nothing more is sent.
            assert len(camera.logins) == 1
            _fresh_budget.advance(rtsp_prober.LADDER_RETRY_SECONDS + 1)
            assert rtsp_prober.credential_probing_paused(IP) is True


class TestAWholePassWasRejected:
    @pytest.mark.asyncio
    async def test_it_waits_the_cooldown_then_starts_a_new_pass(self, _fresh_budget, monkeypatch):
        monkeypatch.setattr(rtsp_prober, "get_credentials", lambda: list(CREDENTIALS[:3]))
        budget = rtsp_prober.LADDER_FAILED_AUTH_BUDGET
        assert budget < 3, "this test needs a list longer than one run's budget"
        async with _ScriptedCamera() as camera:
            await _ladder(camera)  # credentials 0..budget-1
            _fresh_budget.advance(rtsp_prober.LADDER_RETRY_SECONDS + 1)
            await _ladder(camera)  # the rest: every credential has now been rejected

            assert camera.logins == CREDENTIALS[:3]
            assert rtsp_prober.credential_probing_paused(IP) is True

            # The camera has a password we do not know: a retry window is not enough.
            _fresh_budget.advance(rtsp_prober.LADDER_RETRY_SECONDS + 1)
            assert rtsp_prober.credential_probing_paused(IP) is True

            _fresh_budget.advance(rtsp_prober.LADDER_COOLDOWN_SECONDS)
            assert rtsp_prober.credential_probing_paused(IP) is False
            await _ladder(camera)  # a new pass starts from the top

        assert camera.logins[3:] == CREDENTIALS[:budget]


class TestPathsWithNothingToLogInTo:
    @pytest.mark.asyncio
    async def test_cost_one_anonymous_request_each_and_no_login(self):
        async with _ScriptedCamera(paths=set()) as camera:  # every path 404s
            assert await _ladder(camera) is None

        assert camera.logins == []
        assert camera.anonymous == len(rtsp_prober.STREAM_PATHS)  # was len(paths) * len(credentials)

    @pytest.mark.asyncio
    async def test_it_does_not_stand_down_when_there_was_nothing_to_try(self):
        """No login was attempted, so nothing was spent: a camera that starts
        challenging later (it finished first boot) is picked up on the next sweep."""
        async with _ScriptedCamera(paths=set()) as camera:
            await _ladder(camera)

        assert rtsp_prober.credential_probing_paused(IP) is False

    @pytest.mark.asyncio
    async def test_the_credentials_are_tried_on_the_path_that_does_exist(self):
        late_path = rtsp_prober.STREAM_PATHS[7]
        async with _ScriptedCamera(paths={late_path}, good=CREDENTIALS[1]) as camera:
            found = await _ladder(camera)

        assert found == (late_path, *CREDENTIALS[1])
        assert camera.logins == CREDENTIALS[:2]


class TestTheSeamsOthersRelyOn:
    @pytest.mark.asyncio
    async def test_try_credentials_once_still_answers_a_plain_bool(self):
        async with _ScriptedCamera(good=("admin", "right")) as camera:
            ok = await rtsp_prober._try_credentials_once(IP, camera.port, "/live", "admin", "right")
            bad = await rtsp_prober._try_credentials_once(IP, camera.port, "/live", "admin", "nope")

        assert ok is True
        assert bad is False

    @pytest.mark.asyncio
    async def test_verifying_a_known_stream_spends_no_ladder_budget(self):
        """verify_stream replays ONE stored credential; it must not be throttled by,
        or count against, the ladder."""
        async with _ScriptedCamera(good=("admin", "right")) as camera:
            rtsp_prober._ladder[IP] = rtsp_prober._LadderState(quiet_until=rtsp_prober._clock() + 3600)
            assert await rtsp_prober.verify_stream(f"rtsp://admin:right@{IP}:{camera.port}/live") is True

        assert rtsp_prober._ladder[IP].next_credential == 0

    @pytest.mark.asyncio
    async def test_probe_camera_still_surfaces_the_camera_while_the_ladder_is_quiet(self, monkeypatch):
        """Standing down must not make the camera vanish from the list: it falls
        through to the needs-credentials placeholder, with no further login."""
        async with _ScriptedCamera() as camera:

            async def only_our_port(ip, ports=None, timeout=2.0):
                return [camera.port]

            monkeypatch.setattr(rtsp_prober, "scan_ports", only_our_port)
            rtsp_prober._ladder[IP] = rtsp_prober._LadderState(quiet_until=rtsp_prober._clock() + 3600)

            info = await rtsp_prober.probe_camera(IP)

        assert info is not None
        assert info["detection_method"] == "rtsp_port_open"
        assert camera.logins == []


class TestOnvifStandsDownToo:
    """The ONVIF probe logs in as admin/blank — one more failed login per sweep, which
    would defeat the ladder's budget on its own."""

    @staticmethod
    def _sweep(monkeypatch):
        import main

        for state in (main.known_cameras, main.pending_cameras, main.rejected_macs, main.accepting_macs, main.managed_ips):
            state.clear()
        seen = {"onvif": [], "camera": []}

        async def leases():
            return [{"ipaddr": "192.168.100.50", "macaddr": "aa:bb:cc:dd:ee:01", "hostname": "xnv", "source": "dhcp"}]

        async def no_ws_discovery():
            return []

        async def onvif(ip):
            seen["onvif"].append(ip)

        async def camera(ip):
            seen["camera"].append(ip)

        async def verify(url, timeout=4.0):
            return False

        monkeypatch.setattr(main, "fetch_dhcp_leases", leases)
        monkeypatch.setattr(main, "discover_cameras", no_ws_discovery)
        monkeypatch.setattr(main, "probe_onvif_device", onvif)
        monkeypatch.setattr(main, "probe_camera", camera)
        monkeypatch.setattr(main, "verify_stream", verify)
        monkeypatch.setattr(main, "_camera_network", None)
        monkeypatch.setattr(main, "_is_camera_hostname", lambda hostname: True)
        monkeypatch.setattr(main, "publish_discovery", lambda event: None)
        return main, seen

    @pytest.mark.asyncio
    async def test_no_onvif_login_while_the_ladder_is_quiet(self, monkeypatch):
        main, seen = self._sweep(monkeypatch)
        rtsp_prober._ladder["192.168.100.50"] = rtsp_prober._LadderState(quiet_until=rtsp_prober._clock() + 3600)

        await main.scan_and_discover()

        assert seen["onvif"] == [], "ONVIF admin/blank login sent to a camera that has been rejecting logins"
        assert seen["camera"] == ["192.168.100.50"]  # the anonymous probes still run

    @pytest.mark.asyncio
    async def test_onvif_is_probed_as_before_otherwise(self, monkeypatch):
        main, seen = self._sweep(monkeypatch)

        await main.scan_and_discover()

        assert seen["onvif"] == ["192.168.100.50"]
