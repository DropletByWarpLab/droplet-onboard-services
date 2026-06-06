"""Unit tests for the device-bridge factory-reset boundary (WARP-825).

A factory reset wipes every data volume + secrets and bounces the whole stack —
`scripts/factory-reset.sh` runs `docker compose down -v`, which kills the
orchestrator AND (eventually) the device-bridge itself. So unlike the hostapd
write (a blocking `_run`), the reset MUST be spawned DETACHED: the bridge hands
the wipe off to the repo-tracked host script via a non-blocking
`subprocess.Popen` and returns ~immediately, so the wipe survives the bridge's
own teardown.

The bridge NEVER runs `docker compose down -v` itself — it shells the
repo-tracked host script (scripts/host/droplet-factory-reset.sh, installed to
/usr/local/sbin by setup.sh). Its job is:
  (a) require auth on the POST (mirrors /pools/command + /openwrt/wifi/hostapd),
  (b) spawn the host script DETACHED (never block on the multi-minute wipe),
  (c) never raise.

SAFETY: every test monkeypatches the spawn boundary, so the real
factory-reset.sh / docker / `down -v` is NEVER executed. Nothing is wiped.
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
    spec = importlib.util.spec_from_file_location(
        "device_bridge_reset_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# run_factory_reset() spawns the HOST SCRIPT detached, never docker directly
# ---------------------------------------------------------------------------

def test_factory_reset_spawns_host_script_detached(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_spawn(cmd):
        captured["cmd"] = cmd
        return True, None  # (ok, error)

    monkeypatch.setattr(bridge, "_spawn_detached", fake_spawn)

    ok, info = bridge.run_factory_reset({"jobId": "job-1", "targetName": "droplet-home"})
    assert ok is True
    cmd = captured["cmd"]
    # It shells the repo-tracked host script — NOT `docker` / `compose down -v`
    # from the bridge process.
    assert any("droplet-factory-reset.sh" in str(part) for part in cmd)
    assert "docker" not in [str(p) for p in cmd]


def test_factory_reset_uses_popen_not_blocking_run(monkeypatch):
    """The reset must NOT go through the blocking `_run` helper — that would
    wait for the multi-minute wipe to finish, but the wipe tears down the bridge
    mid-flight. It must use the detached spawn path."""
    bridge = _load_bridge(monkeypatch)

    def boom_run(*a, **k):
        raise AssertionError("factory reset must not block on _run")

    monkeypatch.setattr(bridge, "_run", boom_run)
    monkeypatch.setattr(bridge, "_spawn_detached", lambda cmd: (True, None))

    ok, info = bridge.run_factory_reset({"jobId": "job-1", "targetName": "droplet-home"})
    assert ok is True


def test_factory_reset_surfaces_spawn_failure(monkeypatch):
    """If the host script can't even be spawned (missing / not executable), the
    bridge surfaces (False, ...) — it must NOT report success."""
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_spawn_detached",
        lambda cmd: (False, "host script not found"))

    ok, info = bridge.run_factory_reset({"jobId": "job-1", "targetName": "droplet-home"})
    assert ok is False
    assert "not found" in str(info).lower()


def test_factory_reset_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd):
        raise OSError("spawn blew up")

    monkeypatch.setattr(bridge, "_spawn_detached", explode)
    # Degrades to (False, ...) rather than propagating — same contract as
    # run_pool_command() / run_set_hostapd().
    ok, info = bridge.run_factory_reset({"jobId": "job-1", "targetName": "droplet-home"})
    assert ok is False


# ---------------------------------------------------------------------------
# POST /system/factory-reset routing — auth + status
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
        self.path = "/system/factory-reset"
        self.sent = []  # list of (status, obj)
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_POST = bridge.Handler.do_POST.__get__(self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _post(bridge, headers, params: dict):
    import json
    body = json.dumps(params).encode()
    headers = {**headers, "Content-Length": str(len(body))}
    h = _FakeHandler(bridge, headers, body)
    h.do_POST()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def test_reset_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # No auth header -> 401, and the host script is never spawned.
    monkeypatch.setattr(
        bridge, "_spawn_detached",
        lambda cmd: (_ for _ in ()).throw(
            AssertionError("host script spawned unauthenticated")))
    status, obj = _post(bridge, {}, {"jobId": "j", "targetName": "droplet-home"})
    assert status == 401


def test_reset_accepted_with_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    spawned = {"n": 0}

    def fake_spawn(cmd):
        spawned["n"] += 1
        return True, None

    monkeypatch.setattr(bridge, "_spawn_detached", fake_spawn)
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"jobId": "j", "targetName": "droplet-home"})
    # 202 Accepted — the wipe has been dispatched detached.
    assert status == 202
    assert obj.get("ok") is True
    assert spawned["n"] == 1


def test_reset_spawn_failure_maps_to_502(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_spawn_detached",
        lambda cmd: (False, "host script not found"))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"jobId": "j", "targetName": "droplet-home"})
    assert status == 502
    assert obj.get("ok") is False
