"""Unit tests for the device-bridge destructive storage-pool boundary (BUG-3).

The bridge NEVER runs mdadm/mkfs itself — and (ADR-019 follow-up) it never
execs droplet-storage-pool.sh either, because its sandbox (User=droplet +
ProtectSystem=strict + NoNewPrivileges) can't grant the root that script
needs. Instead it spools {request_id, operation, params} into its
StateDirectory and `systemctl start`s the root apply unit
(droplet-storage-pool-apply.service, polkit-authorized), which runs the host
script and writes a result file back. The bridge's job is (a) require auth on
the POST (mirrors /drives/:uuid/eject), (b) refuse unknown ops and concurrent
writes, (c) spool + start + collect, surfacing the host script's verdict
honestly.

We monkeypatch at the `_run` boundary so no systemctl, no mdadm, no host
script is ever actually executed in tests; the fake plays the executor's role
against a tmp spool dir.
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
    spec = importlib.util.spec_from_file_location("device_bridge_pool_ops_under_test",
                                                  _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_bridge_with_spool(monkeypatch, tmp_path):
    spool = tmp_path / "pool-spool"
    bridge = _load_bridge(monkeypatch,
                          {"DROPLET_POOL_SPOOL_DIR": str(spool)})
    return bridge, spool


def _fake_executor(spool: Path, rc: int = 0, stdout: str = "", stderr: str = "",
                   request_id: str | None = None, write_result: bool = True):
    """Build a fake `_run` that plays droplet-storage-pool-apply.sh's role:
    assert the bridge asked systemd (never mdadm/mkfs/the pool script), then
    consume request.json and write result.json like the real executor."""
    seen: dict = {}

    def fake_run(cmd, timeout=15):
        seen["cmd"] = cmd
        assert cmd[0] == "systemctl" and cmd[1] == "start", cmd
        assert "droplet-storage-pool-apply.service" in cmd[2]
        for tool in ("mdadm", "mkfs", "wipefs", "blkdiscard",
                     "droplet-storage-pool.sh"):
            assert all(tool not in str(part) for part in cmd)
        req_file = spool / "request.json"
        assert req_file.exists(), "bridge must spool the request before starting"
        seen["request"] = json.loads(req_file.read_text())
        req_file.unlink()
        if write_result:
            rid = request_id if request_id is not None \
                else seen["request"]["request_id"]
            (spool / "result.json").write_text(json.dumps({
                "request_id": rid, "rc": rc,
                "stdout": stdout, "stderr": stderr,
            }))
        return 0, "", ""

    return fake_run, seen


# ---------------------------------------------------------------------------
# run_pool_command() spools + starts the ROOT APPLY UNIT, never mdadm/mkfs
# (and never the pool script directly — the sandbox can't run it)
# ---------------------------------------------------------------------------

def test_pool_create_goes_via_spool_and_apply_unit(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(
        spool, rc=0, stdout='{"ok": true, "device": "md0"}')
    monkeypatch.setattr(bridge, "_run", fake_run)

    ok, info = bridge.run_pool_command("pool_create", {
        "device": "md0",
        "level": "raid1",
        "members": ["/dev/sda", "/dev/sdb"],
        "confirm_phrase": "ERASE sda sdb",
    })
    assert ok is True
    assert info.get("device") == "md0"
    # The spooled request carries the op + params verbatim for the executor.
    assert seen["request"]["operation"] == "pool_create"
    assert seen["request"]["params"]["members"] == ["/dev/sda", "/dev/sdb"]
    assert seen["request"]["request_id"]
    # The bridge consumed the result — nothing stale left in the spool.
    assert not (spool / "result.json").exists()
    assert not (spool / "request.json").exists()


def test_drive_adopt_goes_via_spool_and_apply_unit(monkeypatch, tmp_path):
    # WARP-662: drive_adopt is in the allow-list and rides the same spool +
    # root-apply-unit path — the bridge never runs wipefs/mkfs/blkdiscard.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(
        spool, rc=0, stdout='{"ok": true, "device": "sdb"}')
    monkeypatch.setattr(bridge, "_run", fake_run)

    ok, info = bridge.run_pool_command("drive_adopt", {
        "device": "sdb", "fstype": "ext4", "wipe_method": "quick",
        "confirm_phrase": "ERASE sdb",
    })
    assert ok is True
    assert seen["request"]["operation"] == "drive_adopt"


def test_pool_command_rejects_unknown_operation(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)

    def boom(cmd, timeout=15):
        raise AssertionError("executor invoked for an unknown operation")

    monkeypatch.setattr(bridge, "_run", boom)
    ok, info = bridge.run_pool_command("rm_rf_everything", {"device": "md0"})
    assert ok is False
    # Refused BEFORE anything was spooled.
    assert not (spool / "request.json").exists()


def test_pool_command_surfaces_host_script_refusal(monkeypatch, tmp_path):
    """When the host-script pre-flight refuses (non-zero rc in the result),
    the bridge surfaces the refusal as (False, ...) — it must NOT swallow it
    as success just because the apply unit itself started fine."""
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(
        spool, rc=3, stderr="refusing: /dev/sda is mounted at /")
    monkeypatch.setattr(bridge, "_run", fake_run)

    ok, info = bridge.run_pool_command("pool_create", {
        "device": "md0", "level": "raid1",
        "members": ["/dev/sda", "/dev/sdb"], "confirm_phrase": "ERASE sda sdb",
    })
    assert ok is False
    assert "mounted" in str(info)


def test_pool_command_never_raises(monkeypatch, tmp_path):
    bridge, _ = _load_bridge_with_spool(monkeypatch, tmp_path)

    def explode(cmd, timeout=15):
        raise OSError("systemctl not found")

    monkeypatch.setattr(bridge, "_run", explode)
    # Must degrade to (False, ...) rather than propagate — same contract as
    # eject_drive().
    ok, info = bridge.run_pool_command("pool_destroy", {
        "device": "md0", "confirm_phrase": "ERASE md0",
    })
    assert ok is False


def test_pool_command_busy_when_another_write_in_flight(monkeypatch, tmp_path):
    """The spool holds exactly one request/result pair, so a second POST while
    one is in flight is refused (non-blocking lock), never queued."""
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)

    def boom(cmd, timeout=15):
        raise AssertionError("second writer must be refused before systemctl")

    monkeypatch.setattr(bridge, "_run", boom)
    assert bridge._POOL_LOCK.acquire(blocking=False)
    try:
        ok, info = bridge.run_pool_command("pool_destroy", {
            "device": "md0", "confirm_phrase": "ERASE md0",
        })
    finally:
        bridge._POOL_LOCK.release()
    assert ok is False
    assert "in progress" in str(info)


def test_pool_command_executor_start_failure_cleans_request(monkeypatch, tmp_path):
    """systemctl start failing (polkit denied / unit missing) is surfaced
    honestly AND the unconsumed request is removed so a later start can't
    pick up a stale destructive op."""
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)

    def fake_run(cmd, timeout=15):
        return 1, "", "Failed to start droplet-storage-pool-apply.service: Access denied"

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_pool_command("pool_destroy", {
        "device": "md0", "confirm_phrase": "ERASE md0",
    })
    assert ok is False
    assert "denied" in str(info).lower()
    assert not (spool / "request.json").exists()


def test_pool_command_fails_when_executor_writes_no_result(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, write_result=False)
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_pool_command("pool_destroy", {
        "device": "md0", "confirm_phrase": "ERASE md0",
    })
    assert ok is False


def test_pool_command_ignores_result_for_a_different_request(monkeypatch, tmp_path):
    """A leftover result from some other run must never be reported as this
    op's outcome — the request_id has to match."""
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(
        spool, rc=0, stdout='{"ok": true}', request_id="someone-elses")
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_pool_command("pool_destroy", {
        "device": "md0", "confirm_phrase": "ERASE md0",
    })
    assert ok is False
    # And the stale result was discarded, not left to poison the next run.
    assert not (spool / "result.json").exists()


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
