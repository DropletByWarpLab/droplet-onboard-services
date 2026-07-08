"""Unit tests for the device-bridge single-box host-uplink probe (VPN home-mode P1.5).

On the single-box deployment shape the WAN uplink is HOST-owned (not inside the
containerised OpenWrt), so the routing-service network summary reports
`wan.present == false` and the orchestrator's home-mode endpoint discovery has no
IP to hand a HOME-mode WireGuard peer. This bridge — which runs in the host's
network namespace (User=droplet, no PrivateNetwork) — can see the host's real
default route, so it exposes a READ-ONLY GET /host/uplink-ip that reports the
default-route egress source IPv4 (the `prefsrc` of `ip route get 1.1.1.1`).

The bridge's job is:
  (a) parse the default-route source IP out of `ip route get` output (both the
      `-j` JSON shape and the plain-text shape, since older iproute2 builds may
      not support `-j`),
  (b) filter placeholders that could never be a dial-able home endpoint
      (unspecified / loopback / link-local); RFC1918 is VALID (the home client is
      on the same LAN),
  (c) require the shared bridge auth token on the GET (the source IP is
      box-internal network topology; mirrors /openwrt/qr + /drives), and
  (d) return {"uplinkIp": "<ip>" | null} — an HONEST null when it cannot
      determine an address, never a fabricated guess.

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
        "device_bridge_uplink_ip_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# `ip -j route get 1.1.1.1` — JSON shape (iproute2 >= 4.x with libjson).
_IP_J_SINGLE_BOX = json.dumps([{
    "dst": "1.1.1.1",
    "gateway": "192.168.1.254",
    "dev": "enp1s0",
    "prefsrc": "192.168.1.87",
    "flags": [],
    "uid": 1000,
    "cache": [],
}])

# `ip route get 1.1.1.1` — plain-text shape (fallback when -j is unavailable).
_IP_TEXT_SINGLE_BOX = (
    "1.1.1.1 via 192.168.1.254 dev enp1s0 src 192.168.1.87 uid 1000 \n"
    "    cache \n"
)


# ---------------------------------------------------------------------------
# _parse_uplink_ip() — parses the source IP out of `ip route get` output
# ---------------------------------------------------------------------------

def test_parse_uplink_ip_from_json_shape(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._parse_uplink_ip(_IP_J_SINGLE_BOX) == "192.168.1.87"


def test_parse_uplink_ip_from_plain_text_shape(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._parse_uplink_ip(_IP_TEXT_SINGLE_BOX) == "192.168.1.87"


def test_parse_uplink_ip_rfc1918_10_dot_is_valid(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    text = "1.1.1.1 via 10.0.0.1 dev eth0 src 10.4.5.6 uid 1000 \n    cache"
    assert bridge._parse_uplink_ip(text) == "10.4.5.6"


def test_parse_uplink_ip_rejects_loopback(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # A box with no default route can resolve 1.1.1.1 to a loopback src — reject.
    text = "1.1.1.1 dev lo src 127.0.0.1 uid 1000 \n    cache"
    assert bridge._parse_uplink_ip(text) is None


def test_parse_uplink_ip_rejects_link_local(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    text = "1.1.1.1 dev eth0 src 169.254.10.20 uid 1000 \n    cache"
    assert bridge._parse_uplink_ip(text) is None


def test_parse_uplink_ip_rejects_unspecified(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    text = "1.1.1.1 dev eth0 src 0.0.0.0 uid 1000 \n    cache"
    assert bridge._parse_uplink_ip(text) is None


def test_parse_uplink_ip_empty_returns_none(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._parse_uplink_ip("") is None
    assert bridge._parse_uplink_ip("Error: any valid prefix is expected.") is None


# ---------------------------------------------------------------------------
# uplink_ip_snapshot() — shells `ip route get`, returns {"uplinkIp": ...}
# ---------------------------------------------------------------------------

def test_uplink_ip_snapshot_happy_path(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (0, _IP_J_SINGLE_BOX, ""))
    snap = bridge.uplink_ip_snapshot()
    assert snap == {"uplinkIp": "192.168.1.87"}


def test_uplink_ip_snapshot_falls_back_to_text_when_json_fails(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    calls = []

    def fake_run(cmd, timeout=15):
        calls.append(cmd)
        # First call uses `-j`; simulate an iproute2 that doesn't support it.
        if "-j" in cmd:
            return 1, "", "Option \"-j\" is unknown, try \"ip -help\"."
        return 0, _IP_TEXT_SINGLE_BOX, ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    snap = bridge.uplink_ip_snapshot()
    assert snap == {"uplinkIp": "192.168.1.87"}
    assert len(calls) == 2  # tried -j, then fell back to plain text


def test_uplink_ip_snapshot_null_when_ip_unavailable(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (127, "", "ip: command not found"))
    assert bridge.uplink_ip_snapshot() == {"uplinkIp": None}


def test_uplink_ip_snapshot_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd, timeout=15):
        raise OSError("boom")

    monkeypatch.setattr(bridge, "_run", explode)
    assert bridge.uplink_ip_snapshot() == {"uplinkIp": None}


# ---------------------------------------------------------------------------
# GET /host/uplink-ip routing — auth + read-only
# ---------------------------------------------------------------------------

class _FakeHeaders(dict):
    def get(self, k, default=None):
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


class _FakeHandler:
    """Minimal stand-in exercising Handler.do_GET without a live socket."""

    def __init__(self, bridge, headers, path="/host/uplink-ip"):
        self.bridge = bridge
        self.headers = _FakeHeaders(headers)
        self.path = path
        self.sent = []
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_GET = bridge.Handler.do_GET.__get__(self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _get(bridge, headers, path="/host/uplink-ip"):
    h = _FakeHandler(bridge, headers, path)
    h.do_GET()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def test_uplink_ip_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("ip route get invoked unauthenticated")))
    status, obj = _get(bridge, {})
    assert status == 401


def test_uplink_ip_happy_path_returns_200(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (0, _IP_J_SINGLE_BOX, ""))
    status, obj = _get(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 200
    assert obj == {"uplinkIp": "192.168.1.87"}


def test_uplink_ip_returns_null_honestly(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (1, "", "no route"))
    status, obj = _get(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 200
    assert obj == {"uplinkIp": None}
