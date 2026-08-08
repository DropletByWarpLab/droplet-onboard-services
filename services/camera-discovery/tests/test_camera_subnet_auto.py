"""WARP-1805 — CAMERA_SUBNET=auto resolves the camera network from the edge router.

A hardcoded CAMERA_SUBNET goes stale every time the fabric moves
(192.168.100.0/24 → 192.168.20.0/24 → the Pi edge router's LAN), and a stale
value silently filters out EVERY candidate — the scan loop runs healthy but
blind. These tests pin the auto contract:

  * ``auto`` resolves the network from the routing service's
    ``/network/interfaces`` (lan → first ipv4-address), and the candidate
    filter + subnet sweep follow the resolved network.
  * While unresolved (routing service down), the filter falls back to
    all-private (RFC 1918) and the brute subnet sweep stays OFF — discovery
    degrades, never widens.
  * After a successful resolve, a refresh failure keeps the last known
    network; within the TTL the router isn't re-asked at all.
  * A non-private answer from the router is refused (a poisoned response
    must not widen probing beyond RFC 1918).
  * An explicit CIDR keeps the historical static behavior and never dials
    the routing service.
"""

from __future__ import annotations

import importlib
import ipaddress

import pytest


def _fresh_main(monkeypatch, camera_subnet: str):
    monkeypatch.setenv("CAMERA_SUBNET", camera_subnet)
    import main

    return importlib.reload(main)


class _RoutingStub:
    """Stands in for main.routing_client — records calls, serves one payload."""

    def __init__(self, payload=None, exc: Exception | None = None):
        self.payload = payload
        self.exc = exc
        self.calls = 0

    async def get(self, path: str):
        self.calls += 1
        assert path == "/network/interfaces"
        if self.exc is not None:
            raise self.exc

        payload = self.payload

        class _Resp:
            def raise_for_status(self):
                return None

            def json(self):
                return payload

        return _Resp()


def _lan_payload(address: str = "192.168.9.1", mask: int = 24):
    return {
        "lan": {
            "present": True,
            "up": True,
            "ipv4-address": [{"address": address, "mask": mask}],
        },
        "wan": {"present": False},
    }


@pytest.mark.asyncio
async def test_auto_resolves_lan_network_and_filters_by_it(monkeypatch):
    main = _fresh_main(monkeypatch, "auto")
    stub = _RoutingStub(_lan_payload())
    monkeypatch.setattr(main, "routing_client", stub)

    await main.resolve_camera_network_auto()

    assert main._camera_network == ipaddress.ip_network("192.168.9.0/24")
    assert main.is_camera_subnet_ip("192.168.9.219") is True
    assert main.is_camera_subnet_ip("192.168.20.5") is False


@pytest.mark.asyncio
async def test_auto_unresolved_falls_back_to_all_private(monkeypatch):
    main = _fresh_main(monkeypatch, "auto")
    stub = _RoutingStub(exc=RuntimeError("routing service down"))
    monkeypatch.setattr(main, "routing_client", stub)

    await main.resolve_camera_network_auto()

    assert main._camera_network is None
    # RFC 1918 candidates still pass (lease/WS-Discovery adoption survives)…
    assert main.is_camera_subnet_ip("10.1.2.3") is True
    assert main.is_camera_subnet_ip("192.168.9.219") is True
    # …but is_safe_ip still rejects public space upstream of this filter.
    assert main.is_safe_ip("8.8.8.8") is False


@pytest.mark.asyncio
async def test_auto_unresolved_skips_subnet_sweep(monkeypatch):
    main = _fresh_main(monkeypatch, "auto")
    monkeypatch.setattr(
        main, "routing_client", _RoutingStub(exc=RuntimeError("down"))
    )

    sweeps: list = []

    async def _record_sweep(network):
        sweeps.append(network)
        return []

    async def _no_leases():
        return []

    async def _no_onvif():
        return []

    monkeypatch.setattr(main, "_subnet_sweep", _record_sweep)
    monkeypatch.setattr(main, "fetch_dhcp_leases", _no_leases)
    monkeypatch.setattr(main, "discover_cameras", _no_onvif)

    await main.scan_and_discover()

    assert sweeps == [], "unresolved auto must not brute-sweep any network"


@pytest.mark.asyncio
async def test_auto_resolved_sweeps_the_resolved_network(monkeypatch):
    main = _fresh_main(monkeypatch, "auto")
    monkeypatch.setattr(main, "routing_client", _RoutingStub(_lan_payload()))

    sweeps: list = []

    async def _record_sweep(network):
        sweeps.append(network)
        return []

    async def _no_leases():
        return []

    async def _no_onvif():
        return []

    monkeypatch.setattr(main, "_subnet_sweep", _record_sweep)
    monkeypatch.setattr(main, "fetch_dhcp_leases", _no_leases)
    monkeypatch.setattr(main, "discover_cameras", _no_onvif)

    await main.scan_and_discover()

    assert sweeps == [ipaddress.ip_network("192.168.9.0/24")]


@pytest.mark.asyncio
async def test_auto_ttl_skips_refresh_and_failure_keeps_last(monkeypatch):
    main = _fresh_main(monkeypatch, "auto")
    stub = _RoutingStub(_lan_payload())
    monkeypatch.setattr(main, "routing_client", stub)

    await main.resolve_camera_network_auto()
    assert stub.calls == 1

    # Within the TTL the router is not re-asked.
    await main.resolve_camera_network_auto()
    assert stub.calls == 1

    # Past the TTL a refresh failure keeps the last resolved network.
    main._auto_subnet_resolved_at = 0.0
    stub.exc = RuntimeError("blip")
    await main.resolve_camera_network_auto()
    assert stub.calls == 2
    assert main._camera_network == ipaddress.ip_network("192.168.9.0/24")


@pytest.mark.asyncio
async def test_auto_refuses_non_private_router_answer(monkeypatch):
    main = _fresh_main(monkeypatch, "auto")
    monkeypatch.setattr(
        main, "routing_client", _RoutingStub(_lan_payload(address="8.8.8.1"))
    )

    await main.resolve_camera_network_auto()

    assert main._camera_network is None


@pytest.mark.asyncio
async def test_explicit_cidr_stays_static_and_never_dials_routing(monkeypatch):
    main = _fresh_main(monkeypatch, "192.168.100.0/24")
    stub = _RoutingStub(_lan_payload())
    monkeypatch.setattr(main, "routing_client", stub)

    await main.resolve_camera_network_auto()

    assert stub.calls == 0
    assert main.CAMERA_SUBNET_AUTO is False
    assert main._camera_network == ipaddress.ip_network("192.168.100.0/24")
    assert main.is_camera_subnet_ip("192.168.100.7") is True
    assert main.is_camera_subnet_ip("192.168.9.219") is False


def test_subnet_status_reports_auto_mode(monkeypatch):
    fastapi_testclient = pytest.importorskip(
        "fastapi.testclient",
        reason="fastapi/pydantic unavailable — run under the project's "
        "supported Python / CI",
    )
    main = _fresh_main(monkeypatch, "auto")
    client = fastapi_testclient.TestClient(main.app)

    resp = client.get(
        "/subnet/status",
        headers={"Authorization": "Bearer pytest-fake-secret"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "auto"
    assert body["camera_subnet"] == "auto"
    # Unresolved at boot: no network yet, isolation not active.
    assert body["network"] is None
    assert body["isolation_active"] is False


def test_subnet_status_reports_static_mode(monkeypatch):
    fastapi_testclient = pytest.importorskip(
        "fastapi.testclient",
        reason="fastapi/pydantic unavailable — run under the project's "
        "supported Python / CI",
    )
    main = _fresh_main(monkeypatch, "192.168.100.0/24")
    client = fastapi_testclient.TestClient(main.app)

    resp = client.get(
        "/subnet/status",
        headers={"Authorization": "Bearer pytest-fake-secret"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "static"
    assert body["network"] == "192.168.100.0/24"
    assert body["isolation_active"] is True
