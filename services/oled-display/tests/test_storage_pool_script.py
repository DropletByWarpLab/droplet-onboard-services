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

# WARP-3513 — fixtures for the always-encrypted bay flow. Obviously fake values
# only: the "recovery key" is the shape systemd-cryptenroll emits (lowercase
# modhex groups) but is NOT a key to anything, and the temporary install key is
# the openssl stub's fixed output.
FAKE_RECOVERY_KEY = (
    "ffffffff-fakefake-fakefake-fakefake-fakefake-fakefake-fakefake-fakefake"
)
FAKE_INSTALL_KEY = "FAKE-TEMPORARY-INSTALL-KEY-MATERIAL-NOT-A-REAL-KEY"
LUKS_UUID = "1a2b3c4d-1111-4222-8333-444455556666"
BAY_MAPPER = "droplet-bay-1a2b3c4d"
BAY_MAPPER_DEV = "/dev/mapper/" + BAY_MAPPER
FS_UUID = "cafef00d-848"   # what the blkid stub reports for any device
CRYPTTAB_OPTS = (
    "tpm2-device=auto,luks,discard,nofail,headless=true,"
    "x-systemd.device-timeout=30s"
)


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
        env=env, capture_output=True, text=True, timeout=600,
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
  if [ -n "${LSBLK_PKNAME_MAP:-}" ]; then
    # WARP-3513: a dm-crypt mapper's parent is the LUKS container node
    # ("<name> <parent>" lines), exactly what the real lsblk reports.
    hit="$(printf '%s' "$LSBLK_PKNAME_MAP" | awk -v d="$dev" '$1 == d { print $2; exit }')"
    if [ -n "$hit" ]; then printf '%s\n' "$hit"; exit 0; fi
  fi
  case "$dev" in
    nvme*p[0-9]*|mmcblk*p[0-9]*) printf '%s\n' "${dev%p*}" ;;
    sd*[0-9]|vd*[0-9]) printf '%s' "$dev" | sed 's/[0-9]*$//'; echo ;;
    *) : ;;
  esac
  exit 0
fi
if [ "${1:-}" = "-rsno" ] && [ "${2:-}" = "TYPE" ]; then
  # WARP-3513 bay_data_is_encrypted: the TYPE of the device holding /data and
  # of everything beneath it, one per line, from $LSBLK_TYPES_OUT.
  printf '%s' "${LSBLK_TYPES_OUT:-}"
  exit 0
fi
if [ "${1:-}" = "-rno" ] && [ "${2:-}" = "NAME,TYPE" ]; then
  # WARP-3513 bay_forget_on: every node stacked on the device (itself first) as
  # "<name> <type>" lines, from $LSBLK_NAME_TYPE_OUT (empty = nothing stacked).
  # $LSBLK_ONLY_NODE (optional) limits the answer to ONE queried node so a
  # test can model "only the SECOND pool member was an encrypted bay".
  if [ -z "${LSBLK_ONLY_NODE:-}" ] || [ "$(basename "${3:-}")" = "$LSBLK_ONLY_NODE" ]; then
    printf '%s' "${LSBLK_NAME_TYPE_OUT:-}"
  fi
  exit 0
fi
if [ "${1:-}" = "-rno" ] && [ "${2:-}" = "FSTYPE,UUID" ]; then
  # WARP-3513: signatures on the device and its children, "<fstype> <uuid>".
  if [ -z "${LSBLK_ONLY_NODE:-}" ] || [ "$(basename "${3:-}")" = "$LSBLK_ONLY_NODE" ]; then
    printf '%s' "${LSBLK_FSTYPE_UUID_OUT:-}"
  fi
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
if [ "${1:-}" = "-U" ]; then
  # blkid -U <uuid>: the device carrying that UUID ($BLKID_U_DEV), else exit 2.
  if [ -n "${BLKID_U_DEV:-}" ]; then printf '%s\n' "$BLKID_U_DEV"; exit 0; fi
  exit 2
fi
case " $* " in
  *" -s UUID "*) printf 'cafef00d-848\n'; exit 0 ;;
  *" -s TYPE "*) exit 2 ;;
esac
exit 0
""",
}
# WARP-3513 — the encryption toolchain. Every stub logs its argv to $CMD_LOG
# (so a test can assert order and flags) and NEVER receives or prints a secret
# argument: the recovery key travels on systemd-cryptenroll's STDOUT only.
_STUBS["cryptsetup"] = r"""
printf 'cryptsetup %s\n' "$*" >> "$CMD_LOG"
case "${1:-}" in
  luksDump)
    printf '%s' "${LUKS_DUMP_JSON:-}"
    exit 0 ;;
  luksUUID)
    printf '%s\n' "${LUKS_UUID_OUT:-1a2b3c4d-1111-4222-8333-444455556666}"
    exit 0 ;;
  close)
    case ",${CLOSE_FAIL:-}," in
      *",${2:-},"*) printf 'Device %s is still in use.\n' "${2:-}" >&2; exit 5 ;;
    esac ;;
  *)
    [ "${CRYPTSETUP_FAIL_OP:-}" = "${1:-}" ] && exit 1 ;;
esac
exit 0
"""
_STUBS["systemd-cryptenroll"] = r"""
printf 'systemd-cryptenroll %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" --tpm2-device=list "*) exit "${CRYPTENROLL_LIST_RC:-0}" ;;
  *" --recovery-key "*)
    [ "${CRYPTENROLL_FAIL:-}" = recovery ] && exit 1
    printf '%s\n' "${FAKE_RECOVERY_KEY:-}"
    exit 0 ;;
  *" --tpm2-device=auto "*)
    [ "${CRYPTENROLL_FAIL:-}" = tpm2 ] && exit 1
    exit 0 ;;
  *" --wipe-slot="*)
    [ "${CRYPTENROLL_FAIL:-}" = wipe ] && exit 1
    exit 0 ;;
esac
exit 0
"""
_STUBS["openssl"] = (
    "printf 'openssl %s\\n' \"$*\" >> \"$CMD_LOG\"\n"
    "printf '" + FAKE_INSTALL_KEY + "'\n"
    "exit 0\n"
)
# shred stub: log, then really remove the file (the real shred is a no-op
# safety net the tests don't need).
_STUBS["shred"] = r"""
printf 'shred %s\n' "$*" >> "$CMD_LOG"
last=; for a in "$@"; do last="$a"; done
rm -f "$last"
exit 0
"""
for _tool in ("wipefs", "blkdiscard", "mkfs.ext4", "mount", "mkdir", "mdadm",
              "docker", "chown", "chmod", "chattr"):
    # docker (WARP-1338): the post-mount Nextcloud registration shells
    # `docker exec -u 33 <container> php occ ...`; the plain logging stub
    # answers success with empty output, so files_external:list never matches
    # and the create path is exercised.
    _STUBS[_tool] = (
        "printf '%s %%s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 0\n" % _tool
    )

# WARP-3513: `mkdir` still RECORDS every call and stays a no-op for the
# /mnt/droplet mount points (the existing assertions rely on that), but it really
# creates directories inside the test's private sandbox ($STUB_REAL_MKDIR_ROOT)
# — the escrow and runtime directories the encryption flow must write into.
_STUBS["mkdir"] = r"""
printf 'mkdir %s\n' "$*" >> "$CMD_LOG"
for a in "$@"; do
  case "$a" in
    "${STUB_REAL_MKDIR_ROOT:-/nonexistent-root}"/*)
      PATH="/usr/bin:/bin:$PATH" command mkdir "$@"; exit $? ;;
  esac
done
exit 0
"""
# chmod: records every call. Inside the sandbox it ALSO attempts the real chmod
# (so the POSIX-mode assertions on the escrow directory mean something on a
# Linux/macOS dev host) and ignores a failure — a Windows host (Git-Bash/MSYS)
# cannot set directory modes at all, and mode bits are meaningless there. A path
# outside the sandbox (/mnt/droplet/...) stays a recorded no-op.
_STUBS["chmod"] = r"""
printf 'chmod %s\n' "$*" >> "$CMD_LOG"
for a in "$@"; do
  case "$a" in
    "${STUB_REAL_MKDIR_ROOT:-/nonexistent-root}"/*)
      PATH="/usr/bin:/bin:$PATH" command chmod "$@" 2>/dev/null || true
      exit 0 ;;
  esac
done
exit 0
"""


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
    # WARP-3513: the encryption flow writes /etc/crypttab, a root-only recovery
    # escrow and a temporary key file under /run. Every one is redirected into
    # tmp_path so a test run can NEVER touch the dev host's real /etc or /run
    # (this suite is also run by developers on Linux boxes where they are root).
    tpm = tmp_path / "tpm0"
    tpm.write_text("", encoding="utf-8")
    env = dict(os.environ)
    env.update({
        "DROPLET_CRYPTTAB": _posix(tmp_path / "crypttab"),
        "DROPLET_BAY_RECOVERY_DIR": _posix(tmp_path / "recovery"),
        "DROPLET_LUKS_RUNTIME_DIR": _posix(tmp_path / "run"),
        "STUB_REAL_MKDIR_ROOT": _posix(tmp_path),
        "DROPLET_POOL_TEST_DATA_ENCRYPTED": "1",
        "DROPLET_TPM_DEVICE": _posix(tpm),
        "FAKE_RECOVERY_KEY": FAKE_RECOVERY_KEY,
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
        # Generous: a Windows dev host pays ~0.5-5s per process spawn (more
        # under load) and the encrypted execute path forks dozens of stubs +
        # several python3 one-liners.
        env=env, capture_output=True, text=True, timeout=900,
    )
    cmds = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln]
    return proc, cmds


def _first(cmds: list[str], prefix: str) -> int:
    for i, c in enumerate(cmds):
        if c.startswith(prefix):
            return i
    return -1


def _idx(cmds: list[str], *needles: str) -> int:
    """Index of the first logged command containing EVERY needle (-1 if none)."""
    for i, c in enumerate(cmds):
        if all(n in c for n in needles):
            return i
    return -1


def _bay_mount(cmds: list[str]) -> int:
    """Index of the encrypted bay's creation-time mount (WARP-3513): the
    filesystem inside the LUKS container is what gets mounted, never the raw
    disk or md node."""
    for i, c in enumerate(cmds):
        if c.startswith("mount -o ") and BAY_MAPPER_DEV in c:
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
    # (a) the filesystem is labelled so the automount derivation has a stem —
    # WARP-3513: it is made INSIDE the LUKS container, on the mapper.
    mkfs = [c for c in cmds if c.startswith("mkfs.ext4")]
    assert mkfs and "-L pool" in mkfs[0] and BAY_MAPPER_DEV in mkfs[0], cmds
    # (b) creation-time mount tail == automount's reboot derivation.
    mount_idx = _bay_mount(cmds)
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
    assert _bay_mount(cmds) >= 0, cmds
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
    mount_idx = _bay_mount(cmds)
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
    mount_idx = _bay_mount(cmds)
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
    mount_idx = _bay_mount(cmds)
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
    # WARP-3513: an encrypted bay is addressed (recovery-key escrow, the
    # reveal API, the drives list) by its filesystem UUID, so a filesystem whose
    # UUID probe comes back empty is REFUSED outright instead of mounted under a
    # bare stem. The property under test is unchanged and holds trivially: no
    # mount may ever land outside the mount base.
    assert proc.returncode != 0
    forbidden_mount = "/mnt/droplet/.."
    assert not any(
        c.startswith("mount ") and c.endswith(" " + forbidden_mount)
        for c in cmds), (
        "a '..' label with no UUID collapsed automount_mount_name's output "
        "to '..', landing the mount OUTSIDE the mount base: %r" % cmds)
    assert _first(cmds, "mount ") == -1, cmds


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


def test_managed_unmount_prunes_an_encrypted_bays_state_entry(tmp_path):
    # WARP-3513: an encrypted bay's automount state entry records the BACKING
    # device (/dev/sdb) in `device` and the dm-crypt mapper — the mount's real
    # SOURCE — in `mapper`. The managed teardown unmounts by SOURCE, so the
    # prune must match the mapper too, or the entry outlives the bay.
    state = tmp_path / "mounts.json"
    state.write_text(json.dumps({"mounts": [
        {"device": "/dev/sdb", "mount": "/mnt/droplet/old-aaaa1111",
         "label": "old", "uuid": "aaaa1111", "trust": "enrolled",
         "mapper": "/dev/mapper/droplet-bay-aaaa1111"},
        {"device": "/dev/sdc1", "mount": "/mnt/droplet/other-9999",
         "label": "other", "uuid": "99999999"},
    ]}), encoding="utf-8", newline="\n")
    proc, _cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/mapper/droplet-bay-aaaa1111",
                 "/mnt/droplet/old-aaaa1111")],
        extra_env={"DROPLET_AUTOMOUNT_STATE": _posix(state),
                   "LSBLK_PKNAME_MAP": "droplet-bay-aaaa1111 sdb\n"})
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
    fmt = _idx(cmds, "mkfs.ext4", "-L pool", BAY_MAPPER_DEV)
    mnt = _idx(cmds, "mount -o", BAY_MAPPER_DEV, "/mnt/droplet/pool-cafef00d")
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
    mount = _bay_mount(cmds)
    assert 0 <= detach < zero < wipe < mkfs < mount, cmds


def test_reclaim_execute_mounts_the_reclaimed_disk(tmp_path):
    # End state parity with adopt: the reclaimed disk is mkfs'd and mounted
    # under the shared /mnt/droplet namespace so it's usable immediately.
    proc, cmds = _exec_run("drive_reclaim", _reclaim_params(), tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert _idx(cmds, "mount -o", BAY_MAPPER_DEV, "/mnt/droplet/") >= 0, cmds


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


# ---------------------------------------------------------------------------
# WARP-3513 — EVERY drive/pool this script formats is ALWAYS encrypted at rest.
#
# Pipeline (same scheme as /data — scripts/host/droplet-luks-provision.sh):
#   wipe -> luksFormat LUKS2/Argon2id (temporary tmpfs key) -> open
#        -> recovery key enrolled FIRST (WARP-2101 ordering) -> TPM2 enrolled
#           (PCR set from droplet-tpm-lib.sh) -> temporary keyslot removed
#        -> ext4 `-O quota,project` inside the container
#        -> recovery key escrowed root-only for ONE-TIME retrieval
#        -> crypttab line (nofail, headless) -> mount `prjquota`
#        -> <mount>/files created -> trusted.list -> Nextcloud registered at
#           <mount>/files (never the drive root; <mount>/nvr is never exposed).
# The recovery key is a SECRET: it may exist only in the shell's memory, the
# root-only escrow file, and the one-time reveal's stdout — never in argv, a
# log, a result file for any other op, or the Prepare success JSON.
# ---------------------------------------------------------------------------

def _crypttab(tmp_path: Path) -> list[str]:
    ct = tmp_path / "crypttab"
    return ct.read_text(encoding="utf-8").splitlines() if ct.exists() else []


def _escrow(tmp_path: Path) -> list[str]:
    d = tmp_path / "recovery"
    return sorted(p.name for p in d.iterdir()) if d.exists() else []


def _bay_line(luks_uuid: str = LUKS_UUID) -> str:
    return "droplet-bay-%s UUID=%s none %s" % (luks_uuid[:8], luks_uuid,
                                               CRYPTTAB_OPTS)


def _assert_no_key_material(tmp_path: Path, proc, cmds: list[str]) -> None:
    """The recovery key and the temporary install key must not appear in the
    script's stdout/stderr, in any logged argv, or in ANY file under tmp_path
    other than the root-only escrow file (which is the one sanctioned home)."""
    blob = proc.stdout + "\n" + proc.stderr + "\n" + "\n".join(cmds)
    assert FAKE_RECOVERY_KEY not in blob, "recovery key leaked into output/argv"
    assert FAKE_INSTALL_KEY not in blob, "install key leaked into output/argv"
    escrow = tmp_path / "recovery"
    for f in tmp_path.rglob("*"):
        if not f.is_file() or escrow in f.parents:
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        assert FAKE_RECOVERY_KEY not in text, "recovery key persisted in %s" % f


def test_adopt_dry_run_reports_the_encryption_pipeline():
    proc = _run("drive_adopt", _adopt_params(label="Photos"))
    assert proc.returncode == 0, proc.stderr
    plan = proc.stderr
    assert "luksFormat" in plan and "TPM2" in plan, plan
    assert "recovery key" in plan.lower(), plan
    assert "quota,project" in plan and "prjquota" in plan, plan
    assert "files" in plan, plan
    # Dry-run must stay inert and keep the pre-existing JSON shape.
    out = json.loads(proc.stdout)
    assert out.get("ok") is True and out.get("dry_run") is True


@pytest.mark.parametrize("op", ["drive_adopt", "drive_reclaim", "pool_format"])
def test_only_ext4_is_accepted_for_encrypted_bays(op, tmp_path):
    # Project quotas (the recordings slice, WARP-3514) are an ext4 mechanism,
    # so a bay is always ext4. xfs/btrfs are refused BEFORE anything runs.
    base = {
        "drive_adopt": _adopt_params(fstype="xfs"),
        "drive_reclaim": {"device": "sdb", "md": "md127", "fstype": "xfs",
                          "wipe_method": "quick",
                          "confirm_phrase": "ERASE sdb"},
        "pool_format": {"device": "md0", "fstype": "btrfs",
                        "confirm_phrase": "ERASE md0"},
    }[op]
    proc, cmds = _exec_run(op, base, tmp_path)
    assert proc.returncode != 0
    assert "ext4" in (proc.stderr + proc.stdout)
    for destructive in ("wipefs", "cryptsetup", "mkfs", "mdadm", "umount"):
        assert _first(cmds, destructive) == -1, cmds


def test_adopt_builds_the_full_encrypted_bay_in_order(tmp_path):
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(label="Family_Photos"), tmp_path,
        extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    mnt = "/mnt/droplet/Family_Photos-cafef00d"

    wipe = _idx(cmds, "wipefs -a /dev/sdb")
    fmt = _idx(cmds, "cryptsetup luksFormat", "--type luks2",
               "--pbkdf argon2id", "--batch-mode", "--key-file", "/dev/sdb")
    opened = _idx(cmds, "cryptsetup open", "--key-file", "/dev/sdb", BAY_MAPPER)
    recovery = _idx(cmds, "systemd-cryptenroll", "--recovery-key", "/dev/sdb")
    tpm = _idx(cmds, "systemd-cryptenroll", "--tpm2-device=auto",
               "--tpm2-pcrs=0+2+4+7", "/dev/sdb")
    rmkey = _idx(cmds, "cryptsetup luksRemoveKey", "/dev/sdb")
    mkfs = _idx(cmds, "mkfs.ext4", "-O quota,project", "-L Family_Photos",
                BAY_MAPPER_DEV)
    mount = _idx(cmds, "mount -o rw,nosuid,nodev,noatime,prjquota",
                 BAY_MAPPER_DEV, mnt)
    files = _idx(cmds, "mkdir -p " + mnt + "/files")
    chown = _idx(cmds, "chown 33:33 " + mnt + "/files")
    chmod = _idx(cmds, "chmod 0770 " + mnt + "/files")
    chattr = _idx(cmds, "chattr +P -p 4097 " + mnt + "/files")
    nc = _idx(cmds, "files_external:create /Family_Photos-cafef00d",
              "datadir=/host/Family_Photos-cafef00d/files")
    steps = [wipe, fmt, opened, recovery, tpm, rmkey, mkfs, mount, files,
             chown, chmod, chattr, nc]
    assert all(i >= 0 for i in steps), (steps, cmds)
    assert steps == sorted(steps), (
        "pipeline out of order — recovery key must be enrolled BEFORE the TPM "
        "slot (WARP-2101), the temporary slot removed before mkfs, and the "
        "drive registered only after files/ exists: %r" % (cmds,))
    # The registration must NEVER be the drive root (nvr/ + lost+found stay
    # private): no occ create without the /files suffix.
    assert not any("files_external:create" in c and
                   "datadir=/host/Family_Photos-cafef00d" in c and
                   not c.rstrip().endswith("/files") for c in cmds), cmds
    # fs UUID (not the LUKS UUID) seeds trusted.list (reboot re-mount rw).
    assert FS_UUID in _trusted_list(tmp_path), _trusted_list(tmp_path)


def test_adopt_writes_the_crypttab_line_exactly_and_idempotently(tmp_path):
    ct = tmp_path / "crypttab"
    ct.write_text(
        "# <name> <device> <password> <options>\n"
        "droplet-data-crypt /dev/ubuntu-vg/droplet-data none "
        "tpm2-device=auto,luks,discard,nofail,headless=true,"
        "x-systemd.device-timeout=30s\n"
        + _bay_line() + "\n",
        encoding="utf-8", newline="\n")
    proc, cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path,
                           extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    lines = _crypttab(tmp_path)
    assert lines.count(_bay_line()) == 1, lines          # not duplicated
    assert any(ln.startswith("droplet-data-crypt ") for ln in lines), lines
    assert lines[0].startswith("#"), lines                # comments survive


def test_adopt_json_announces_the_pending_recovery_key_but_never_the_key(tmp_path):
    proc, cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path,
                           extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("ok") is True
    assert out.get("encrypted") is True
    assert out.get("uuid") == FS_UUID
    assert out.get("recovery_key_pending") is True
    _assert_no_key_material(tmp_path, proc, cmds)


def test_stdout_is_exactly_one_json_object_even_when_the_tools_are_noisy(tmp_path):
    # mkfs / wipefs / systemd-cryptenroll narrate on STDOUT in real life. The
    # bridge json.loads()'s the whole stdout and falls back to an opaque
    # `message` string on ANY stray line — which would silently drop the
    # `uuid` / `encrypted` / `recovery_key_pending` fields the dashboard needs.
    # Tool chatter must go to stderr; stdout is the JSON line and nothing else.
    noisy = {
        "wipefs": "printf 'wipefs %s\\n' \"$*\" >> \"$CMD_LOG\"\n"
                  "echo '/dev/sdb: 2 bytes were erased at offset 0x00000438'\n",
        "mkfs.ext4": "printf 'mkfs.ext4 %s\\n' \"$*\" >> \"$CMD_LOG\"\n"
                     "echo 'Creating filesystem with 244190646 4k blocks'\n",
    }
    proc, cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path,
                           extra_env=_pool_state_env(tmp_path),
                           stub_overrides=noisy)
    assert proc.returncode == 0, proc.stderr
    assert len(proc.stdout.strip().splitlines()) == 1, proc.stdout
    out = json.loads(proc.stdout)
    assert out["encrypted"] is True and out["uuid"] == FS_UUID
    # …and the chatter was not swallowed: it is on stderr for diagnosis.
    assert "bytes were erased" in proc.stderr


def test_adopt_escrows_the_recovery_key_root_only_and_removes_the_install_key(tmp_path):
    proc, cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path,
                           extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    assert _escrow(tmp_path) == ["%s__%s.key" % (LUKS_UUID, FS_UUID)]
    key_file = tmp_path / "recovery" / ("%s__%s.key" % (LUKS_UUID, FS_UUID))
    assert key_file.read_text(encoding="utf-8").strip() == FAKE_RECOVERY_KEY
    if os.name == "posix":  # POSIX modes are not meaningful on a Windows host
        assert (key_file.stat().st_mode & 0o777) == 0o600
        assert ((tmp_path / "recovery").stat().st_mode & 0o777) == 0o700
    # The temporary install key lived only in the tmpfs runtime dir and is gone.
    assert list((tmp_path / "run").glob(".bay-key.*")) == []
    assert any(c.startswith("cryptsetup luksRemoveKey") for c in cmds), cmds


_PREPARE_OPS = {
    "drive_adopt": lambda: _adopt_params(),
    "drive_reclaim": lambda: {"device": "sdb", "md": "md127", "fstype": "ext4",
                              "wipe_method": "quick",
                              "confirm_phrase": "ERASE sdb"},
    "pool_format": lambda: {"device": "md0", "confirm_phrase": "ERASE md0"},
}


def _assert_nothing_destructive_ran(cmds):
    for destructive in ("umount", "wipefs", "cryptsetup", "mkfs", "mdadm",
                        "mount ", "blkdiscard"):
        assert _first(cmds, destructive) == -1, (destructive, cmds)


@pytest.mark.parametrize("op", sorted(_PREPARE_OPS))
def test_every_prepare_op_refuses_without_a_tpm_with_the_tpm_required_code(op, tmp_path):
    # Prepare REQUIRES a TPM2 (owner decision, ADR-070): exit 75 is the machine
    # code the bridge turns into HTTP 409 tpm_required, and NOTHING is touched.
    proc, cmds = _exec_run(
        op, _PREPARE_OPS[op](), tmp_path,
        mounts=[("/dev/sdb1", "/mnt/droplet/data-abcd1234")],
        extra_env={"DROPLET_TPM_DEVICE": _posix(tmp_path / "no-such-tpm")})
    assert proc.returncode == 75, (proc.returncode, proc.stderr)
    assert "tpm2" in (proc.stderr + proc.stdout).lower()
    _assert_nothing_destructive_ran(cmds)
    assert _crypttab(tmp_path) == [] and _escrow(tmp_path) == []


def test_there_is_no_override_that_prepares_a_bay_without_a_tpm(tmp_path):
    # The /data provisioning's old dev escape hatch must NOT carry over: an
    # encrypted drive that is not TPM-sealed would not auto-unlock.
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        extra_env={"DROPLET_TPM_DEVICE": _posix(tmp_path / "no-such-tpm"),
                   "DROPLET_LUKS_ALLOW_NO_TPM": "1",
                   **_pool_state_env(tmp_path)})
    assert proc.returncode == 75, (proc.returncode, proc.stderr)
    _assert_nothing_destructive_ran(cmds)


def test_adopt_refuses_when_tpm2_userspace_is_unusable_before_anything_destructive(tmp_path):
    # WARP-2101 class: /dev/tpm0 exists but systemd-cryptenroll cannot drive
    # it (tss2 libs missing). Same machine code, same "nothing was erased".
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        extra_env={"CRYPTENROLL_LIST_RC": "1"})
    assert proc.returncode == 75, (proc.returncode, proc.stderr)
    assert "tpm2" in (proc.stderr + proc.stdout).lower()
    _assert_nothing_destructive_ran(cmds)


@pytest.mark.parametrize("op", sorted(_PREPARE_OPS))
def test_every_prepare_op_refuses_when_data_is_not_encrypted(op, tmp_path):
    # ADR-070 section 8.2: the recovery key waits on /data, "the TPM-sealed LUKS
    # volume, never the unencrypted root filesystem". Exit 76 -> HTTP 409
    # encrypted_data_required; nothing is erased.
    proc, cmds = _exec_run(
        op, _PREPARE_OPS[op](), tmp_path,
        extra_env={"DROPLET_POOL_TEST_DATA_ENCRYPTED": "0"})
    assert proc.returncode == 76, (proc.returncode, proc.stderr)
    assert "encrypted" in (proc.stderr + proc.stdout).lower()
    _assert_nothing_destructive_ran(cmds)
    assert _escrow(tmp_path) == []


def _real_probe_env(tmp_path, types_out, mounts_src="/dev/mapper/droplet-data-crypt"):
    return ({"DROPLET_POOL_TEST_DATA_ENCRYPTED": "",     # the REAL probe
             "LSBLK_TYPES_OUT": types_out},
            [(mounts_src, _posix(tmp_path))])


@pytest.mark.parametrize("types_out,expect_ok", [
    ("crypt\ndisk\n", True),                 # /data on its own LUKS mapper
    ("lvm\ncrypt\npart\ndisk\n", True),      # LUKS under LVM
    ("lvm\npart\ndisk\n", False),            # plain LVM root: NOT encrypted
    ("part\ndisk\n", False),
    ("", False),                             # lsblk could not say -> fail closed
])
def test_the_real_data_probe_wants_a_crypt_device_in_the_ancestry(types_out, expect_ok, tmp_path):
    env, mounts = _real_probe_env(tmp_path, types_out)
    proc, cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path,
                           mounts=mounts,
                           extra_env={**env, **_pool_state_env(tmp_path)})
    if expect_ok:
        assert proc.returncode == 0, proc.stderr
    else:
        assert proc.returncode == 76, (proc.returncode, proc.stderr)
        _assert_nothing_destructive_ran(cmds)


def test_the_real_data_probe_fails_closed_when_the_secrets_tree_is_missing(tmp_path):
    # The escrow's parent directory (/data/droplet/secrets in production) does
    # not exist: /data was never provisioned -> refuse, do not invent it.
    env, mounts = _real_probe_env(tmp_path, "crypt\n")
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path, mounts=mounts,
        extra_env={**env,
                   "DROPLET_BAY_RECOVERY_DIR": _posix(tmp_path / "no" / "such" / "bay-recovery")})
    assert proc.returncode == 76, (proc.returncode, proc.stderr)
    _assert_nothing_destructive_ran(cmds)


@pytest.mark.parametrize("fail_env,why", [
    ({"CRYPTENROLL_FAIL": "recovery"}, "recovery-key enrolment fails"),
    ({"CRYPTENROLL_FAIL": "tpm2"}, "TPM2 enrolment fails"),
    ({"CRYPTSETUP_FAIL_OP": "open"}, "the container will not open"),
])
def test_a_failed_prepare_leaves_no_half_built_bay_behind(fail_env, why, tmp_path):
    proc, cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path,
                           extra_env=fail_env)
    assert proc.returncode != 0, why
    # Nothing is mounted/registered/wired for boot, no key material remains,
    # and a mapper we opened is closed again.
    assert _first(cmds, "mount ") == -1, cmds
    assert _crypttab(tmp_path) == [], (why, _crypttab(tmp_path))
    assert _escrow(tmp_path) == [], (why, _escrow(tmp_path))
    assert list((tmp_path / "run").glob(".bay-key.*")) == [], why
    if fail_env.get("CRYPTSETUP_FAIL_OP") != "open":
        assert _idx(cmds, "cryptsetup close", BAY_MAPPER) >= 0, (why, cmds)
    erase = _idx(cmds, "cryptsetup luksErase --batch-mode /dev/sdb")
    signature = _idx(cmds, "wipefs -a /dev/sdb")
    assert 0 <= erase < signature, (why, cmds)
    _assert_no_key_material(tmp_path, proc, cmds)


def test_a_failed_mkfs_leaves_no_half_built_bay_behind(tmp_path):
    failing_mkfs = "printf 'mkfs.ext4 %s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 1\n"
    proc, cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path,
                           stub_overrides={"mkfs.ext4": failing_mkfs})
    assert proc.returncode != 0
    assert _first(cmds, "mount ") == -1, cmds
    assert _crypttab(tmp_path) == [] and _escrow(tmp_path) == []
    assert _idx(cmds, "cryptsetup close", BAY_MAPPER) >= 0, cmds
    erase = _idx(cmds, "cryptsetup luksErase --batch-mode /dev/sdb")
    signature = _idx(cmds, "wipefs -a /dev/sdb")
    assert 0 <= erase < signature, cmds
    assert list((tmp_path / "run").glob(".bay-key.*")) == []


def test_unexpected_recovery_key_output_is_rejected_without_echoing_it(tmp_path):
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        extra_env={"FAKE_RECOVERY_KEY": "error: Failed to generate THE-SECRET"})
    assert proc.returncode != 0
    assert "THE-SECRET" not in proc.stdout + proc.stderr
    assert _first(cmds, "mkfs") == -1, cmds
    assert _crypttab(tmp_path) == [] and _escrow(tmp_path) == []


def test_reprepare_forgets_the_previous_bay_before_wiping(tmp_path):
    # The drive already is a prepared bay (open mapper, crypttab line, escrow).
    # Re-preparing it must close the mapper (it would EBUSY the wipe), drop the
    # stale crypttab line and its escrow, then wire the NEW container.
    old_luks = "aaaa1111-2222-4333-8444-555566667777"
    (tmp_path / "crypttab").write_text(
        "droplet-data-crypt /dev/ubuntu-vg/droplet-data none luks,nofail\n"
        + _bay_line(old_luks) + "\n", encoding="utf-8", newline="\n")
    esc = tmp_path / "recovery"
    esc.mkdir()
    (esc / ("%s__oldfsuuid.key" % old_luks)).write_text("old\n", encoding="utf-8")
    (esc / ("%s__oldfsuuid.retrieved" % old_luks)).write_text("t\n", encoding="utf-8")
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        extra_env={
            **_pool_state_env(tmp_path),
            "LSBLK_NAME_TYPE_OUT": "sdb disk\ndroplet-bay-aaaa1111 crypt\n",
            "LSBLK_FSTYPE_UUID_OUT": "crypto_LUKS %s\next4 oldfsuuid\n" % old_luks,
        })
    assert proc.returncode == 0, proc.stderr
    close = _idx(cmds, "cryptsetup close droplet-bay-aaaa1111")
    wipe = _idx(cmds, "wipefs -a /dev/sdb")
    assert 0 <= close < wipe, cmds
    lines = _crypttab(tmp_path)
    assert not any("aaaa1111" in ln for ln in lines), lines
    assert any(ln.startswith("droplet-data-crypt ") for ln in lines), lines
    assert _bay_line() in lines, lines
    assert _escrow(tmp_path) == ["%s__%s.key" % (LUKS_UUID, FS_UUID)]


def test_reprepare_refuses_when_the_old_mapper_is_still_in_use(tmp_path):
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        extra_env={
            "LSBLK_NAME_TYPE_OUT": "sdb disk\ndroplet-bay-aaaa1111 crypt\n",
            "CLOSE_FAIL": "droplet-bay-aaaa1111",
        })
    assert proc.returncode != 0
    assert "close open files" in (proc.stderr + proc.stdout).lower()
    assert _first(cmds, "wipefs") == -1, cmds
    assert _first(cmds, "cryptsetup luksFormat") == -1, cmds


def test_pool_format_is_luks_over_the_md_array(tmp_path):
    proc, cmds = _exec_run(
        "pool_format", {"device": "md0", "confirm_phrase": "ERASE md0"},
        tmp_path, extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out.get("encrypted") is True and out.get("uuid") == FS_UUID
    fmt = _idx(cmds, "cryptsetup luksFormat", "/dev/md0")
    tpm = _idx(cmds, "systemd-cryptenroll", "--tpm2-device=auto", "/dev/md0")
    mkfs = _idx(cmds, "mkfs.ext4", "-O quota,project", "-L pool", BAY_MAPPER_DEV)
    mnt = _idx(cmds, "mount -o", "prjquota", BAY_MAPPER_DEV,
               "/mnt/droplet/pool-cafef00d")
    assert 0 <= fmt < tpm < mkfs < mnt, cmds
    assert _bay_line() in _crypttab(tmp_path)
    assert _idx(cmds, "files_external:create /pool-cafef00d",
                "datadir=/host/pool-cafef00d/files") >= 0, cmds
    _assert_no_key_material(tmp_path, proc, cmds)


def test_pool_format_of_a_prepared_pool_unmounts_and_forgets_it_first(tmp_path):
    old_luks = "bbbb2222-2222-4333-8444-555566667777"
    (tmp_path / "crypttab").write_text(_bay_line(old_luks) + "\n",
                                       encoding="utf-8", newline="\n")
    proc, cmds = _exec_run(
        "pool_format", {"device": "md0", "confirm_phrase": "ERASE md0"},
        tmp_path,
        mounts=[("/dev/mapper/droplet-bay-bbbb2222", "/mnt/droplet/pool-bbbb2222")],
        extra_env={
            **_pool_state_env(tmp_path),
            "LSBLK_NAME_TYPE_OUT": "md0 raid1\ndroplet-bay-bbbb2222 crypt\n",
            "LSBLK_FSTYPE_UUID_OUT": "crypto_LUKS %s\n" % old_luks,
            "LSBLK_PKNAME_MAP": "droplet-bay-bbbb2222 md0\n",
        })
    assert proc.returncode == 0, proc.stderr
    umount = _idx(cmds, "umount /mnt/droplet/pool-bbbb2222")
    close = _idx(cmds, "cryptsetup close droplet-bay-bbbb2222")
    fmt = _idx(cmds, "cryptsetup luksFormat", "/dev/md0")
    assert 0 <= umount < close < fmt, cmds
    assert not any("bbbb2222" in ln for ln in _crypttab(tmp_path))


def test_reclaim_encrypts_the_disk_after_detaching_it_from_the_array(tmp_path):
    proc, cmds = _exec_run(
        "drive_reclaim",
        {"device": "sdb", "md": "md127", "fstype": "ext4",
         "wipe_method": "quick", "label": "Backup",
         "confirm_phrase": "ERASE sdb"},
        tmp_path, extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    detach = _idx(cmds, "mdadm /dev/md127 --fail /dev/sdb --remove /dev/sdb")
    wipe = _idx(cmds, "wipefs -a /dev/sdb")
    fmt = _idx(cmds, "cryptsetup luksFormat", "/dev/sdb")
    mnt = _idx(cmds, "mount -o", "prjquota", BAY_MAPPER_DEV,
               "/mnt/droplet/Backup-cafef00d")
    assert 0 <= detach < wipe < fmt < mnt, cmds
    assert json.loads(proc.stdout).get("encrypted") is True


def test_create_forgets_a_member_that_was_a_prepared_bay_before_wiping_it(tmp_path):
    old_luks = "cccc3333-2222-4333-8444-555566667777"
    (tmp_path / "crypttab").write_text(_bay_line(old_luks) + "\n",
                                       encoding="utf-8", newline="\n")
    params = _create_params(members=["/dev/sdb", "/dev/sdc"],
                            confirm_phrase="ERASE sdb sdc")
    proc, cmds = _exec_run(
        "pool_create", params, tmp_path,
        extra_env={
            "LSBLK_NAME_TYPE_OUT": "sdb disk\ndroplet-bay-cccc3333 crypt\n",
            "LSBLK_FSTYPE_UUID_OUT": "crypto_LUKS %s\n" % old_luks,
        })
    assert proc.returncode == 0, proc.stderr
    close = _idx(cmds, "cryptsetup close droplet-bay-cccc3333")
    wipe = _idx(cmds, "wipefs -a /dev/sdb")
    assert 0 <= close < wipe, cmds
    assert _crypttab(tmp_path) == []


def test_create_erases_no_member_until_every_bay_mapper_has_closed(tmp_path):
    # WARP-848's invariant ("nothing is destroyed until EVERY member has
    # released cleanly") must survive WARP-3513: the SECOND member is a prepared
    # bay whose mapper is busy. Closing it is part of the release phase, so the
    # create is refused BEFORE the first member is wiped — never half-erased.
    params = _create_params(members=["/dev/sdb", "/dev/sdc"],
                            confirm_phrase="ERASE sdb sdc")
    proc, cmds = _exec_run(
        "pool_create", params, tmp_path,
        extra_env={
            "LSBLK_ONLY_NODE": "sdc",
            "LSBLK_NAME_TYPE_OUT": "sdc disk\ndroplet-bay-cccc3333 crypt\n",
            "CLOSE_FAIL": "droplet-bay-cccc3333",
        })
    assert proc.returncode != 0
    assert "close open files" in (proc.stderr + proc.stdout).lower()
    assert _first(cmds, "wipefs") == -1, cmds
    assert _first(cmds, "mdadm") == -1, cmds


def test_crypttab_without_a_trailing_newline_is_not_corrupted(tmp_path):
    (tmp_path / "crypttab").write_text(
        "droplet-data-crypt /dev/ubuntu-vg/droplet-data none luks,nofail",
        encoding="utf-8", newline="\n")           # NO trailing newline
    proc, _cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path,
                            extra_env=_pool_state_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    lines = _crypttab(tmp_path)
    assert lines[0] == "droplet-data-crypt /dev/ubuntu-vg/droplet-data none luks,nofail", lines
    assert _bay_line() in lines, lines


def test_destroy_closes_the_luks_layer_before_stopping_the_array(tmp_path):
    old_luks = "dddd4444-2222-4333-8444-555566667777"
    (tmp_path / "crypttab").write_text(_bay_line(old_luks) + "\n",
                                       encoding="utf-8", newline="\n")
    proc, cmds = _exec_run(
        "pool_destroy", {"device": "md0", "confirm_phrase": "ERASE md0"},
        tmp_path,
        mounts=[("/dev/mapper/droplet-bay-dddd4444", "/mnt/droplet/pool-dddd4444")],
        extra_env={
            "LSBLK_NAME_TYPE_OUT": "md0 raid1\ndroplet-bay-dddd4444 crypt\n",
            "LSBLK_FSTYPE_UUID_OUT": "crypto_LUKS %s\n" % old_luks,
            "LSBLK_PKNAME_MAP": "droplet-bay-dddd4444 md0\n",
        })
    assert proc.returncode == 0, proc.stderr
    umount = _idx(cmds, "umount /mnt/droplet/pool-dddd4444")
    close = _idx(cmds, "cryptsetup close droplet-bay-dddd4444")
    stop = _idx(cmds, "mdadm --stop /dev/md0")
    assert 0 <= umount < close < stop, (
        "an open dm-crypt mapper holds the md array: stop would EBUSY: %r" % cmds)
    assert _crypttab(tmp_path) == []


# --- one-time recovery-key reveal (the host half of POST .../recovery-key/reveal) ---

def _seed_escrow(tmp_path: Path, luks: str = LUKS_UUID, fs: str = FS_UUID,
                 key: str = FAKE_RECOVERY_KEY) -> Path:
    d = tmp_path / "recovery"
    d.mkdir(exist_ok=True)
    f = d / ("%s__%s.key" % (luks, fs))
    f.write_text(key + "\n", encoding="utf-8", newline="\n")
    return f


def _reveal(tmp_path: Path, uuid: str = FS_UUID):
    return _exec_run("recovery_key_reveal", {"uuid": uuid}, tmp_path)


def test_reveal_hands_the_key_over_exactly_once(tmp_path):
    key_file = _seed_escrow(tmp_path)
    first, cmds = _reveal(tmp_path)
    assert first.returncode == 0, first.stderr
    out = json.loads(first.stdout)
    assert out["ok"] is True
    assert out["operation"] == "recovery_key_reveal"
    assert out["status"] == "revealed"
    assert out["uuid"] == FS_UUID
    assert out["recovery_key"] == FAKE_RECOVERY_KEY
    # The key is on STDOUT only — never stderr, never an argv.
    assert FAKE_RECOVERY_KEY not in first.stderr
    assert FAKE_RECOVERY_KEY not in "\n".join(cmds)
    # Consumed: the escrow file is gone and a tombstone (no secret) remains.
    assert not key_file.exists()
    assert _escrow(tmp_path) == ["%s__%s.retrieved" % (LUKS_UUID, FS_UUID)]
    tomb = tmp_path / "recovery" / ("%s__%s.retrieved" % (LUKS_UUID, FS_UUID))
    assert FAKE_RECOVERY_KEY not in tomb.read_text(encoding="utf-8")

    second, _ = _reveal(tmp_path)
    assert second.returncode == 0, second.stderr
    again = json.loads(second.stdout)
    assert again["status"] == "already_retrieved"
    assert "recovery_key" not in again
    assert FAKE_RECOVERY_KEY not in second.stdout + second.stderr


def test_reveal_of_an_unknown_drive_is_not_found_not_an_error(tmp_path):
    proc, _ = _reveal(tmp_path, uuid="00000000-0000-4000-8000-000000000000")
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["status"] == "not_found"
    assert "recovery_key" not in out


@pytest.mark.parametrize("bad", [
    "../etc/passwd", "a/b", "..", "", "short", "x" * 65, "abcdefgh ijkl",
    "cafef00d;rm -rf", "ghijklmn-opqr",
])
def test_reveal_rejects_a_malformed_uuid_without_touching_the_escrow(bad, tmp_path):
    key_file = _seed_escrow(tmp_path)
    proc, _cmds = _reveal(tmp_path, uuid=bad)
    assert proc.returncode != 0
    assert key_file.exists(), "a malformed uuid must never consume a key"
    assert FAKE_RECOVERY_KEY not in proc.stdout + proc.stderr


def test_reveal_needs_no_device_or_confirm_phrase_and_runs_nothing_else(tmp_path):
    # The tier-2 confirmation + owner gate live in the orchestrator; the host
    # op is a pure read-and-consume of an escrow file. It must not unmount,
    # wipe, mkfs, enrol or register anything.
    _seed_escrow(tmp_path)
    proc, cmds = _reveal(tmp_path)
    assert proc.returncode == 0, proc.stderr
    for forbidden in ("umount", "wipefs", "mkfs", "cryptsetup", "mdadm",
                      "systemd-cryptenroll", "mount ", "docker", "chown"):
        assert _first(cmds, forbidden) == -1, (forbidden, cmds)


def test_reveal_refuses_a_malformed_escrow_file_without_echoing_it(tmp_path):
    _seed_escrow(tmp_path, key="not a key: THE-SECRET")
    proc, _cmds = _reveal(tmp_path)
    assert proc.returncode != 0
    assert "THE-SECRET" not in proc.stdout + proc.stderr


def test_reveal_has_exactly_one_winner_when_two_requests_race(tmp_path):
    # Consumption is an atomic rename out of the escrow dir, so even if the
    # root executor were ever started twice only ONE caller gets the key.
    _seed_escrow(tmp_path)
    import concurrent.futures as cf

    def go(i):
        wd = tmp_path / ("w%d" % i)
        wd.mkdir()
        proc, _c = _exec_run(
            "recovery_key_reveal", {"uuid": FS_UUID}, wd,
            extra_env={"DROPLET_BAY_RECOVERY_DIR": _posix(tmp_path / "recovery")})
        return json.loads(proc.stdout)["status"] if proc.returncode == 0 else "error"

    with cf.ThreadPoolExecutor(max_workers=2) as ex:
        results = list(ex.map(go, range(2)))
    assert results.count("revealed") == 1, results
    assert all(r in ("revealed", "already_retrieved", "not_found")
               for r in results), results


# --- 7-day expiry of an unrevealed key ---------------------------------------

def _age(path: Path, days: float) -> None:
    """Back-date a file's mtime (the escrow TTL is measured from it)."""
    t = path.stat().st_mtime - days * 86400
    os.utime(path, (t, t))


def test_a_key_older_than_seven_days_is_shredded_and_never_revealed(tmp_path):
    key_file = _seed_escrow(tmp_path)
    _age(key_file, 8)
    first, cmds = _reveal(tmp_path)
    assert first.returncode == 0, first.stderr
    out = json.loads(first.stdout)
    assert out["status"] == "expired"
    assert "recovery_key" not in out
    assert FAKE_RECOVERY_KEY not in first.stdout + first.stderr
    assert not key_file.exists(), "an expired key must be shredded, not kept"
    assert _escrow(tmp_path) == ["%s__%s.expired" % (LUKS_UUID, FS_UUID)]
    # …and it stays "expired" (no secret in the tombstone, nothing to reveal).
    second, _ = _reveal(tmp_path)
    assert json.loads(second.stdout)["status"] == "expired"


def test_a_key_younger_than_seven_days_is_still_revealed(tmp_path):
    key_file = _seed_escrow(tmp_path)
    _age(key_file, 6)
    proc, _cmds = _reveal(tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["status"] == "revealed"


def test_the_expiry_sweep_shreds_only_stale_unrevealed_keys(tmp_path):
    old_fs, new_fs, done_fs = "aaaaaaaa-1111", "bbbbbbbb-2222", "cccccccc-3333"
    old = _seed_escrow(tmp_path, fs=old_fs)
    fresh = _seed_escrow(tmp_path, luks="2b2b2b2b-1111-4222-8333-444455556666", fs=new_fs)
    tomb = tmp_path / "recovery" / ("%s__%s.retrieved" % (LUKS_UUID, done_fs))
    tomb.write_text("t\n", encoding="utf-8")
    _age(old, 9)
    _age(tomb, 30)               # old tombstones are NOT keys: left alone
    proc, cmds = _exec_run("recovery_key_expire", {}, tmp_path)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["ok"] is True and out["operation"] == "recovery_key_expire"
    assert out["expired"] == 1
    assert not old.exists() and fresh.exists() and tomb.exists()
    assert ("%s__%s.expired" % (LUKS_UUID, old_fs)) in _escrow(tmp_path)
    assert FAKE_RECOVERY_KEY not in proc.stdout + proc.stderr


def test_the_expiry_sweep_with_nothing_escrowed_is_a_clean_no_op(tmp_path):
    proc, cmds = _exec_run("recovery_key_expire", {}, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["expired"] == 0
    for forbidden in ("cryptsetup", "mount ", "umount", "wipefs", "docker"):
        assert _first(cmds, forbidden) == -1, (forbidden, cmds)


# --- Regenerate recovery key (owner, Tier 3) ---------------------------------

LUKS_DUMP_ONE_OLD_RECOVERY = json.dumps({"tokens": {
    "0": {"type": "systemd-tpm2", "keyslots": ["1"]},
    "2": {"type": "systemd-recovery", "keyslots": ["2"]},
}})


def _regen(tmp_path: Path, uuid: str = FS_UUID, **env):
    base = {"BLKID_U_DEV": "/dev/sdb", "LUKS_DUMP_JSON": LUKS_DUMP_ONE_OLD_RECOVERY}
    base.update(env)
    return _exec_run("recovery_key_regenerate", {"uuid": uuid}, tmp_path,
                     extra_env=base)


def test_regenerate_enrols_a_new_recovery_key_then_wipes_only_the_old_slot(tmp_path):
    _seed_escrow(tmp_path)
    key_file = tmp_path / "recovery" / ("%s__%s.key" % (LUKS_UUID, FS_UUID))
    # The owner already retrieved the previous key: a tombstone says so.
    key_file.rename(key_file.with_suffix(".retrieved"))
    proc, cmds = _regen(tmp_path)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["status"] == "regenerated" and out["recovery_key_pending"] is True
    assert "recovery_key" not in out, "the new key leaves only through the reveal"
    new = _idx(cmds, "systemd-cryptenroll", "--unlock-tpm2-device=auto",
               "--recovery-key", "/dev/sdb")
    wipe_old = _idx(cmds, "systemd-cryptenroll", "--wipe-slot=2", "/dev/sdb")
    assert 0 <= new < wipe_old, ("new key first, old slot wiped after", cmds)
    # Exactly the OLD recovery slot — never the TPM slot (1), never "recovery"
    # (which would take the new slot with it).
    wipes = [c for c in cmds if "--wipe-slot=" in c]
    assert len(wipes) == 1 and "--wipe-slot=2" in wipes[0], wipes
    assert not any("--wipe-slot=recovery" in c for c in cmds), cmds
    # A fresh, unrevealed key is escrowed and the stale tombstone is gone.
    assert _escrow(tmp_path) == ["%s__%s.key" % (LUKS_UUID, FS_UUID)]
    assert key_file.read_text(encoding="utf-8").strip() == FAKE_RECOVERY_KEY
    assert FAKE_RECOVERY_KEY not in proc.stdout + proc.stderr + "\n".join(cmds)
    # …and it is then revealable exactly once, like any other.
    reveal, _ = _reveal(tmp_path)
    assert json.loads(reveal.stdout)["status"] == "revealed"


def test_regenerate_restarts_the_seven_day_clock(tmp_path):
    f = _seed_escrow(tmp_path)
    _age(f, 20)                                   # long expired
    f.rename(f.with_suffix(".expired"))
    proc, _cmds = _regen(tmp_path)
    assert proc.returncode == 0, proc.stderr
    key_file = tmp_path / "recovery" / ("%s__%s.key" % (LUKS_UUID, FS_UUID))
    reveal, _ = _reveal(tmp_path)
    assert key_file.exists() is False                  # consumed by the reveal…
    assert json.loads(reveal.stdout)["status"] == "revealed"   # …not "expired"


def test_regenerate_with_no_old_recovery_slot_just_enrols_one(tmp_path):
    _seed_escrow(tmp_path)
    proc, cmds = _regen(tmp_path, LUKS_DUMP_JSON="{}")
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["status"] == "regenerated"
    assert _idx(cmds, "systemd-cryptenroll", "--recovery-key") >= 0
    assert not any("--wipe-slot=" in c for c in cmds), cmds


def test_regenerate_refuses_when_recovery_slot_metadata_cannot_be_read(tmp_path):
    old = _seed_escrow(tmp_path)
    before = old.read_text(encoding="utf-8")
    proc, cmds = _regen(tmp_path, LUKS_DUMP_JSON="not json")
    assert proc.returncode != 0
    assert "inspect the existing recovery keyslots" in (proc.stderr + proc.stdout)
    assert old.read_text(encoding="utf-8") == before
    assert _first(cmds, "systemd-cryptenroll") == -1, cmds


def test_regenerate_of_an_unknown_drive_is_not_found(tmp_path):
    proc, cmds = _regen(tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["status"] == "not_found"
    assert _first(cmds, "systemd-cryptenroll") == -1, cmds


def test_regenerate_of_a_drive_that_is_not_plugged_in_changes_nothing(tmp_path):
    f = _seed_escrow(tmp_path)
    proc, cmds = _regen(tmp_path, BLKID_U_DEV="")
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["status"] == "drive_absent"
    assert f.exists(), "the existing key must not be touched"
    assert _first(cmds, "systemd-cryptenroll --unlock") == -1, cmds


def test_regenerate_needs_a_tpm_and_an_encrypted_data_volume(tmp_path):
    f = _seed_escrow(tmp_path)
    no_tpm, c1 = _regen(tmp_path,
                        DROPLET_TPM_DEVICE=_posix(tmp_path / "no-such-tpm"))
    assert no_tpm.returncode == 75, no_tpm.stderr
    plain, c2 = _regen(tmp_path, DROPLET_POOL_TEST_DATA_ENCRYPTED="0")
    assert plain.returncode == 76, plain.stderr
    assert f.exists()
    for cmds in (c1, c2):
        assert _idx(cmds, "--recovery-key") == -1, cmds


def test_a_failed_old_slot_wipe_still_leaves_the_new_key_escrowed(tmp_path):
    _seed_escrow(tmp_path)
    proc, _cmds = _regen(tmp_path, CRYPTENROLL_FAIL="wipe")
    assert proc.returncode != 0
    assert "retry" in (proc.stderr + proc.stdout).lower()
    # The new key is safe in escrow BEFORE the old slot is touched, so the
    # drive is never left without a recovery key.
    assert _escrow(tmp_path) == ["%s__%s.key" % (LUKS_UUID, FS_UUID)]
    assert FAKE_RECOVERY_KEY not in proc.stdout + proc.stderr


def test_regenerate_preserves_lookup_tombstone_when_escrow_install_fails(tmp_path):
    # Fail the atomic install after the replacement key has been staged. The
    # old marker is the only filesystem-UUID -> LUKS-UUID lookup for retry.
    old = _seed_escrow(tmp_path)
    old.rename(old.with_suffix(".retrieved"))
    tombstone = old.with_suffix(".retrieved")
    tombstone.write_text("retrieved\n", encoding="utf-8")
    fail_mv = 'printf "mv %s\\n" "$*" >> "$CMD_LOG"\nexit 1\n'

    failed, _cmds = _regen(tmp_path, stub_overrides={"mv": fail_mv})
    assert failed.returncode != 0
    assert tombstone.exists(), "failed staging must preserve the drive lookup"
    assert _escrow(tmp_path) == [tombstone.name]
    assert not list((tmp_path / "recovery").glob("*.tmp.*")), \
        "a failed install must shred its staged recovery key"

    retry, cmds = _regen(tmp_path)
    assert retry.returncode == 0, retry.stderr
    assert json.loads(retry.stdout)["status"] == "regenerated"
    assert _idx(cmds, "systemd-cryptenroll", "--recovery-key") >= 0
    assert _escrow(tmp_path) == ["%s__%s.key" % (LUKS_UUID, FS_UUID)]
    assert FAKE_RECOVERY_KEY not in retry.stdout + retry.stderr + "\n".join(cmds)


def test_regenerate_rejects_unexpected_enrolment_output_without_echoing_it(tmp_path):
    f = _seed_escrow(tmp_path)
    before = f.read_text(encoding="utf-8")
    proc, _cmds = _regen(tmp_path, FAKE_RECOVERY_KEY="error: nope THE-SECRET")
    assert proc.returncode != 0
    assert "THE-SECRET" not in proc.stdout + proc.stderr
    assert f.read_text(encoding="utf-8") == before


# --- files/ project id, and the Nextcloud registration of a replaced drive ----

def test_files_project_id_failure_aborts_and_undoes_the_prepare(tmp_path):
    failing_chattr = "printf 'chattr %s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 1\n"
    proc, cmds = _exec_run("drive_adopt", _adopt_params(), tmp_path,
                           extra_env=_pool_state_env(tmp_path),
                           stub_overrides={"chattr": failing_chattr})
    assert proc.returncode != 0
    assert "project" in (proc.stderr + proc.stdout).lower()
    assert _crypttab(tmp_path) == [] and _escrow(tmp_path) == []
    assert _idx(cmds, "umount /mnt/droplet/drive-cafef00d") >= 0, cmds
    assert _idx(cmds, "cryptsetup close", BAY_MAPPER) >= 0, cmds
    assert not any("files_external:create" in c for c in cmds), cmds


_NC_LIST_STUB = (
    "printf 'docker %s\\n' \"$*\" >> \"$CMD_LOG\"\n"
    "case \"$*\" in\n"
    "  *files_external:list*) printf '%s' \"${DOCKER_LIST_JSON:-}\" ;;\n"
    "esac\n"
    "exit 0\n"
)


def _nc_listing(*entries) -> str:
    return json.dumps([
        {"mount_id": mid, "mount_point": "/" + name,
         "configuration": {"datadir": datadir}}
        for mid, name, datadir in entries])


@pytest.mark.parametrize("datadir_suffix", ["", "/files"])
def test_erasing_a_drive_removes_its_nextcloud_registration(datadir_suffix, tmp_path):
    # ADR-070 4.2: Prepare REPLACES the old registration (drive root for a plain
    # drive, files/ for a bay) — a dangling entry must not outlive the erase.
    listing = _nc_listing(
        (7, "old-aaaa1111", "/host/old-aaaa1111" + datadir_suffix),
        (9, "other-9999", "/host/other-9999"))
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/sdb1", "/mnt/droplet/old-aaaa1111")],
        extra_env={**_pool_state_env(tmp_path), "DOCKER_LIST_JSON": listing},
        stub_overrides={"docker": _NC_LIST_STUB})
    assert proc.returncode == 0, proc.stderr
    delete = _idx(cmds, "files_external:delete -y 7")
    unmount = _idx(cmds, "umount /mnt/droplet/old-aaaa1111")
    create = _idx(cmds, "files_external:create /drive-cafef00d")
    assert 0 <= unmount < delete < create, cmds
    assert _idx(cmds, "files_external:delete -y 9") == -1, "another drive's registration stays"


def test_erasing_a_drive_with_no_registration_deletes_nothing(tmp_path):
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/sdb1", "/mnt/droplet/old-aaaa1111")],
        extra_env={**_pool_state_env(tmp_path),
                   "DOCKER_LIST_JSON": _nc_listing((9, "other-9999", "/host/other-9999"))},
        stub_overrides={"docker": _NC_LIST_STUB})
    assert proc.returncode == 0, proc.stderr
    assert _idx(cmds, "files_external:delete") == -1, cmds


def test_a_down_nextcloud_never_blocks_the_erase(tmp_path):
    proc, cmds = _exec_run(
        "drive_adopt", _adopt_params(), tmp_path,
        mounts=[("/dev/sdb1", "/mnt/droplet/old-aaaa1111")],
        extra_env=_pool_state_env(tmp_path),
        stub_overrides={"docker": _DOWN_DOCKER_STUB})
    assert proc.returncode == 0, proc.stderr
    assert _first(cmds, "wipefs") >= 0, cmds
