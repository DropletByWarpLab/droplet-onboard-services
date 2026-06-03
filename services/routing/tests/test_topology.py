"""Deployment-topology auto-detection (ADR-018 Decision 2).

The routing service must determine an EXPLICIT `DeploymentTopology` posture by
probing the WAN-facing interface for an upstream gateway, reusing the SAME
shape-detection mechanism the rest of the SDK uses
(`NetworkApi.get_all_interface_statuses()`) — never inventing a second presence
path and never inferring the posture from the absence of a field (rule 10;
mirrors `interface_stub(present=…)` / `ApDeviceStatus`).

Two real-world postures + one explicit "can't tell" state:

* **DOWNSTREAM_ROUTER** — the box is plugged into an existing upstream network;
  its WAN-facing interface has an upstream default-route gateway (it is a DHCP
  client of the home/ISP router). The upstream is NEVER mutated — detection is
  read-only probing only.
* **PRIMARY_ROUTER** — the box owns the WAN uplink: the WAN interface is present
  and up but there is no upstream gateway handed to it (it is the edge).
* **UNKNOWN** — the WAN-facing interface is not present on this deployment shape
  (the LAN-only single-box that motivated ADR-018). We refuse to GUESS a posture
  from that absence; the posture is an explicit, indexable enum member and the
  evidence carries `wan_present=False` so the caller knows *why* it is undetermined.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import (
    DeploymentTopology,
    NetworkApi,
    UbusError,
    detect_deployment_topology,
    interface_stub,
)
from mock_router import MockRouter


AUTH = {"authorization": "Bearer pytest-fake-token"}

UBUS_STATUS_PERMISSION_DENIED = 6


# WAN interface status as ubus reports it when an UPSTREAM router has handed us a
# DHCP lease + default gateway (the DOWNSTREAM posture). The `route` list carries
# a default route (target 0.0.0.0/0) with a `nexthop` pointing at the upstream.
_WAN_DOWNSTREAM = {
    "up": True,
    "present": True,
    "device": "eth1",
    "l3_device": "eth1",
    "proto": "dhcp",
    "ipv4-address": [{"address": "192.168.1.87", "mask": 24}],
    "route": [
        {"target": "0.0.0.0", "mask": 0, "nexthop": "192.168.1.254", "source": ""},
    ],
}

# WAN interface status when the box OWNS the uplink (PRIMARY posture): present +
# up, an address, but NO upstream default-route gateway pointing elsewhere.
_WAN_PRIMARY = {
    "up": True,
    "present": True,
    "device": "eth1",
    "l3_device": "eth1",
    "proto": "static",
    "ipv4-address": [{"address": "203.0.113.42", "mask": 24}],
    "route": [],
}

_LAN_STATUS = {"up": True, "present": True, "device": "br-lan", "proto": "static"}


class _FakeNetwork:
    """A NetworkApi-shaped stub returning a pinned interface-status map.

    Mirrors how `test_network_shape.py` drives the SDK without a real router and
    how `_make_ddns_store_client` pins which interfaces a shape exposes — so the
    detector reads the SAME `get_all_interface_statuses()` contract production does.
    """

    def __init__(self, statuses: dict[str, dict]):
        self._statuses = statuses
        self.calls = 0

    def get_all_interface_statuses(self) -> dict[str, dict]:
        self.calls += 1
        return self._statuses


class _FakeRouter:
    def __init__(self, statuses: dict[str, dict]):
        self.network = _FakeNetwork(statuses)


# ---------------------------------------------------------------------------
# Enum contract (AC 3: explicit enum, indexable, not inferred from null)
# ---------------------------------------------------------------------------


class TestDeploymentTopologyEnum:
    def test_members_are_explicit_and_indexable(self) -> None:
        # The two real postures the ADR names, plus the explicit undetermined
        # state. Indexable by name (string-keyed) — NOT a truthy/falsy or
        # None-derived signal.
        assert DeploymentTopology["PRIMARY_ROUTER"].value == "PRIMARY_ROUTER"
        assert DeploymentTopology["DOWNSTREAM_ROUTER"].value == "DOWNSTREAM_ROUTER"
        assert DeploymentTopology["UNKNOWN"].value == "UNKNOWN"

    def test_str_enum_serialises_to_its_name(self) -> None:
        # A str-enum so it round-trips cleanly through JSON on the endpoint.
        assert DeploymentTopology.DOWNSTREAM_ROUTER == "DOWNSTREAM_ROUTER"


# ---------------------------------------------------------------------------
# Detection logic (AC 1 + 2 + 5)
# ---------------------------------------------------------------------------


class TestDetectDeploymentTopology:
    def test_upstream_gateway_present_is_downstream(self) -> None:
        # AC 1: a box with an upstream gateway on the WAN-facing iface.
        router = _FakeRouter({"lan": dict(_LAN_STATUS), "wan": dict(_WAN_DOWNSTREAM)})
        result = detect_deployment_topology(router)

        assert result["posture"] == DeploymentTopology.DOWNSTREAM_ROUTER
        ev = result["evidence"]
        assert ev["wan_present"] is True
        assert ev["wan_up"] is True
        assert ev["upstream_gateway_present"] is True
        assert ev["upstream_gateway"] == "192.168.1.254"
        assert ev["wan_device"] == "eth1"

    def test_owns_wan_no_upstream_is_primary(self) -> None:
        # AC 2: a box that owns the WAN (no upstream default-route gateway).
        router = _FakeRouter({"lan": dict(_LAN_STATUS), "wan": dict(_WAN_PRIMARY)})
        result = detect_deployment_topology(router)

        assert result["posture"] == DeploymentTopology.PRIMARY_ROUTER
        ev = result["evidence"]
        assert ev["wan_present"] is True
        assert ev["wan_up"] is True
        assert ev["upstream_gateway_present"] is False
        assert ev["upstream_gateway"] is None

    def test_absent_wan_is_unknown_not_guessed(self) -> None:
        # AC 5 (no-WAN-iface edge) + AC 3 (never inferred from null): a LAN-only
        # single-box where `wan` is not present must NOT be guessed into either
        # posture — it is the explicit UNKNOWN member with evidence saying why.
        router = _FakeRouter(
            {"lan": dict(_LAN_STATUS), "wan": interface_stub(present=False)}
        )
        result = detect_deployment_topology(router)

        assert result["posture"] == DeploymentTopology.UNKNOWN
        ev = result["evidence"]
        assert ev["wan_present"] is False
        assert ev["upstream_gateway_present"] is False
        assert ev["upstream_gateway"] is None

    def test_missing_wan_key_entirely_is_unknown(self) -> None:
        # Defensive: if a shape's status map omits `wan` altogether (not even a
        # present:False stub), treat it as undetermined — still explicit, still
        # not a guessed posture.
        router = _FakeRouter({"lan": dict(_LAN_STATUS)})
        result = detect_deployment_topology(router)
        assert result["posture"] == DeploymentTopology.UNKNOWN
        assert result["evidence"]["wan_present"] is False

    def test_present_but_down_wan_without_gateway_is_not_downstream(self) -> None:
        # A WAN that is present but link-down and carries no upstream gateway
        # cannot be DOWNSTREAM (there is no upstream handing us a route). It is
        # not guessed as DOWNSTREAM purely from being configured.
        wan_down = dict(_WAN_PRIMARY)
        wan_down["up"] = False
        router = _FakeRouter({"lan": dict(_LAN_STATUS), "wan": wan_down})
        result = detect_deployment_topology(router)
        assert result["posture"] != DeploymentTopology.DOWNSTREAM_ROUTER
        assert result["evidence"]["upstream_gateway_present"] is False

    def test_reuses_get_all_interface_statuses_presence_path(self) -> None:
        # Guardrail: the detector must read presence from the SAME mechanism
        # `get_network_summary` / `_select_ddns_interface` use — not a second
        # presence probe. Asserting the call happened pins that contract.
        net = _FakeNetwork({"lan": dict(_LAN_STATUS), "wan": dict(_WAN_DOWNSTREAM)})
        router = type("R", (), {"network": net})()
        detect_deployment_topology(router)
        assert net.calls == 1


# ---------------------------------------------------------------------------
# Endpoint (AC 4: endpoint returns posture + evidence)
# ---------------------------------------------------------------------------


def _topology_client(
    monkeypatch: pytest.MonkeyPatch, statuses: dict[str, dict]
) -> TestClient:
    """TestClient backed by a MockRouter whose interface-status map is pinned to
    `statuses` — same monkeypatch seam `_make_ddns_store_client` uses to pin a
    shape's present interfaces."""
    router = MockRouter()
    monkeypatch.setattr(
        router.network, "get_all_interface_statuses", lambda: statuses
    )
    monkeypatch.setattr(main, "router_instance", router)
    return TestClient(main.app)


class TestTopologyEndpoint:
    def test_downstream_endpoint_returns_posture_and_evidence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = _topology_client(
            monkeypatch, {"lan": dict(_LAN_STATUS), "wan": dict(_WAN_DOWNSTREAM)}
        )
        resp = client.get("/network/topology", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["posture"] == "DOWNSTREAM_ROUTER"
        assert body["evidence"]["wan_present"] is True
        assert body["evidence"]["upstream_gateway_present"] is True
        assert body["evidence"]["upstream_gateway"] == "192.168.1.254"

    def test_primary_endpoint_returns_posture_and_evidence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = _topology_client(
            monkeypatch, {"lan": dict(_LAN_STATUS), "wan": dict(_WAN_PRIMARY)}
        )
        resp = client.get("/network/topology", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["posture"] == "PRIMARY_ROUTER"
        assert body["evidence"]["upstream_gateway_present"] is False

    def test_lan_only_box_endpoint_returns_unknown(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = _topology_client(
            monkeypatch, {"lan": dict(_LAN_STATUS), "wan": interface_stub(present=False)}
        )
        resp = client.get("/network/topology", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["posture"] == "UNKNOWN"
        assert body["evidence"]["wan_present"] is False

    def test_endpoint_503_when_router_disconnected(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "router_instance", None)
        resp = TestClient(main.app).get("/network/topology", headers=AUTH)
        assert resp.status_code == 503

    def test_endpoint_requires_bearer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client = _topology_client(
            monkeypatch, {"lan": dict(_LAN_STATUS), "wan": dict(_WAN_PRIMARY)}
        )
        resp = client.get("/network/topology")  # no Authorization header
        assert resp.status_code == 401

    def test_endpoint_propagates_real_ubus_fault(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A genuine ubus fault (e.g. PERMISSION_DENIED) while probing must NOT be
        # masked as a posture — it surfaces as an error the dashboard can show,
        # same discipline as get_camera_subnet / the interface-status path.
        router = MockRouter()

        def _boom() -> dict:
            raise UbusError(UBUS_STATUS_PERMISSION_DENIED, "Permission denied")

        monkeypatch.setattr(router.network, "get_all_interface_statuses", _boom)
        monkeypatch.setattr(main, "router_instance", router)
        resp = TestClient(main.app).get("/network/topology", headers=AUTH)
        assert resp.status_code >= 400
        assert resp.status_code != 200


class TestMockRouterTopologyContract:
    """The mock router (ROUTING_MODE=mock — dev laptops, demos, CI) must model a
    determinate posture, not read as UNKNOWN.

    The mock's interface fixtures must carry the canonical `present: True` flag
    the real SDK stamps on every live interface (`get_all_interface_statuses`),
    otherwise the detector — which reads presence from that exact flag — would
    treat the demo WAN as absent and report UNKNOWN on a box that clearly has an
    uplink. The mock models the single-box that motivated ADR-018, which sits
    DOWNSTREAM of a home router, so its demo WAN carries an upstream gateway.
    """

    def test_mock_reports_downstream_with_real_detector(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Use the UNPATCHED mock network so we exercise the real fixtures.
        router = MockRouter()
        monkeypatch.setattr(main, "router_instance", router)
        resp = TestClient(main.app).get("/network/topology", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["posture"] == "DOWNSTREAM_ROUTER"
        assert body["evidence"]["wan_present"] is True
        assert body["evidence"]["upstream_gateway_present"] is True
