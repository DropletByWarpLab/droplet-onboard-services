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
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "test" / "pytest"))
from _topology_lock_test_support import add_trusted_stat_env

SCRIPT = (
    REPO_ROOT / "scripts" / "host" / "droplet-storage-pool-apply.sh"
)
BASH = shutil.which("bash")

pytestmark = [
    pytest.mark.skipif(BASH is None, reason="bash not available"),
    pytest.mark.skipif(
        os.name == "nt",
        reason="root executor tests require POSIX flock, /proc fd identity checks, and Unix shebang execution",
    ),
]


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


def _run_apply(spool: Path, stub: Path, **extra_env):
    work = spool.parent
    lock = work / "recordings-topology.lock"
    lock.touch(exist_ok=True)
    status_file = work / "nvr-status.json"
    if not status_file.exists():
        status_file.write_text(json.dumps({"kind": "volume", "source": "nvrdata"}),
                               encoding="utf-8")
    status_script = work / "nvr-status.sh"
    status_script.write_text(
        '#!/bin/sh\ncat "$DROPLET_TEST_NVR_STATUS_JSON_FILE"\n',
        encoding="utf-8", newline="\n")
    os.chmod(status_script, 0o755)
    env = dict(os.environ)
    env.update({
        "DROPLET_POOL_SPOOL_DIR": str(spool),
        "DROPLET_POOL_SCRIPT": str(stub),
        "DROPLET_STORAGE_TOPOLOGY_LOCK_FILE": str(lock),
        "DROPLET_NVR_STATUS_SCRIPT": str(status_script),
        "DROPLET_TEST_NVR_STATUS_JSON_FILE": str(status_file),
    })
    env.update({k: str(v) for k, v in extra_env.items()})
    add_trusted_stat_env(env, work / "test-bin", lock)
    return subprocess.run(
        [BASH, str(SCRIPT)],
        env=env, capture_output=True, text=True, timeout=600,
    )


def test_active_recordings_device_is_refused_by_root_recheck(tmp_path):
    spool = tmp_path / "spool"
    marker = tmp_path / "POOL_SCRIPT_RAN"
    stub = _write_stub(tmp_path, f'touch "{marker}"\nexit 0\n')
    _spool_request(spool, operation="drive_adopt", params={"device": "md0"})
    status = {
        "kind": "path", "source": "/mnt/droplet/bay/nvr", "mounted": True,
        "fsUuid": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
        "mountPath": "/mnt/droplet/bay", "physicalDisk": "sdb,sdc",
        "backingDevices": ["md0", "sdb", "sdc", "droplet-bay-ab12cd34"],
    }
    status_file = tmp_path / "nvr-status.json"
    status_file.write_text(json.dumps(status), encoding="utf-8")
    proc = _run_apply(spool, stub)
    assert proc.returncode == 0, proc.stderr
    result = json.loads((spool / "result.json").read_text())
    assert result["rc"] == 77
    assert "camera recordings" in result["stdout"]
    assert not marker.exists()


def test_unverified_recordings_status_fails_closed_before_pool_script(tmp_path):
    spool = tmp_path / "spool"
    marker = tmp_path / "POOL_SCRIPT_RAN"
    stub = _write_stub(tmp_path, f'touch "{marker}"\nexit 0\n')
    _spool_request(spool, operation="drive_adopt", params={"device": "sdb"})
    status_file = tmp_path / "nvr-status.json"
    status_file.write_text('{"kind":"path","source":"/mnt/droplet/bay/nvr",'
                           '"mounted":true,"mountPath":"/",'
                           '"backingDevices":["sdb"]}', encoding="utf-8")
    proc = _run_apply(spool, stub)
    assert proc.returncode == 0, proc.stderr
    assert json.loads((spool / "result.json").read_text())["rc"] == 78
    assert not marker.exists()


def test_topology_lock_remains_held_through_pool_script(tmp_path):
    spool = tmp_path / "spool"
    stub = _write_stub(
        tmp_path,
        'if flock -n "$DROPLET_STORAGE_TOPOLOGY_LOCK_FILE" -c true; then exit 91; fi\n'
        'printf \'{"lockHeld":true}\\n\'\nexit 0\n',
    )
    _spool_request(spool, operation="drive_adopt", params={"device": "sdb"})
    proc = _run_apply(spool, stub)
    assert proc.returncode == 0, proc.stderr
    result = json.loads((spool / "result.json").read_text())
    assert result["rc"] == 0
    assert json.loads(result["stdout"])["lockHeld"] is True


@pytest.mark.skipif(os.name == "nt", reason="requires POSIX flock")
def test_writer_and_pool_executor_serialize_on_the_same_lock_inode(tmp_path):
    import fcntl

    spool = tmp_path / "spool"
    lock = tmp_path / "recordings-topology.lock"
    lock.touch()
    release = tmp_path / "release-writer.lock"
    writer = subprocess.Popen(
        [sys.executable, "-c",
         "import fcntl,os,sys,time; fd=os.open(sys.argv[1],os.O_RDWR); "
         "fcntl.flock(fd,fcntl.LOCK_EX); print('locked',flush=True); "
         "\nwhile not os.path.exists(sys.argv[2]): time.sleep(.01)",
         str(lock), str(release)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        assert writer.stdout is not None
        assert writer.stdout.readline().strip() == "locked"
        marker = tmp_path / "POOL_SCRIPT_RAN"
        stub = _write_stub(tmp_path, f'touch "{marker}"\nexit 0\n')
        _spool_request(spool, operation="drive_adopt", params={"device": "sdb"})
        first = _run_apply(spool, stub)
        assert first.returncode == 0, first.stderr
        assert json.loads((spool / "result.json").read_text())["rc"] == 79

        # The active device changes while the NVR-side writer still owns the
        # shared lock. The pool operation must remain blocked until that writer
        # releases; its next fresh attempt must then see the new active chain.
        (tmp_path / "nvr-status.json").write_text(json.dumps({
            "kind": "path", "source": "/mnt/droplet/bay/nvr", "mounted": True,
            "fsUuid": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
            "mountPath": "/mnt/droplet/bay", "physicalDisk": "sdb",
            "backingDevices": ["sdb", "sdb1", "droplet-bay-crypt"],
        }), encoding="utf-8")
        _spool_request(spool, operation="drive_adopt", params={"device": "sdb"})
        second = _run_apply(spool, stub)
        assert second.returncode == 0, second.stderr
        assert json.loads((spool / "result.json").read_text())["rc"] == 79
        assert not marker.exists()
    finally:
        release.touch()
        writer.wait(timeout=10)
        if writer.returncode != 0:
            raise AssertionError(writer.stderr.read() if writer.stderr else "lock holder failed")

    _spool_request(spool, operation="drive_adopt", params={"device": "sdb"})
    third = _run_apply(spool, stub)
    assert third.returncode == 0, third.stderr
    assert json.loads((spool / "result.json").read_text())["rc"] == 77
    assert not marker.exists()


def test_recovery_custody_skips_topology_guard_and_lock(tmp_path):
    spool = tmp_path / "spool"
    stub = _write_stub(tmp_path, 'printf \'{"ok":true}\\n\'\nexit 0\n')
    _spool_request(spool, operation="recovery_key_reveal",
                   params={"uuid": "cafef00d-848"})
    proc = _run_apply(
        spool, stub,
        DROPLET_STORAGE_TOPOLOGY_LOCK_FILE=str(tmp_path / "missing-lock"),
        DROPLET_NVR_STATUS_SCRIPT=str(tmp_path / "missing-status-script"),
        DROPLET_POOL_TMPDIR=str(tmp_path),
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads((spool / "result.json").read_text())["rc"] == 0


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


# ---------------------------------------------------------------------------
# WARP-3513 — the pool script's stdout carries the ONE-TIME recovery-key reveal
# (recovery_key_reveal). The executor captures it in temp files; those must
# live on tmpfs (/run), never mktemp's default /tmp on the unencrypted root LV.
# ---------------------------------------------------------------------------

def _run_apply_with_tmp(spool: Path, stub: Path, capture_dir: Path,
                        plain_tmp: Path):
    env = dict(os.environ)
    env.update({
        "DROPLET_POOL_SPOOL_DIR": str(spool),
        "DROPLET_POOL_SCRIPT": str(stub),
        "DROPLET_POOL_TMPDIR": str(capture_dir).replace("\\", "/"),
        # mktemp's default location — must stay UNTOUCHED while a capture dir
        # is available.
        "TMPDIR": str(plain_tmp).replace("\\", "/"),
    })
    lock = spool.parent / "recordings-topology.lock"
    lock.touch(exist_ok=True)
    status_file = spool.parent / "nvr-status.json"
    if not status_file.exists():
        status_file.write_text(json.dumps({"kind": "volume", "source": "nvrdata"}),
                               encoding="utf-8")
    status_script = spool.parent / "nvr-status.sh"
    status_script.write_text(
        '#!/bin/sh\ncat "$DROPLET_TEST_NVR_STATUS_JSON_FILE"\n',
        encoding="utf-8", newline="\n")
    os.chmod(status_script, 0o755)
    env.update({
        "DROPLET_STORAGE_TOPOLOGY_LOCK_FILE": str(lock),
        "DROPLET_NVR_STATUS_SCRIPT": str(status_script),
        "DROPLET_TEST_NVR_STATUS_JSON_FILE": str(status_file),
    })
    add_trusted_stat_env(env, spool.parent / "test-bin", lock)
    return subprocess.run(
        [BASH, str(SCRIPT)],
        env=env, capture_output=True, text=True, timeout=600,
    )


def test_stdout_capture_files_live_in_the_tmpfs_dir_not_the_default_tmp(tmp_path):
    spool = tmp_path / "spool"
    capture_dir = tmp_path / "ramdir"
    plain_tmp = tmp_path / "plain-tmp"
    capture_dir.mkdir()
    plain_tmp.mkdir()
    seen = tmp_path / "seen.txt"
    # While the pool script runs, the executor's two capture files exist: record
    # where. The "secret" it prints is a fake marker, not a key.
    stub = _write_stub(
        tmp_path,
        'ls -A "{cap}" > "{seen}"\n'
        "printf '{{\"ok\": true, \"marker\": \"FAKE-REVEAL-OUTPUT\"}}\n'\n"
        "exit 0\n".format(cap=str(capture_dir).replace("\\", "/"),
                          seen=str(seen).replace("\\", "/")))
    _spool_request(spool, operation="recovery_key_reveal",
                   params={"uuid": "cafef00d-848"})
    proc = _run_apply_with_tmp(spool, stub, capture_dir, plain_tmp)
    assert proc.returncode == 0, proc.stderr
    during = [ln for ln in seen.read_text().splitlines() if ln]
    assert len(during) == 2, (
        "stdout/stderr capture must use the tmpfs dir: %r" % during)
    assert list(plain_tmp.iterdir()) == [], "default /tmp must stay untouched"
    # Both capture files are removed afterwards (the secret does not linger),
    # and the result still reaches the bridge's spool.
    assert list(capture_dir.iterdir()) == []
    result = json.loads((spool / "result.json").read_text())
    assert "FAKE-REVEAL-OUTPUT" in result["stdout"]


def test_an_unusable_capture_dir_falls_back_instead_of_failing(tmp_path):
    spool = tmp_path / "spool"
    stub = _write_stub(tmp_path, "printf '{\"ok\": true}\n'\nexit 0\n")
    _spool_request(spool)
    proc = _run_apply_with_tmp(spool, stub, tmp_path / "no-such-dir",
                               tmp_path / "plain-tmp")
    assert proc.returncode == 0, proc.stderr
    assert json.loads((spool / "result.json").read_text())["rc"] == 0
