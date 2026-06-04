"""Unit tests for the device-bridge destructive storage-pool boundary (BUG-3).

The bridge NEVER runs mdadm/mkfs itself — destructive ops shell the
repo-tracked host script (scripts/host/droplet-storage-pool.sh, installed to
/usr/local/sbin by setup.sh). The bridge's job is (a) require auth on the POST
(mirrors /drives/:uuid/eject) and (b) hand the owner-confirmed op to the host
script, whose hard pre-flight is the real last line of defense.

We monkeypatch at the `_run` boundary so no mdadm, no mkfs, no host script is
ever actually executed in tests.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location("device_bridge_pool_ops_under_test",
                                                  _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# run_pool_command() shells the HOST SCRIPT, never mdadm/mkfs directly
# ---------------------------------------------------------------------------

def test_pool_create_invokes_host_script_not_mdadm(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, '{"ok": true, "device": "md0"}', ""

    monkeypatch.setattr(bridge, "_run", fake_run)

    ok, info = bridge.run_pool_command("pool_create", {
        "device": "md0",
        "level": "raid1",
        "members": ["/dev/sda", "/dev/sdb"],
        "confirm_phrase": "ERASE sda sdb",
    })
    assert ok is True
    cmd = captured["cmd"]
    # It shells the host script — NOT mdadm/mkfs from the bridge process.
    assert any("droplet-storage-pool.sh" in str(part) for part in cmd)
    assert "mdadm" not in cmd
    assert "mkfs" not in cmd
    # The operation is passed through to the script.
    assert "pool_create" in cmd


def test_pool_command_rejects_unknown_operation(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def boom(cmd, timeout=15):
        raise AssertionError("host script invoked for an unknown operation")

    monkeypatch.setattr(bridge, "_run", boom)
    ok, info = bridge.run_pool_command("rm_rf_everything", {"device": "md0"})
    assert ok is False


def test_pool_command_surfaces_host_script_refusal(monkeypatch):
    """When the host-script pre-flight refuses (non-zero exit), the bridge
    surfaces the refusal as (False, ...) — it must NOT swallow it as success."""
    bridge = _load_bridge(monkeypatch)

    def fake_run(cmd, timeout=15):
        return 3, "", "refusing: /dev/sda is mounted at /"

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_pool_command("pool_create", {
        "device": "md0", "level": "raid1",
        "members": ["/dev/sda", "/dev/sdb"], "confirm_phrase": "ERASE sda sdb",
    })
    assert ok is False
    assert "mounted" in str(info)


def test_pool_command_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd, timeout=15):
        raise OSError("script not found")

    monkeypatch.setattr(bridge, "_run", explode)
    # Must degrade to (False, ...) rather than propagate — same contract as
    # eject_drive().
    ok, info = bridge.run_pool_command("pool_destroy", {
        "device": "md0", "confirm_phrase": "ERASE md0",
    })
    assert ok is False


# ---------------------------------------------------------------------------
# POST /pools/command is AUTH-GATED (mirrors /drives/:uuid/eject)
# ---------------------------------------------------------------------------

class _FakeHeaders(dict):
    def get(self, k, default=None):
        # case-insensitive header lookup like http.server's headers
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


class _FakeHandler:
    """Minimal stand-in exercising Handler._authed without a live socket."""

    def __init__(self, bridge, headers):
        self.headers = _FakeHeaders(headers)
        # Bind the real _authed implementation to this fake instance.
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)


def test_pools_command_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # No auth header -> _authed() is False -> the route would 401.
    h = _FakeHandler(bridge, {})
    assert h._authed() is False


def test_pools_command_accepts_correct_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    h = _FakeHandler(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert h._authed() is True


def test_pools_command_rejects_wrong_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    h = _FakeHandler(bridge, {"X-Droplet-Auth": "not-the-token"})
    assert h._authed() is False
