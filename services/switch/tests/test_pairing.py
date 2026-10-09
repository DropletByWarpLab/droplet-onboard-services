"""ADR-071 slice C (WARP-3739) - switch half of box <-> device pairing.

Mirrors services/routing/tests/test_pairing.py. Covers, in order:
  * the null-session `droplet.pair` client (open / closed / paired, plugin absent)
  * the password holder (a rotated credential applies on the next login)
  * `/health.pairing` + `error_code` (`SWITCH_AUTH` / `SWITCH_PAIRED_ELSEWHERE`)
  * the auth-rejected-only scheduler job (probes `status` ONLY in that state)
  * `PUT /pairing/identity`, `POST /pairing/claim` (happy path, every error code)
    and the pending / persisted lifecycle

No test opens a socket: the switch is `FakeSwitchBox` (ubus transport for the
null-session client, driver factory for the logins).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from drivers.base import AuthenticationError, ConnectionLost
from drivers.openwrt import NULL_SESSION as DRIVER_NULL_SESSION, OpenWrtSwitchDriver
from pairing import (
    NULL_SESSION,
    PairingApi,
    PairingClaimError,
    PairingProtocolError,
    PairingState,
    PairingUnsupported,
    PairStatus,
)
from tests.fakes import FakeSwitchDriver

AUTH_HEADERS = {"Authorization": "Bearer pytest-fake-secret"}
BOX_FP = "ab" * 32
OTHER_FP = "cd" * 32
OLD_PW = "old-switch-password"


# ---------------------------------------------------------------------------
# Null-session client
# ---------------------------------------------------------------------------
class _Scripted:
    """Transport returning the queued response and recording the payloads."""

    def __init__(self, response: dict):
        self.response = response
        self.payloads: list[dict] = []

    async def __call__(self, payload: dict) -> dict:
        self.payloads.append(payload)
        return self.response


def _api(response: dict) -> tuple[PairingApi, _Scripted]:
    transport = _Scripted(response)
    return PairingApi("switch", transport=transport), transport


@pytest.mark.asyncio
class TestPairingApi:
    async def test_status_open_uses_the_null_session(self):
        api, tr = _api({"result": [0, {"pairing": "open", "window_ends_at": 1_800_000_000}]})
        st = await api.status()
        assert st.state == "open"
        assert st.window_ends_at == "2027-01-15T08:00:00+00:00"
        assert st.paired_box is None
        assert tr.payloads[0]["method"] == "call"
        assert tr.payloads[0]["params"] == [NULL_SESSION, "droplet.pair", "status", {}]

    async def test_null_session_is_the_drivers_null_session(self):
        assert NULL_SESSION == DRIVER_NULL_SESSION == "0" * 32

    async def test_status_closed(self):
        api, _ = _api({"result": [0, {"pairing": "closed"}]})
        st = await api.status()
        assert (st.state, st.window_ends_at, st.paired_box) == ("closed", None, None)

    async def test_status_paired_carries_the_box_and_iso_window_passthrough(self):
        api, _ = _api({"result": [0, {
            "pairing": "paired", "paired_box": BOX_FP, "window_ends_at": "2026-10-06T12:00:00Z",
        }]})
        st = await api.status()
        assert st.state == "paired"
        assert st.paired_box == BOX_FP
        assert st.window_ends_at == "2026-10-06T12:00:00Z"

    async def test_malformed_paired_box_is_dropped(self):
        api, _ = _api({"result": [0, {"pairing": "paired", "paired_box": "not-hex"}]})
        assert (await api.status()).paired_box is None

    async def test_unrecognised_state_is_unknown(self):
        api, _ = _api({"result": [0, {"pairing": "banana"}]})
        assert (await api.status()).state == "unknown"

    @pytest.mark.parametrize("response", [
        {"error": {"code": -32000, "message": "Object not found"}},
        {"error": {"code": -32002, "message": "Access denied"}},
        {"result": [4]},  # ubus NOT_FOUND
        {"result": [6]},  # ubus PERMISSION_DENIED
    ])
    async def test_plugin_absent_is_unsupported(self, response):
        api, _ = _api(response)
        with pytest.raises(PairingUnsupported):
            await api.status()
        with pytest.raises(PairingUnsupported):
            await api.claim("a" * 32, BOX_FP)

    async def test_other_ubus_errors_pass_through(self):
        api, _ = _api({"error": {"code": -32603, "message": "boom"}})
        with pytest.raises(PairingProtocolError):
            await api.status()

    async def test_claim_sends_password_and_fingerprint(self):
        api, tr = _api({"result": [0, {"ok": True}]})
        await api.claim("0123456789abcdef0123456789abcdef", BOX_FP)
        assert tr.payloads[0]["params"] == [NULL_SESSION, "droplet.pair", "claim", {
            "password": "0123456789abcdef0123456789abcdef", "box_fingerprint": BOX_FP,
        }]

    @pytest.mark.parametrize("data", [
        {"error": "window closed"},
        {"ok": False},
    ])
    async def test_claim_error_body_raises(self, data):
        api, _ = _api({"result": [0, data]})
        with pytest.raises(PairingClaimError):
            await api.claim("a" * 32, BOX_FP)

    async def test_claim_nonzero_ubus_status_raises_claim_error(self):
        api, _ = _api({"result": [2]})
        with pytest.raises(PairingClaimError):
            await api.claim("a" * 32, BOX_FP)

    async def test_transport_failure_is_connection_lost(self):
        import httpx

        async def boom(payload):
            raise httpx.ConnectError("no route")

        api = PairingApi("switch", transport=boom)
        with pytest.raises(ConnectionLost):
            await api.status()


# ---------------------------------------------------------------------------
# The fake switch
# ---------------------------------------------------------------------------
class FakeSwitchBox:
    """One switch: its `droplet.pair` object and its droplet-ai login."""

    def __init__(self, state: str = "open", password: str = OLD_PW,
                 paired_box: Optional[str] = None):
        self.state = state
        self.password = password
        self.paired_box = paired_box
        self.window_ends_at: Optional[int] = 1_800_000_000 if state == "open" else None
        self.reachable = True
        self.plugin = True
        self.claim_error: Optional[str] = None
        self.claim_applies = True  # False: answers ok but keeps the old password
        self.calls: list[str] = []
        self.logins: list[str] = []

    async def transport(self, payload: dict) -> dict:
        import httpx

        if not self.reachable:
            raise httpx.ConnectError("switch down")
        _session, obj, method, args = payload["params"]
        assert _session == NULL_SESSION and obj == "droplet.pair"
        self.calls.append(method)
        if not self.plugin:
            return {"error": {"code": -32000, "message": "Object not found"}}
        if method == "status":
            data: dict = {"pairing": self.state}
            if self.window_ends_at is not None:
                data["window_ends_at"] = self.window_ends_at
            if self.paired_box:
                data["paired_box"] = self.paired_box
            return {"result": [0, data]}
        if method == "claim":
            if self.claim_error:
                return {"result": [0, {"error": self.claim_error}]}
            if self.state != "open":
                return {"result": [0, {"error": "window closed"}]}
            if self.claim_applies:
                self.password = args["password"]
            self.paired_box = args["box_fingerprint"]
            self.state = "paired"
            self.window_ends_at = None
            return {"result": [0, {"ok": True}]}
        raise AssertionError(method)


class BoxDriver(FakeSwitchDriver):
    """A driver whose login is checked against the box's current password."""

    def __init__(self, box: FakeSwitchBox, password_source):
        super().__init__()
        self.box = box
        self.password_source = password_source
        self._connected = False

    def _pw(self) -> str:
        src = self.password_source
        return src() if callable(src) else src

    async def connect(self) -> None:
        if not self.box.reachable:
            raise ConnectionLost("switch down")
        pw = self._pw()
        self.box.logins.append(pw)
        if pw != self.box.password:
            raise AuthenticationError("rejected")
        self._connected = True

    async def get_system_info(self) -> dict:
        if not self.box.reachable:
            raise ConnectionLost("switch down")
        if self._pw() != self.box.password:
            raise AuthenticationError("rejected")
        return {"model": "Zyxel GS1900-10HP A1", "port_count": 8}


@pytest.fixture
def box(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> FakeSwitchBox:
    """A fake switch wired into main: pairing client, driver factory, holder."""
    b = FakeSwitchBox()
    secret = tmp_path / "switch_password"
    secret.write_text(OLD_PW)
    monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(secret))
    monkeypatch.setenv("SWITCH_PASSWORD", "")
    monkeypatch.setattr(main, "pairing_state", PairingState())
    monkeypatch.setattr(main, "_auth_rejected", False)
    monkeypatch.setattr(main, "_pairing_scheduler", None)
    monkeypatch.setattr(main, "driver_instance", None)
    monkeypatch.setattr(main, "_provision_task", None)
    monkeypatch.setattr(main, "_pairing_api", lambda: PairingApi("switch", transport=b.transport))
    monkeypatch.setattr(main, "create_driver", lambda password_source=None: BoxDriver(b, password_source))
    monkeypatch.delenv("SWITCH_AUTOPROVISION", raising=False)
    return b


@pytest.fixture
def client(box) -> TestClient:
    return TestClient(main.app)


# ---------------------------------------------------------------------------
# Password holder
# ---------------------------------------------------------------------------
class TestPasswordHolder:
    def test_prefers_the_password_claimed_in_process(self, box):
        main.pairing_state.record_claim("f" * 32, BOX_FP)
        assert main.current_switch_password() == "f" * 32

    def test_rereads_the_secret_file_every_call(self, box, tmp_path):
        assert main.current_switch_password() == OLD_PW
        Path(main.os.environ["SWITCH_PASSWORD_FILE"]).write_text("rotated-out-of-band\n")
        assert main.current_switch_password() == "rotated-out-of-band"

    def test_falls_back_to_env_when_file_missing_or_empty(self, box, monkeypatch, tmp_path):
        monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(tmp_path / "absent"))
        monkeypatch.setenv("SWITCH_PASSWORD", "env-pw")
        assert main.current_switch_password() == "env-pw"

    def test_persisted_with_matching_file_drops_the_in_memory_copy(self, box):
        main.pairing_state.record_claim("e" * 32, BOX_FP)
        Path(main.os.environ["SWITCH_PASSWORD_FILE"]).write_text("e" * 32)
        main.pairing_state.mark_persisted(main._read_switch_password_file())
        assert main.pairing_state.live_password() is None
        assert main.current_switch_password() == "e" * 32  # now from the file


@pytest.mark.asyncio
class TestDriverHolderAtLogin:
    async def test_a_rotated_credential_applies_on_the_next_login(self):
        current = {"pw": "first"}
        seen: list[str] = []

        async def transport(payload: dict) -> dict:
            _s, obj, method, args = payload["params"]
            assert (obj, method) == ("session", "login")
            seen.append(args["password"])
            return {"result": [0, {"ubus_rpc_session": "s" * 32, "timeout": 300}]}

        drv = OpenWrtSwitchDriver("h", password=lambda: current["pw"], transport=transport)
        await drv._login()
        drv._session_token = None
        current["pw"] = "second"
        await drv._login()
        assert seen == ["first", "second"]

    async def test_a_plain_string_password_still_works(self):
        seen: list[str] = []

        async def transport(payload: dict) -> dict:
            seen.append(payload["params"][3]["password"])
            return {"result": [0, {"ubus_rpc_session": "s" * 32, "timeout": 300}]}

        drv = OpenWrtSwitchDriver("h", password="plain", transport=transport)
        await drv._login()
        assert seen == ["plain"] and drv._password == "plain"


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------
class TestHealthPairing:
    def test_auth_rejected_at_startup_is_switch_auth_with_the_cached_probe(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        main.pairing_state.record_probe(PairStatus("open", "2026-10-07T00:00:00+00:00", None))
        body = client.get("/health").json()
        assert body["status"] == "disconnected" and body["connected"] is False
        assert body["error_code"] == "SWITCH_AUTH"
        assert "rejected" in body["error"]
        assert body["pairing"] == {
            "state": "open", "window_ends_at": "2026-10-07T00:00:00+00:00",
            "paired_box": None, "paired_elsewhere": False, "pending_persist": False,
        }

    def test_health_never_touches_the_network_for_pairing(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        client.get("/health")
        assert box.calls == [] and box.logins == []

    def test_paired_elsewhere_is_its_own_code(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        main.pairing_state.set_box_fingerprint(BOX_FP)
        main.pairing_state.record_probe(PairStatus("paired", None, OTHER_FP))
        body = client.get("/health").json()
        assert body["error_code"] == "SWITCH_PAIRED_ELSEWHERE"
        assert OTHER_FP[:16] in body["error"]
        assert body["pairing"]["paired_elsewhere"] is True
        assert body["pairing"]["paired_box"] == OTHER_FP

    def test_a_foreign_probe_without_our_fingerprint_is_not_guessed(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        main.pairing_state.record_probe(PairStatus("paired", None, OTHER_FP))
        assert client.get("/health").json()["error_code"] == "SWITCH_AUTH"

    def test_runtime_auth_rejection_flags_the_state(self, box, client, monkeypatch):
        drv = BoxDriver(box, lambda: "stale-password")
        monkeypatch.setattr(main, "driver_instance", drv)
        body = client.get("/health").json()
        assert body["status"] == "error"
        assert body["error_code"] == "SWITCH_AUTH"
        assert main._auth_rejected is True

    def test_unreachable_is_not_an_auth_state(self, box, client, monkeypatch):
        drv = BoxDriver(box, lambda: OLD_PW)
        monkeypatch.setattr(main, "driver_instance", drv)
        box.reachable = False
        body = client.get("/health").json()
        assert body["status"] == "error"
        assert body["error_code"] is None
        assert main._auth_rejected is False
        assert body["pairing"]["state"] == "unknown"

    def test_never_connected_and_not_auth_has_no_error_code(self, box, client):
        body = client.get("/health").json()
        assert body["error"] == "Switch not connected at startup"
        assert body["error_code"] is None
        assert body["pairing"]["state"] == "unknown"

    def test_connected_reports_unknown_until_a_claim_then_paired(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "driver_instance", BoxDriver(box, lambda: OLD_PW))
        body = client.get("/health").json()
        assert body["status"] == "ok" and body["error_code"] is None
        assert body["pairing"]["state"] == "unknown"
        main.pairing_state.record_claim("c" * 32, BOX_FP)
        monkeypatch.setattr(main, "driver_instance", BoxDriver(box, lambda: OLD_PW))
        assert client.get("/health").json()["pairing"] == {
            "state": "paired", "window_ends_at": None, "paired_box": BOX_FP,
            "paired_elsewhere": False, "pending_persist": True,
        }

    def test_a_401_on_a_privileged_route_also_flags_the_state(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "driver_instance", BoxDriver(box, lambda: "stale"))
        resp = client.get("/system/info", headers=AUTH_HEADERS)
        assert resp.status_code == 401
        assert main._auth_rejected is True


# ---------------------------------------------------------------------------
# The auth-rejected-only scheduler job
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
class TestAuthStateTick:
    async def test_does_nothing_and_removes_itself_when_not_rejected(self, box, monkeypatch):
        sched = MagicMock()
        monkeypatch.setattr(main, "_pairing_scheduler", sched)
        await main._auth_state_tick()
        assert box.calls == [] and box.logins == []
        sched.remove_job.assert_called_once_with(main.PAIRING_PROBE_JOB_ID)

    async def test_probes_status_only_while_auth_rejected(self, box, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        box.password = "something-else"  # our holder value is stale -> still rejected
        await main._auth_state_tick()
        assert box.calls == ["status"]
        assert main.pairing_state.snapshot(connected=False, auth_failed=True)["state"] == "open"

    async def test_reconnects_with_the_holder_and_clears_the_state(self, box, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        sched = MagicMock()
        monkeypatch.setattr(main, "_pairing_scheduler", sched)
        await main._auth_state_tick()  # holder returns OLD_PW == box.password
        assert main._auth_rejected is False
        assert main.driver_instance is not None
        assert box.calls == []  # no status probe once the login works
        sched.remove_job.assert_called_with(main.PAIRING_PROBE_JOB_ID)

    async def test_an_unreachable_switch_ends_the_auth_state(self, box, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        box.reachable = False
        await main._auth_state_tick()
        assert main._auth_rejected is False
        assert box.calls == []

    async def test_plugin_absent_caches_unknown(self, box, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        box.password = "different"
        box.plugin = False
        await main._auth_state_tick()
        assert main.pairing_state.snapshot(connected=False, auth_failed=True)["state"] == "unknown"

    async def test_probe_failure_caches_unknown_and_never_raises(self, box, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        box.password = "different"
        monkeypatch.setattr(main, "_pairing_api", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        await main._auth_state_tick()  # must not raise

    async def test_skips_while_a_claim_is_in_flight(self, box, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        async with main._pairing_lock:
            await main._auth_state_tick()
        assert box.calls == [] and box.logins == []

    async def test_entering_the_state_schedules_one_interval_job(self, box, monkeypatch):
        sched = MagicMock()
        monkeypatch.setattr(main, "_pairing_scheduler", sched)
        main._enter_auth_rejected()
        main._enter_auth_rejected()
        kwargs = sched.add_job.call_args.kwargs
        assert kwargs["id"] == main.PAIRING_PROBE_JOB_ID
        assert kwargs["replace_existing"] is True and kwargs["max_instances"] == 1
        assert sched.add_job.call_args.args[:2] == (main._auth_state_tick, "interval")


class TestLifespan:
    def test_startup_auth_rejection_schedules_the_probe_job_and_shutdown_clears_it(self, box, monkeypatch):
        def refuse(password_source=None):
            return BoxDriver(box, lambda: "stale")

        monkeypatch.setattr(main, "create_driver", refuse)
        with TestClient(main.app) as c:
            assert main._auth_rejected is True
            job = main._pairing_scheduler.get_job(main.PAIRING_PROBE_JOB_ID)
            assert job is not None
            body = c.get("/health").json()
            assert body["error_code"] == "SWITCH_AUTH"
        assert main._pairing_scheduler is None

    def test_a_healthy_start_schedules_nothing(self, box):
        with TestClient(main.app):
            assert main._auth_rejected is False
            assert main._pairing_scheduler.get_job(main.PAIRING_PROBE_JOB_ID) is None


# ---------------------------------------------------------------------------
# POST /pairing/claim
# ---------------------------------------------------------------------------
class TestClaim:
    def _claim(self, client, fp=BOX_FP):
        return client.post("/pairing/claim", json={"box_fingerprint": fp}, headers=AUTH_HEADERS)

    def test_happy_path_mints_claims_verifies_and_goes_live(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        resp = self._claim(client)
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert len(body["password"]) == 32 and set(body["password"]) <= set("0123456789abcdef")
        assert body["host"] == main.SWITCH_HOST
        assert body["model"] == "Zyxel GS1900-10HP A1"
        assert body["paired_at"]
        assert resp.headers["cache-control"] == "no-store"
        # the switch really holds the new password, with this box's fingerprint
        assert box.password == body["password"] and box.paired_box == BOX_FP
        # the proof login used the NEW password (not the stale holder value)
        assert body["password"] in box.logins
        # live: holder, driver and state all moved
        assert main.current_switch_password() == body["password"]
        assert main.driver_instance is not None
        assert main._auth_rejected is False
        assert main.pairing_state.pending()["pending"] is True

    def test_password_is_not_logged(self, box, client, caplog):
        with caplog.at_level("DEBUG"):
            body = self._claim(client).json()
        assert body["password"] not in caplog.text

    def test_a_new_password_every_claim(self, box, client):
        first = self._claim(client).json()["password"]
        box.state, box.paired_box = "open", None
        second = self._claim(client).json()["password"]
        assert first != second

    def test_the_old_driver_is_closed_when_the_live_one_is_swapped(self, box, client, monkeypatch):
        old = BoxDriver(box, lambda: OLD_PW)
        monkeypatch.setattr(main, "driver_instance", old)
        assert self._claim(client).status_code == 200
        assert main.driver_instance is not old
        assert old._connected is False

    def test_autoprovision_runs_after_a_claim_when_enabled(self, box, client, monkeypatch):
        ran: list[int] = []

        async def fake_provision(profile_override=None):
            ran.append(1)

        monkeypatch.setenv("SWITCH_AUTOPROVISION", "1")
        monkeypatch.setattr(main, "run_provisioner_safe", fake_provision)

        async def go():
            await main.pairing_claim(main.PairingFingerprintRequest(box_fingerprint=BOX_FP))
            await asyncio.sleep(0)
            return main._provision_task

        task = asyncio.run(go())
        assert task is not None and ran == [1]

    def test_autoprovision_stays_off_when_disabled(self, box, client):
        assert self._claim(client).status_code == 200
        assert main._provision_task is None

    @pytest.mark.parametrize("fp", [None, "", "short", "AB" * 32, "zz" * 32, "ab" * 31])
    def test_invalid_fingerprint_is_400_and_never_reaches_the_switch(self, box, client, fp):
        resp = client.post("/pairing/claim", json={"box_fingerprint": fp}, headers=AUTH_HEADERS)
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_FINGERPRINT"
        assert box.calls == []

    def test_window_closed(self, box, client):
        box.state = "closed"
        resp = self._claim(client)
        assert resp.status_code == 409 and resp.json()["code"] == "PAIR_WINDOW_CLOSED"
        assert "claim" not in box.calls

    def test_already_paired_to_this_box_is_window_closed(self, box, client):
        box.state, box.paired_box = "paired", BOX_FP
        resp = self._claim(client)
        assert resp.status_code == 409 and resp.json()["code"] == "PAIR_WINDOW_CLOSED"

    def test_paired_elsewhere_names_the_foreign_fingerprint(self, box, client):
        box.state, box.paired_box = "paired", OTHER_FP
        resp = self._claim(client)
        assert resp.status_code == 409
        assert resp.json()["code"] == "SWITCH_PAIRED_ELSEWHERE"
        assert resp.json()["paired_box"] == OTHER_FP
        assert "claim" not in box.calls

    def test_unknown_state_is_unsupported(self, box, client):
        box.state = "banana"
        resp = self._claim(client)
        assert resp.status_code == 502 and resp.json()["code"] == "PAIR_UNSUPPORTED"

    def test_plugin_absent_is_unsupported(self, box, client):
        box.plugin = False
        resp = self._claim(client)
        assert resp.status_code == 502 and resp.json()["code"] == "PAIR_UNSUPPORTED"

    def test_unreachable_is_switch_unreachable(self, box, client):
        box.reachable = False
        resp = self._claim(client)
        assert resp.status_code == 503 and resp.json()["code"] == "SWITCH_UNREACHABLE"

    def test_claim_refused_by_the_switch(self, box, client):
        box.claim_error = "window expired"
        resp = self._claim(client)
        assert resp.status_code == 502 and resp.json()["code"] == "PAIR_CLAIM_FAILED"
        assert main.pairing_state.pending()["pending"] is False
        assert main.pairing_state.live_password() is None

    def test_verify_failure_keeps_the_state_and_the_old_credential(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        box.claim_applies = False  # answers ok, but the new password does not log in
        resp = self._claim(client)
        assert resp.status_code == 502 and resp.json()["code"] == "PAIR_VERIFY_FAILED"
        assert main.pairing_state.live_password() is None
        assert main.pairing_state.pending()["pending"] is False
        assert main._auth_rejected is True
        assert main.current_switch_password() == OLD_PW

    def test_unsupported_driver_is_unsupported(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "SWITCH_DRIVER", "asic")
        resp = self._claim(client)
        assert resp.status_code == 502 and resp.json()["code"] == "PAIR_UNSUPPORTED"
        assert box.calls == []

    def test_a_second_concurrent_claim_is_refused(self, box, client):
        async def go():
            async with main._pairing_lock:
                return await main.pairing_claim(
                    main.PairingFingerprintRequest(box_fingerprint=BOX_FP)
                )

        resp = asyncio.run(go())
        assert resp.status_code == 409
        assert b"PAIR_BUSY" in resp.body

    def test_requires_the_service_token(self, box, client):
        resp = client.post("/pairing/claim", json={"box_fingerprint": BOX_FP})
        assert resp.status_code == 403
        assert box.calls == []


# ---------------------------------------------------------------------------
# identity + pending / persisted
# ---------------------------------------------------------------------------
class TestIdentityAndLifecycle:
    def test_identity_makes_paired_elsewhere_visible_before_a_claim(self, box, client, monkeypatch):
        monkeypatch.setattr(main, "_auth_rejected", True)
        main.pairing_state.record_probe(PairStatus("paired", None, OTHER_FP))
        assert client.get("/health").json()["error_code"] == "SWITCH_AUTH"
        resp = client.put("/pairing/identity", json={"box_fingerprint": BOX_FP}, headers=AUTH_HEADERS)
        assert resp.status_code == 200 and resp.json() == {"ok": True}
        assert client.get("/health").json()["error_code"] == "SWITCH_PAIRED_ELSEWHERE"

    def test_identity_rejects_a_malformed_fingerprint(self, box, client):
        resp = client.put("/pairing/identity", json={"box_fingerprint": "nope"}, headers=AUTH_HEADERS)
        assert resp.status_code == 400 and resp.json()["code"] == "INVALID_FINGERPRINT"

    def test_pending_then_persisted_lifecycle(self, box, client):
        assert client.get("/pairing/pending", headers=AUTH_HEADERS).json() == {
            "pending": False, "password": None, "paired_at": None,
        }
        password = client.post(
            "/pairing/claim", json={"box_fingerprint": BOX_FP}, headers=AUTH_HEADERS
        ).json()["password"]
        pending = client.get("/pairing/pending", headers=AUTH_HEADERS)
        assert pending.headers["cache-control"] == "no-store"
        assert pending.json()["pending"] is True and pending.json()["password"] == password
        # the orchestrator wrote the secret file, then confirms
        Path(main.os.environ["SWITCH_PASSWORD_FILE"]).write_text(password)
        assert client.post("/pairing/persisted", headers=AUTH_HEADERS).json() == {"ok": True}
        assert client.get("/pairing/pending", headers=AUTH_HEADERS).json()["pending"] is False
        assert main.pairing_state.live_password() is None
        assert main.current_switch_password() == password  # from the file now

    def test_persisted_without_a_matching_file_keeps_the_live_password(self, box, client):
        password = client.post(
            "/pairing/claim", json={"box_fingerprint": BOX_FP}, headers=AUTH_HEADERS
        ).json()["password"]
        client.post("/pairing/persisted", headers=AUTH_HEADERS)
        assert main.current_switch_password() == password  # never regresses to the stale file

    @pytest.mark.parametrize("method,path", [
        ("get", "/pairing/pending"), ("post", "/pairing/persisted"), ("put", "/pairing/identity"),
    ])
    def test_every_pairing_route_is_bearer_gated(self, box, client, method, path):
        resp = getattr(client, method)(path)
        assert resp.status_code == 403
