"""ADR-071 slice C (WARP-3739) - AP half of box <-> device pairing (routing).

The AP's `droplet.pair` window is claimed through the AP onboarding path:

  * `GET  /aps/{mac}/pairing`         the AP's null-session `status`
  * `POST /aps/{mac}/pairing/claim`   mint, claim THAT AP, prove login, go live
  * `GET  /aps/pairing/pending` / `POST /aps/pairing/persisted`   the lifecycle
  * `current_ap_password()`           the reloadable holder behind every AP login

The AP's address comes from the same mDNS inventory `/aps/{mac}/approve` uses.
ADR-071 section 2.3 keeps ONE `ap_openwrt_password` for all APs - the tests pin
that behaviour (a second claim replaces the first AP's credential) so it cannot
drift silently.

All against the MagicMock router from conftest and a fake AP - no sockets.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import ConnectionLost, UbusError
from pairing import (
    PairingClaimError,
    PairingState,
    PairingUnsupported,
    PairStatus,
)

AUTH = {"Authorization": "Bearer pytest-fake-token"}
MAC = "AA:BB:CC:DD:EE:01"
MAC2 = "AA:BB:CC:DD:EE:02"
AP_IP = "192.168.9.42"
AP_IP2 = "192.168.9.43"
BOX_FP = "ab" * 32
OTHER_FP = "cd" * 32
OLD_PW = "old-ap-password"
APPROVE_BODY = {"ssid": "Droplet", "encryption_key": "longenoughpw"}


class FakeApBox:
    """One AP: its `droplet.pair` window and its droplet-ai login."""

    def __init__(self, host: str = AP_IP) -> None:
        self.host = host
        self.password = OLD_PW
        self.status = PairStatus(state="open", window_ends_at="2026-10-07T00:00:00+00:00")
        self.unsupported = False
        self.unreachable = False
        self.claim_error: Optional[str] = None
        self.claim_applies_password = True
        self.claims: list[tuple[str, str]] = []
        self.status_calls = 0


class FakeApFleet:
    """All the fake APs, keyed by host, plus the doubles main.py is wired to."""

    def __init__(self) -> None:
        self.by_host: dict[str, FakeApBox] = {AP_IP: FakeApBox(AP_IP), AP_IP2: FakeApBox(AP_IP2)}
        self.api_hosts: list[str] = []
        self.logins: list[tuple[str, str, str]] = []  # (host, username, password)
        self.devices: list["_Device"] = []

    def make_api(self, host: str):
        fleet = self
        fleet.api_hosts.append(host)

        class _Api:
            def status(self_inner):  # noqa: N805
                box = fleet.by_host[host]
                box.status_calls += 1
                if box.unreachable:
                    raise ConnectionLost("AP down")
                if box.unsupported:
                    raise PairingUnsupported("no plugin")
                return box.status

            def claim(self_inner, password, fingerprint):  # noqa: N805
                box = fleet.by_host[host]
                if box.unsupported:
                    raise PairingUnsupported("no plugin")
                if box.claim_error:
                    raise PairingClaimError(box.claim_error)
                box.claims.append((password, fingerprint))
                if box.claim_applies_password:
                    box.password = password
                    box.status = PairStatus(state="paired", paired_box=fingerprint)

        return _Api()

    def make_device(self, host, port=80, username="droplet-ai", password="",
                    auto_login=True, **_kw):
        pw = password() if callable(password) else password
        self.logins.append((host, username, pw))
        box = self.by_host.get(host)
        if box is None or box.unreachable:
            raise ConnectionLost("AP down")
        if pw != box.password:
            raise UbusError(6)
        dev = _Device(host, port, username, pw)
        self.devices.append(dev)
        return dev


class _Device:
    """What `main.DropletRouter(...)` returns for an AP that accepted the login."""

    def __init__(self, host, port, username, password):
        self.ctor = {"host": host, "port": port, "username": username, "password": password}
        self.system = MagicMock()
        self.system.board_info.return_value = {"model": "Zyxel NWA50BE", "hostname": "droplet-ap"}
        self.uci = MagicMock()
        self.uci.get.return_value = {"values": {"default_radio0": {".type": "wifi-iface"}}}
        self.disconnected = False

    def disconnect(self):
        self.disconnected = True

    def safe_apply(self, timeout=60):
        from contextlib import nullcontext

        return nullcontext()


@pytest.fixture
def fleet(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mock_router: MagicMock) -> FakeApFleet:
    f = FakeApFleet()
    secret = tmp_path / "ap_openwrt_password"
    secret.write_text(OLD_PW + "\n")
    monkeypatch.setenv("AP_OPENWRT_PASSWORD_FILE", str(secret))
    monkeypatch.setattr(main, "AP_PASSWORD", "")
    monkeypatch.setattr(main, "ROUTING_MODE", "real")
    monkeypatch.setattr(main, "ap_pairing_state", PairingState(role="ap"))
    monkeypatch.setattr(main, "_ap_pending_mac", None)
    mock_router.ap.get.side_effect = lambda m: {
        MAC: {"mac": MAC, "last_ip": AP_IP},
        MAC2: {"mac": MAC2, "last_ip": AP_IP2},
    }.get(m)
    mock_router.ap.browse_discovered.return_value = [
        {"mac": MAC, "last_ip": AP_IP},
        {"mac": MAC2, "last_ip": AP_IP2},
    ]
    mock_router.wireless.status.return_value = {}
    monkeypatch.setattr(main, "router_instance", mock_router)
    monkeypatch.setattr(main, "_ap_pairing_api", f.make_api)
    monkeypatch.setattr(main, "DropletRouter", f.make_device)
    return f


@pytest.fixture
def client(fleet: FakeApFleet) -> TestClient:
    return TestClient(main.app)


def _claim(client: TestClient, mac: str = MAC, fp: Optional[str] = BOX_FP):
    return client.post(f"/aps/{mac}/pairing/claim", json={"box_fingerprint": fp}, headers=AUTH)


# ---------------------------------------------------------------------------
# AP password holder
# ---------------------------------------------------------------------------
class TestApPasswordHolder:
    def test_prefers_the_password_claimed_in_process(self, fleet):
        main.ap_pairing_state.record_claim("f" * 32, BOX_FP)
        assert main.current_ap_password() == "f" * 32

    def test_rereads_the_secret_file_every_call(self, fleet):
        assert main.current_ap_password() == OLD_PW
        Path(main.os.environ["AP_OPENWRT_PASSWORD_FILE"]).write_text("rotated\n")
        assert main.current_ap_password() == "rotated"

    def test_falls_back_to_the_import_time_value(self, fleet, monkeypatch, tmp_path):
        monkeypatch.setenv("AP_OPENWRT_PASSWORD_FILE", str(tmp_path / "absent"))
        monkeypatch.setattr(main, "AP_PASSWORD", "from-env")
        assert main.current_ap_password() == "from-env"

    def test_nothing_configured_is_empty(self, fleet, monkeypatch, tmp_path):
        monkeypatch.setenv("AP_OPENWRT_PASSWORD_FILE", str(tmp_path / "absent"))
        assert main.current_ap_password() == ""

    def test_an_ap_claim_never_touches_the_router_holder(self, fleet, monkeypatch, tmp_path):
        monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(tmp_path / "absent"))
        monkeypatch.setattr(main, "OPENWRT_PASSWORD", "router-pw")
        main.ap_pairing_state.record_claim("a" * 32, BOX_FP)
        assert main.current_openwrt_password() == "router-pw"
        assert main.pairing_state.live_password() is None

    def test_connect_ap_uses_the_holder_value(self, fleet):
        main.ap_pairing_state.record_claim("b" * 32, BOX_FP)
        with pytest.raises(UbusError):  # fake AP still has OLD_PW
            main._connect_ap(AP_IP)
        assert fleet.logins[-1] == (AP_IP, "droplet-ai", "b" * 32)


# ---------------------------------------------------------------------------
# GET /aps/{mac}/pairing
# ---------------------------------------------------------------------------
class TestApPairingStatus:
    def test_open_window_is_reported_from_the_aps_own_host(self, client, fleet):
        res = client.get(f"/aps/{MAC}/pairing", headers=AUTH)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["mac"] == MAC and body["host"] == AP_IP
        assert body["error_code"] is None
        assert body["connected"] is None  # not probed for an AP
        assert body["pairing"] == {
            "state": "open",
            "window_ends_at": "2026-10-07T00:00:00+00:00",
            "paired_box": None,
            "paired_elsewhere": False,
            "pending_persist": False,
        }
        assert fleet.api_hosts == [AP_IP]  # not the other AP's host

    def test_is_per_ap(self, client, fleet):
        fleet.by_host[AP_IP2].status = PairStatus(state="closed")
        assert client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()["pairing"]["state"] == "open"
        assert client.get(f"/aps/{MAC2}/pairing", headers=AUTH).json()["pairing"]["state"] == "closed"

    def test_lowercase_mac_is_canonicalised(self, client):
        assert client.get(f"/aps/{MAC.lower()}/pairing", headers=AUTH).json()["mac"] == MAC

    def test_paired_elsewhere_needs_our_fingerprint_and_is_never_guessed(self, client, fleet):
        fleet.by_host[AP_IP].status = PairStatus(state="paired", paired_box=OTHER_FP)
        body = client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()
        assert body["pairing"]["paired_elsewhere"] is False and body["error_code"] is None
        main.ap_pairing_state.set_box_fingerprint(BOX_FP)
        body = client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()
        assert body["pairing"]["paired_elsewhere"] is True
        assert body["pairing"]["paired_box"] == OTHER_FP
        assert body["error_code"] == "AP_PAIRED_ELSEWHERE"

    def test_the_routers_identity_publish_also_teaches_the_ap_flow(self, client, fleet):
        fleet.by_host[AP_IP].status = PairStatus(state="paired", paired_box=OTHER_FP)
        assert client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()["error_code"] is None
        res = client.put("/pairing/identity", json={"box_fingerprint": BOX_FP}, headers=AUTH)
        assert res.status_code == 200
        body = client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()
        assert body["error_code"] == "AP_PAIRED_ELSEWHERE"
        assert body["pairing"]["paired_elsewhere"] is True

    def test_paired_to_this_box_is_not_elsewhere(self, client, fleet):
        main.ap_pairing_state.set_box_fingerprint(BOX_FP)
        fleet.by_host[AP_IP].status = PairStatus(state="paired", paired_box=BOX_FP)
        body = client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()
        assert body["pairing"]["state"] == "paired"
        assert body["pairing"]["paired_elsewhere"] is False and body["error_code"] is None

    def test_plugin_absent_is_unknown_not_an_error(self, client, fleet):
        fleet.by_host[AP_IP].unsupported = True
        body = client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()
        assert body["pairing"]["state"] == "unknown" and body["error_code"] is None

    def test_unreachable_ap_is_unknown_with_a_typed_code(self, client, fleet):
        fleet.by_host[AP_IP].unreachable = True
        body = client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()
        assert body["pairing"]["state"] == "unknown"
        assert body["error_code"] == "AP_UNREACHABLE"

    def test_ap_not_in_the_inventory_is_unreachable_without_a_host(self, client, fleet, mock_router):
        mock_router.ap.get.side_effect = lambda m: {"mac": m}  # discovered, address aged out
        mock_router.ap.browse_discovered.return_value = []
        body = client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()
        assert body["host"] is None and body["error_code"] == "AP_UNREACHABLE"
        assert fleet.api_hosts == []

    def test_pending_persist_belongs_to_the_ap_that_was_claimed(self, client, fleet):
        assert _claim(client, MAC).status_code == 200
        fleet.by_host[AP_IP].status = PairStatus(state="paired", paired_box=BOX_FP)
        assert client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()["pairing"]["pending_persist"] is True
        assert client.get(f"/aps/{MAC2}/pairing", headers=AUTH).json()["pairing"]["pending_persist"] is False

    def test_mock_mode_makes_no_device_call(self, client, fleet, monkeypatch):
        monkeypatch.setattr(main, "ROUTING_MODE", "mock")
        body = client.get(f"/aps/{MAC}/pairing", headers=AUTH).json()
        assert body["pairing"]["state"] == "unknown"
        assert fleet.api_hosts == []

    def test_invalid_mac_is_404(self, client):
        assert client.get("/aps/not-a-mac/pairing", headers=AUTH).status_code == 404

    def test_router_in_the_auth_state_surfaces_its_typed_error(self, client, monkeypatch):
        monkeypatch.setattr(main, "router_instance", None)
        monkeypatch.setattr(main, "_last_connect_failure", "auth")
        monkeypatch.setattr(
            main, "reconnect_coordinator", MagicMock(maybe_reconnect_on_demand=lambda: False)
        )
        res = client.get(f"/aps/{MAC}/pairing", headers=AUTH)
        assert res.status_code == 502 and res.json()["detail"]["code"] == "ROUTER_AUTH"

    def test_requires_the_service_token(self, client):
        assert client.get(f"/aps/{MAC}/pairing").status_code == 401


# ---------------------------------------------------------------------------
# POST /aps/{mac}/pairing/claim
# ---------------------------------------------------------------------------
class TestApClaim:
    def test_requires_the_service_token(self, client, fleet):
        res = client.post(f"/aps/{MAC}/pairing/claim", json={"box_fingerprint": BOX_FP})
        assert res.status_code == 401
        assert client.get("/aps/pairing/pending").status_code == 401
        assert client.post("/aps/pairing/persisted").status_code == 401

    def test_happy_path_claims_that_ap_and_proves_the_login(self, client, fleet, caplog):
        with caplog.at_level("DEBUG"):
            res = _claim(client)
        assert res.status_code == 200, res.text
        assert res.headers["cache-control"] == "no-store"
        body = res.json()
        password = body["password"]
        assert len(password) == 32 and all(c in "0123456789abcdef" for c in password)
        assert body["ok"] is True
        assert body["host"] == AP_IP  # resolved from the mDNS inventory
        assert body["mac"] == MAC
        assert body["model"] == "Zyxel NWA50BE"
        assert body["paired_at"]

        # claim reached THAT AP only, with exactly that password + fingerprint
        assert fleet.by_host[AP_IP].claims == [(password, BOX_FP)]
        assert fleet.by_host[AP_IP2].claims == []
        assert fleet.api_hosts == [AP_IP]
        # proof login: a fresh connection to that AP with the NEW password
        assert (AP_IP, "droplet-ai", password) in fleet.logins
        assert fleet.devices[0].disconnected is True
        # live: the holder, and every AP-direct call after it, use the new one
        assert main.current_ap_password() == password
        assert main.ap_pairing_state.pending()["pending"] is True
        # never logged
        assert all(password not in r.getMessage() for r in caplog.records)

    def test_resolves_the_address_the_same_way_approve_does(self, client, fleet, mock_router):
        mock_router.ap.get.side_effect = lambda m: {"mac": m}  # no cached address
        mock_router.ap.browse_discovered.return_value = [{"mac": MAC.lower(), "last_ip": AP_IP}]
        assert _claim(client).json()["host"] == AP_IP

    def test_after_pairing_approve_pushes_with_the_new_credential(self, client, fleet):
        """The AP-direct approval path was gated on AP_PASSWORD at import; the
        holder makes a freshly paired AP approvable with no restart."""
        # a fresh box: setup.sh wrote the EMPTY placeholder (no AP credential yet)
        Path(main.os.environ["AP_OPENWRT_PASSWORD_FILE"]).write_text("")
        res = client.post(f"/aps/{MAC}/approve", json=APPROVE_BODY, headers=AUTH)
        assert res.status_code == 200 and res.json()["ap_configured"] is False
        password = _claim(client).json()["password"]
        res = client.post(f"/aps/{MAC}/approve", json=APPROVE_BODY, headers=AUTH)
        assert res.status_code == 200, res.text
        assert res.json()["ap_configured"] is True
        assert fleet.logins[-1] == (AP_IP, "droplet-ai", password)

    def test_a_second_ap_claim_replaces_the_shared_credential(self, client, fleet):
        """ADR-071 section 2.3: ONE ap_openwrt_password for all APs."""
        first = _claim(client, MAC).json()["password"]
        second = _claim(client, MAC2).json()["password"]
        assert first != second
        assert main.current_ap_password() == second
        assert main.ap_pairing_state.pending()["pending"] is True
        assert main._ap_pending_mac == MAC2
        # the first AP still holds its own password: an AP-direct call to it now fails
        with pytest.raises(UbusError):
            main._connect_ap(AP_IP)

    @pytest.mark.parametrize("fp", [None, "", "short", "AB" * 32, "zz" * 32])
    def test_invalid_fingerprint_is_400_and_never_reaches_the_ap(self, client, fleet, fp):
        res = _claim(client, fp=fp)
        assert res.status_code == 400 and res.json()["code"] == "INVALID_FINGERPRINT"
        assert fleet.api_hosts == []

    def test_mock_mode_is_unsupported(self, client, fleet, monkeypatch):
        monkeypatch.setattr(main, "ROUTING_MODE", "mock")
        res = _claim(client)
        assert res.status_code == 502 and res.json()["code"] == "PAIR_UNSUPPORTED"

    def test_ap_not_visible_is_ap_unreachable(self, client, fleet, mock_router):
        mock_router.ap.get.side_effect = lambda m: {"mac": m}
        mock_router.ap.browse_discovered.return_value = []
        res = _claim(client)
        assert res.status_code == 502 and res.json()["code"] == "AP_UNREACHABLE"
        assert fleet.api_hosts == []

    def test_unreachable_ap(self, client, fleet):
        fleet.by_host[AP_IP].unreachable = True
        res = _claim(client)
        assert res.status_code == 503 and res.json()["code"] == "AP_UNREACHABLE"

    def test_window_closed(self, client, fleet):
        fleet.by_host[AP_IP].status = PairStatus(state="closed")
        res = _claim(client)
        assert res.status_code == 409 and res.json()["code"] == "PAIR_WINDOW_CLOSED"
        assert fleet.by_host[AP_IP].claims == []

    def test_already_paired_to_this_box_is_window_closed(self, client, fleet):
        fleet.by_host[AP_IP].status = PairStatus(state="paired", paired_box=BOX_FP)
        res = _claim(client)
        assert res.status_code == 409 and res.json()["code"] == "PAIR_WINDOW_CLOSED"

    def test_paired_elsewhere_names_the_foreign_fingerprint(self, client, fleet):
        fleet.by_host[AP_IP].status = PairStatus(state="paired", paired_box=OTHER_FP)
        res = _claim(client)
        assert res.status_code == 409
        assert res.json()["code"] == "AP_PAIRED_ELSEWHERE"
        assert res.json()["paired_box"] == OTHER_FP
        assert fleet.by_host[AP_IP].claims == []

    def test_plugin_absent_is_unsupported(self, client, fleet):
        fleet.by_host[AP_IP].unsupported = True
        res = _claim(client)
        assert res.status_code == 502 and res.json()["code"] == "PAIR_UNSUPPORTED"

    def test_unknown_state_is_unsupported(self, client, fleet):
        fleet.by_host[AP_IP].status = PairStatus(state="unknown")
        res = _claim(client)
        assert res.status_code == 502 and res.json()["code"] == "PAIR_UNSUPPORTED"

    def test_claim_refused_by_the_ap(self, client, fleet):
        fleet.by_host[AP_IP].claim_error = "window expired"
        res = _claim(client)
        assert res.status_code == 502 and res.json()["code"] == "PAIR_CLAIM_FAILED"
        assert main.ap_pairing_state.pending()["pending"] is False

    def test_verify_failure_changes_nothing_on_the_box(self, client, fleet):
        fleet.by_host[AP_IP].claim_applies_password = False  # ok answer, new password does not log in
        res = _claim(client)
        assert res.status_code == 502 and res.json()["code"] == "PAIR_VERIFY_FAILED"
        assert main.ap_pairing_state.live_password() is None
        assert main.current_ap_password() == OLD_PW
        assert main._ap_pending_mac is None

    def test_does_not_touch_the_router_pairing_state(self, client, fleet):
        _claim(client)
        assert main.pairing_state.live_password() is None
        assert main.pairing_state.pending()["pending"] is False


# ---------------------------------------------------------------------------
# pending / persisted
# ---------------------------------------------------------------------------
class TestApPendingLifecycle:
    def test_pending_then_persisted(self, client, fleet):
        none = client.get("/aps/pairing/pending", headers=AUTH)
        assert none.json() == {"pending": False, "password": None, "paired_at": None, "mac": None}
        password = _claim(client).json()["password"]
        pending = client.get("/aps/pairing/pending", headers=AUTH)
        assert pending.headers["cache-control"] == "no-store"
        body = pending.json()
        assert body["pending"] is True and body["password"] == password and body["mac"] == MAC
        # the orchestrator wrote the secret file, then confirms
        Path(main.os.environ["AP_OPENWRT_PASSWORD_FILE"]).write_text(password)
        assert client.post("/aps/pairing/persisted", headers=AUTH).json() == {"ok": True}
        after = client.get("/aps/pairing/pending", headers=AUTH).json()
        assert after["pending"] is False and after["mac"] is None
        assert main.ap_pairing_state.live_password() is None
        assert main.current_ap_password() == password  # from the file now

    def test_persisted_without_a_matching_file_keeps_the_live_password(self, client, fleet):
        password = _claim(client).json()["password"]
        client.post("/aps/pairing/persisted", headers=AUTH)
        assert main.current_ap_password() == password  # never regresses to the stale file

    def test_pairing_routes_do_not_shadow_the_mac_routes(self, client, fleet):
        # `/aps/pairing/pending` must not be captured by `/aps/{mac}/...`
        assert client.get("/aps/pairing/pending", headers=AUTH).status_code == 200
        assert client.get(f"/aps/{MAC}", headers=AUTH).status_code == 200
