"""Hermetic tests for droplet-automount.sh's add path (WARP-936 review fix).

The WARP-936 udev widening (99-droplet-automount.rules now matches whole-disk
nodes) delivers add events for disks whose signature is real but NOT
mountable — RAID members (linux_raid_member), LVM PVs (LVM2_member), LUKS
containers (crypto_LUKS) and swap. Before this fix the script's `*` mount
branch attempted a real `mount` on them, failed, and exited 1 — one failed
droplet-automount@sdX systemd unit per pool member on every boot of a box
with a pool. Those signatures are owned by their own subsystems (mdadm / LVM
/ cryptsetup / swapon); the script must skip them cleanly: exit 0, no mount
attempted.

Same PATH-stub approach as test_storage_pool_script.py: every host tool the
script shells out to is replaced by a stub that logs to $CMD_LOG, so no real
block device, root, or mount is ever needed. The script's base paths are
redirected into tmp via the DROPLET_AUTOMOUNT_* env seams (udev/systemd
invoke the real unit with a clean environment, so the defaults always apply
in production).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "services" / "automount" / "droplet-automount.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def _posix(p: Path) -> str:
    # Git-Bash on Windows handles C:/-style paths; backslashes don't survive
    # bash quoting (same trick as test_storage_pool_script.py).
    return str(p).replace("\\", "/")


_STUBS = {
    # blkid answers from $STUB_FS_TYPE so each test picks the signature.
    "blkid": r"""
printf 'blkid %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" -s TYPE "*) [ -n "${STUB_FS_TYPE:-}" ] && printf '%s\n' "$STUB_FS_TYPE"; exit 0 ;;
  *" -s LABEL "*) exit 2 ;;
  *" -s UUID "*) printf 'cafef00d-9360\n'; exit 0 ;;
esac
exit 0
""",
    # lsblk: PKNAME of the boot partition -> its disk; PKNAME of a whole disk
    # -> empty; SIZE -> big enough to pass the 100 MiB guard.
    "lsblk": r"""
printf 'lsblk %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" PKNAME "*)
    dev="$(basename "${@: -1}")"
    case "$dev" in
      nvme*p[0-9]*) printf '%s\n' "${dev%p*}" ;;
      sd*[0-9]) printf '%s' "$dev" | sed 's/[0-9]*$//'; echo ;;
      *) : ;;
    esac
    exit 0 ;;
  *" SIZE "*) printf '2000000000000\n'; exit 0 ;;
esac
exit 0
""",
    # findmnt: root fs lives on the NVMe OS disk; nothing else is mounted.
    "findmnt": r"""
printf 'findmnt %s\n' "$*" >> "$CMD_LOG"
last=; for a in "$@"; do last="$a"; done
if [ "$last" = "/" ]; then printf '/dev/nvme0n1p2\n'; exit 0; fi
exit 1
""",
    "mountpoint": "printf 'mountpoint %s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 1\n",
}
for _tool in ("mount", "umount", "chown", "curl", "docker"):
    _STUBS[_tool] = (
        "printf '%s %%s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 0\n" % _tool
    )


def _run_add(device: str, fs_type: str, tmp_path: Path):
    stub_dir = tmp_path / "stub-bin"
    stub_dir.mkdir(exist_ok=True)
    for name, body in _STUBS.items():
        stub = stub_dir / name
        stub.write_text("#!/usr/bin/env bash\n" + body.lstrip("\n"),
                        encoding="utf-8", newline="\n")
        os.chmod(stub, 0o755)
    # Pin `python3` (state_add helper) to THIS interpreter — the bare name on
    # a Windows dev host resolves to the WindowsApps alias shim.
    py_stub = stub_dir / "python3"
    py_stub.write_text(
        '#!/usr/bin/env bash\nexec "{}" "$@"\n'.format(
            Path(sys.executable).as_posix()),
        encoding="utf-8", newline="\n")
    os.chmod(py_stub, 0o755)

    log = tmp_path / "cmd-log.txt"
    log.write_text("", encoding="utf-8")
    base = tmp_path / "mnt"
    state_dir = tmp_path / "state"
    script_log = tmp_path / "automount.log"
    env = dict(os.environ)
    env.update({
        "CMD_LOG": _posix(log),
        "STUB_FS_TYPE": fs_type,
        "DROPLET_AUTOMOUNT_BASE": _posix(base),
        "DROPLET_AUTOMOUNT_STATE_DIR": _posix(state_dir),
        "DROPLET_AUTOMOUNT_LOG": _posix(script_log),
        "BRIDGE_ENV_FILE": _posix(tmp_path / "no-such.env"),
        "PATH": str(stub_dir) + os.pathsep + env.get("PATH", ""),
    })
    proc = subprocess.run(
        [BASH, str(SCRIPT), "add", device],
        env=env, capture_output=True, text=True, timeout=60,
    )
    cmds = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln]
    script_logged = (
        script_log.read_text(encoding="utf-8") if script_log.exists() else ""
    )
    return proc, cmds, script_logged


@pytest.mark.parametrize(
    "sig", ["linux_raid_member", "LVM2_member", "crypto_LUKS", "swap"]
)
def test_non_mountable_signatures_skip_cleanly(sig, tmp_path):
    # A pool-member / PV / LUKS / swap whole disk must be a clean no-op:
    # exit 0 (no failed systemd unit) and NO mount attempt.
    proc, cmds, logged = _run_add("/dev/sdb", sig, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert not any(c.startswith("mount ") for c in cmds), cmds
    assert sig in logged and "skip" in logged.lower(), logged


def test_plain_filesystem_still_mounts():
    # Control: the skip-list must not be over-broad — a real data filesystem
    # on a whole disk still goes through the mount branch.
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        proc, cmds, _ = _run_add("/dev/sdb", "ext4", Path(td))
        assert proc.returncode == 0, proc.stderr
        assert any(c.startswith("mount ") for c in cmds), cmds


def test_signatureless_disk_still_skips(tmp_path):
    # Regression pin for the pre-existing guard: a bare disk with no
    # signature at all (fresh drive, OS whole-disk node) stays a no-op.
    proc, cmds, logged = _run_add("/dev/sdb", "", tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert not any(c.startswith("mount ") for c in cmds), cmds
    assert "no filesystem signature" in logged, logged
