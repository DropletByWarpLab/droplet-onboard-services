"""Hermetic test for the destructive storage-pool host script (BUG-3).

scripts/host/droplet-storage-pool.sh is the actual data-destroying execution
layer (mdadm/mkfs). Its HARD PRE-FLIGHT is the last line of defense and is the
unit under test here: it must refuse to touch a disk that is mounted, holds a
filesystem with data, or is (or backs) the OS disk, and it must require a typed
double-confirm naming the exact disks + the data erased. It must NEVER run
blind.

We drive it via subprocess in DRY-RUN mode (DROPLET_POOL_DRY_RUN=1) so no real
mdadm/mkfs ever runs, and we inject the disk-probe results via env hooks so we
can simulate "mounted" / "has data" / "OS disk" without any real block device.
Skipped automatically if a POSIX `sh`/`bash` isn't on PATH.
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
    / "scripts" / "host" / "droplet-storage-pool.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def _run(operation: str, params: dict, extra_env: dict | None = None):
    env = dict(os.environ)
    env.update({
        "DROPLET_POOL_DRY_RUN": "1",  # never actually run mdadm/mkfs
        # Default probe hooks → "safe" (nothing mounted, no data, not OS disk).
        # Individual tests override these to simulate a refusal condition.
        "DROPLET_POOL_TEST_MOUNTED": "",
        "DROPLET_POOL_TEST_HASDATA": "",
        "DROPLET_POOL_TEST_OSDISK": "",
    })
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [BASH, str(SCRIPT), operation, json.dumps(params)],
        env=env, capture_output=True, text=True, timeout=30,
    )


def _create_params(**over):
    p = {
        "device": "md0",
        "level": "raid1",
        "members": ["/dev/sda", "/dev/sdb"],
        "confirm_phrase": "ERASE sda sdb",
    }
    p.update(over)
    return p


def test_script_exists_and_is_executable_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    first = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("#!") and "bash" in first


def test_happy_path_dry_run_succeeds_with_correct_confirm():
    proc = _run("pool_create", _create_params())
    assert proc.returncode == 0, proc.stderr
    # Emits JSON the bridge can parse.
    out = json.loads(proc.stdout)
    assert out.get("ok") is True
    assert out.get("device") == "md0"


def test_refuses_when_a_member_is_mounted():
    # Simulate /dev/sda being mounted.
    proc = _run("pool_create", _create_params(),
                {"DROPLET_POOL_TEST_MOUNTED": "/dev/sda"})
    assert proc.returncode != 0
    assert "mounted" in (proc.stderr + proc.stdout).lower()


def test_refuses_when_a_member_holds_a_filesystem_with_data():
    proc = _run("pool_create", _create_params(),
                {"DROPLET_POOL_TEST_HASDATA": "/dev/sdb"})
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "data" in combined or "filesystem" in combined


def test_refuses_when_a_member_is_the_os_disk():
    proc = _run("pool_create", _create_params(),
                {"DROPLET_POOL_TEST_OSDISK": "/dev/sda"})
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "os" in combined or "system" in combined or "boot" in combined


def test_refuses_without_the_typed_double_confirm():
    # Missing confirm_phrase → refuse. Never run blind.
    proc = _run("pool_create", _create_params(confirm_phrase=""))
    assert proc.returncode != 0
    assert "confirm" in (proc.stderr + proc.stdout).lower()


def test_refuses_when_confirm_phrase_does_not_name_the_disks():
    # A confirm phrase that doesn't name the disks being erased is rejected —
    # the double-confirm has to actually match the target.
    proc = _run("pool_create", _create_params(confirm_phrase="yes do it"))
    assert proc.returncode != 0
    assert "confirm" in (proc.stderr + proc.stdout).lower()


def test_destroy_requires_confirm_naming_the_array():
    # pool_destroy with the wrong confirm phrase is refused.
    bad = _run("pool_destroy", {"device": "md0", "confirm_phrase": "nope"})
    assert bad.returncode != 0
    # Correct phrase (names the array) passes the confirm gate in dry-run.
    good = _run("pool_destroy", {"device": "md0", "confirm_phrase": "ERASE md0"})
    assert good.returncode == 0, good.stderr


def test_rejects_unknown_operation():
    proc = _run("rm_rf", {"device": "md0", "confirm_phrase": "ERASE md0"})
    assert proc.returncode != 0


def test_never_runs_mdadm_in_dry_run():
    # Belt-and-braces: in dry-run the script must print the command it WOULD
    # run rather than executing it. We assert it reports a dry-run marker.
    proc = _run("pool_create", _create_params())
    assert "dry-run" in (proc.stdout + proc.stderr).lower() or \
        json.loads(proc.stdout).get("dry_run") is True


# ---------------------------------------------------------------------------
# WARP-662 — drive_adopt: wipe + reformat + mount a previously-used disk.
# Same hard gates as the pool ops EXCEPT it deliberately allows has_data
# (wiping existing data is the confirm-gated intent). The OS disk is still
# never adoptable.
# ---------------------------------------------------------------------------

def _adopt_params(**over):
    p = {
        "device": "sdb",
        "fstype": "ext4",
        "wipe_method": "quick",
        "confirm_phrase": "ERASE sdb",
    }
    p.update(over)
    return p


def test_adopt_happy_path_dry_run_succeeds():
    proc = _run("drive_adopt", _adopt_params())
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("ok") is True
    assert out.get("device") == "sdb"


def test_adopt_refuses_the_os_disk():
    # The OS/boot disk is NEVER adoptable — server-side last-line guard.
    proc = _run("drive_adopt", _adopt_params(),
                {"DROPLET_POOL_TEST_OSDISK": "/dev/sdb"})
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "os" in combined or "system" in combined or "boot" in combined


def test_adopt_allows_a_disk_that_holds_data():
    # Unlike the pool ops, adopt's whole point is to wipe a drive that HAS data.
    # has_data must NOT block it — the typed confirm naming the disk is consent.
    proc = _run("drive_adopt", _adopt_params(),
                {"DROPLET_POOL_TEST_HASDATA": "/dev/sdb"})
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True


def test_adopt_requires_confirm_naming_the_disk():
    # No phrase → refuse; a phrase that doesn't name the disk → refuse.
    assert _run("drive_adopt", _adopt_params(confirm_phrase="")).returncode != 0
    bad = _run("drive_adopt", _adopt_params(confirm_phrase="yes wipe it"))
    assert bad.returncode != 0
    assert "confirm" in (bad.stderr + bad.stdout).lower()


def test_adopt_dry_run_reports_wipe_and_mkfs_not_blind():
    proc = _run("drive_adopt", _adopt_params(wipe_method="secure"))
    assert proc.returncode == 0, proc.stderr
    combined = (proc.stdout + proc.stderr).lower()
    assert "dry-run" in combined or json.loads(proc.stdout).get("dry_run") is True
    assert "wipe" in combined and "mkfs" in combined
