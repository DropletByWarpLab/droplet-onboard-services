"""Interface Add / Edit / Restart write path (KAN-10).

The Interfaces table was read-only (PR #669). KAN-10 adds the create/edit
interface + restart-network write path. Editing an interface is high blast
radius — a wrong proto/address/zone can cut the dashboard's own connectivity —
so every write rides the SAME blast-radius-safety patterns the VPN/wireless
writes use:

  * SDK create/edit stage uci changes inside the caller's ``safe_apply(timeout=60)``
    (auto-rollback on lost connectivity), mirroring ``FirewallApi.set_zone_policy``.
  * The routes return the ``rollback_pending`` 503 on ``ConnectionLost`` exactly
    like ``/aps/{mac}/approve`` and ``/network/subnets/cameras/setup``.
  * A write that targets the MANAGEMENT interface (the interface the dashboard
    is reached on — ``lan``/``mgmt`` on the shipped shapes) is REFUSED with 409
    unless the caller passes ``force: true`` (the explicit extra-confirm). This
    is the connectivity-self-cut guard.

These are unit/route-level proofs with a mocked connectivity probe. On-box
self-revert against live hardware (.87) remains a separate validation.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from droplet_openwrt_sdk import ConnectionLost, NetworkApi, UbusError

AUTH = {"authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# SDK: create_interface / edit_interface ride safe_apply
# ---------------------------------------------------------------------------
class TestNetworkApiInterfaceWrites:
    def test_create_interface_stages_uci_under_safe_apply(self) -> None:
        router = MagicMock()
        NetworkApi(router).create_interface(
            "iot", proto="static", device="br-lan.20",
            ipaddr="192.168.20.1", netmask="255.255.255.0",
        )
        # safe_apply context manager was entered with the 60s rollback timer.
        router.safe_apply.assert_called_once_with(timeout=60)
        cfg, section, values = router.uci.set.call_args.args
        assert cfg == "network" and section == "iot"
        assert values["proto"] == "static"
        assert values["device"] == "br-lan.20"
        assert values["ipaddr"] == "192.168.20.1"
        assert values["netmask"] == "255.255.255.0"
        router.uci.commit.assert_called_with("network")

    def test_create_interface_omits_unset_optional_fields(self) -> None:
        router = MagicMock()
        NetworkApi(router).create_interface("iot", proto="dhcp")
        _, _, values = router.uci.set.call_args.args
        assert values == {"proto": "dhcp"}

    def test_edit_interface_updates_only_supplied_fields_under_safe_apply(self) -> None:
        router = MagicMock()
        NetworkApi(router).edit_interface("iot", ipaddr="192.168.20.2")
        router.safe_apply.assert_called_once_with(timeout=60)
        cfg, section, values = router.uci.set.call_args.args
        assert cfg == "network" and section == "iot"
        assert values == {"ipaddr": "192.168.20.2"}
        router.uci.commit.assert_called_with("network")

    def test_edit_interface_rejects_empty_change(self) -> None:
        router = MagicMock()
        try:
            NetworkApi(router).edit_interface("iot")
            raised = False
        except ValueError:
            raised = True
        assert raised
        router.safe_apply.assert_not_called()


# ---------------------------------------------------------------------------
# Route: POST /network/interfaces (create)
# ---------------------------------------------------------------------------
class TestCreateInterfaceEndpoint:
    def test_create_dispatches_and_returns_operation_id(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        resp = connected_client.post(
            "/network/interfaces",
            json={
                "name": "iot", "proto": "static",
                "device": "br-lan.20", "ipaddr": "192.168.20.1",
                "netmask": "255.255.255.0",
            },
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["name"] == "iot"
        # X-Operation-Id is mirrored into the body (proxy-strip resilience).
        assert body["operation_id"]
        mock_router.network.create_interface.assert_called_once()

    def test_create_rejects_bad_name(self, connected_client: TestClient) -> None:
        resp = connected_client.post(
            "/network/interfaces",
            json={"name": "BR LAN!", "proto": "dhcp"},
            headers=AUTH,
        )
        assert resp.status_code == 422

    def test_create_rejects_bad_proto(self, connected_client: TestClient) -> None:
        resp = connected_client.post(
            "/network/interfaces",
            json={"name": "iot", "proto": "ppp-bogus"},
            headers=AUTH,
        )
        assert resp.status_code == 422

    def test_create_on_management_interface_is_refused(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        """Creating/overwriting the management interface (lan) without force is
        a connectivity-self-cut and must be blocked BEFORE any router write."""
        resp = connected_client.post(
            "/network/interfaces",
            json={"name": "lan", "proto": "static", "ipaddr": "192.168.1.1"},
            headers=AUTH,
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "MANAGEMENT_INTERFACE"
        mock_router.network.create_interface.assert_not_called()

    def test_create_on_management_interface_with_force_proceeds(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        resp = connected_client.post(
            "/network/interfaces",
            json={
                "name": "lan", "proto": "static",
                "ipaddr": "192.168.1.1", "force": True,
            },
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        mock_router.network.create_interface.assert_called_once()

    def test_create_rolls_back_on_lost_connectivity(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        """A create that severs the link → the safe_apply ConnectionLost path
        surfaces a 503 with rollback_pending, NOT a fake success."""
        mock_router.network.create_interface.side_effect = ConnectionLost(
            "link cut after apply"
        )
        resp = connected_client.post(
            "/network/interfaces",
            json={"name": "iot", "proto": "static", "ipaddr": "192.168.20.1"},
            headers=AUTH,
        )
        assert resp.status_code == 503, resp.text
        assert resp.json()["rollback_pending"] is True


# ---------------------------------------------------------------------------
# Route: PUT /network/interfaces/{name} (edit)
# ---------------------------------------------------------------------------
class TestEditInterfaceEndpoint:
    def test_edit_dispatches(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        resp = connected_client.put(
            "/network/interfaces/iot",
            json={"ipaddr": "192.168.20.2"},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "iot"
        mock_router.network.edit_interface.assert_called_once()

    def test_edit_rejects_empty_body(self, connected_client: TestClient) -> None:
        resp = connected_client.put(
            "/network/interfaces/iot", json={}, headers=AUTH,
        )
        assert resp.status_code == 422

    def test_edit_management_interface_is_refused(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        resp = connected_client.put(
            "/network/interfaces/lan",
            json={"ipaddr": "192.168.99.1"},
            headers=AUTH,
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "MANAGEMENT_INTERFACE"
        mock_router.network.edit_interface.assert_not_called()

    def test_edit_management_interface_with_force_proceeds(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        resp = connected_client.put(
            "/network/interfaces/lan",
            json={"ipaddr": "192.168.99.1", "force": True},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        mock_router.network.edit_interface.assert_called_once()

    def test_edit_rolls_back_on_lost_connectivity(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        mock_router.network.edit_interface.side_effect = ConnectionLost("cut")
        resp = connected_client.put(
            "/network/interfaces/iot",
            json={"ipaddr": "192.168.20.2"},
            headers=AUTH,
        )
        assert resp.status_code == 503, resp.text
        assert resp.json()["rollback_pending"] is True


# ---------------------------------------------------------------------------
# Route: POST /network/restart
# ---------------------------------------------------------------------------
class TestRestartNetworkEndpoint:
    def test_restart_dispatches(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        resp = connected_client.post("/network/restart", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["action"] == "network_restart"
        mock_router.network.restart.assert_called_once()

    def test_restart_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.post("/network/restart")
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class TestInterfaceWriteAuth:
    def test_create_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.post(
            "/network/interfaces", json={"name": "iot", "proto": "dhcp"}
        )
        assert resp.status_code == 401

    def test_edit_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.put(
            "/network/interfaces/iot", json={"ipaddr": "192.168.20.2"}
        )
        assert resp.status_code == 401
