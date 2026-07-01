"""Unit tests for the device-bridge box-name write-back boundary (WARP-988).

The wizard's "name your box" step (WARP-979) picks the owner's slug; the
orchestrator POSTs it here so it can be persisted back to the host `.env`
(DROPLET_BOX_NAME) for the next boot, when tls-issuance sends it to HQ as
`requested_name`. The bridge NEVER writes `.env` itself — it shells the
repo-tracked host script (scripts/host/droplet-set-box-name.sh, installed to
/usr/local/sbin by install-device-bridge.sh), which does the idempotent
sed-replace-or-append (no DNS legs — HQ owns the name's DNS). The bridge's job
is:
  (a) require auth on the POST (mirrors /host/public-fqdn + /tls/reload),
  (b) STRICTLY validate the name shape BEFORE exec (lowercase slug, 3-40 chars,
      [a-z0-9-], no leading/trailing/double hyphen, never a `d-<16 hex>`
      device-identifier lookalike) — never hand junk to the host script, and
  (c) hand the validated name to the host script, never write .env itself.

We monkeypatch at the `_run` boundary so no host script ever runs.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"

_GOOD_NAME = "warp-lab-hq"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_box_name_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# run_set_box_name() shells the HOST SCRIPT, never writes .env directly
# ---------------------------------------------------------------------------

def test_set_box_name_invokes_host_script(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, '{"ok": true}', ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_set_box_name(_GOOD_NAME)
    assert ok is True
    cmd = captured["cmd"]
    assert any("droplet-set-box-name.sh" in str(part) for part in cmd)
    # The name is passed as an explicit arg — never interpolated into a shell.
    assert _GOOD_NAME in [str(p) for p in cmd]


def test_set_box_name_rejects_junk_before_exec(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("host script invoked on junk name")))
    for junk in [
        "",
        "ab",                           # too short (< 3)
        "a" * 41,                       # too long (> 40)
        "not a slug",                   # whitespace
        "../etc/passwd",                # path traversal / dots
        "hq; rm -rf /",                 # shell metacharacters
        "Warp-Lab",                     # uppercase
        "warp.lab",                     # dots — a slug, not an fqdn
        "-warp-lab",                    # leading hyphen
        "warp-lab-",                    # trailing hyphen
        "warp--lab",                    # double hyphen
        "d-0123456789abcdef",           # opaque per-device lookalike (ADR-023)
        None,                           # not a string at all
        42,
    ]:
        ok, info = bridge.run_set_box_name(junk)
        assert ok is False, f"expected refusal for {junk!r}"


def test_set_box_name_surfaces_host_script_refusal(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (1, "", "droplet-set-box-name: refused"))
    ok, info = bridge.run_set_box_name(_GOOD_NAME)
    assert ok is False


def test_set_box_name_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd, timeout=15):
        raise OSError("script not found")

    monkeypatch.setattr(bridge, "_run", explode)
    ok, info = bridge.run_set_box_name(_GOOD_NAME)
    assert ok is False


# ---------------------------------------------------------------------------
# POST /host/box-name routing — auth + validation
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
        self.path = "/host/box-name"
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


def test_box_name_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("host script invoked unauthenticated")))
    status, obj = _post(bridge, {}, {"name": _GOOD_NAME})
    assert status == 401


def test_box_name_happy_path_returns_200(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (0, '{"ok": true}', ""))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"name": _GOOD_NAME})
    assert status == 200
    assert obj.get("ok") is True


def test_box_name_junk_returns_400_without_exec(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("host script invoked on junk name")))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"name": "not a slug; rm -rf /"})
    assert status == 400
    assert obj.get("ok") is False


def test_box_name_device_lookalike_returns_400_without_exec(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("host script invoked on lookalike name")))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"name": "d-0123456789abcdef"})
    assert status == 400
    assert obj.get("ok") is False


def test_box_name_host_script_refusal_returns_502(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (1, "", "droplet-set-box-name: refused"))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"name": _GOOD_NAME})
    assert status == 502
    assert obj.get("ok") is False


def test_box_name_rejects_bad_json(monkeypatch):
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
