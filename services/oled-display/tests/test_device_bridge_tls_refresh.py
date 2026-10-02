"""WARP-2944 / ADR-058 — the bootstrap certificate follows the box's address.

The bridge samples the uplink address for the panel already; this is the
seam that turns "the address changed" into "regenerate the self-signed cert
around the same key" (scripts/host/droplet-tls-bootstrap-refresh.sh →
secrets.sh::_generate_tls_cert). These tests pin the pure decision rule (when
the script runs, when it must not), the executor's honesty at the `_run`
boundary, the auth gate on the route, and that the watcher is wired at boot.
No host script ever runs.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_BRIDGE_PATH = _HERE.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    monkeypatch.setenv("DROPLET_TLS_REFRESH_WATCH_SECONDS", "0")   # no thread in tests
    spec = importlib.util.spec_from_file_location("device_bridge_tls_refresh_under_test",
                                                  _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- the decision rule -------------------------------------------------------

def test_the_first_usable_address_after_start_runs_the_refresh(monkeypatch):
    """Boot on a new network: the very first sample heals the cert."""
    bridge = _load_bridge(monkeypatch)
    w = bridge.TlsRefreshWatcher(min_interval=600)
    assert w.decide("192.168.9.195", 1000.0) is True
    w.ran("192.168.9.195", 1000.0)
    # Same address a minute later: nothing to do until the interval passes.
    assert w.decide("192.168.9.195", 1060.0) is False


def test_no_usable_address_never_runs_and_clears_a_pending_change(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    w = bridge.TlsRefreshWatcher(min_interval=600)
    for bad in (None, "", "0.0.0.0", "127.0.0.1"):
        assert w.decide(bad, 1000.0) is False, bad
    w.ran("192.168.9.195", 1000.0)
    assert w.decide("10.50.0.7", 1060.0) is False          # seen once → pending
    assert w.decide(None, 1120.0) is False                 # link down clears it
    assert w.decide("10.50.0.7", 1180.0) is False          # must be seen twice again
    assert w.decide("10.50.0.7", 1240.0) is True


def test_a_changed_address_runs_only_once_it_has_held_for_two_samples(monkeypatch):
    """A DHCP flap (A → B → A) must not trigger; a real move (A → B → B) must."""
    bridge = _load_bridge(monkeypatch)
    w = bridge.TlsRefreshWatcher(min_interval=600)
    w.ran("192.168.9.195", 1000.0)
    assert w.decide("10.50.0.7", 1060.0) is False
    assert w.decide("192.168.9.195", 1120.0) is False       # flapped back: no run
    assert w.decide("10.50.0.7", 1180.0) is False           # new pending again
    assert w.decide("10.50.0.7", 1240.0) is True            # held → run
    w.ran("10.50.0.7", 1240.0)
    assert w.decide("10.50.0.7", 1300.0) is False


def test_the_minimum_interval_is_a_safety_net_not_a_cadence(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    w = bridge.TlsRefreshWatcher(min_interval=600)
    w.ran("192.168.9.195", 1000.0)
    assert w.decide("192.168.9.195", 1599.0) is False
    assert w.decide("192.168.9.195", 1600.0) is True


# --- the executor -------------------------------------------------------------

def test_refresh_invokes_the_host_script_with_no_arguments(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    seen = {}

    def fake_run(cmd, timeout=15):
        seen["cmd"] = cmd
        seen["timeout"] = timeout
        return 0, '{"ok":true,"changed":true,"pin":"8Bev="}\n', ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_tls_bootstrap_refresh()
    assert ok is True
    assert info == {"ok": True, "changed": True, "pin": "8Bev="}
    assert seen["cmd"] == [bridge.TLS_BOOTSTRAP_REFRESH_SCRIPT]
    assert seen["timeout"] >= 30


def test_refresh_surfaces_a_refusal_and_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (1, "", "helper missing: secrets.sh"))
    ok, info = bridge.run_tls_bootstrap_refresh()
    assert ok is False and "helper missing" in info

    def boom(*a, **k):
        raise OSError("no such file")

    monkeypatch.setattr(bridge, "_run", boom)
    ok, info = bridge.run_tls_bootstrap_refresh()
    assert ok is False and info == "host script unavailable"


def test_refresh_tolerates_a_non_json_success_line(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (0, "did the thing\n", ""))
    ok, info = bridge.run_tls_bootstrap_refresh()
    assert ok is True and info == {"message": "did the thing"}


# --- the route -----------------------------------------------------------------

class _FakeHeaders(dict):
    def get(self, k, default=None):
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


class _FakeRfile:
    def __init__(self, body: bytes):
        self._body = body

    def read(self, n):
        return self._body[:n]


class _FakeHandler:
    """Minimal stand-in exercising Handler.do_POST without a live socket
    (the same shape test_device_bridge_public_fqdn.py uses)."""

    def __init__(self, bridge, headers, body: bytes = b""):
        self.bridge = bridge
        self.headers = _FakeHeaders(headers)
        self.rfile = _FakeRfile(body)
        self.path = "/tls/bootstrap-refresh"
        self.sent = []
        self.client_address = ("127.0.0.1", 12345)
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_POST = bridge.Handler.do_POST.__get__(self, bridge.Handler)
        self._dispatch_post = bridge.Handler._dispatch_post.__get__(
            self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _post(bridge, headers):
    body = json.dumps({}).encode()
    headers = {**headers, "Content-Length": str(len(body))}
    h = _FakeHandler(bridge, headers, body)
    h.do_POST()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def test_the_route_is_gated_and_never_execs_unauthenticated(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("host script invoked unauthenticated")))
    status, obj = _post(bridge, {})
    assert status == 401


def test_the_route_reports_the_refresh_outcome(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (0, '{"ok":true,"changed":false}', ""))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 200 and obj.get("ok") is True and obj.get("changed") is False
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (1, "", "certificate refresh failed"))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 502 and obj.get("ok") is False


# --- wiring ----------------------------------------------------------------------

def test_the_watcher_is_started_at_boot_and_disabled_by_zero(monkeypatch):
    src = _BRIDGE_PATH.read_text(encoding="utf-8")
    main = src[src.index('if __name__ == "__main__":'):]
    assert "start_tls_refresh_watcher()" in main
    bridge = _load_bridge(monkeypatch)      # WATCH_SECONDS=0 in the harness
    assert bridge.start_tls_refresh_watcher() is None


def test_the_host_script_is_installed_and_removed_with_its_sibling():
    repo = _HERE.parent.parent.parent
    installer = (repo / "scripts" / "install-device-bridge.sh").read_text(encoding="utf-8")
    reset = (repo / "scripts" / "factory-reset.sh").read_text(encoding="utf-8")
    assert "droplet-tls-bootstrap-refresh.sh" in installer
    assert "/usr/local/sbin/droplet-tls-bootstrap-refresh.sh" in reset
    assert (repo / "scripts" / "host" / "droplet-tls-bootstrap-refresh.sh").exists()
