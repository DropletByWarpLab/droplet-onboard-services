"""WARP-826 — `/health` must carry the deployment-topology posture so the
orchestrator can derive `routerConnected` HONESTLY and never read a LAN-only
single-box (WAN handled by the host, not the containerised OpenWrt) as OFFLINE.

Root cause (static analysis, ADR-018 + the 2026-05-31 single-box diagnosis):
the orchestrator hardcoded `routerConnected: true` on a successful summary and
fell to OFFLINE on any error. On the single-box the OpenWrt has no `wan` logical
interface, so anything that conflated "no WAN" with "router down" rendered the
router degraded/offline even though ubus was fully reachable.

The fix on THIS side: the routing service already reports `connected` from a live
`board_info()` probe (test_health.py) and already lands an explicit
`DeploymentTopology` posture (test_topology.py). This test pins the contract the
orchestrator depends on — that `/health` *also* exposes the posture — so the
orchestrator can say:

    routerConnected = health.connected            # real ubus reachability
    # and a posture of UNKNOWN (WAN absent) is NOT treated as "offline".

`connected` stays the single source of truth for reachability; `topology` is
informational evidence (explicit enum, never a guessed/None-derived flag — rule
10) so a WAN-less shape is distinguishable from an unreachable router.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import interface_stub
from mock_router import MockRouter


AUTH = {"authorization": "Bearer pytest-fake-token"}

_LAN_STATUS = {"up": True, "present": True, "device": "br-lan", "proto": "static"}
# A WAN that an upstream home/ISP router handed a DHCP lease + default route.
_WAN_DOWNSTREAM = {
    "up": True,
    "present": True,
    "device": "eth1",
    "l3_device": "eth1",
    "proto": "dhcp",
    "ipv4-address": [{"address": "192.168.1.87", "mask": 24}],
    "route": [{"target": "0.0.0.0", "mask": 0, "nexthop": "192.168.1.254", "source": ""}],
}


def _health_client(
    monkeypatch: pytest.MonkeyPatch, statuses: dict[str, dict]
) -> TestClient:
    """TestClient backed by a connected MockRouter whose interface-status map is
    pinned — the same seam test_topology.py uses to pin a shape's interfaces."""
    router = MockRouter()
    monkeypatch.setattr(router.network, "get_all_interface_statuses", lambda: statuses)
    monkeypatch.setattr(main, "router_instance", router)
    return TestClient(main.app)


class TestHealthCarriesTopology:
    def test_connected_health_includes_topology_posture(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A reachable router that sits DOWNSTREAM of a home router: connected AND
        # an explicit posture the orchestrator can show alongside "online".
        client = _health_client(
            monkeypatch, {"lan": dict(_LAN_STATUS), "wan": dict(_WAN_DOWNSTREAM)}
        )
        resp = client.get("/health", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["connected"] is True
        assert body["status"] == "ok"
        # The posture rides along so the orchestrator never has to re-probe to
        # learn the shape — and so it can branch the WAN expectation explicitly.
        assert body["topology"] == "DOWNSTREAM_ROUTER"

    def test_lan_only_single_box_is_connected_not_offline(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # THE regression this ticket fixes: a LAN-only single-box (no `wan`
        # logical interface — WAN handled by the host) is fully reachable. It must
        # report connected:true with an explicit UNKNOWN posture, NOT read as a
        # down/degraded router just because the WAN interface is absent.
        client = _health_client(
            monkeypatch,
            {"lan": dict(_LAN_STATUS), "wan": interface_stub(present=False)},
        )
        resp = client.get("/health", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["connected"] is True
        assert body["status"] == "ok"
        assert body["topology"] == "UNKNOWN"

    def test_topology_probe_failure_does_not_break_health(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Health is the reachability SLO (Docker healthcheck + orchestrator
        # routerConnected). A failure inside the best-effort topology probe must
        # NOT flip a reachable router to disconnected — board_info() succeeded, so
        # connected stays true; topology degrades to null/UNKNOWN, never an
        # exception that 500s /health.
        router = MockRouter()

        def _boom() -> dict:
            raise RuntimeError("topology probe blew up")

        monkeypatch.setattr(router.network, "get_all_interface_statuses", _boom)
        monkeypatch.setattr(main, "router_instance", router)
        resp = TestClient(main.app).get("/health", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Reachability is unaffected by a topology-probe hiccup.
        assert body["connected"] is True
        assert body["status"] == "ok"
        # Posture is unknown-but-explicit (or absent), never a thrown error.
        assert body.get("topology") in (None, "UNKNOWN")

    def test_disconnected_health_has_no_misleading_posture(
        self, disconnected_client
    ) -> None:
        # When the router is unreachable at startup, connected:false and there is
        # no router to probe — the posture must not falsely claim a real topology.
        resp = disconnected_client.get("/health", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["connected"] is False
        assert body.get("topology") in (None, "UNKNOWN")
