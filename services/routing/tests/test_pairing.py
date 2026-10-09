"""ADR-071 slice B (WARP-3739) - routing half of box <-> router pairing.

Covers, in order:
  * the null-session `droplet.pair` client (open / closed / paired, plugin absent)
  * the SDK password holder (a rotated credential applies on the next login)
  * `/health.pairing` + the AUTH-state-only probe from the reconnect tick
  * `ROUTER_PAIRED_ELSEWHERE` vs `ROUTER_AUTH`
  * `POST /pairing/claim` (happy path, every error code) and the
    pending / persisted lifecycle
"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import (
    NULL_SESSION,
    ConnectionLost,
    DropletRouter,
    LoginDenied,
    SessionManager,
    UbusError,
)
from pairing import (
    PairingApi,
    PairingClaimError,
    PairingState,
    PairingUnsupported,
    PairStatus,
)
from reconnect import ReconnectCoordinator

AUTH_HEADERS = {"Authorization": "Bearer pytest-fake-token"}
BOX_FP = "ab" * 32
OTHER_FP = "cd" * 32
OLD_PW = "old-router-password"


# ---------------------------------------------------------------------------
# Null-session client
# ---------------------------------------------------------------------------
class _ScriptedClient:
    """Stand-in for UbusClient.raw_call: returns the queued response."""

    def __init__(self, response: dict):
        self.response = response
        self.calls: list[tuple[str, list]] = []

    def raw_call(self, method: str, params: list) -> dict:
        self.calls.append((method, params))
        return self.response


def _api(response: dict) -> tuple[PairingApi, _ScriptedClient]:
    client = _ScriptedClient(response)
    return PairingApi("router", client=client), client  # type: ignore[arg-type]


class TestPairingApi:
    def test_status_open_uses_the_null_session(self):
        api, client = _api(
            {"result": [0, {"pairing": "open", "window_ends_at": 1_800_000_000}]}
        )
        st = api.status()
        assert st.state == "open"
        assert st.window_ends_at == "2027-01-15T08:00:00+00:00"
        assert st.paired_box is None
        method, params = client.calls[0]
        assert method == "call"
        assert params == [NULL_SESSION, "droplet.pair", "status", {}]

    def test_status_closed(self):
        api, _ = _api({"result": [0, {"pairing": "closed"}]})
        st = api.status()
        assert (st.state, st.window_ends_at, st.paired_box) == ("closed", None, None)

    def test_status_paired_carries_the_box_and_iso_window_passthrough(self):
        api, _ = _api(
            {
                "result": [
                    0,
                    {
                        "pairing": "paired",
                        "paired_box": BOX_FP,
                        "window_ends_at": "2026-10-06T12:00:00Z",
                    },
                ]
            }
        )
        st = api.status()
        assert st.state == "paired"
        assert st.paired_box == BOX_FP
        assert st.window_ends_at == "2026-10-06T12:00:00Z"

    def test_malformed_paired_box_is_dropped(self):
        api, _ = _api({"result": [0, {"pairing": "paired", "paired_box": "not-hex"}]})
        assert api.status().paired_box is None

    def test_unrecognised_state_is_unknown(self):
        api, _ = _api({"result": [0, {"pairing": "banana"}]})
        assert api.status().state == "unknown"

    @pytest.mark.parametrize(
        "response",
        [
            {"error": {"code": -32000, "message": "Object not found"}},
            {"error": {"code": -32002, "message": "Access denied"}},
            {"result": [4]},  # ubus NOT_FOUND
            {"result": [6]},  # ubus PERMISSION_DENIED
        ],
    )
    def test_plugin_absent_is_unsupported(self, response):
        api, _ = _api(response)
        with pytest.raises(PairingUnsupported):
            api.status()
        with pytest.raises(PairingUnsupported):
            api.claim("a" * 32, BOX_FP)

    def test_other_ubus_errors_pass_through(self):
        api, _ = _api({"error": {"code": -32603, "message": "boom"}})
        with pytest.raises(UbusError):
            api.status()

    def test_claim_sends_password_and_fingerprint(self):
        api, client = _api({"result": [0, {"ok": True}]})
        api.claim("0123456789abcdef0123456789abcdef", BOX_FP)
        assert client.calls[0][1] == [
            NULL_SESSION,
            "droplet.pair",
            "claim",
            {"password": "0123456789abcdef0123456789abcdef", "box_fingerprint": BOX_FP},
        ]

    def test_claim_error_payload_raises(self):
        api, _ = _api({"result": [0, {"error": "window closed"}]})
        with pytest.raises(PairingClaimError, match="window closed"):
            api.claim("a" * 32, BOX_FP)

    def test_claim_ubus_failure_raises_claim_error(self):
        api, _ = _api({"result": [2]})
        with pytest.raises(PairingClaimError):
            api.claim("a" * 32, BOX_FP)

    def test_real_transport_posts_to_ubus_with_null_session(self):
        seen: dict = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers["Content-Length"]))
                seen["path"] = self.path
                seen["body"] = json.loads(body)
                payload = json.dumps(
                    {"jsonrpc": "2.0", "id": 1, "result": [0, {"pairing": "open"}]}
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):  # silence
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            st = PairingApi("127.0.0.1", server.server_address[1]).status()
        finally:
            server.shutdown()
            server.server_close()
        assert st.state == "open"
        assert seen["path"] == "/ubus"
        assert seen["body"]["method"] == "call"
        assert seen["body"]["params"] == [NULL_SESSION, "droplet.pair", "status", {}]


# ---------------------------------------------------------------------------
# SDK password holder
# ---------------------------------------------------------------------------
class _LoginRecorder:
    """UbusClient stand-in: records `session login` passwords, accepts one."""

    def __init__(self, accepted: str):
        self.accepted = accepted
        self.login_passwords: list[str] = []

    def call(self, session, obj, method, args=None):
        if (obj, method) == ("session", "login"):
            self.login_passwords.append(args["password"])
            if args["password"] != self.accepted:
                raise UbusError(6)
            return {"ubus_rpc_session": "tok-" + args["password"], "timeout": 300}
        if (obj, method) == ("system", "board"):
            return {"model": "RB5009", "hostname": "edge"}
        raise AssertionError(f"unexpected call {obj}.{method}")


class TestPasswordHolder:
    def test_callable_password_is_resolved_at_every_login(self):
        current = {"pw": "one"}
        rec = _LoginRecorder(accepted="one")
        mgr = SessionManager(rec, "droplet-ai", lambda: current["pw"])  # type: ignore[arg-type]
        mgr.login()
        current["pw"] = "two"
        rec.accepted = "two"
        mgr.login()
        assert rec.login_passwords == ["one", "two"]

    def test_plain_string_password_still_works(self):
        rec = _LoginRecorder(accepted="static")
        mgr = SessionManager(rec, "droplet-ai", "static")  # type: ignore[arg-type]
        assert mgr.login() == "tok-static"

    def test_current_password_precedence(self, tmp_path: Path, monkeypatch):
        secret = tmp_path / "openwrt_password"
        secret.write_text("from-file\n")
        monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(secret))
        assert main.current_openwrt_password() == "from-file"
        # A file updated after startup is picked up without a restart ...
        secret.write_text("rotated-file\n")
        assert main.current_openwrt_password() == "rotated-file"
        # ... and a claim in this process wins over the (stale) file.
        main.pairing_state.record_claim("minted-in-process", BOX_FP)
        assert main.current_openwrt_password() == "minted-in-process"

    def test_current_password_falls_back_to_startup_value(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(tmp_path / "missing"))
        monkeypatch.setattr(main, "OPENWRT_PASSWORD", "env-fallback")
        assert main.current_openwrt_password() == "env-fallback"


# ---------------------------------------------------------------------------
# A fake router the claim flow can run against
# ---------------------------------------------------------------------------
class FakeRouterBox:
    """The router side: a rpcd password, a pairing window and a recorded claim."""

    def __init__(self) -> None:
        self.password = OLD_PW
        self.status = PairStatus(state="open", window_ends_at="2026-10-07T00:00:00+00:00")
        self.unsupported = False
        self.unreachable = False
        self.claim_error: Optional[str] = None
        self.claim_applies_password = True
        self.claims: list[tuple[str, str]] = []
        self.logins: list[str] = []

    # --- null-session side (what `main.PairingApi` is replaced with) ---
    def make_api(self):
        box = self

        class _Api:
            def status(self_inner):  # noqa: N805
                if box.unreachable:
                    raise ConnectionLost("router down")
                if box.unsupported:
                    raise PairingUnsupported("no plugin")
                return box.status

            def claim(self_inner, password, fingerprint):  # noqa: N805
                if box.unsupported:
                    raise PairingUnsupported("no plugin")
                if box.claim_error:
                    raise PairingClaimError(box.claim_error)
                box.claims.append((password, fingerprint))
                if box.claim_applies_password:
                    box.password = password
                    box.status = PairStatus(state="paired", paired_box=fingerprint)

        return _Api()

    # --- authenticated side (what `main.DropletRouter` is replaced with) ---
    def make_router(self, host, port, username, password, auto_login=True, **_kw):
        pw = password() if callable(password) else password
        router = DropletRouter(
            host=host, port=port, username=username, password=password, auto_login=False
        )
        client = _FakeUbus(self)
        router._client = client  # type: ignore[assignment]
        router._session.client = client  # type: ignore[assignment]
        if auto_login:
            self.logins.append(pw)
            router._session.login()
        return router


class _FakeUbus:
    def __init__(self, box: FakeRouterBox):
        self.box = box

    def call(self, session, obj, method, args=None):
        if (obj, method) == ("session", "login"):
            if args["password"] != self.box.password:
                raise UbusError(6)
            return {"ubus_rpc_session": "tok-" + args["password"], "timeout": 300}
        if (obj, method) == ("system", "board"):
            return {"model": "MikroTik RB5009", "hostname": "droplet-edge"}
        if (obj, method) == ("session", "destroy"):
            return {}
        raise AssertionError(f"unexpected call {obj}.{method}")


@pytest.fixture
def box(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> FakeRouterBox:
    fake = FakeRouterBox()
    secret = tmp_path / "openwrt_password"
    secret.write_text(OLD_PW + "\n")
    monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(secret))
    monkeypatch.setattr(main, "router_instance", None)
    monkeypatch.setattr(main, "ROUTING_MODE", "real")
    monkeypatch.setattr(main, "_pairing_api", fake.make_api)
    monkeypatch.setattr(main, "DropletRouter", fake.make_router)
    monkeypatch.setattr(
        main,
        "reconnect_coordinator",
        ReconnectCoordinator(
            connect_fn=main._connect_to_openwrt,
            on_connected=main._set_router_instance,
            is_connected=main._router_is_connected,
            cooldown_seconds=0.0,
            on_background_failure=main._probe_pairing_if_auth,
        ),
    )
    return fake


@pytest.fixture
def client(box: FakeRouterBox) -> TestClient:
    return TestClient(main.app)


@pytest.fixture
def auth_state(box: FakeRouterBox) -> None:
    """The router rejects our (old) credential: the AUTH state."""
    box.password = "rotated-by-reflash"
    with pytest.raises(LoginDenied):
        main._connect_to_openwrt()
    assert main._last_connect_failure == "auth"


# ---------------------------------------------------------------------------
# /health.pairing and the AUTH-state-only probe
# ---------------------------------------------------------------------------
class TestHealthPairing:
    def test_auth_state_probe_reports_open_window(self, client, box, auth_state):
        main._probe_pairing_if_auth()
        body = client.get("/health").json()
        assert body["connected"] is False
        assert body["error_code"] == "ROUTER_AUTH"
        assert body["pairing"] == {
            "state": "open",
            "window_ends_at": "2026-10-07T00:00:00+00:00",
            "paired_box": None,
            "paired_elsewhere": False,
            "pending_persist": False,
        }

    def test_health_serves_the_cache_and_never_probes(self, client, box, auth_state, monkeypatch):
        calls = []

        def _tracking_api():
            calls.append(1)
            return box.make_api()

        monkeypatch.setattr(main, "_pairing_api", _tracking_api)
        client.get("/health")
        client.get("/health")
        assert calls == []

    def test_no_probe_when_not_in_auth_state(self, box):
        main._last_connect_failure = "unreachable"
        main._probe_pairing_if_auth()
        assert main.pairing_state.snapshot(connected=False, auth_failed=False)["state"] == "unknown"

    def test_no_probe_when_connected(self, box, monkeypatch):
        called = []
        monkeypatch.setattr(main, "_pairing_api", lambda: called.append(1))
        monkeypatch.setattr(main, "_last_connect_failure", "auth")
        monkeypatch.setattr(main, "router_instance", MagicMock())
        main._probe_pairing_if_auth()
        assert called == []

    def test_connected_without_claim_is_unknown(self, monkeypatch, mock_router):
        monkeypatch.setattr(main, "router_instance", mock_router)
        body = TestClient(main.app).get("/health").json()
        assert body["pairing"]["state"] == "unknown"
        assert body["pairing"]["paired_elsewhere"] is False
        assert body["error_code"] is None

    def test_connected_after_claim_in_process_is_paired(self, monkeypatch, mock_router):
        monkeypatch.setattr(main, "router_instance", mock_router)
        main.pairing_state.record_claim("a" * 32, BOX_FP)
        pairing = TestClient(main.app).get("/health").json()["pairing"]
        assert pairing["state"] == "paired"
        assert pairing["paired_box"] == BOX_FP
        assert pairing["pending_persist"] is True

    def test_unsupported_plugin_is_unknown(self, client, box, auth_state):
        box.unsupported = True
        main._probe_pairing_if_auth()
        assert client.get("/health").json()["pairing"]["state"] == "unknown"

    def test_unreachable_probe_is_unknown_and_does_not_raise(self, client, box, auth_state):
        box.unreachable = True
        main._probe_pairing_if_auth()
        assert client.get("/health").json()["pairing"]["state"] == "unknown"

    def test_background_tick_probes_after_a_failed_reconnect(self, box, auth_state):
        class Sched:
            def __init__(self):
                self.jobs = {}

            def add_job(self, func, trigger, *, seconds=None, id, **kw):
                self.jobs[id] = func

            def reschedule_job(self, *a, **kw):
                pass

            def remove_job(self, *a, **kw):
                pass

        sched = Sched()
        main.reconnect_coordinator.start_background_retry(sched)
        (tick,) = sched.jobs.values()
        asyncio.run(tick())
        assert main.pairing_state.snapshot(connected=False, auth_failed=True)["state"] == "open"


# ---------------------------------------------------------------------------
# ROUTER_PAIRED_ELSEWHERE
# ---------------------------------------------------------------------------
class TestPairedElsewhere:
    def _foreign(self, box):
        box.status = PairStatus(state="paired", paired_box=OTHER_FP)

    def test_distinct_502_code_and_health(self, client, box, auth_state):
        self._foreign(box)
        main.pairing_state.set_box_fingerprint(BOX_FP)
        main._probe_pairing_if_auth()

        res = client.get("/network/summary", headers=AUTH_HEADERS)
        assert res.status_code == 502
        detail = res.json()["detail"]
        assert detail["code"] == "ROUTER_PAIRED_ELSEWHERE"
        assert detail["paired_box"] == OTHER_FP

        health = client.get("/health").json()
        assert health["error_code"] == "ROUTER_PAIRED_ELSEWHERE"
        assert health["pairing"]["paired_elsewhere"] is True
        assert health["pairing"]["paired_box"] == OTHER_FP
        assert health["pairing"]["state"] == "paired"

    def test_unknown_own_fingerprint_stays_plain_auth(self, client, box, auth_state):
        self._foreign(box)
        main._probe_pairing_if_auth()
        res = client.get("/network/summary", headers=AUTH_HEADERS)
        assert res.status_code == 502
        assert res.json()["detail"]["code"] == "ROUTER_AUTH"
        assert client.get("/health").json()["pairing"]["paired_elsewhere"] is False

    def test_paired_to_this_box_is_plain_auth(self, client, box, auth_state):
        box.status = PairStatus(state="paired", paired_box=BOX_FP)
        main.pairing_state.set_box_fingerprint(BOX_FP)
        main._probe_pairing_if_auth()
        res = client.get("/network/summary", headers=AUTH_HEADERS)
        assert res.json()["detail"]["code"] == "ROUTER_AUTH"

    def test_identity_endpoint_arms_the_state(self, client, box, auth_state):
        self._foreign(box)
        main._probe_pairing_if_auth()
        assert client.put(
            "/pairing/identity", json={"box_fingerprint": BOX_FP}, headers=AUTH_HEADERS
        ).json() == {"ok": True}
        res = client.get("/network/summary", headers=AUTH_HEADERS)
        assert res.json()["detail"]["code"] == "ROUTER_PAIRED_ELSEWHERE"

    def test_identity_rejects_malformed(self, client):
        res = client.put(
            "/pairing/identity", json={"box_fingerprint": "XYZ"}, headers=AUTH_HEADERS
        )
        assert res.status_code == 400
        assert res.json()["code"] == "INVALID_FINGERPRINT"

    def test_logged_once_per_distinct_foreign_fingerprint(self, caplog):
        state = PairingState()
        state.set_box_fingerprint(BOX_FP)
        with caplog.at_level("WARNING", logger="droplet.routing.pairing"):
            for _ in range(3):
                state.record_probe(PairStatus(state="paired", paired_box=OTHER_FP))
            state.record_probe(PairStatus(state="paired", paired_box="ef" * 32))
        records = [r for r in caplog.records if "ROUTER_PAIRED_ELSEWHERE" in r.getMessage()]
        assert len(records) == 2


# ---------------------------------------------------------------------------
# POST /pairing/claim
# ---------------------------------------------------------------------------
def _claim(client: TestClient, fp: str = BOX_FP):
    return client.post("/pairing/claim", json={"box_fingerprint": fp}, headers=AUTH_HEADERS)


class TestClaim:
    def test_requires_the_service_token(self, client):
        res = client.post("/pairing/claim", json={"box_fingerprint": BOX_FP})
        assert res.status_code == 401
        assert client.get("/pairing/pending").status_code == 401
        assert client.post("/pairing/persisted").status_code == 401

    def test_happy_path_goes_live_on_the_new_password(self, client, box, auth_state, caplog):
        with caplog.at_level("DEBUG"):
            res = _claim(client)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["ok"] is True
        assert body["host"] == main.OPENWRT_HOST
        assert body["model"] == "MikroTik RB5009"
        assert body["paired_at"]
        password = body["password"]
        assert len(password) == 32 and all(c in "0123456789abcdef" for c in password)

        # claim reached the router with exactly that password + fingerprint
        assert box.claims == [(password, BOX_FP)]
        # the proof login used the NEW password
        assert password in box.logins
        # AUTH state cleared and the live session is up
        assert main._last_connect_failure is None
        assert main.router_instance is not None
        # a later router call after session expiry re-logs-in with the new
        # password (holder), with no container recreate
        main.router_instance._session.token = None
        assert main.router_instance.system.board_info()["model"] == "MikroTik RB5009"
        assert main.router_instance._session.password == password
        # the secret file still holds the OLD value - the live password wins
        assert main.current_openwrt_password() == password
        # never logged
        assert all(password not in r.getMessage() for r in caplog.records)
        # /health: connected + paired + pending
        health = client.get("/health").json()
        assert health["connected"] is True
        assert health["pairing"]["state"] == "paired"
        assert health["pairing"]["pending_persist"] is True
        assert health["pairing"]["paired_box"] == BOX_FP

    def test_malformed_fingerprint_is_400(self, client, box):
        for bad in ("", "abc", "AB" * 32, "zz" * 32, None):
            res = client.post(
                "/pairing/claim", json={"box_fingerprint": bad}, headers=AUTH_HEADERS
            )
            assert res.status_code == 400, bad
            assert res.json()["code"] == "INVALID_FINGERPRINT"
        assert box.claims == []

    def test_window_closed(self, client, box):
        box.status = PairStatus(state="closed")
        res = _claim(client)
        assert res.status_code == 409
        assert res.json()["code"] == "PAIR_WINDOW_CLOSED"
        assert box.claims == []

    def test_paired_to_this_box_without_window_is_closed(self, client, box):
        box.status = PairStatus(state="paired", paired_box=BOX_FP)
        res = _claim(client)
        assert res.status_code == 409
        assert res.json()["code"] == "PAIR_WINDOW_CLOSED"

    def test_paired_elsewhere(self, client, box):
        box.status = PairStatus(state="paired", paired_box=OTHER_FP)
        res = _claim(client)
        assert res.status_code == 409
        body = res.json()
        assert body["code"] == "ROUTER_PAIRED_ELSEWHERE"
        assert body["paired_box"] == OTHER_FP
        assert box.claims == []

    def test_open_button_window_over_an_existing_pairing_is_claimable(self, client, box, auth_state):
        box.status = PairStatus(state="open", paired_box=OTHER_FP)
        assert _claim(client).status_code == 200

    def test_plugin_absent(self, client, box):
        box.unsupported = True
        res = _claim(client)
        assert res.status_code == 502
        assert res.json()["code"] == "PAIR_UNSUPPORTED"

    def test_claim_failed(self, client, box):
        box.claim_error = "window closed"
        res = _claim(client)
        assert res.status_code == 502
        assert res.json()["code"] == "PAIR_CLAIM_FAILED"
        assert main.pairing_state.pending()["pending"] is False

    def test_verify_failed_keeps_auth_state_and_logs_loudly(
        self, client, box, auth_state, caplog
    ):
        box.claim_applies_password = False  # claim "ok", router password unchanged
        with caplog.at_level("ERROR"):
            res = _claim(client)
        assert res.status_code == 502
        assert res.json()["code"] == "PAIR_VERIFY_FAILED"
        assert "password" not in res.json()
        assert any("PAIR_VERIFY_FAILED" in r.getMessage() for r in caplog.records)
        assert main._last_connect_failure == "auth"
        assert main.router_instance is None
        assert main.pairing_state.pending()["pending"] is False
        assert main.pairing_state.live_password() is None
        minted = box.claims[0][0]
        assert all(minted not in r.getMessage() for r in caplog.records)

    def test_router_unreachable(self, client, box):
        box.unreachable = True
        res = _claim(client)
        assert res.status_code == 503
        assert res.json()["code"] == "ROUTER_UNREACHABLE"

    def test_mock_mode_is_unsupported(self, client, monkeypatch):
        monkeypatch.setattr(main, "ROUTING_MODE", "mock")
        assert _claim(client).json()["code"] == "PAIR_UNSUPPORTED"


# ---------------------------------------------------------------------------
# pending / persisted lifecycle
# ---------------------------------------------------------------------------
class TestPendingLifecycle:
    def test_nothing_pending_initially(self, client):
        assert client.get("/pairing/pending", headers=AUTH_HEADERS).json() == {
            "pending": False,
            "password": None,
            "paired_at": None,
        }

    def test_pending_then_persisted(self, client, box, auth_state, tmp_path: Path):
        password = _claim(client).json()["password"]

        pending = client.get("/pairing/pending", headers=AUTH_HEADERS).json()
        assert pending["pending"] is True
        assert pending["password"] == password
        assert pending["paired_at"]
        # idempotent until confirmed (the Retry path can read it repeatedly)
        assert client.get("/pairing/pending", headers=AUTH_HEADERS).json() == pending

        # the orchestrator's bridge wrote the secret file ...
        Path(main.os.environ["OPENWRT_PASSWORD_FILE"]).write_text(password + "\n")
        res = client.post("/pairing/persisted", headers=AUTH_HEADERS)
        assert res.json() == {"ok": True}

        assert client.get("/pairing/pending", headers=AUTH_HEADERS).json() == {
            "pending": False,
            "password": None,
            "paired_at": None,
        }
        assert client.get("/health").json()["pairing"]["pending_persist"] is False
        # file is now authoritative and agrees - the router session still works
        assert main.current_openwrt_password() == password
        assert main.pairing_state.live_password() is None

    def test_persisted_before_file_updated_keeps_the_live_password(
        self, client, box, auth_state
    ):
        password = _claim(client).json()["password"]
        client.post("/pairing/persisted", headers=AUTH_HEADERS)
        # file still holds the old value: never regress to it
        assert main.current_openwrt_password() == password

    def test_persisted_with_nothing_pending_is_ok(self, client):
        assert client.post("/pairing/persisted", headers=AUTH_HEADERS).json() == {"ok": True}
