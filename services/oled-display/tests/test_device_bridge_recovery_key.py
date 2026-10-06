"""WARP-3513 — the one-time LUKS recovery-key reveal, through the device-bridge.

The recovery key is the one secret that can decrypt a bay drive without the TPM.
It is escrowed HOST-ONLY (root, 0600) and leaves the host exactly once, through
the new `recovery_key_reveal` pool op:

  orchestrator --(bridge auth)--> POST /pools/command
    -> run_pool_command -> spool -> root apply unit -> droplet-storage-pool.sh
    <- result.json {"rc": 0, "stdout": "{... \"recovery_key\": \"...\"}"}

What the bridge owes that path (and what this file pins):
  * `recovery_key_reveal` is on the allow-list, a READ-AND-CONSUME op — it does
    not change drive/pool topology, so no cache invalidation;
  * `params.uuid` is validated BEFORE anything is spooled;
  * the key is NEVER logged — not on success, not when the script misbehaves,
    not by the HTTP layer — and never echoed in an error message;
  * the key lives nowhere but the /run tmpfs spool result file the executor
    already creates, and the bridge deletes that file right after reading it.

Test keys here are obviously fake. NEVER put a real key in this file.
"""

from __future__ import annotations

import importlib.util
import io
import json
import logging
import os
import traceback
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"

_FS_UUID = "5b0e6c1e-0b0a-4c8e-9a53-7f3b1c2d4e5f"
# Obviously fake. The short marker is asserted absent too, so a TRUNCATED or
# re-formatted leak of the key is caught, not just the exact string.
_FAKE_KEY = "cccccc-fakefake-fakefake-fakefake-fakefake-fakefake-fakefake-fakefake"
_KEY_MARKER = "fakefake"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_recovery_key_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_bridge_with_spool(monkeypatch, tmp_path):
    spool = tmp_path / "pool-spool"
    bridge = _load_bridge(monkeypatch, {"DROPLET_POOL_SPOOL_DIR": str(spool)})
    return bridge, spool


def _fake_executor(spool: Path, *, rc: int = 0, stdout: str = "", stderr: str = "",
                   request_id: str | None = None, write_result: bool = True,
                   start_rc: int = 0, start_err: str = ""):
    """A fake `_run` playing droplet-storage-pool-apply.sh: assert the bridge
    asked systemd (never the pool script itself), consume request.json, write
    result.json like the real executor. `start_rc != 0` models the unit failing
    AFTER it wrote a result (the leftover must not survive)."""
    seen: dict = {"calls": 0}

    def fake_run(cmd, timeout=15):
        if len(cmd) == 2 and cmd[1] == "--status":
            return 0, json.dumps({"kind": "volume", "source": "nvrdata"}), ""
        if cmd and cmd[0] == "lsblk":
            return 1, "", "lsblk unavailable in tests"
        seen["calls"] += 1
        assert cmd[0] == "systemctl" and cmd[1] == "start", cmd
        assert "droplet-storage-pool-apply.service" in cmd[2]
        req_file = spool / "request.json"
        assert req_file.exists(), "bridge must spool the request before starting"
        seen["request"] = json.loads(req_file.read_text())
        req_file.unlink()
        if write_result:
            rid = request_id if request_id is not None \
                else seen["request"]["request_id"]
            (spool / "result.json").write_text(json.dumps({
                "request_id": rid, "rc": rc, "stdout": stdout, "stderr": stderr,
            }))
            seen["result_bytes"] = (spool / "result.json").read_bytes()
        return start_rc, "", start_err

    return fake_run, seen


def _reveal_stdout(status: str = "revealed", key: str = _FAKE_KEY,
                   uuid: str = _FS_UUID) -> str:
    # The host script's contract: `recovery_key` is present ONLY when revealed.
    body = {"ok": True, "operation": "recovery_key_reveal", "status": status,
            "uuid": uuid}
    if status == "revealed":
        body["recovery_key"] = key
    return json.dumps(body)


@pytest.mark.parametrize("rc,code", [
    (77, "recordings_drive_active"), (78, "recordings_status_unavailable"),
    (79, "storage_busy"),
])
def test_final_executor_recordings_refusals_preserve_codes_and_hide_host_diagnostics(monkeypatch, tmp_path, rc, code):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(spool, rc=rc, stderr="internal /dev/sdb /mnt/private details")
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info, actual_code = bridge.run_pool_command_ex("pool_destroy", {"device": "md0"})
    assert ok is False and actual_code == code
    assert "internal" not in info and "/dev/sdb" not in info and "/mnt/private" not in info
    assert seen["calls"] == 1
    assert not (spool / "result.json").exists()


def _forbid_run(bridge, monkeypatch, why: str):
    def boom(cmd, timeout=15):
        raise AssertionError(why)
    monkeypatch.setattr(bridge, "_run", boom)


def _logged_text(caplog) -> str:
    """Everything any log record could carry: message, raw args, traceback."""
    parts = [caplog.text]
    for rec in caplog.records:
        parts.append(rec.getMessage())
        parts.append(repr(rec.args))
        parts.append(rec.name)
        if rec.exc_info:
            parts.append("".join(traceback.format_exception(*rec.exc_info)))
        if rec.exc_text:
            parts.append(rec.exc_text)
    return "\n".join(parts)


def _capture_everything(caplog):
    """DEBUG on the root logger AND the bridge's own logger, so neither the
    default level nor a per-logger level can hide a record."""
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.DEBUG, logger="droplet.bridge")


def _assert_capture_is_live(bridge, caplog):
    # Guard against a vacuous pass: prove a DEBUG record from the bridge's
    # logger is actually captured before asserting the key is absent.
    bridge.logger.debug("canary-record-proves-capture")
    assert "canary-record-proves-capture" in caplog.text


# ---------------------------------------------------------------------------
# The allow-list
# ---------------------------------------------------------------------------

def test_recovery_key_reveal_is_on_the_allow_list(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert "recovery_key_reveal" in bridge._POOL_OPS


def test_allow_list_is_exactly_the_known_operations(monkeypatch):
    # Pinned so adding an op is a conscious, reviewed change — this list is the
    # whole of what the sandboxed bridge will hand to the root executor.
    bridge = _load_bridge(monkeypatch)
    assert bridge._POOL_OPS == frozenset({
        "pool_create", "pool_destroy", "pool_format", "pool_set_level",
        "pool_add_spare", "pool_remove_disk", "drive_adopt", "drive_reclaim",
        "recovery_key_reveal", "recovery_key_regenerate",
    })


# ---------------------------------------------------------------------------
# Happy path + the other two host statuses
# ---------------------------------------------------------------------------

def test_reveal_goes_via_spool_and_returns_the_key_to_the_caller(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)

    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})

    assert ok is True
    assert info["status"] == "revealed"
    assert info["recovery_key"] == _FAKE_KEY
    assert info["uuid"] == _FS_UUID
    assert seen["request"]["operation"] == "recovery_key_reveal"
    assert seen["request"]["params"] == {"uuid": _FS_UUID}
    assert seen["request"]["request_id"]


def test_reveal_forwards_only_the_validated_uuid(monkeypatch, tmp_path):
    # Anything else the caller tucked into params never reaches the root script.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, _ = bridge.run_pool_command("recovery_key_reveal", {
        "uuid": _FS_UUID, "path": "/etc/shadow", "confirm_phrase": "x"})
    assert ok is True
    assert seen["request"]["params"] == {"uuid": _FS_UUID}


@pytest.mark.parametrize("status", ["already_retrieved", "not_found"])
def test_reveal_non_revealed_statuses_pass_through_without_a_key(
    monkeypatch, tmp_path, status,
):
    # rc 0 for all three statuses: the bridge reports them as the success the
    # script says they are, and no key is invented.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_reveal_stdout(status))
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is True
    assert info["status"] == status
    assert "recovery_key" not in info


# ---------------------------------------------------------------------------
# params.uuid is validated BEFORE anything is spooled
# ---------------------------------------------------------------------------

_GOOD_UUIDS = [
    "5b0e6c1e",                                          # 8 — the minimum
    "5B0E6C1E-0B0A-4C8E-9A53-7F3B1C2D4E5F",              # upper case + dashes
    _FS_UUID,
    "a" * 64,                                            # 64 — the maximum
]

_BAD_UUIDS = [
    "", "abc", "1234567",                                # shorter than 8
    "a" * 65,                                            # longer than 64
    "g" * 12, "zz1234567890", "not-a-uuid-at-all",       # non-hex letters
    "../../etc/passwd", "5b0e6c1e/../x", "5b0e6c1e0b0a/",
    "5b0e6c1e 0b0a", "5b0e6c1e;rm -rf /", "5b0e6c1e$(id)",
    "5b0e6c1e\n",                                        # `$` would let this pass
    "\n5b0e6c1e", "5b0e6c1e0b0a\x00",
    chr(0x0663) + "b0e6c1e0b0a",                         # ARABIC-INDIC digit three
    "5b0e6c1e_0b0a",                                     # underscore is not hex
]


@pytest.mark.parametrize("uuid", _BAD_UUIDS)
def test_reveal_refuses_a_malformed_uuid_without_spooling(
    monkeypatch, tmp_path, caplog, uuid,
):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    _forbid_run(bridge, monkeypatch, "executor started for a malformed uuid")
    _capture_everything(caplog)
    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": uuid})
    assert ok is False
    assert isinstance(info, str) and 0 < len(info) <= 80, "a SHORT message"
    assert not spool.exists(), "nothing may be spooled (not even the directory)"
    # The offending value is never echoed back or written to the log.
    if uuid.strip():
        assert uuid not in info
        assert uuid not in _logged_text(caplog)
    # ... and the pool lock was never taken: a valid request can still proceed.
    assert bridge._POOL_LOCK.acquire(blocking=False)
    bridge._POOL_LOCK.release()


@pytest.mark.parametrize("params", [
    None, {}, [], "5b0e6c1e0b0a", 5, {"uuid": None}, {"uuid": 123456789},
    {"uuid": ["5b0e6c1e0b0a"]}, {"uuid": {"x": 1}}, {"uuid": True},
    {"UUID": _FS_UUID}, {"fsUuid": _FS_UUID},
])
def test_reveal_refuses_missing_or_non_string_uuid_without_spooling(
    monkeypatch, tmp_path, params,
):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    _forbid_run(bridge, monkeypatch, "executor started for a bad params shape")
    ok, info = bridge.run_pool_command("recovery_key_reveal", params)
    assert ok is False
    assert isinstance(info, str) and info
    assert not spool.exists()


@pytest.mark.parametrize("uuid", _GOOD_UUIDS)
def test_reveal_accepts_well_formed_uuids(monkeypatch, tmp_path, uuid):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(spool, stdout=_reveal_stdout(uuid=uuid))
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, _info = bridge.run_pool_command("recovery_key_reveal", {"uuid": uuid})
    assert ok is True
    assert seen["request"]["params"] == {"uuid": uuid}


def test_other_operations_are_not_subject_to_the_uuid_rule(monkeypatch, tmp_path):
    # The validation is specific to the reveal op: the existing ops still pass
    # their params through verbatim (no `uuid` required).
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(spool, stdout='{"ok": true, "device": "sdb"}')
    monkeypatch.setattr(bridge, "_run", fake_run)
    _record_snapshots(bridge, monkeypatch)
    ok, _ = bridge.run_pool_command("drive_adopt", {
        "device": "sdb", "fstype": "ext4", "wipe_method": "quick",
        "confirm_phrase": "ERASE sdb"})
    assert ok is True
    assert seen["request"]["params"]["device"] == "sdb"


def test_reveal_still_respects_the_single_in_flight_lock(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    _forbid_run(bridge, monkeypatch, "second writer must be refused before systemctl")
    assert bridge._POOL_LOCK.acquire(blocking=False)
    try:
        ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    finally:
        bridge._POOL_LOCK.release()
    assert ok is False
    assert "in progress" in info
    assert not (spool / "request.json").exists()


# ---------------------------------------------------------------------------
# A read-and-consume op: no pools/drives cache invalidation
# ---------------------------------------------------------------------------

def _record_snapshots(bridge, monkeypatch):
    calls = []
    monkeypatch.setattr(bridge, "pools_snapshot",
                        lambda invalidate=False: calls.append(("pools", invalidate)) or {})
    monkeypatch.setattr(bridge, "drives_snapshot",
                        lambda invalidate=False: calls.append(("drives", invalidate)) or {})
    return calls


def test_reveal_does_not_invalidate_the_pools_or_drives_caches(monkeypatch, tmp_path):
    # Nothing about topology changed — burning the 10 s caches (and re-running
    # lsblk) for a key read would be pure cost.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)
    calls = _record_snapshots(bridge, monkeypatch)
    ok, _ = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is True
    assert calls == []


def test_data_changing_ops_still_invalidate_both_caches(monkeypatch, tmp_path):
    # Control for the test above: the skip is specific to the reveal op.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout='{"ok": true}')
    monkeypatch.setattr(bridge, "_run", fake_run)
    calls = _record_snapshots(bridge, monkeypatch)
    ok, _ = bridge.run_pool_command("drive_adopt", {
        "device": "sdb", "fstype": "ext4", "wipe_method": "quick",
        "confirm_phrase": "ERASE sdb"})
    assert ok is True
    assert ("pools", True) in calls and ("drives", True) in calls


@pytest.mark.parametrize("op, params", [
    ("drive_adopt", {"device": "sdb", "confirm_phrase": "ERASE sdb"}),
    ("drive_reclaim", {"device": "sda", "md": "md127", "confirm_phrase": "ERASE sda"}),
    ("pool_format", {"device": "md127", "confirm_phrase": "ERASE md127"}),
])
def test_prepare_ops_pass_the_encryption_result_through_without_a_key(
    monkeypatch, tmp_path, op, params,
):
    # The prepare success JSON gains encrypted/uuid/recovery_key_pending (never
    # the key itself). The bridge is a transparent pipe for them.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    stdout = json.dumps({"ok": True, "operation": op, "encrypted": True,
                         "uuid": _FS_UUID, "recovery_key_pending": True})
    fake_run, _ = _fake_executor(spool, stdout=stdout)
    monkeypatch.setattr(bridge, "_run", fake_run)
    _record_snapshots(bridge, monkeypatch)
    ok, info = bridge.run_pool_command(op, params)
    assert ok is True
    assert info["encrypted"] is True
    assert info["uuid"] == _FS_UUID
    assert info["recovery_key_pending"] is True
    assert "recovery_key" not in info


# ---------------------------------------------------------------------------
# NEVER log the key — success, script failure, garbage
# ---------------------------------------------------------------------------

def test_the_key_is_never_logged_on_the_whole_run_pool_command_path(
    monkeypatch, tmp_path, caplog,
):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)
    _capture_everything(caplog)
    _assert_capture_is_live(bridge, caplog)

    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})

    assert ok is True and info["recovery_key"] == _FAKE_KEY  # the key DID travel
    text = _logged_text(caplog)
    assert _FAKE_KEY not in text
    assert _KEY_MARKER not in text
    for rec in caplog.records:
        assert _KEY_MARKER not in rec.getMessage()
        assert _KEY_MARKER not in repr(rec.args)


def test_a_script_that_prints_the_key_then_fails_is_not_logged_or_echoed(
    monkeypatch, tmp_path, caplog,
):
    # Worst case: the root script emits the key on stdout and then exits
    # non-zero. The failure path used to log (and return) stdout verbatim; for
    # this op it must do neither.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(
        spool, rc=1, stdout=_reveal_stdout(),
        stderr="tombstone write failed for " + _FAKE_KEY)
    monkeypatch.setattr(bridge, "_run", fake_run)
    _capture_everything(caplog)
    _assert_capture_is_live(bridge, caplog)

    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})

    assert ok is False
    assert _KEY_MARKER not in str(info)
    assert str(info), "the caller still gets a (generic) reason"
    assert _KEY_MARKER not in _logged_text(caplog)
    # The failure itself is still logged — just without the output.
    assert any(r.levelno >= logging.WARNING and "recovery_key_reveal" in r.getMessage()
               for r in caplog.records)
    assert not (spool / "result.json").exists()


def test_a_non_json_result_is_not_echoed_or_logged(monkeypatch, tmp_path, caplog):
    # rc 0 but stdout is not the contract JSON (e.g. the bare key). The
    # non-secret ops fall back to {"message": <stdout>}; for the reveal op that
    # would hand the raw text back — and a bare key — so it fails closed.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_FAKE_KEY + "\n")
    monkeypatch.setattr(bridge, "_run", fake_run)
    _capture_everything(caplog)
    _assert_capture_is_live(bridge, caplog)

    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})

    assert ok is False
    assert _KEY_MARKER not in str(info)
    assert _KEY_MARKER not in _logged_text(caplog)
    assert not (spool / "result.json").exists()


def test_a_non_object_result_is_refused_for_the_reveal_op(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=json.dumps([_FAKE_KEY]))
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is False
    assert _KEY_MARKER not in str(info)


def test_executor_start_failure_never_logs_the_key(monkeypatch, tmp_path, caplog):
    # systemctl failed AFTER the unit wrote a result (a crash on the way out).
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(
        spool, stdout=_reveal_stdout(), start_rc=1,
        start_err="Job for droplet-storage-pool-apply.service failed")
    monkeypatch.setattr(bridge, "_run", fake_run)
    _capture_everything(caplog)
    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is False
    assert "failed" in info
    assert _KEY_MARKER not in _logged_text(caplog)


def test_other_ops_failure_messages_are_unchanged(monkeypatch, tmp_path):
    # The secret-op hardening must not change what the existing ops report.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(
        spool, rc=3, stdout="partial out", stderr="refusing: /dev/sda is mounted at /")
    monkeypatch.setattr(bridge, "_run", fake_run)
    _record_snapshots(bridge, monkeypatch)
    ok, info = bridge.run_pool_command("drive_adopt", {
        "device": "sda", "confirm_phrase": "ERASE sda"})
    assert ok is False
    assert info == "refusing: /dev/sda is mounted at /"
    # ... and a non-JSON stdout still degrades to {"message": ...} for them.
    fake_run2, _ = _fake_executor(spool, stdout="all done\n")
    monkeypatch.setattr(bridge, "_run", fake_run2)
    ok2, info2 = bridge.run_pool_command("drive_adopt", {
        "device": "sdb", "confirm_phrase": "ERASE sdb"})
    assert ok2 is True and info2 == {"message": "all done"}


# ---------------------------------------------------------------------------
# The key is written nowhere but the spool result file — and that is deleted
# ---------------------------------------------------------------------------

def _spool_listing(spool: Path):
    return sorted(p.name for p in spool.iterdir()) if spool.exists() else []


def test_result_json_is_gone_after_a_successful_reveal(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is True and info["recovery_key"] == _FAKE_KEY
    assert not (spool / "result.json").exists()
    assert _spool_listing(spool) == [], "no request/result/tmp file left behind"


def test_result_json_is_gone_when_the_result_is_unreadable(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)

    def fake_run(cmd, timeout=15):
        req = spool / "request.json"
        req.unlink()
        # A truncated write that still contains key text.
        (spool / "result.json").write_text('{"request_id": "x", "stdout": "' + _FAKE_KEY)
        return 0, "", ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, _ = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is False
    assert _spool_listing(spool) == []


def test_result_json_is_gone_when_the_request_id_does_not_match(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_reveal_stdout(),
                                 request_id="someone-elses")
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is False
    assert _KEY_MARKER not in str(info)
    assert _spool_listing(spool) == []


def test_result_json_is_gone_when_the_script_failed(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, rc=2, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, _ = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is False
    assert _spool_listing(spool) == []


def test_result_json_is_removed_even_when_systemctl_start_fails_after_writing_it(
    monkeypatch, tmp_path,
):
    # The executor-level failure path used to remove only the request; a result
    # the unit managed to write before dying (holding a key) stayed on disk
    # until the next op's stale sweep.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_reveal_stdout(), start_rc=1,
                                 start_err="unit failed")
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, _ = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is False
    assert _spool_listing(spool) == []


def _spy_on_removals(bridge, monkeypatch, name: str = "result.json"):
    """Record the bytes `name` holds at the instant the bridge unlinks it — what
    a plain unlink would leave behind in the freed blocks."""
    held: list[bytes] = []
    real_remove = os.remove

    def spy(path, *a, **kw):
        p = Path(path)
        if p.name == name and p.is_file():
            held.append(p.read_bytes())
        return real_remove(path, *a, **kw)

    monkeypatch.setattr(bridge.os, "remove", spy)
    return held


def test_result_json_is_zeroed_before_it_is_unlinked_for_the_reveal_op(
    monkeypatch, tmp_path,
):
    # The spool lives on the OS disk, which is NOT encrypted: a plain unlink
    # would leave the recovery key in the freed blocks. So the bridge overwrites
    # the file with zeros (same length) before removing it.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)
    held = _spy_on_removals(bridge, monkeypatch)
    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is True and info["recovery_key"] == _FAKE_KEY
    assert _FAKE_KEY.encode() in seen["result_bytes"], "the executor DID write the key"
    assert held == [b"\0" * len(seen["result_bytes"])], (
        "at unlink time the file must hold only zeros, same length")
    assert not (spool / "result.json").exists()


@pytest.mark.parametrize("scenario", ["script_failed", "unreadable", "wrong_request_id",
                                      "start_failed"])
def test_result_json_is_zeroed_on_every_exit_path_of_the_reveal_op(
    monkeypatch, tmp_path, scenario,
):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    if scenario == "unreadable":
        text = '{"request_id": "x", "stdout": "' + _FAKE_KEY  # truncated, holds the key

        def fake_run(cmd, timeout=15):
            (spool / "request.json").unlink()
            (spool / "result.json").write_text(text)
            return 0, "", ""

        written = text.encode()
    else:
        kwargs = {
            "script_failed": {"rc": 2},
            "wrong_request_id": {"request_id": "someone-elses"},
            "start_failed": {"start_rc": 1, "start_err": "unit failed"},
        }[scenario]
        fake_run, seen = _fake_executor(spool, stdout=_reveal_stdout(), **kwargs)
        written = None
    monkeypatch.setattr(bridge, "_run", fake_run)
    held = _spy_on_removals(bridge, monkeypatch)
    ok, _info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is False
    assert len(held) == 1
    assert set(held[0]) == {0}, "only zeros may be left at unlink time"
    if written is not None:
        assert len(held[0]) == len(written)
    assert not (spool / "result.json").exists()


def test_a_stale_result_from_an_interrupted_run_is_zeroed_by_the_next_op(
    monkeypatch, tmp_path,
):
    # The bridge died between the executor writing result.json and reading it:
    # the key sits in the spool until the next pool op's stale sweep. That sweep
    # wipes it, whatever op comes next.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    spool.mkdir()
    stale = json.dumps({"request_id": "gone", "rc": 0,
                        "stdout": _reveal_stdout(), "stderr": ""})
    (spool / "result.json").write_text(stale)
    fake_run, _ = _fake_executor(spool, stdout='{"ok": true}')
    monkeypatch.setattr(bridge, "_run", fake_run)
    _record_snapshots(bridge, monkeypatch)
    held = _spy_on_removals(bridge, monkeypatch)
    ok, _ = bridge.run_pool_command("drive_adopt", {
        "device": "sdb", "confirm_phrase": "ERASE sdb"})
    assert ok is True
    assert held and set(held[0]) == {0}, "the stale result was zeroed before removal"
    assert len(held[0]) == len(stale)


def test_other_ops_results_are_removed_without_being_rewritten(monkeypatch, tmp_path):
    # The wipe is specific to secret-bearing results: no extra I/O (and no
    # behaviour change) for the existing ops.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(spool, stdout='{"ok": true, "device": "sdb"}')
    monkeypatch.setattr(bridge, "_run", fake_run)
    _record_snapshots(bridge, monkeypatch)
    held = _spy_on_removals(bridge, monkeypatch)
    ok, _ = bridge.run_pool_command("drive_adopt", {
        "device": "sdb", "confirm_phrase": "ERASE sdb"})
    assert ok is True
    assert held == [seen["result_bytes"]]


def test_the_wipe_is_best_effort_and_never_blocks_the_removal(monkeypatch, tmp_path):
    # If the file cannot be opened for overwriting, the key is still returned
    # and the file is still unlinked — the wipe is defence in depth, not a gate.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)

    def refuse(*a, **kw):
        raise PermissionError("no overwrite for you")

    monkeypatch.setattr(bridge.os, "open", refuse)
    ok, info = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is True and info["recovery_key"] == _FAKE_KEY
    assert not (spool / "result.json").exists()


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="O_NOFOLLOW is POSIX-only")
def test_the_wipe_never_follows_a_symlink(monkeypatch, tmp_path):
    # A planted result.json symlink must not turn the wipe into "zero any file
    # the bridge user can write".
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    spool.mkdir()
    victim = tmp_path / "victim.txt"
    victim.write_text("keep me")
    try:
        os.symlink(victim, spool / "result.json")
    except (OSError, NotImplementedError):
        pytest.skip("cannot create symlinks here")
    bridge._wipe_file(str(spool / "result.json"))
    assert victim.read_text() == "keep me"


def test_wipe_file_tolerates_a_missing_file_and_zeroes_a_real_one(monkeypatch, tmp_path):
    bridge = _load_bridge(monkeypatch)
    bridge._wipe_file(str(tmp_path / "does-not-exist"))  # no-op, no raise
    target = tmp_path / "secret.bin"
    payload = b"s3cret-" * 20000  # larger than one write chunk
    target.write_bytes(payload)
    bridge._wipe_file(str(target))
    assert target.read_bytes() == b"\0" * len(payload)


def test_the_bridge_writes_the_key_to_no_file_other_than_the_spool_result(
    monkeypatch, tmp_path,
):
    # Walk everything under tmp_path after the call: no file anywhere contains
    # the key (the spool result was deleted; the bridge persists nothing else).
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, _ = bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert ok is True
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert _KEY_MARKER not in path.read_text(errors="replace"), path


def test_a_request_never_contains_the_key(monkeypatch, tmp_path):
    # The spooled REQUEST carries only the uuid; the key only ever flows back.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)
    bridge.run_pool_command("recovery_key_reveal", {"uuid": _FS_UUID})
    assert _KEY_MARKER not in json.dumps(seen["request"])


# ---------------------------------------------------------------------------
# HTTP: POST /pools/command — the REAL handler, no socket
# ---------------------------------------------------------------------------

class _Headers(dict):
    def get(self, k, default=None):
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


def _http_post(bridge, payload: dict, *, token: str | None = "pytest-bridge-token"):
    """Drive bridge.Handler.do_POST for real (real _send, real send_response,
    real log_message override); only the socket is replaced by in-memory
    streams. Returns (status, parsed_body, raw_response_bytes)."""
    body = json.dumps(payload).encode()
    h = bridge.Handler.__new__(bridge.Handler)
    h.rfile = io.BytesIO(body)
    h.wfile = io.BytesIO()
    h.headers = _Headers({"Content-Length": str(len(body)),
                          **({"X-Droplet-Auth": token} if token else {})})
    h.path = "/pools/command"
    h.command = "POST"
    h.request_version = "HTTP/1.1"
    h.requestline = "POST /pools/command HTTP/1.1"
    h.client_address = ("127.0.0.1", 50000)
    h.do_POST()
    raw = h.wfile.getvalue()
    head, _, payload_bytes = raw.partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1])
    return status, json.loads(payload_bytes or b"{}"), raw


def test_http_reveal_returns_the_key_and_logs_nothing(
    monkeypatch, tmp_path, caplog, capsys,
):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_reveal_stdout())
    monkeypatch.setattr(bridge, "_run", fake_run)
    _capture_everything(caplog)
    _assert_capture_is_live(bridge, caplog)
    capsys.readouterr()  # drop anything printed so far

    status, body, raw = _http_post(bridge, {
        "operation": "recovery_key_reveal", "params": {"uuid": _FS_UUID}})

    # The key reached the (authenticated) caller ...
    assert status == 200
    assert body["ok"] is True
    assert body["status"] == "revealed"
    assert body["recovery_key"] == _FAKE_KEY
    assert _FAKE_KEY.encode() in raw
    # ... and nowhere else: no log record, nothing on stdout/stderr (the stdlib
    # access log writes to stderr unless Handler.log_message is silenced).
    assert _KEY_MARKER not in _logged_text(caplog)
    printed = capsys.readouterr()
    assert _KEY_MARKER not in printed.out + printed.err
    assert printed.err == "", "the handler must not write an access line to stderr"
    assert not (spool / "result.json").exists()


def test_http_reveal_failure_returns_422_without_the_key(
    monkeypatch, tmp_path, caplog, capsys,
):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, rc=1, stdout=_reveal_stdout(),
                                 stderr="boom " + _FAKE_KEY)
    monkeypatch.setattr(bridge, "_run", fake_run)
    _capture_everything(caplog)
    capsys.readouterr()

    status, body, raw = _http_post(bridge, {
        "operation": "recovery_key_reveal", "params": {"uuid": _FS_UUID}})

    assert status == 422
    assert body["ok"] is False
    assert _KEY_MARKER.encode() not in raw
    assert _KEY_MARKER not in _logged_text(caplog)
    printed = capsys.readouterr()
    assert _KEY_MARKER not in printed.out + printed.err


def test_http_reveal_with_a_bad_uuid_is_422_and_never_reaches_the_executor(
    monkeypatch, tmp_path,
):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    _forbid_run(bridge, monkeypatch, "executor started for a malformed uuid")
    status, body, _raw = _http_post(bridge, {
        "operation": "recovery_key_reveal", "params": {"uuid": "../../etc/passwd"}})
    assert status == 422
    assert body["ok"] is False
    assert not spool.exists()


def test_http_reveal_requires_the_bridge_auth_token(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    _forbid_run(bridge, monkeypatch, "executor started for an unauthenticated request")
    for token in (None, "not-the-token"):
        status, body, raw = _http_post(bridge, {
            "operation": "recovery_key_reveal", "params": {"uuid": _FS_UUID}},
            token=token)
        assert status == 401
        assert body == {"ok": False, "error": "unauthorized"}
        assert b"recovery_key" not in raw
    assert not spool.exists()


def test_the_http_access_log_is_silenced(capsys):
    # The stdlib BaseHTTPRequestHandler.log_message writes every request line
    # to stderr. The bridge overrides it to a no-op; if that override is ever
    # dropped, request metadata (and anything echoed into it) starts landing in
    # the journal. Negative control first: the stdlib method DOES print.
    h = BaseHTTPRequestHandler.__new__(BaseHTTPRequestHandler)
    h.client_address = ("127.0.0.1", 1)
    BaseHTTPRequestHandler.log_message(h, "%s", "stdlib-access-line")
    assert "stdlib-access-line" in capsys.readouterr().err


def test_handler_log_message_override_prints_and_logs_nothing(
    monkeypatch, caplog, capsys,
):
    bridge = _load_bridge(monkeypatch)
    assert bridge.Handler.log_message is not BaseHTTPRequestHandler.log_message
    _capture_everything(caplog)
    h = bridge.Handler.__new__(bridge.Handler)
    h.client_address = ("127.0.0.1", 1)
    h.requestline = "POST /pools/command HTTP/1.1"
    capsys.readouterr()
    h.log_message('"%s" %s %s', h.requestline, "200", "123")
    h.log_request(200, 123)
    h.log_error("%s", "an error line")
    printed = capsys.readouterr()
    assert printed.out == "" and printed.err == ""
    assert not [r for r in caplog.records if r.name == "droplet.bridge"]
