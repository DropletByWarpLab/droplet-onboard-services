"""Unit tests for the device-bridge public-FQDN write-back boundary (ADR-023 PR-1).

The orchestrator's tls-issuance service LEARNS the box's opaque per-device FQDN
from the HQ challenge response and POSTs it here so it can be persisted back to
the host `.env` (DROPLET_PUBLIC_FQDN). The bridge NEVER writes `.env` itself —
it shells the repo-tracked host script
(scripts/host/droplet-set-public-fqdn.sh, installed to /usr/local/sbin by
install-device-bridge.sh), which does the idempotent sed-replace-or-append +
re-registers split-horizon DNS. The bridge's job is:
  (a) require auth on the POST (mirrors /tls/reload + /openwrt/wifi/hostapd),
  (b) STRICTLY validate the fqdn shape BEFORE exec (an opaque per-device name or
      a conservative hostname charset) — never hand junk to the host script, and
  (c) hand the validated fqdn to the host script, never run setup_public_fqdn_dns
      itself.

We monkeypatch at the `_run` boundary so no host script ever runs.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"

_GOOD_FQDN = "d-0123456789abcdef.devices.warp-lab.ai"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_public_fqdn_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# run_set_public_fqdn() shells the HOST SCRIPT, never writes .env directly
# ---------------------------------------------------------------------------

def test_set_public_fqdn_invokes_host_script(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, '{"ok": true}', ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_set_public_fqdn(_GOOD_FQDN)
    assert ok is True
    cmd = captured["cmd"]
    assert any("droplet-set-public-fqdn.sh" in str(part) for part in cmd)
    # The fqdn is passed as an explicit arg — never interpolated into a shell.
    assert _GOOD_FQDN in [str(p) for p in cmd]


def test_set_public_fqdn_rejects_junk_before_exec(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("host script invoked on junk fqdn")))
    for junk in [
        "",
        "not a hostname",
        "../etc/passwd",
        "d-abc; rm -rf /",
        "https://evil.example.com",
        "UPPER.devices.warp-lab.ai",   # uppercase rejected by the conservative charset
        "a" * 300,                      # absurdly long
    ]:
        ok, info = bridge.run_set_public_fqdn(junk)
        assert ok is False, f"expected refusal for {junk!r}"


def test_set_public_fqdn_surfaces_host_script_refusal(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (1, "", "droplet-set-public-fqdn: refused"))
    ok, info = bridge.run_set_public_fqdn(_GOOD_FQDN)
    assert ok is False


def test_set_public_fqdn_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd, timeout=15):
        raise OSError("script not found")

    monkeypatch.setattr(bridge, "_run", explode)
    ok, info = bridge.run_set_public_fqdn(_GOOD_FQDN)
    assert ok is False


# ---------------------------------------------------------------------------
# POST /host/public-fqdn routing — auth + validation
# ---------------------------------------------------------------------------

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
    """Minimal stand-in exercising Handler.do_POST without a live socket."""

    def __init__(self, bridge, headers, body: bytes = b""):
        self.bridge = bridge
        self.headers = _FakeHeaders(headers)
        self.rfile = _FakeRfile(body)
        self.path = "/host/public-fqdn"
        self.sent = []
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_POST = bridge.Handler.do_POST.__get__(self, bridge.Handler)
        self._dispatch_post = bridge.Handler._dispatch_post.__get__(
            self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _post(bridge, headers, payload: dict):
    body = json.dumps(payload).encode()
    headers = {**headers, "Content-Length": str(len(body))}
    h = _FakeHandler(bridge, headers, body)
    h.do_POST()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def test_public_fqdn_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("host script invoked unauthenticated")))
    status, obj = _post(bridge, {}, {"fqdn": _GOOD_FQDN})
    assert status == 401


def test_public_fqdn_happy_path_returns_200(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (0, '{"ok": true}', ""))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"fqdn": _GOOD_FQDN})
    assert status == 200
    assert obj.get("ok") is True


def test_public_fqdn_junk_returns_400_without_exec(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("host script invoked on junk fqdn")))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"fqdn": "not a hostname; rm -rf /"})
    assert status == 400
    assert obj.get("ok") is False


def test_public_fqdn_rejects_bad_json(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("host script invoked on bad json")))
    body = b"{not valid json"
    headers = {"X-Droplet-Auth": "pytest-bridge-token",
               "Content-Length": str(len(body))}
    h = _FakeHandler(bridge, headers, body)
    h.do_POST()
    status, obj = h.sent[-1]
    assert status == 400
