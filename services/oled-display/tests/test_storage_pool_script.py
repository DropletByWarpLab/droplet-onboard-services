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
        # WARP-1048: default the drive_reclaim membership pre-flight to "yes,
        # the disk is a member" so the happy-path/adopt/pool tests aren't gated
        # on a real /sys/block/<md>/slaves entry; the refusal test sets it to 0.
        "DROPLET_POOL_TEST_MDSLAVE": "1",
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
if [ "${1:-}" = "-s" ]; then
  # WARP-857 ancestor chain: lsblk -s -rn -o NAME,TYPE <dev>. Emit "<name> <type>"
  # lines from $LSBLK_ANCESTRY (records "<querybase>;name type;name type;..."),
  # so a test can model an LVM/dm/md stack down to its TYPE=disk leaf. Unknown
  # device or unset ancestry -> empty (the script falls back to the basename).
  _dev=; for _a in "$@"; do _dev="$_a"; done
  _base="$(basename "$_dev")"
  if [ -n "${LSBLK_ANCESTRY:-}" ] && [ -f "$LSBLK_ANCESTRY" ]; then
    while IFS= read -r _rec; do
      [ -n "$_rec" ] || continue
      [ "${_rec%%;*}" = "$_base" ] || continue
      printf '%s\n' "${_rec#*;}" | tr ';' '\n'
    done < "$LSBLK_ANCESTRY"
  fi
  exit 0
fi
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
for _tool in ("wipefs", "blkdiscard", "mkfs.ext4", "mount", "mkdir", "mdadm",
              "docker"):
    # docker (WARP-1338): the post-mount Nextcloud registration shells
    # `docker exec -u 33 <container> php occ ...`; the plain logging stub
    # answers success with empty output, so files_external:list never matches
    # and the create path is exercised.
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
              extra_env: dict | None = None,
              stub_overrides: dict | None = None):
    """Run the script WITHOUT dry-run, against the stub toolchain.

    stub_overrides (same shape as test_automount_script.py's _run_add):
    per-test stub bodies merged OVER _STUBS before writing. Every _STUBS
    entry is rewritten on each call, so writing a stub file between two
    _exec_run calls silently reverts — overrides must travel through here.
    """
    stub_dir = tmp_path / "stub-bin"
    stub_dir.mkdir(exist_ok=True)
    stubs = dict(_STUBS)
    if stub_overrides:
        stubs.update(stub_overrides)
    for name, body in stubs.items():
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
        # WARP-1048: reclaim membership pre-flight defaults to "is a member"
        # (see _run); the execute-path membership-refusal test overrides to 0.
        "DROPLET_POOL_TEST_MDSLAVE": "1",
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
# WARP-857 item 1 — is_os_disk walks the FULL dm/LVM/crypt/md ancestor chain
# (lsblk -s) to the physical disk, not just one PKNAME level. A pool member
# whose disk backs an LVM/LUKS-stacked root must be refused; a member on a
# genuinely separate disk must NOT false-positive.
# ---------------------------------------------------------------------------

def test_create_execute_refuses_member_whose_disk_backs_lvm_root(tmp_path):
    # Root is an LVM LV (vg-root) stacked over /dev/sda2 -> the OS physical disk
    # is sda. A pool_create naming /dev/sda as a member must be refused: the
    # ancestor walk resolves the LV down to sda. Before the fix, PKNAME of the LV
    # source was the dm node (never sda), so the OS disk sailed through as a
    # poolable member — a data-loss latent bug on any LVM/dm box.
    ancestry = tmp_path / "ancestry.txt"
    ancestry.write_text(
        "vg-root;vg-root lvm;sda2 part;sda disk\n"
        "sda;sda disk\n"
        "sdb;sdb disk\n",
        encoding="utf-8", newline="\n")
    params = _create_params(members=["/dev/sda", "/dev/sdb"],
                            confirm_phrase="ERASE sda sdb")
    proc, cmds = _exec_run(
        "pool_create", params, tmp_path,
        mounts=[("/dev/mapper/vg-root", "/")],
        extra_env={"LSBLK_ANCESTRY": _posix(ancestry)})
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "os" in combined or "system" in combined or "boot" in combined
    # Refused in the pre-flight, before any destructive command.
    assert _first(cmds, "wipefs") == -1, cmds
    assert _first(cmds, "mdadm") == -1, cmds


def test_create_execute_allows_members_when_os_disk_is_separate(tmp_path):
    # The full-chain walk must NOT false-positive: root on sdc's LV, pool members
    # sda/sdb -> create proceeds (wipe + mdadm), sdc never touched. Confirms the
    # refusal keys on a SHARED physical disk, not merely "root is on LVM".
    ancestry = tmp_path / "ancestry.txt"
    ancestry.write_text(
        "vg-root;vg-root lvm;sdc2 part;sdc disk\n"
        "sda;sda disk\n"
        "sdb;sdb disk\n",
        encoding="utf-8", newline="\n")
    params = _create_params(members=["/dev/sda", "/dev/sdb"],
                            confirm_phrase="ERASE sda sdb")
    proc, cmds = _exec_run(
        "pool_create", params, tmp_path,
        mounts=[("/dev/mapper/vg-root", "/")],
        extra_env={"LSBLK_ANCESTRY": _posix(ancestry)})
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    mdadm_idx = _first(cmds, "mdadm")
    assert mdadm_idx >= 0, cmds
    assert "--create /dev/md0" in cmds[mdadm_idx], cmds


# ---------------------------------------------------------------------------
# WARP-857 item 2 — a btrfs-subvolume / bind-mount SOURCE (findmnt reports
# /dev/sdX1[/subvol]) must not evade teardown enumeration: mounts_backed_by
# strips the [...] suffix so the mount is recognised and released before the
# wipe.
# ---------------------------------------------------------------------------

def test_adopt_execute_tears_down_btrfs_subvol_source(tmp_path):
    # findmnt reports the mount SOURCE as /dev/sdb1[/@data]. mounts_backed_by
    # must strip the [..] so it sees /dev/sdb1 (a PKNAME-child of the adopt
    # target /dev/sdb) and unmounts it. Before the fix the bracketed source
    # matched neither the disk node nor a child, so the mount was never
    # enumerated (no umount) and a real wipe would hit EBUSY.
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/sdb1[/@data]", "/mnt/droplet/data-btrfs")])
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    umount_idx = _first(cmds, "umount /mnt/droplet/data-btrfs")
    assert umount_idx >= 0, cmds
    # …and the unmount happens BEFORE the wipe (never a wipe over a live mount).
    assert umount_idx < _first(cmds, "wipefs"), cmds


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


# ---------------------------------------------------------------------------
# WARP-1338 — pool/adopted mounts must (a) land at the SAME
# <label>-<short-uuid> tail droplet-automount.sh derives on reboot (else the
# Nextcloud registration + the dashboard's driveContentsHref dangle after the
# first reboot), (b) seed automount's trusted.list with the new fs UUID so
# the reboot path re-mounts rw (an unlisted plain fs remounts read-only-
# untrusted under WARP-232), and (c) register with Nextcloud after each
# host_mount — best-effort, same occ shape as automount, container name from
# the shared env (default droplet-nextcloud-1).
#
# The blkid stub reports UUID cafef00d-848, so short-uuid = "cafef00d" and
# the automount-derived tail for label "pool" is EXACTLY "pool-cafef00d" —
# the same literal test_automount_script.py pins for the reboot path
# (TestNextcloudRegistration::test_md_pool_mount_..._at_stable_name).
# ---------------------------------------------------------------------------

def _pool_state_env(tmp_path: Path) -> dict:
    state_dir = tmp_path / "automount-state"
    state_dir.mkdir(exist_ok=True)
    return {
        "DROPLET_AUTOMOUNT_STATE": _posix(state_dir / "mounts.json"),
    }


def _trusted_list(tmp_path: Path) -> list[str]:
    tl = tmp_path / "automount-state" / "trusted.list"
    return tl.read_text(encoding="utf-8").split() if tl.exists() else []


def test_pool_format_labels_mounts_stable_name_seeds_trust_and_registers(tmp_path):
    proc, cmds = _exec_run(
        "pool_format", {"device": "md0", "fstype": "ext4",
                        "confirm_phrase": "ERASE md0"},
        tmp_path, extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    # (a) the filesystem is labelled so the automount derivation has a stem.
    mkfs = [c for c in cmds if c.startswith("mkfs.ext4")]
    assert mkfs and "-L pool" in mkfs[0] and "/dev/md0" in mkfs[0], cmds
    # (b) creation-time mount tail == automount's reboot derivation.
    mount_idx = _first(cmds, "mount /dev/md0")
    assert mount_idx >= 0, cmds
    assert cmds[mount_idx].endswith("/mnt/droplet/pool-cafef00d"), (
        "creation-time pool mount tail differs from the automount "
        "derivation — registration/driveContentsHref dangle on reboot: %r"
        % cmds[mount_idx]
    )
    # (c) fs UUID seeded into automount's trusted.list (reboot re-mounts rw).
    assert "cafef00d-848" in _trusted_list(tmp_path), _trusted_list(tmp_path)
    # (d) Nextcloud registration AFTER the mount, in the shared-env container.
    reg_idx = _first(cmds, "docker exec -u 33 droplet-nextcloud-1 php occ files_external:create /pool-cafef00d")
    assert reg_idx > mount_idx, cmds


def test_pool_format_carries_owner_label_into_fs_label_and_mount_tail(tmp_path):
    # WARP-2097: the owner's chosen name must reach the FILESYSTEM, not just the
    # StoragePool DB row. The fs label becomes the mount tail, which becomes the
    # Nextcloud external-storage folder AND every /files?path= deep link — none
    # of which the DB-only PATCH rename can ever reach. pool_format used to
    # hardcode "-L pool" and throw an owner-supplied label away.
    proc, cmds = _exec_run(
        "pool_format", {"device": "md0", "fstype": "ext4",
                        "label": "Family_Photos",
                        "confirm_phrase": "ERASE md0"},
        tmp_path, extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    # (a) the label reaches mkfs.
    mkfs = [c for c in cmds if c.startswith("mkfs.ext4")]
    assert mkfs and "-L Family_Photos" in mkfs[0] and "/dev/md0" in mkfs[0], cmds
    # (b) the mount tail derives from the SAME label — the WARP-1338
    # creation-time == reboot-derivation invariant must hold for a NAMED pool
    # too, not just the default one.
    mount_idx = _first(cmds, "mount /dev/md0")
    assert mount_idx >= 0, cmds
    assert cmds[mount_idx].endswith("/mnt/droplet/Family_Photos-cafef00d"), (
        "named pool mount tail differs from the automount derivation: %r"
        % cmds[mount_idx]
    )
    # (c) trust seeding is label-independent (keys off the fs UUID).
    assert "cafef00d-848" in _trusted_list(tmp_path), _trusted_list(tmp_path)
    # (d) the Nextcloud folder follows the tail with no extra plumbing — this is
    # what makes the owner's name visible on the Files screen.
    reg_idx = _first(cmds, "docker exec -u 33 droplet-nextcloud-1 php occ files_external:create /Family_Photos-cafef00d")
    assert reg_idx > mount_idx, cmds


# Down-container docker stub: every `docker exec … php occ …` call fails, the
# way a warming/absent Nextcloud container does. Passed via stub_overrides so
# _exec_run's stub rewrite can't clobber it back to the success stub (the old
# write-between-two-runs shape did exactly that and re-tested the SUCCESS path).
_DOWN_DOCKER_STUB = (
    "printf 'docker %s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 1\n"
)


def test_pool_format_registration_failure_is_nonfatal(tmp_path):
    # A warming/absent Nextcloud container must never fail a pool op that
    # already formatted + mounted — the boot reconcile converges it later.
    proc, cmds = _exec_run(
        "pool_format", {"device": "md0", "fstype": "ext4",
                        "confirm_phrase": "ERASE md0"},
        tmp_path, extra_env=_pool_state_env(tmp_path),
        stub_overrides={"docker": _DOWN_DOCKER_STUB})
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    assert _first(cmds, "mount /dev/md0") >= 0, cmds
    # The failing registration path was genuinely exercised (docker WAS
    # called and failed) — not short-circuited before the docker exec…
    assert _first(cmds, "docker exec") >= 0, cmds
    # …and the script reported it as deferred-to-reconcile, not a failure.
    assert "deferred" in proc.stderr, proc.stderr


def test_pool_format_registers_even_when_hotplug_autoregister_opted_out(tmp_path):
    # WARP-1338 review: NEXTCLOUD_AUTO_REGISTER scopes the HOT-PLUG paths
    # (udev automount add + boot reconcile) only. The pool/adopt/reclaim ops
    # are owner-confirmed dashboard operations — the very "add mounts via the
    # dashboard instead" alternative the opt-out steers tighter deployments
    # toward — so they register regardless of the flag (install.sh's env-file
    # comment is scoped to match). Pin that deliberate behavior here.
    proc, cmds = _exec_run(
        "pool_format", {"device": "md0", "fstype": "ext4",
                        "confirm_phrase": "ERASE md0"},
        tmp_path, extra_env={
            **_pool_state_env(tmp_path),
            "NEXTCLOUD_AUTO_REGISTER": "0",
        })
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    assert _first(
        cmds,
        "docker exec -u 33 droplet-nextcloud-1 php occ files_external:create /pool-cafef00d",
    ) >= 0, cmds


def test_adopt_mounts_at_automount_derived_name_and_registers(tmp_path):
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(label="Family_Photos"), tmp_path,
        extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    mount_idx = _first(cmds, "mount /dev/sdb")
    assert mount_idx >= 0, cmds
    # Labelled adopt: <label>-<short-uuid>, exactly what automount re-derives.
    assert cmds[mount_idx].endswith("/mnt/droplet/Family_Photos-cafef00d"), cmds
    assert "cafef00d-848" in _trusted_list(tmp_path), _trusted_list(tmp_path)
    reg_idx = _first(cmds, "docker exec -u 33 droplet-nextcloud-1 php occ files_external:create /Family_Photos-cafef00d")
    assert reg_idx > mount_idx, cmds


def test_adopt_without_label_uses_the_drive_stem(tmp_path):
    # No label -> automount's "drive" fallback stem, same short-uuid tail.
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    mount_idx = _first(cmds, "mount /dev/sdb")
    assert mount_idx >= 0, cmds
    assert cmds[mount_idx].endswith("/mnt/droplet/drive-cafef00d"), cmds


def test_reclaim_mounts_at_automount_derived_name_and_registers(tmp_path):
    proc, cmds = _exec_run(
        "drive_reclaim",
        {"device": "sdb", "md": "md127", "fstype": "ext4",
         "wipe_method": "quick", "label": "Backup",
         "confirm_phrase": "ERASE sdb"},
        tmp_path, extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    mount_idx = _first(cmds, "mount /dev/sdb")
    assert mount_idx >= 0, cmds
    assert cmds[mount_idx].endswith("/mnt/droplet/Backup-cafef00d"), cmds
    assert "cafef00d-848" in _trusted_list(tmp_path), _trusted_list(tmp_path)
    reg_idx = _first(cmds, "docker exec -u 33 droplet-nextcloud-1 php occ files_external:create /Backup-cafef00d")
    assert reg_idx > mount_idx, cmds


# blkid stub that answers an EMPTY UUID — models a freshly-made filesystem
# whose superblock UUID probe comes back empty (SHORT_UUID stays empty, so
# automount_mount_name has no disambiguating suffix to append).
_EMPTY_UUID_BLKID_STUB = r"""
printf 'blkid %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" -s UUID "*) exit 0 ;;
  *" -s TYPE "*) exit 2 ;;
esac
exit 0
"""


def test_adopt_dotdot_label_never_escapes_the_mount_base(tmp_path):
    # automount_mount_name's tr+sed charset filter allows '.' through, and the
    # trailing dash-strip only trims DASHES — a label of exactly ".." with no
    # UUID to append a disambiguating suffix survives sanitization unchanged,
    # so "/mnt/droplet/$(automount_mount_name ..)" resolves to the mount
    # base's PARENT directory instead of a name under it.
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(label=".."), tmp_path,
        extra_env=_pool_state_env(tmp_path),
        stub_overrides={"blkid": _EMPTY_UUID_BLKID_STUB})
    assert proc.returncode == 0, proc.stderr
    forbidden_mount = "/mnt/droplet/.."
    assert not any(
        c.startswith("mount ") and c.endswith(" " + forbidden_mount)
        for c in cmds), (
        "a '..' label with no UUID collapsed automount_mount_name's output "
        "to '..', landing the mount OUTSIDE the mount base: %r" % cmds)


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


# ---------------------------------------------------------------------------
# WARP-936 UX-review fix — pool_format must complete the flow: mkfs THEN mount
# under /mnt/droplet, mirroring drive_adopt steps 3-4. Before this, pool_format
# was mkfs-only: the dashboard's "Format & mount" CTA erased the array and
# returned the owner to a byte-identical "isn't set up as storage yet" card —
# a destructive dead-end loop.
# ---------------------------------------------------------------------------

def _format_params(**over):
    p = {"device": "md0", "confirm_phrase": "ERASE md0"}
    p.update(over)
    return p


def test_pool_format_execute_formats_then_mounts(tmp_path):
    proc, cmds = _exec_run("pool_format", _format_params(), tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    # WARP-1338: the fs is labelled "pool" and the mount lands at the
    # automount-derived pool-<short-uuid> tail (blkid stub answers UUID
    # cafef00d-848), not the old bare-UUID path — so the reboot remount name
    # is identical. Still under the shared /mnt/droplet namespace
    # (host_mount, WARP-868).
    fmt = _first(cmds, "mkfs.ext4 -L pool /dev/md0")
    mnt = _first(cmds, "mount /dev/md0 /mnt/droplet/pool-cafef00d")
    assert 0 <= fmt < mnt, cmds
    assert _first(cmds, "mkdir") >= 0, cmds


def test_pool_format_dry_run_reports_mkfs_and_mount():
    proc = _run("pool_format", _format_params())
    assert proc.returncode == 0, proc.stderr
    assert "mkfs" in proc.stderr
    assert "mount /mnt/droplet" in proc.stderr


def test_pool_format_still_refuses_without_confirm_naming_the_array():
    proc = _run("pool_format", _format_params(confirm_phrase="ERASE md1"))
    assert proc.returncode != 0


# ---------------------------------------------------------------------------
# WARP-1048 — drive_reclaim: break a member out of its md array, then reuse the
# adopt (wipe + reformat + mount) path so the drive is usable on its own again.
# The live box's two WD drives are linux_raid_member disks of a created-but-
# unformatted md127; a plain drive_adopt on a member fails EBUSY (the kernel
# holds it in the array), so reclaim must FIRST fail+remove it from the array
# and zero its md superblock. The OS disk is NEVER reclaimable; the typed
# confirm phrase must name the disk being erased.
# ---------------------------------------------------------------------------

def _reclaim_params(**over):
    p = {
        "device": "sda",
        "md": "md127",
        "fstype": "ext4",
        "wipe_method": "quick",
        "confirm_phrase": "ERASE sda",
    }
    p.update(over)
    return p


def test_reclaim_happy_path_dry_run_succeeds():
    proc = _run("drive_reclaim", _reclaim_params())
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("ok") is True
    assert out.get("device") == "sda"


def test_reclaim_refuses_the_os_disk():
    # The OS/boot disk is never a pool member we'd reclaim — last-line guard.
    proc = _run("drive_reclaim", _reclaim_params(),
                {"DROPLET_POOL_TEST_OSDISK": "/dev/sda"})
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "os" in combined or "system" in combined or "boot" in combined


def test_reclaim_requires_confirm_naming_the_disk():
    assert _run("drive_reclaim", _reclaim_params(confirm_phrase="")).returncode != 0
    bad = _run("drive_reclaim", _reclaim_params(confirm_phrase="yes reclaim it"))
    assert bad.returncode != 0
    assert "confirm" in (bad.stderr + bad.stdout).lower()


def test_reclaim_requires_the_md_array():
    # Reclaim has to know WHICH array to break the disk out of — missing md is
    # a refusal, never a guess.
    proc = _run("drive_reclaim", _reclaim_params(md=""))
    assert proc.returncode != 0
    assert "md" in (proc.stderr + proc.stdout).lower()


def test_reclaim_rejects_a_non_md_array_name():
    # The md field must look like md<N> — never a partition or a shell-injectable
    # token. (The orchestrator also validates; this is the last line.)
    proc = _run("drive_reclaim", _reclaim_params(md="sdb; rm -rf /"))
    assert proc.returncode != 0


def test_reclaim_dry_run_reports_fail_remove_then_wipe_and_mkfs():
    proc = _run("drive_reclaim", _reclaim_params(wipe_method="secure"))
    assert proc.returncode == 0, proc.stderr
    combined = (proc.stdout + proc.stderr).lower()
    assert "dry-run" in combined or json.loads(proc.stdout).get("dry_run") is True
    # The command plan names the array detach AND the wipe/mkfs reuse.
    assert "fail" in combined and "remove" in combined
    assert "wipe" in combined and "mkfs" in combined


def test_reclaim_execute_detaches_from_array_before_wiping(tmp_path):
    # The heart of WARP-1048: mdadm --fail/--remove + --zero-superblock must run
    # BEFORE wipefs/mkfs, or the wipe hits EBUSY on the array-held member.
    proc, cmds = _exec_run("drive_reclaim", _reclaim_params(), tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout).get("ok") is True
    detach = _first(cmds, "mdadm /dev/md127 --fail /dev/sda --remove /dev/sda")
    zero = _first(cmds, "mdadm --zero-superblock /dev/sda")
    wipe = _first(cmds, "wipefs")
    mkfs = _first(cmds, "mkfs.ext4")
    mount = _first(cmds, "mount /dev/sda")
    assert 0 <= detach < zero < wipe < mkfs < mount, cmds


def test_reclaim_execute_mounts_the_reclaimed_disk(tmp_path):
    # End state parity with adopt: the reclaimed disk is mkfs'd and mounted
    # under the shared /mnt/droplet namespace so it's usable immediately.
    proc, cmds = _exec_run("drive_reclaim", _reclaim_params(), tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert _first(cmds, "mount /dev/sda /mnt/droplet/") >= 0, cmds


def test_reclaim_confirm_phrase_substring_is_not_enough():
    # Phrase names sda1, reclaim target is the DISK sda → refuse (exact token).
    proc = _run("drive_reclaim", _reclaim_params(confirm_phrase="ERASE sda1"))
    assert proc.returncode != 0
    assert "confirm" in (proc.stderr + proc.stdout).lower()


def test_reclaim_refuses_when_disk_is_not_a_member_of_the_named_array():
    # WARP-1048 hardening: if the disk is NOT actually a member of the named md
    # (stale dashboard view, disk already left the array, wrong pool named), the
    # script refuses cleanly BEFORE any mdadm --fail — turning a raw "cannot
    # find <dev>" mdadm error into an owner-actionable message. Dry-run still
    # runs the pre-flight, so we can assert the refusal without the stub chain.
    proc = _run("drive_reclaim", _reclaim_params(),
                {"DROPLET_POOL_TEST_MDSLAVE": "0"})
    assert proc.returncode != 0
    combined = (proc.stderr + proc.stdout).lower()
    assert "not a member" in combined or "nothing to reclaim" in combined


def test_reclaim_execute_non_member_never_touches_mdadm_or_wipes(tmp_path):
    # The membership refusal must fire before ANY destructive command — no
    # mdadm --fail/--remove/--zero-superblock, no wipefs, no mkfs.
    proc, cmds = _exec_run("drive_reclaim", _reclaim_params(), tmp_path,
                           extra_env={"DROPLET_POOL_TEST_MDSLAVE": "0"})
    assert proc.returncode != 0
    assert _first(cmds, "mdadm") == -1, cmds
    assert _first(cmds, "wipefs") == -1, cmds
    assert _first(cmds, "mkfs.ext4") == -1, cmds
