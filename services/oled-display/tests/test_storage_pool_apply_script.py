"""Hermetic tests for the storage-pool ROOT executor (ADR-019 follow-up).

scripts/host/droplet-storage-pool-apply.sh is the ExecStart of the root
oneshot droplet-storage-pool-apply.service: it consumes the ONE request the
sandboxed bridge spooled into its StateDirectory, runs droplet-storage-pool.sh
as root, and writes a result file the bridge reads back. Under test here is
that contract:

  - the spooled operation + params reach the pool script verbatim;
  - the pool script's rc / stdout / stderr travel into result.json and the
    request is consumed — for refusals too (exit 0: a wrong confirm phrase
    must not leave a failed unit behind);
  - executor-level breakage (no request, malformed request) exits non-zero
    and writes NO result, so `systemctl start` fails honestly.

We never run the real pool script — DROPLET_POOL_SCRIPT points at a stub —
and the spool is a tmp dir via DROPLET_POOL_SPOOL_DIR. Skipped automatically
if bash isn't on PATH (same posture as test_storage_pool_script.py).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "scripts" / "host" / "droplet-storage-pool-apply.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def _write_stub(tmp_path: Path, body: str) -> Path:
    """A stand-in for droplet-storage-pool.sh the executor invokes."""
    stub = tmp_path / "pool-script-stub.sh"
    stub.write_text("#!/bin/bash\n" + body, encoding="utf-8", newline="\n")
    os.chmod(stub, 0o755)
    return stub


def _spool_request(spool: Path, operation="pool_create", params=None,
                   request_id="req-test-1", raw: str | None = None):
    spool.mkdir(parents=True, exist_ok=True)
    if raw is not None:
        (spool / "request.json").write_text(raw, encoding="utf-8")
        return
    (spool / "request.json").write_text(json.dumps({
        "request_id": request_id,
        "operation": operation,
        "params": params if params is not None else {"device": "md0"},
    }), encoding="utf-8")


def _run_apply(spool: Path, stub: Path):
    env = dict(os.environ)
    env.update({
        "DROPLET_POOL_SPOOL_DIR": str(spool),
        "DROPLET_POOL_SCRIPT": str(stub),
    })
    return subprocess.run(
        [BASH, str(SCRIPT)],
        env=env, capture_output=True, text=True, timeout=30,
    )


def test_script_exists_and_is_executable_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    first = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("#!") and "bash" in first


def test_happy_path_writes_result_and_consumes_request(tmp_path):
    spool = tmp_path / "spool"
    stub = _write_stub(tmp_path,
                       'printf \'{"ok": true, "device": "md0"}\\n\'\nexit 0\n')
    _spool_request(spool)
    proc = _run_apply(spool, stub)
    assert proc.returncode == 0, proc.stderr
    result = json.loads((spool / "result.json").read_text())
    assert result["request_id"] == "req-test-1"
    assert result["rc"] == 0
    assert json.loads(result["stdout"]).get("ok") is True
    # The request was consumed — it must never be re-applied.
    assert not (spool / "request.json").exists()


def test_operation_and_params_reach_the_pool_script_verbatim(tmp_path):
    spool = tmp_path / "spool"
    capture = tmp_path / "seen-args.txt"
    stub = _write_stub(
        tmp_path,
        'printf "%s\\n%s\\n" "$1" "$2" > "{}"\nexit 0\n'.format(
            str(capture).replace("\\", "/")))
    params = {"device": "md0", "level": "raid1",
              "members": ["/dev/sda", "/dev/sdb"],
              "confirm_phrase": "ERASE sda sdb"}
    _spool_request(spool, operation="pool_create", params=params)
    proc = _run_apply(spool, stub)
    assert proc.returncode == 0, proc.stderr
    op_line, params_line = capture.read_text().splitlines()[:2]
    assert op_line == "pool_create"
    # Round-trips as the same JSON object — one argument, nothing mangled.
    assert json.loads(params_line) == params


def test_pool_script_refusal_travels_in_result_with_exit_zero(tmp_path):
    """A pre-flight refusal is the OP failing, not the executor: rc/stderr go
    into result.json and the executor exits 0 so the oneshot unit doesn't land
    in a failed state on every wrong confirm phrase."""
    spool = tmp_path / "spool"
    stub = _write_stub(
        tmp_path,
        'echo "refusing: /dev/sda is mounted — unmount it first" >&2\nexit 3\n')
    _spool_request(spool, operation="pool_destroy",
                   params={"device": "md0", "confirm_phrase": "nope"})
    proc = _run_apply(spool, stub)
    assert proc.returncode == 0, proc.stderr
    result = json.loads((spool / "result.json").read_text())
    assert result["rc"] == 3
    assert "mounted" in result["stderr"]
    assert not (spool / "request.json").exists()


def test_no_spooled_request_is_executor_level_breakage(tmp_path):
    spool = tmp_path / "spool"
    spool.mkdir(parents=True)
    stub = _write_stub(tmp_path, "exit 0\n")
    proc = _run_apply(spool, stub)
    assert proc.returncode != 0
    assert "no spooled request" in proc.stderr
    assert not (spool / "result.json").exists()


def test_malformed_request_json_is_executor_level_breakage(tmp_path):
    spool = tmp_path / "spool"
    stub = _write_stub(tmp_path, "exit 0\n")
    _spool_request(spool, raw="{not json")
    proc = _run_apply(spool, stub)
    assert proc.returncode != 0
    assert "malformed" in proc.stderr
    # Fail-closed: no result, and the bad request is left for inspection.
    assert not (spool / "result.json").exists()
    assert (spool / "request.json").exists()


def test_request_without_operation_is_refused(tmp_path):
    spool = tmp_path / "spool"
    stub = _write_stub(tmp_path, "exit 0\n")
    _spool_request(spool, raw=json.dumps({"request_id": "r1", "params": {}}))
    proc = _run_apply(spool, stub)
    assert proc.returncode != 0
    assert "no operation" in proc.stderr
    assert not (spool / "result.json").exists()
