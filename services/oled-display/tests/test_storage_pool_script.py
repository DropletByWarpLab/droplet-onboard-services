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
import sys
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
        # WARP-868: keep the host-namespace nsenter escape OFF so the PATH-shim
        # umount/findmnt stubs are exercised (CI may run in a container whose
        # mount ns differs from PID 1's, which would otherwise trigger nsenter).
        "DROPLET_POOL_HOSTNS_DISABLE": "1",
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


def test_create_proceeds_when_a_member_is_mounted():
    # WARP-848: first-run drives arrive automounted (the automount service
    # mounts every data drive at boot), so "mounted" is NO LONGER a dead-end
    # refusal for pool_create. The confirm phrase already names every member;
    # mounted members get a managed teardown in the execute step instead.
    proc = _run("pool_create", _create_params(),
                {"DROPLET_POOL_TEST_MOUNTED": "/dev/sda"})
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True


def test_create_proceeds_when_a_member_holds_a_filesystem_with_data():
    # WARP-848: same managed-teardown posture for has-data members — the
    # execute step wipefs's every member after the clean unmount. The typed
    # confirm phrase naming every member is the consent gate (the owner has
    # already passed the destructive ConfirmDialog upstream).
    proc = _run("pool_create", _create_params(),
                {"DROPLET_POOL_TEST_HASDATA": "/dev/sdb"})
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True


def test_add_spare_still_refuses_mounted_and_has_data_members():
    # WARP-848 must NOT loosen pool_add_spare: it writes to a single new disk
    # without the all-members confirm-naming of pool_create, so its full
    # pre-flight (refuse mounted / has-data) stays.
    spare = {"device": "md0", "member": "/dev/sdc",
             "confirm_phrase": "ERASE md0 sdc"}
    mounted = _run("pool_add_spare", dict(spare),
                   {"DROPLET_POOL_TEST_MOUNTED": "/dev/sdc"})
    assert mounted.returncode != 0
    assert "mounted" in (mounted.stderr + mounted.stdout).lower()
    has_data = _run("pool_add_spare", dict(spare),
                    {"DROPLET_POOL_TEST_HASDATA": "/dev/sdc"})
    assert has_data.returncode != 0
    combined = (has_data.stderr + has_data.stdout).lower()
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


# ---------------------------------------------------------------------------
# WARP-848 — EXECUTE-path coverage via PATH-stubbed host tools.
#
# The dry-run tests above stop at the pre-flight; the first-run storage bugs
# (drive_adopt umounting a never-mounted disk node and dying; pool_create
# dead-ending on automounted members) live in the EXECUTE step. We run the
# script for real but with every host tool it shells out to (findmnt, lsblk,
# blkid, umount, wipefs, blkdiscard, mkfs.ext4, mount, mkdir, mdadm) replaced
# by PATH stubs that (a) log their invocation to $CMD_LOG and (b) play a
# faithful mount table: findmnt/lsblk answer from $FINDMNT_TABLE, umount
# REMOVES the entry it unmounted, fails "not mounted" for an absent one
# (exactly the live-box failure mode), and fails "target is busy" for targets
# listed in $UMOUNT_FAIL. No real block device, root, or mdadm is ever needed.
# ---------------------------------------------------------------------------

_STUBS = {
    "findmnt": r"""
printf 'findmnt %s\n' "$*" >> "$CMD_LOG"
mode=table needle= prev=
for a in "$@"; do
  case "$prev" in
    --source) mode=source; needle="$a" ;;
    --target) mode=target; needle="$a" ;;
    --mountpoint) mode=mountpoint; needle="$a" ;;
  esac
  prev="$a"
done
case "$mode" in
  table) cat "$FINDMNT_TABLE" 2>/dev/null; exit 0 ;;
  source)     hits="$(awk -v n="$needle" '$1 == n { print $2 }' "$FINDMNT_TABLE" 2>/dev/null)" ;;
  mountpoint) hits="$(awk -v n="$needle" '$2 == n { print $0 }' "$FINDMNT_TABLE" 2>/dev/null)" ;;
  target)     hits="$(awk -v n="$needle" '$2 == n { print $1 }' "$FINDMNT_TABLE" 2>/dev/null)" ;;
esac
[ -n "$hits" ] || exit 1
printf '%s\n' "$hits"
exit 0
""",
    "umount": r"""
printf 'umount %s\n' "$*" >> "$CMD_LOG"
tgt=
for a in "$@"; do tgt="$a"; done
case ",${UMOUNT_FAIL:-}," in
  *",$tgt,"*) printf 'umount: %s: target is busy.\n' "$tgt" >&2; exit 32 ;;
esac
if ! awk -v x="$tgt" '$1 == x || $2 == x { f=1 } END { exit f ? 0 : 1 }' \
    "$FINDMNT_TABLE" 2>/dev/null; then
  printf 'umount: %s: not mounted.\n' "$tgt" >&2
  exit 32
fi
awk -v x="$tgt" '$1 != x && $2 != x' "$FINDMNT_TABLE" > "$FINDMNT_TABLE.new"
mv "$FINDMNT_TABLE.new" "$FINDMNT_TABLE"
exit 0
""",
    "lsblk": r"""
printf 'lsblk %s\n' "$*" >> "$CMD_LOG"
if [ "${1:-}" = "-ndo" ] && [ "${2:-}" = "PKNAME" ]; then
  dev="$(basename "${3:-}")"
  case "$dev" in
    nvme*p[0-9]*|mmcblk*p[0-9]*) printf '%s\n' "${dev%p*}" ;;
    sd*[0-9]|vd*[0-9]) printf '%s' "$dev" | sed 's/[0-9]*$//'; echo ;;
    *) : ;;
  esac
  exit 0
fi
if [ "${1:-}" = "-rno" ] && [ "${2:-}" = "MOUNTPOINT" ]; then
  awk -v d="${3:-}" 'index($1, d) == 1 { print $2 }' "$FINDMNT_TABLE" 2>/dev/null
  exit 0
fi
exit 0
""",
    "blkid": r"""
printf 'blkid %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" -s UUID "*) printf 'cafef00d-848\n'; exit 0 ;;
  *" -s TYPE "*) exit 2 ;;
esac
exit 0
""",
}
for _tool in ("wipefs", "blkdiscard", "mkfs.ext4", "mount", "mkdir", "mdadm"):
    _STUBS[_tool] = (
        "printf '%s %%s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 0\n" % _tool
    )


def _posix(p: Path) -> str:
    # Git-Bash on Windows handles C:/-style paths; backslashes don't survive
    # bash quoting (same trick as test_storage_pool_apply_script.py).
    return str(p).replace("\\", "/")


def _exec_run(operation: str, params: dict, tmp_path: Path,
              mounts: list[tuple[str, str]] | None = None,
              umount_fail: list[str] | None = None,
              extra_env: dict | None = None):
    """Run the script WITHOUT dry-run, against the stub toolchain."""
    stub_dir = tmp_path / "stub-bin"
    stub_dir.mkdir(exist_ok=True)
    for name, body in _STUBS.items():
        stub = stub_dir / name
        stub.write_text("#!/usr/bin/env bash\n" + body.lstrip("\n"),
                        encoding="utf-8", newline="\n")
        os.chmod(stub, 0o755)
    # Pin the script's `python3` to THIS interpreter. On a Windows dev host
    # the bare name otherwise resolves to the WindowsApps alias shim, which
    # hangs intermittently under rapid process churn; on Linux this is a
    # no-op redirect to the same python running pytest.
    py_stub = stub_dir / "python3"
    py_stub.write_text(
        '#!/usr/bin/env bash\nexec "{}" "$@"\n'.format(
            Path(sys.executable).as_posix()),
        encoding="utf-8", newline="\n")
    os.chmod(py_stub, 0o755)
    table = tmp_path / "findmnt-table.txt"
    table.write_text(
        "".join(f"{src} {tgt}\n" for src, tgt in (mounts or [])),
        encoding="utf-8", newline="\n")
    log = tmp_path / "cmd-log.txt"
    log.write_text("", encoding="utf-8")
    env = dict(os.environ)
    env.update({
        "DROPLET_POOL_DRY_RUN": "",          # the real execute path
        "DROPLET_POOL_TEST_MOUNTED": "",
        "DROPLET_POOL_TEST_HASDATA": "",
        "DROPLET_POOL_TEST_OSDISK": "",
        "CMD_LOG": _posix(log),
        "FINDMNT_TABLE": _posix(table),
        "UMOUNT_FAIL": ",".join(umount_fail or []),
        # WARP-868: exercise the PATH-shim umount/findmnt, never the real
        # nsenter host-namespace escape.
        "DROPLET_POOL_HOSTNS_DISABLE": "1",
        "PATH": str(stub_dir) + os.pathsep + env.get("PATH", ""),
    })
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [BASH, str(SCRIPT), operation, json.dumps(params)],
        # Generous: a Windows dev host pays ~0.5-2s per process spawn and the
        # execute path forks dozens of stubs + several python3 one-liners.
        env=env, capture_output=True, text=True, timeout=120,
    )
    cmds = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln]
    return proc, cmds


def _first(cmds: list[str], prefix: str) -> int:
    for i, c in enumerate(cmds):
        if c.startswith(prefix):
            return i
    return -1


def test_adopt_execute_succeeds_when_only_a_partition_is_mounted(tmp_path):
    # THE WARP-848 live failure: /dev/sdb1 is automounted, /dev/sdb (the disk
    # node) is NOT itself a mount source. The old code asked is_mounted() about
    # the disk node — whose lsblk fallback reports CHILD mountpoints — then ran
    # `umount /dev/sdb`, which failed "not mounted" and killed the adopt before
    # the partition loop ran. The fix unmounts the actually-mounted partition
    # and never umounts a disk node that isn't a mount source.
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/sdb1", "/mnt/droplet/data-abcd1234")])
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    assert any(c.startswith("umount") and "/mnt/droplet/data-abcd1234" in c
               for c in cmds), cmds
    assert not any(c.rstrip() == "umount /dev/sdb" for c in cmds), cmds
    # Wipe + format + remount still happen, in that order.
    assert 0 <= _first(cmds, "wipefs") < _first(cmds, "mkfs.ext4") \
        < _first(cmds, "mount "), cmds


def test_adopt_execute_unmounts_partitions_before_the_disk_node(tmp_path):
    # Partition mounts release first; the disk node is unmounted LAST and only
    # because it genuinely appears as a mount source in the table.
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/sdb", "/mnt/droplet/whole-0000"),
                ("/dev/sdb1", "/mnt/droplet/part-1111")])
    assert proc.returncode == 0, proc.stderr
    part_idx = _first(cmds, "umount /mnt/droplet/part-1111")
    disk_idx = _first(cmds, "umount /mnt/droplet/whole-0000")
    assert 0 <= part_idx < disk_idx, cmds


def test_adopt_execute_with_nothing_mounted_runs_no_umount(tmp_path):
    # "Not mounted" is a fine starting state, not an error.
    proc, cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path, mounts=[])
    assert proc.returncode == 0, proc.stderr
    assert not any(c.startswith("umount") for c in cmds), cmds
    assert _first(cmds, "wipefs") >= 0, cmds


def test_adopt_execute_busy_unmount_still_refuses_and_never_wipes(tmp_path):
    # A REAL unmount failure (EBUSY / open files) must still die loudly with
    # the dashboard-recognised "close open files and retry" message, name the
    # mountpoint, and never reach the wipe.
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/sdb1", "/mnt/droplet/data-abcd1234")],
        umount_fail=["/mnt/droplet/data-abcd1234"])
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "close open files" in combined
    assert "/mnt/droplet/data-abcd1234" in (proc.stderr + proc.stdout)
    assert _first(cmds, "wipefs") == -1, cmds
    assert _first(cmds, "mkfs.ext4") == -1, cmds


def test_adopt_execute_tolerates_shared_propagation_duplicate(tmp_path):
    # WARP-868: the Nextcloud /mnt/droplet bind-mount has shared propagation,
    # so every data mount appears TWICE in findmnt (host root + bind peer, same
    # target). mounts_backed_by enumerates both; the FIRST host-namespace
    # umount clears the whole shared peer group (the stub drops every matching
    # row), so the SECOND enumerated copy umounts "not mounted". That must be
    # treated as already-gone (success), NOT the old die-busy regression that
    # left create/adopt doing nothing after the warning (the 422).
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/sdb1", "/mnt/droplet/data-dupe9999"),
                ("/dev/sdb1", "/mnt/droplet/data-dupe9999")])
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    # The wipe/format still happen — the duplicate didn't wedge the teardown.
    assert _first(cmds, "wipefs") >= 0, cmds
    assert _first(cmds, "mkfs.ext4") >= 0, cmds


def test_create_execute_tears_down_mounted_members_then_runs_mdadm(tmp_path):
    # WARP-848 bug 2: automounted members get a managed teardown — every
    # member's mounts released (non-lazy) BEFORE any wipefs, every member
    # wiped, then mdadm. Nothing is destroyed until every member unmounted.
    params = _create_params(members=["/dev/sda1", "/dev/sdb1"],
                            confirm_phrase="ERASE sda1 sdb1")
    proc, cmds = _exec_run(
        "pool_create", params, tmp_path,
        mounts=[("/dev/sda1", "/mnt/droplet/data-aaaa1111"),
                ("/dev/sdb1", "/mnt/droplet/data-bbbb2222")])
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    umounts = [i for i, c in enumerate(cmds) if c.startswith("umount")]
    wipes = [i for i, c in enumerate(cmds) if c.startswith("wipefs")]
    mdadm_idx = _first(cmds, "mdadm")
    assert len(umounts) == 2 and len(wipes) == 2, cmds
    assert max(umounts) < min(wipes) < mdadm_idx, cmds
    assert any("wipefs -a /dev/sda1" in c for c in cmds), cmds
    assert any("wipefs -a /dev/sdb1" in c for c in cmds), cmds
    assert "--create /dev/md0" in cmds[mdadm_idx], cmds


def test_create_execute_busy_member_refuses_naming_the_mountpoint(tmp_path):
    # EBUSY on any member is still a refusal — named mountpoint, no wipe of
    # ANY member (including the ones that unmounted cleanly), no mdadm.
    params = _create_params(members=["/dev/sda1", "/dev/sdb1"],
                            confirm_phrase="ERASE sda1 sdb1")
    proc, cmds = _exec_run(
        "pool_create", params, tmp_path,
        mounts=[("/dev/sda1", "/mnt/droplet/data-aaaa1111"),
                ("/dev/sdb1", "/mnt/droplet/data-bbbb2222")],
        umount_fail=["/mnt/droplet/data-bbbb2222"])
    assert proc.returncode != 0
    combined = proc.stderr + proc.stdout
    assert "/mnt/droplet/data-bbbb2222" in combined
    # Matches the dashboard's friendlyCreateError regex (busy / mounted).
    assert "busy" in combined.lower()
    assert _first(cmds, "wipefs") == -1, cmds
    assert _first(cmds, "mdadm") == -1, cmds


def test_create_execute_os_disk_refused_before_any_unmount_or_wipe(tmp_path):
    # The OS-disk refusal is unconditional and runs BEFORE the teardown —
    # a mounted OS-backing member must die without a single umount/wipefs.
    params = _create_params(members=["/dev/sda1", "/dev/sdb1"],
                            confirm_phrase="ERASE sda1 sdb1")
    proc, cmds = _exec_run(
        "pool_create", params, tmp_path,
        mounts=[("/dev/sda1", "/mnt/droplet/data-aaaa1111"),
                ("/dev/sdb1", "/mnt/droplet/data-bbbb2222")],
        extra_env={"DROPLET_POOL_TEST_OSDISK": "/dev/sdb1"})
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "os" in combined or "system" in combined or "boot" in combined
    assert not any(c.startswith(("umount", "wipefs", "mdadm")) for c in cmds), cmds


def test_create_execute_whole_disk_member_unmounts_all_its_partitions(tmp_path):
    # The live-box shape (WARP-848 QA must-fix): ONE physical disk holding two
    # automounted filesystems (sda1 `nvr` + sda2 `data`). The wizard sends
    # WHOLE-DISK members; the managed teardown must release BOTH partitions
    # (they are PKNAME-children of the disk node), wipefs the disk nodes
    # themselves, then run mdadm — the whole-disk erase the confirm dialog
    # promised, never a partition-sized pool with a survivor filesystem.
    params = _create_params(members=["/dev/sda", "/dev/sdb"],
                            confirm_phrase="ERASE sda sdb")
    proc, cmds = _exec_run(
        "pool_create", params, tmp_path,
        mounts=[("/dev/sda1", "/mnt/droplet/nvr-aaaa1111"),
                ("/dev/sda2", "/mnt/droplet/data-bbbb2222")])
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    # BOTH partitions released…
    assert _first(cmds, "umount /mnt/droplet/nvr-aaaa1111") >= 0, cmds
    assert _first(cmds, "umount /mnt/droplet/data-bbbb2222") >= 0, cmds
    # …the DISK nodes get wiped (not a partition)…
    assert any(c.strip() == "wipefs -a /dev/sda" for c in cmds), cmds
    assert any(c.strip() == "wipefs -a /dev/sdb" for c in cmds), cmds
    # …and mdadm assembles the whole disks AFTER every unmount + wipe.
    umounts = [i for i, c in enumerate(cmds) if c.startswith("umount")]
    wipes = [i for i, c in enumerate(cmds) if c.startswith("wipefs")]
    mdadm_idx = _first(cmds, "mdadm")
    assert max(umounts) < min(wipes) < mdadm_idx, cmds
    assert "--create /dev/md0" in cmds[mdadm_idx], cmds
    assert "/dev/sda /dev/sdb" in cmds[mdadm_idx], cmds


def test_create_execute_partition_member_with_mounted_sibling_refuses(tmp_path):
    # Belt-and-braces for any OTHER caller that still sends a PARTITION member
    # (the wizard now sends whole disks): tearing down /dev/sda1's own mounts
    # leaves its SIBLING /dev/sda2 mounted — sda2 is not a PKNAME-child of the
    # partition NODE — so wipefs+mdadm would silently under-deliver the
    # whole-disk erase the confirm promised, and the survivor filesystem would
    # re-automount every boot. The script must die loudly — with the
    # dashboard-mappable mounted/busy wording — before ANYTHING is wiped.
    params = _create_params(members=["/dev/sda1", "/dev/sdb1"],
                            confirm_phrase="ERASE sda1 sdb1")
    proc, cmds = _exec_run(
        "pool_create", params, tmp_path,
        mounts=[("/dev/sda1", "/mnt/droplet/nvr-aaaa1111"),
                ("/dev/sda2", "/mnt/droplet/data-bbbb2222")])
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    # Matches the dashboard's friendlyCreateError regex (mounted / busy).
    assert "mounted" in combined or "busy" in combined
    assert _first(cmds, "wipefs") == -1, cmds
    assert _first(cmds, "mdadm") == -1, cmds


# ---------------------------------------------------------------------------
# WARP-848 QA hardening — the confirm-phrase gate is an EXACT-TOKEN match.
# A case-sensitive SUBSTRING check let `sda1` ride on a phrase that named only
# `sda10`: one typed phrase consenting to a DIFFERENT disk. The phrase is now
# split on runs of non-alphanumerics and each target's short name must equal a
# whole token.
# ---------------------------------------------------------------------------

def test_create_confirm_phrase_substring_is_not_enough():
    # Phrase names sda10, member is sda1 → must refuse (old substring passed).
    proc = _run("pool_create", _create_params(
        members=["/dev/sda1", "/dev/sdb1"],
        confirm_phrase="ERASE sda10 sdb1"))
    assert proc.returncode != 0
    assert "confirm" in (proc.stderr + proc.stdout).lower()


def test_adopt_confirm_phrase_substring_is_not_enough():
    # Phrase names sdb1, adopt target is the DISK sdb → must refuse (old
    # substring matched "sdb" inside "sdb1").
    proc = _run("drive_adopt", _adopt_params(confirm_phrase="ERASE sdb1"))
    assert proc.returncode != 0
    assert "confirm" in (proc.stderr + proc.stdout).lower()


def test_confirm_phrase_with_punctuation_separators_still_passes():
    # The split is on runs of non-alphanumerics, so separator style doesn't
    # matter — only whole-token identity does. (Pins compatibility with the
    # dashboard's space-separated `buildConfirmPhrase` output and any caller
    # that punctuates.)
    proc = _run("pool_create", _create_params(confirm_phrase="ERASE: sda, sdb"))
    assert proc.returncode == 0, proc.stderr


def test_managed_unmount_prunes_the_automount_state(tmp_path):
    # WARP-612 parity: the guarded-eject path "forgets" an unmounted drive by
    # dropping its entry from /var/lib/droplet-automount/mounts.json. A managed
    # teardown does the same for every device it unmounts, and leaves every
    # other entry alone. (The bridge's drives snapshot self-heals stale entries
    # via its ismount check regardless — this keeps the state file honest.)
    state = tmp_path / "mounts.json"
    state.write_text(json.dumps({"mounts": [
        {"device": "/dev/sdb1", "mount": "/mnt/droplet/data-abcd1234",
         "label": "data", "uuid": "abcd1234"},
        {"device": "/dev/sdc1", "mount": "/mnt/droplet/other-9999",
         "label": "other", "uuid": "99999999"},
    ]}), encoding="utf-8", newline="\n")
    proc, _cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/sdb1", "/mnt/droplet/data-abcd1234")],
        extra_env={"DROPLET_AUTOMOUNT_STATE": _posix(state)})
    assert proc.returncode == 0, proc.stderr
    remaining = json.loads(state.read_text(encoding="utf-8"))["mounts"]
    assert [m["device"] for m in remaining] == ["/dev/sdc1"], remaining
