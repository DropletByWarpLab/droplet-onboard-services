"""Unit tests for the device-bridge diagnostics-log boundary (WARP-823).

The bridge NEVER reads journald / `docker logs` inline — it shells the
repo-tracked host collector script (scripts/host/droplet-collect-logs.sh,
installed to /usr/local/sbin by setup.sh / install-device-bridge.sh). The
collector bounds the window + size AND redacts secrets on the host; the
orchestrator redacts again before zipping (defense in depth).

The bridge's job here is (a) require auth on GET /logs/bundle (mirrors the
auth on /openwrt/qr and /drives) and (b) hand the bounded request to the host
script and surface its output/refusal honestly — never raising.

We monkeypatch at the `_run` boundary so no journalctl, no docker, no host
script is ever actually executed in tests.
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
        "device_bridge_logs_under_test", _BRIDGE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# collect_logs() shells the HOST SCRIPT, never journalctl/docker directly
# ---------------------------------------------------------------------------

def test_collect_logs_invokes_host_script_not_journalctl(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, json.dumps({
            "collected_at": "2026-06-06T10:00:00Z",
            "window_hours": 24,
            "services": [
                {"name": "orchestrator", "source": "docker", "lines": "ok"}
            ],
            "truncated": False,
        }), ""

    monkeypatch.setattr(bridge, "_run", fake_run)

    ok, info = bridge.collect_logs(24, None)
    assert ok is True
    cmd = captured["cmd"]
    # It shells the host collector — NOT journalctl / docker from the bridge.
    assert any("droplet-collect-logs.sh" in str(part) for part in cmd)
    assert "journalctl" not in cmd
    assert "docker" not in cmd
    # The window is passed through to the script as an argument.
    assert any("24" in str(part) for part in cmd)
    assert info["services"][0]["name"] == "orchestrator"


def test_collect_logs_clamps_window_hours(monkeypatch):
    """An out-of-range window is clamped before it reaches the host script —
    the bridge never asks journald for an unbounded history."""
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, json.dumps({"services": []}), ""

    monkeypatch.setattr(bridge, "_run", fake_run)

    bridge.collect_logs(100000, None)
    # The clamped value (<= the 168h / 7-day cap) is what is passed, never 100000.
    joined = " ".join(str(p) for p in captured["cmd"])
    assert "100000" not in joined


def test_collect_logs_passes_service_filter(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, json.dumps({"services": []}), ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    bridge.collect_logs(24, "orchestrator")
    joined = " ".join(str(p) for p in captured["cmd"])
    assert "orchestrator" in joined


def test_collect_logs_surfaces_host_script_failure(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def fake_run(cmd, timeout=15):
        return 3, "", "journalctl: command not found"

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.collect_logs(24, None)
    assert ok is False
    assert "journalctl" in str(info)


def test_collect_logs_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd, timeout=15):
        raise OSError("script not found")

    monkeypatch.setattr(bridge, "_run", explode)
    # Must degrade to (False, ...) rather than propagate — same contract as
    # run_pool_command() / eject_drive().
    ok, info = bridge.collect_logs(24, None)
    assert ok is False


def test_collect_logs_rejects_nonjson_but_succeeds(monkeypatch):
    """A 0-exit script that prints non-JSON still yields ok=True with the raw
    message wrapped — same tolerant shape as run_pool_command()."""
    bridge = _load_bridge(monkeypatch)

    def fake_run(cmd, timeout=15):
        return 0, "not json output", ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.collect_logs(24, None)
    assert ok is True
    assert "message" in info


# ---------------------------------------------------------------------------
# GET /logs/bundle is AUTH-GATED (mirrors /openwrt/qr, /drives)
# ---------------------------------------------------------------------------

class _FakeHeaders(dict):
    def get(self, k, default=None):
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


class _FakeHandler:
    """Minimal stand-in exercising Handler._authed without a live socket."""

    def __init__(self, bridge, headers):
        self.headers = _FakeHeaders(headers)
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)


def test_logs_bundle_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    h = _FakeHandler(bridge, {})
    assert h._authed() is False


def test_logs_bundle_accepts_correct_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    h = _FakeHandler(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert h._authed() is True


# ---------------------------------------------------------------------------
# CodeQL py/command-line-injection (#65): the service filter comes off the query
# string and is handed to the host script as argv. Explicit ASCII allow-list.
# ---------------------------------------------------------------------------

def _capture_run(monkeypatch, bridge):
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, json.dumps({"services": []}), ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    return captured


@pytest.mark.parametrize("good", ["orchestrator", "ai-gateway", "file_indexer", "_x", "A1"])
def test_collect_logs_keeps_a_well_formed_service_filter(monkeypatch, good):
    bridge = _load_bridge(monkeypatch)
    captured = _capture_run(monkeypatch, bridge)
    bridge.collect_logs(24, good)
    assert captured["cmd"][2] == good


@pytest.mark.parametrize("bad", [
    "--orchestrator", "-x", "ünïcode", "orchestrator;reboot", "svc name",
    "a/b", "a" * 65, "", None, 7,
])
def test_collect_logs_drops_an_out_of_shape_service_filter(monkeypatch, bad):
    """Anything outside [A-Za-z0-9_][A-Za-z0-9_-]{0,63} becomes "" — the script
    reads that as "all services" — and never reaches argv."""
    bridge = _load_bridge(monkeypatch)
    captured = _capture_run(monkeypatch, bridge)
    bridge.collect_logs(24, bad)
    assert captured["cmd"][2] == ""
