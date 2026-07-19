"""Unit tests for the device-bridge STUN probe (WARP-1385, direct-punch overlay).

The direct-punch remote-access overlay (ADR-030) needs the box to learn its OWN
public UDP mapping — the {ip, port} an upstream NAT assigns to traffic leaving
from the WireGuard source port (51820). The box then hands that mapping to HQ in
the `answer` so the phone can aim its WireGuard endpoint at it.

device-bridge runs in the HOST network namespace (root), so it is the one place
that can send a STUN Binding request FROM host udp/51820 and read the reflexive
mapping back. This is valid only once WARP-1385 Part A removes docker-proxy from
host:51820 (wg's socket is in the container netns, so the host port is free).

Contract the endpoint must honor:
  (a) send ONE STUN Binding request from host UDP SOURCE PORT 51820 (so the
      observed mapping is the SAME one the wg0 punch uses),
  (b) parse the reflexive {ip, port} out of the XOR-MAPPED-ADDRESS attribute,
  (c) fail CLOSED — a 502 with a clear error, never a fabricated mapping, when
      no STUN server answers,
  (d) require the shared bridge auth token (mirrors /openwrt/qr + /host/uplink-ip
      now the bridge binds all interfaces),
  (e) source the STUN server list INLINE — never from a droplet-writable path
      (device-bridge is root; the LPE invariant forbids reading config from a
      writable file).

We monkeypatch at the `socket` / `_stun_query` boundary so no packet is ever
sent. Mirrors test_device_bridge_uplink_ip.py's structure.
"""

from __future__ import annotations

import importlib.util
import socket as _socket
import struct
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"

_STUN_MAGIC_COOKIE = 0x2112A442


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_stun_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _build_binding_response(ip: str, port: int, txid: bytes,
                            attr_type: int = 0x0020) -> bytes:
    """Build a STUN Binding Success Response (0x0101) carrying a single
    XOR-MAPPED-ADDRESS (0x0020) or MAPPED-ADDRESS (0x0001) for `ip:port`."""
    xport = port ^ (_STUN_MAGIC_COOKIE >> 16) if attr_type == 0x0020 else port
    addr_int = struct.unpack(">I", _socket.inet_aton(ip))[0]
    xaddr = addr_int ^ _STUN_MAGIC_COOKIE if attr_type == 0x0020 else addr_int
    # value: reserved(1) + family(1, 0x01=IPv4) + port(2) + addr(4) = 8 bytes
    value = struct.pack(">BBH I", 0x00, 0x01, xport, xaddr)
    attr = struct.pack(">HH", attr_type, len(value)) + value
    header = struct.pack(">HHI", 0x0101, len(attr), _STUN_MAGIC_COOKIE) + txid
    return header + attr


# ---------------------------------------------------------------------------
# _parse_stun_mapped_address() — pulls {ip, port} out of a binding response
# ---------------------------------------------------------------------------

def test_parse_xor_mapped_address(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    txid = b"0123456789ab"
    resp = _build_binding_response("203.0.113.7", 51820, txid)
    assert bridge._parse_stun_mapped_address(resp, txid) == ("203.0.113.7", 51820)


def test_parse_plain_mapped_address_fallback(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    txid = b"abcdefghijkl"
    resp = _build_binding_response("198.51.100.9", 40000, txid, attr_type=0x0001)
    assert bridge._parse_stun_mapped_address(resp, txid) == ("198.51.100.9", 40000)


def test_parse_rejects_wrong_transaction_id(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    resp = _build_binding_response("203.0.113.7", 51820, b"txid-A-000000")
    with pytest.raises(Exception):
        bridge._parse_stun_mapped_address(resp, b"txid-B-111111")


def test_parse_rejects_short_or_nonstun(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    with pytest.raises(Exception):
        bridge._parse_stun_mapped_address(b"\x00\x01\x02", b"0123456789ab")


# ---------------------------------------------------------------------------
# _stun_query() — binds host udp/51820 and sends one Binding request
# ---------------------------------------------------------------------------

class _FakeSocket:
    """Records bind/settimeout and replays a canned STUN response on recvfrom."""

    def __init__(self, response: bytes, *, family=None, type=None):
        self._response = response
        self.bound = None
        self.timeout = None
        self.sent = []
        self.closed = False

    def setsockopt(self, *a):
        pass

    def bind(self, addr):
        self.bound = addr

    def settimeout(self, t):
        self.timeout = t

    def sendto(self, data, addr):
        self.sent.append((data, addr))

    def recvfrom(self, n):
        return self._response, ("stun.example", 3478)

    def close(self):
        self.closed = True


def test_stun_query_binds_source_port_51820(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    txid_holder = {}
    resp_holder = {}

    def fake_socket_factory(family, type):
        # Response is built lazily once we know the txid the query generated —
        # patch secrets.token_bytes to a fixed value so we can pre-build it.
        return resp_holder["sock"]

    fixed_txid = b"FIXEDTXID_012"[:12]
    monkeypatch.setattr(bridge.secrets, "token_bytes", lambda n: fixed_txid)
    resp = _build_binding_response("203.0.113.7", 51820, fixed_txid)
    fake = _FakeSocket(resp)
    resp_holder["sock"] = fake
    monkeypatch.setattr(bridge.socket, "socket", fake_socket_factory)

    ip, port = bridge._stun_query("stun.cloudflare.com", 3478)
    assert (ip, port) == ("203.0.113.7", 51820)
    # The probe MUST originate from host udp/51820 (the wg0 punch source port).
    assert fake.bound == ("0.0.0.0", 51820)
    assert fake.timeout is not None and fake.timeout > 0
    assert fake.closed is True
    assert len(fake.sent) == 1


# ---------------------------------------------------------------------------
# stun_probe_snapshot() — tries each inline server, fails closed
# ---------------------------------------------------------------------------

def test_stun_servers_are_inlined_two_public(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    servers = list(bridge._STUN_SERVERS)
    assert len(servers) >= 2
    hosts = {h for h, _p in servers}
    assert "stun.cloudflare.com" in hosts
    # Source port pinned to the WireGuard listener port.
    assert bridge.STUN_SOURCE_PORT == 51820


def test_snapshot_happy_path(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_stun_query",
                        lambda host, port, **k: ("203.0.113.7", 51820))
    ok, info = bridge.stun_probe_snapshot()
    assert ok is True
    assert info["ip"] == "203.0.113.7"
    assert info["port"] == 51820


def test_snapshot_falls_through_to_second_server(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    calls = []

    def flaky(host, port, **k):
        calls.append(host)
        if len(calls) == 1:
            raise OSError("first server timed out")
        return ("198.51.100.9", 51820)

    monkeypatch.setattr(bridge, "_stun_query", flaky)
    ok, info = bridge.stun_probe_snapshot()
    assert ok is True
    assert info["ip"] == "198.51.100.9"
    assert len(calls) == 2  # tried the first, fell through to the second


def test_snapshot_fails_closed_when_all_servers_error(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def always_fail(host, port, **k):
        raise OSError("no route to STUN server")

    monkeypatch.setattr(bridge, "_stun_query", always_fail)
    ok, info = bridge.stun_probe_snapshot()
    assert ok is False
    assert "error" in info
    assert "ip" not in info  # NEVER fabricate a mapping


# ---------------------------------------------------------------------------
# GET /host/stun-probe routing — auth + fail-closed
# ---------------------------------------------------------------------------

class _FakeHeaders(dict):
    def get(self, k, default=None):
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


class _FakeHandler:
    def __init__(self, bridge, headers, path="/host/stun-probe"):
        self.bridge = bridge
        self.headers = _FakeHeaders(headers)
        self.path = path
        self.sent = []
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_GET = bridge.Handler.do_GET.__get__(self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _get(bridge, headers, path="/host/stun-probe"):
    h = _FakeHandler(bridge, headers, path)
    h.do_GET()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def test_stun_probe_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "stun_probe_snapshot",
        lambda: (_ for _ in ()).throw(
            AssertionError("STUN probe ran unauthenticated")))
    status, _obj = _get(bridge, {})
    assert status == 401


def test_stun_probe_happy_path_returns_200(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "stun_probe_snapshot",
                        lambda: (True, {"ip": "203.0.113.7", "port": 51820,
                                        "server": "stun.cloudflare.com:3478"}))
    status, obj = _get(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 200
    assert obj["ip"] == "203.0.113.7"
    assert obj["port"] == 51820


def test_stun_probe_fails_closed_502(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "stun_probe_snapshot",
                        lambda: (False, {"error": "no STUN response"}))
    status, obj = _get(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 502
    assert "error" in obj
