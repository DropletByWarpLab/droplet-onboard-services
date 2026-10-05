"""WARP-3513 — the bridge's machine-readable Prepare refusals and the
recovery-key regenerate op.

Two additions to the `/pools/command` path, both decided in ADR-070:

  * Prepare REQUIRES a TPM2 (and an encrypted /data to hold the recovery key).
    The root host script refuses BEFORE touching anything with a dedicated exit
    code — 75 tpm_required, 76 encrypted_data_required. The bridge turns the
    EXIT CODE (never a substring of the human message) into a `code`, answers
    HTTP 409 instead of 422, and the orchestrator maps it to the owner-facing
    `409 tpm_required`.
  * `recovery_key_regenerate` ("Regenerate recovery key", owner + Tier 3) is a
    second UUID-only op next to the one-time reveal: same uuid validation, no
    cache invalidation, and its reply carries NO key.

The one-time reveal's own guarantees (never logged, spool file zeroed, ...) are
pinned in test_device_bridge_recovery_key.py. Keys here are obviously fake.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from test_device_bridge_recovery_key import (  # the shared fake-executor harness
    _FS_UUID,
    _fake_executor,
    _forbid_run,
    _http_post,
    _load_bridge_with_spool,
)

_REGEN_OK = json.dumps({"ok": True, "operation": "recovery_key_regenerate",
                        "status": "regenerated", "uuid": _FS_UUID,
                        "recovery_key_pending": True})


# --- refusal codes ------------------------------------------------------------

@pytest.mark.parametrize("rc,code", [(75, "tpm_required"),
                                     (76, "encrypted_data_required")])
def test_a_machine_refusal_exit_code_becomes_a_code(rc, code, monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(
        spool, rc=rc, stderr="droplet-storage-pool: refusing: this box has no TPM2 device")
    monkeypatch.setattr(bridge, "_run", fake_run)

    ok, info, got = bridge.run_pool_command_ex("drive_adopt", {
        "device": "sdb", "confirm_phrase": "ERASE sdb"})

    assert ok is False
    assert got == code
    assert "TPM2" in info, "the human message still travels with the code"


def test_run_pool_command_keeps_its_two_element_contract(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, rc=75, stderr="refusing: no TPM2")
    monkeypatch.setattr(bridge, "_run", fake_run)
    result = bridge.run_pool_command("drive_adopt", {
        "device": "sdb", "confirm_phrase": "ERASE sdb"})
    assert result == (False, "refusing: no TPM2")


@pytest.mark.parametrize("rc", [1, 2, 74, 80, 126])
def test_every_other_failure_has_no_code(rc, monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, rc=rc, stderr="refusing: /dev/sdb is mounted")
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info, code = bridge.run_pool_command_ex("drive_adopt", {
        "device": "sdb", "confirm_phrase": "ERASE sdb"})
    assert ok is False and code == ""


def test_a_message_that_merely_mentions_tpm_is_not_a_code(monkeypatch, tmp_path):
    # The code is keyed on the exit code, "NEVER a substring of the human
    # message" (the WARP-834 rule the hostapd path follows too).
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(
        spool, rc=1, stderr="refusing: tpm_required encrypted_data_required")
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, _info, code = bridge.run_pool_command_ex("drive_adopt", {
        "device": "sdb", "confirm_phrase": "ERASE sdb"})
    assert ok is False and code == ""


def test_success_and_unknown_op_carry_no_code(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout='{"ok": true}')
    monkeypatch.setattr(bridge, "_run", fake_run)
    assert bridge.run_pool_command_ex("drive_adopt", {
        "device": "sdb", "confirm_phrase": "ERASE sdb"})[2] == ""
    assert bridge.run_pool_command_ex("rm_rf", {}) == (
        False, "unknown pool operation: rm_rf", "")


@pytest.mark.parametrize("rc,code", [(75, "tpm_required"),
                                     (76, "encrypted_data_required")])
def test_http_answers_409_with_the_code(rc, code, monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, rc=rc, stderr="refusing: nothing was erased")
    monkeypatch.setattr(bridge, "_run", fake_run)

    status, body, _raw = _http_post(bridge, {
        "operation": "drive_adopt",
        "params": {"device": "sdb", "confirm_phrase": "ERASE sdb"}})

    assert status == 409
    assert body == {"ok": False, "error": "refusing: nothing was erased",
                    "code": code}


def test_http_keeps_422_for_an_ordinary_refusal(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, rc=1, stderr="refusing: /dev/sdb is mounted")
    monkeypatch.setattr(bridge, "_run", fake_run)
    status, body, _raw = _http_post(bridge, {
        "operation": "drive_adopt",
        "params": {"device": "sdb", "confirm_phrase": "ERASE sdb"}})
    assert status == 422
    assert body == {"ok": False, "error": "refusing: /dev/sdb is mounted"}


@pytest.mark.parametrize("rc,code,status", [
    (77, "recordings_drive_active", 409),
    (78, "recordings_status_unavailable", 503),
    (79, "storage_busy", 409),
])
def test_http_preserves_final_executor_topology_refusals(rc, code, status, monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, rc=rc, stderr="internal /dev/sdb mount diagnostics")
    monkeypatch.setattr(bridge, "_run", fake_run)
    actual_status, body, _raw = _http_post(bridge, {
        "operation": "drive_adopt", "params": {"device": "sdb", "confirm_phrase": "ERASE sdb"}})
    assert actual_status == status and body["code"] == code and body["ok"] is False
    assert "internal" not in body["error"] and "/dev/sdb" not in body["error"]


# --- recovery_key_regenerate --------------------------------------------------

def test_regenerate_goes_via_spool_with_only_the_validated_uuid(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, seen = _fake_executor(spool, stdout=_REGEN_OK)
    monkeypatch.setattr(bridge, "_run", fake_run)

    ok, info = bridge.run_pool_command("recovery_key_regenerate", {
        "uuid": _FS_UUID, "device": "sdb", "confirm_phrase": "x", "junk": 1})

    assert ok is True
    assert info["status"] == "regenerated" and info["recovery_key_pending"] is True
    assert "recovery_key" not in info
    assert seen["request"]["operation"] == "recovery_key_regenerate"
    assert seen["request"]["params"] == {"uuid": _FS_UUID}


@pytest.mark.parametrize("bad", [None, "", "short", "../../etc", "a b",
                                 "z" * 12, "x" * 65, 5, ["a"]])
def test_regenerate_refuses_a_malformed_uuid_without_spooling(bad, monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    _forbid_run(bridge, monkeypatch, "a malformed uuid must never reach the executor")
    params = {} if bad is None else {"uuid": bad}
    ok, info = bridge.run_pool_command("recovery_key_regenerate", params)
    assert ok is False
    assert info == "invalid uuid for recovery key regenerate"
    assert not (spool / "request.json").exists()


def test_regenerate_does_not_invalidate_the_topology_caches(monkeypatch, tmp_path):
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    fake_run, _ = _fake_executor(spool, stdout=_REGEN_OK)
    monkeypatch.setattr(bridge, "_run", fake_run)
    calls = []
    monkeypatch.setattr(bridge, "pools_snapshot", lambda invalidate=False: calls.append("pools"))
    monkeypatch.setattr(bridge, "drives_snapshot", lambda invalidate=False: calls.append("drives"))
    ok, _ = bridge.run_pool_command("recovery_key_regenerate", {"uuid": _FS_UUID})
    assert ok is True
    assert calls == [], "regenerate changes no drive/pool topology"


def test_regenerate_failure_message_is_passed_on_to_the_owner(monkeypatch, tmp_path):
    # Unlike the reveal, its reply carries no key, so the host's actionable
    # message ("... run Regenerate again to retry") must reach the caller.
    bridge, spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    msg = "the new recovery key is escrowed, but the old recovery keyslot 2 could not be wiped — run Regenerate again to retry"
    fake_run, _ = _fake_executor(spool, rc=1, stderr=msg)
    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_pool_command("recovery_key_regenerate", {"uuid": _FS_UUID})
    assert ok is False and info == msg


def test_regenerate_needs_the_bridge_auth_token(monkeypatch, tmp_path):
    bridge, _spool = _load_bridge_with_spool(monkeypatch, tmp_path)
    _forbid_run(bridge, monkeypatch, "an unauthenticated call must not reach the executor")
    status, body, _raw = _http_post(
        bridge, {"operation": "recovery_key_regenerate", "params": {"uuid": _FS_UUID}},
        token=None)
    assert status == 401
    assert body["ok"] is False
