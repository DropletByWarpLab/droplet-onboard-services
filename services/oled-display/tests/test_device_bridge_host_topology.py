"""Unit tests for the device-bridge host uplink topology probe (WARP-817).

The routing service's GET /network/topology (ADR-018) determines the
deployment posture by probing the CONTAINERISED OpenWrt's "wan" ubus
interface. On single-box that interface is never configured — WAN is
HOST-owned — so the routing-service probe always reports UNKNOWN, and the
onboarding wizard can never tell "downstream of an existing home router" (the
common case) apart from "this box IS the primary router".

This bridge — which runs in the host's network namespace — answers the SAME
question via the host's own default route (`ip route get`), exposing a
READ-ONLY GET /host/topology that mirrors
`droplet_openwrt_sdk.detect_deployment_topology()`'s posture semantics:

  * a default route with an upstream `via <gw>` next-hop -> DOWNSTREAM_ROUTER
  * a default route with NO next-hop                      -> PRIMARY_ROUTER
  * no default route resolvable at all                    -> UNKNOWN

We monkeypatch at the `_run` boundary so `ip` never actually runs.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_host_topology_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# `ip -j route get 1.1.1.1` — downstream shape: an upstream router (an
# existing home router) hands us a gateway.
_IP_J_DOWNSTREAM = json.dumps([{
    "dst": "1.1.1.1",
    "gateway": "192.168.1.254",
    "dev": "br-mgmt",
    "prefsrc": "192.168.1.87",
    "flags": [],
    "uid": 1000,
    "cache": [],
}])

# `ip route get 1.1.1.1` — plain-text downstream shape.
_IP_TEXT_DOWNSTREAM = (
    "1.1.1.1 via 192.168.1.254 dev br-mgmt src 192.168.1.87 uid 1000 \n"
    "    cache \n"
)

# Primary-router shape: the box owns the edge — a route resolves directly to
# an interface with NO upstream next-hop.
_IP_J_PRIMARY = json.dumps([{
    "dst": "1.1.1.1",
    "dev": "eth0",
    "prefsrc": "203.0.113.42",
    "flags": [],
    "uid": 1000,
    "cache": [],
}])

_IP_TEXT_PRIMARY = "1.1.1.1 dev eth0 src 203.0.113.42 uid 1000 \n    cache \n"


# ---------------------------------------------------------------------------
# _parse_route_topology() — parses (iface, gateway) out of `ip route get`
# ---------------------------------------------------------------------------

def test_parse_route_topology_downstream_json_shape(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._parse_route_topology(_IP_J_DOWNSTREAM) == ("br-mgmt", "192.168.1.254")


def test_parse_route_topology_downstream_text_shape(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._parse_route_topology(_IP_TEXT_DOWNSTREAM) == ("br-mgmt", "192.168.1.254")


def test_parse_route_topology_primary_json_shape(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._parse_route_topology(_IP_J_PRIMARY) == ("eth0", None)


def test_parse_route_topology_primary_text_shape(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._parse_route_topology(_IP_TEXT_PRIMARY) == ("eth0", None)


def test_parse_route_topology_empty_returns_none_none(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._parse_route_topology("") == (None, None)
    assert bridge._parse_route_topology("Error: any valid prefix is expected.") == (None, None)


# ---------------------------------------------------------------------------
# host_topology_snapshot() — shells `ip route get`, classifies the posture
# ---------------------------------------------------------------------------

def test_host_topology_snapshot_downstream(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (0, _IP_J_DOWNSTREAM, ""))
    snap = bridge.host_topology_snapshot()
    assert snap == {
        "posture": "DOWNSTREAM_ROUTER",
        "evidence": {"uplink_iface": "br-mgmt", "upstream_gateway": "192.168.1.254"},
    }


def test_host_topology_snapshot_primary_router(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (0, _IP_J_PRIMARY, ""))
    snap = bridge.host_topology_snapshot()
    assert snap == {
        "posture": "PRIMARY_ROUTER",
        "evidence": {"uplink_iface": "eth0", "upstream_gateway": None},
    }


def test_host_topology_snapshot_falls_back_to_text_when_json_fails(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    calls = []

    def fake_run(cmd, timeout=15):
        calls.append(cmd)
        if "-j" in cmd:
            return 1, "", "Option \"-j\" is unknown, try \"ip -help\"."
        return 0, _IP_TEXT_DOWNSTREAM, ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    snap = bridge.host_topology_snapshot()
    assert snap["posture"] == "DOWNSTREAM_ROUTER"
    assert len(calls) == 2  # tried -j, then fell back to plain text


def test_host_topology_snapshot_unknown_when_no_route(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (2, "", "Error: Network is unreachable"))
    snap = bridge.host_topology_snapshot()
    assert snap == {
        "posture": "UNKNOWN",
        "evidence": {"uplink_iface": None, "upstream_gateway": None},
    }


def test_host_topology_snapshot_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd, timeout=15):
        raise OSError("boom")

    monkeypatch.setattr(bridge, "_run", explode)
    snap = bridge.host_topology_snapshot()
    assert snap == {
        "posture": "UNKNOWN",
        "evidence": {"uplink_iface": None, "upstream_gateway": None},
    }


# ---------------------------------------------------------------------------
# GET /host/topology routing — auth + read-only
# ---------------------------------------------------------------------------

class _FakeHeaders(dict):
    def get(self, k, default=None):
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


class _FakeHandler:
    """Minimal stand-in exercising Handler.do_GET without a live socket."""

    def __init__(self, bridge, headers, path="/host/topology"):
        self.bridge = bridge
        self.headers = _FakeHeaders(headers)
        self.path = path
        self.sent = []
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_GET = bridge.Handler.do_GET.__get__(self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _get(bridge, headers, path="/host/topology"):
    h = _FakeHandler(bridge, headers, path)
    h.do_GET()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def test_host_topology_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("ip route get invoked unauthenticated")))
    status, obj = _get(bridge, {})
    assert status == 401


def test_host_topology_happy_path_returns_200(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (0, _IP_J_DOWNSTREAM, ""))
    status, obj = _get(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 200
    assert obj["posture"] == "DOWNSTREAM_ROUTER"


def test_host_topology_returns_unknown_honestly(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (1, "", "no route"))
    status, obj = _get(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 200
    assert obj == {
        "posture": "UNKNOWN",
        "evidence": {"uplink_iface": None, "upstream_gateway": None},
    }
