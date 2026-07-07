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

import json
import os
import re
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

# WARP-232 stubs. cryptsetup's luksDump prints a `systemd-tpm2` token line only
# when STUB_LUKS_ENROLLED=1, so a test picks "droplet-enrolled" vs "foreign"
# LUKS. systemd-cryptsetup logs its `attach` call and exits per STUB_ATTACH_FAILS.
_STUBS["cryptsetup"] = r"""
printf 'cryptsetup %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" luksDump "*)
    if [ "${STUB_LUKS_ENROLLED:-0}" = "1" ]; then
      printf '  0: systemd-tpm2\n        tpm2-device: auto\n'
    fi
    exit 0 ;;
  *" open "*) exit "${STUB_OPEN_FAILS:-0}" ;;
esac
exit 0
"""
_STUBS["systemd-cryptsetup"] = r"""
printf 'systemd-cryptsetup %s\n' "$*" >> "$CMD_LOG"
exit "${STUB_ATTACH_FAILS:-0}"
"""
# The derived-passphrase fallback shells out to droplet-usb-enroll.sh; stub it
# so no real derivation runs in these hermetic cases.
_STUBS["droplet-usb-enroll.sh"] = r"""
printf 'droplet-usb-enroll.sh %s\n' "$*" >> "$CMD_LOG"
case "${1:-}" in derive) printf 'deadbeefdeadbeef\n' ;; esac
exit 0
"""


def _run_add(device: str, fs_type: str, tmp_path: Path, extra_env: dict | None = None):
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
        # WARP-232: point the LUKS-unlock helper seam at the stub on PATH.
        "DROPLET_AUTOMOUNT_USB_ENROLL": _posix(stub_dir / "droplet-usb-enroll.sh"),
        "DROPLET_SYSTEMD_CRYPTSETUP_BIN": _posix(stub_dir / "systemd-cryptsetup"),
        "DROPLET_CRYPTSETUP_BIN": _posix(stub_dir / "cryptsetup"),
        "PATH": str(stub_dir) + os.pathsep + env.get("PATH", ""),
    })
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [BASH, str(SCRIPT), "add", device],
        env=env, capture_output=True, text=True, timeout=60,
    )
    cmds = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln]
    script_logged = (
        script_log.read_text(encoding="utf-8") if script_log.exists() else ""
    )
    mounts_json_path = state_dir / "mounts.json"
    mounts_json = (
        mounts_json_path.read_text(encoding="utf-8")
        if mounts_json_path.exists() else ""
    )
    return proc, cmds, script_logged, mounts_json, state_dir


@pytest.mark.parametrize(
    "sig", ["linux_raid_member", "LVM2_member", "swap"]
)
def test_non_mountable_signatures_skip_cleanly(sig, tmp_path):
    # A pool-member / PV / swap whole disk must be a clean no-op: exit 0 (no
    # failed systemd unit) and NO mount attempt. (crypto_LUKS is handled
    # separately by TestLuksAutomount — WARP-232 now unlocks enrolled ones.)
    proc, cmds, logged, _mj, _sd = _run_add("/dev/sdb", sig, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert not any(c.startswith("mount ") for c in cmds), cmds
    assert sig in logged and "skip" in logged.lower(), logged


def test_plain_filesystem_still_mounts():
    # Control: the skip-list must not be over-broad — a real data filesystem
    # on a whole disk still goes through the mount branch.
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        proc, cmds, _l, _mj, _sd = _run_add("/dev/sdb", "ext4", Path(td))
        assert proc.returncode == 0, proc.stderr
        assert any(c.startswith("mount ") for c in cmds), cmds


def test_signatureless_disk_still_skips(tmp_path):
    # Regression pin for the pre-existing guard: a bare disk with no
    # signature at all (fresh drive, OS whole-disk node) stays a no-op.
    proc, cmds, logged, _mj, _sd = _run_add("/dev/sdb", "", tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert not any(c.startswith("mount ") for c in cmds), cmds
    assert "no filesystem signature" in logged, logged


class TestLuksAutomount:
    """WARP-232: droplet-enrolled LUKS2 USB drives are unlocked + mounted rw;
    foreign LUKS is skipped; plain drives default to read-only-untrusted."""

    def test_enrolled_luks_unlocks_and_mounts_rw(self, tmp_path):
        # A droplet-enrolled LUKS2 drive (systemd-tpm2 header token) is attached
        # via systemd-cryptsetup and mounted read-write.
        proc, cmds, _logged, mounts_json, _sd = _run_add(
            "/dev/sdz1", "crypto_LUKS", tmp_path,
            extra_env={"STUB_LUKS_ENROLLED": "1"},
        )
        assert proc.returncode == 0, proc.stderr
        log = "\n".join(cmds)
        assert "systemd-cryptsetup attach" in log, log
        assert re.search(r"mount .*rw.*droplet-usb-", log), log
        assert '"trust": "enrolled"' in mounts_json, mounts_json

    def test_enrolled_luks_state_records_backing_partition_not_mapper(self, tmp_path):
        # WARP-232 finding 7: state must record device=the BACKING partition
        # (/dev/sdz1) and the mapper SEPARATELY — NOT device=the mapper. Otherwise
        # the udev REMOVE event (which carries /dev/sdz1) never matches (mapper
        # leaks) and crypto-shred luksErases the plaintext mapper (no LUKS header,
        # always fails) instead of the real partition header.
        proc, _cmds, _logged, mounts_json, _sd = _run_add(
            "/dev/sdz1", "crypto_LUKS", tmp_path,
            extra_env={"STUB_LUKS_ENROLLED": "1"},
        )
        assert proc.returncode == 0, proc.stderr
        state = json.loads(mounts_json)
        m = state["mounts"][0]
        assert m["device"] == "/dev/sdz1", (
            "state recorded the mapper as device; crypto-shred + remove break "
            "(finding 7): %r" % m
        )
        assert m.get("mapper", "").startswith("/dev/mapper/droplet-usb-"), (
            "mapper not recorded separately for close-on-remove (finding 7): %r" % m
        )

    def test_enrolled_luks_remove_matches_backing_and_closes_mapper(self, tmp_path):
        # WARP-232 finding 7: the REMOVE event carries the backing partition
        # /dev/sdz1 (that is what udev passes) — it must match the recorded state
        # and `cryptsetup close` the mapper so a replug re-unlocks cleanly.
        # First add (enroll+unlock), then remove using the BACKING partition.
        stub_dir = tmp_path / "stub-bin"
        state_dir = tmp_path / "state"
        _run_add("/dev/sdz1", "crypto_LUKS", tmp_path,
                 extra_env={"STUB_LUKS_ENROLLED": "1"})
        log = tmp_path / "cmd-log.txt"
        log.write_text("", encoding="utf-8")
        env = dict(os.environ)
        env.update({
            "CMD_LOG": _posix(log),
            "DROPLET_AUTOMOUNT_BASE": _posix(tmp_path / "mnt"),
            "DROPLET_AUTOMOUNT_STATE_DIR": _posix(state_dir),
            "DROPLET_AUTOMOUNT_LOG": _posix(tmp_path / "automount.log"),
            "BRIDGE_ENV_FILE": _posix(tmp_path / "no-such.env"),
            "DROPLET_CRYPTSETUP_BIN": _posix(stub_dir / "cryptsetup"),
            "PATH": str(stub_dir) + os.pathsep + env.get("PATH", ""),
        })
        proc = subprocess.run(
            [BASH, str(SCRIPT), "remove", "/dev/sdz1"],
            env=env, capture_output=True, text=True, timeout=60,
        )
        assert proc.returncode == 0, proc.stderr
        cmds = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln]
        joined = "\n".join(cmds)
        # The remove matched (state entry drained) and closed the mapper.
        assert re.search(r"cryptsetup close droplet-usb-", joined), (
            "remove did not close the LUKS mapper — a replug would find it stale "
            "(finding 7): %s" % joined
        )
        state = json.loads((state_dir / "mounts.json").read_text(encoding="utf-8"))
        assert state["mounts"] == [], (
            "remove did not drain the state entry — device match failed "
            "(finding 7): %r" % state
        )

    def test_foreign_luks_still_skipped(self, tmp_path):
        # A LUKS container with no droplet token + no derivable slot: clean skip.
        proc, cmds, logged, _mj, _sd = _run_add(
            "/dev/sdz1", "crypto_LUKS", tmp_path,
            extra_env={"STUB_LUKS_ENROLLED": "0", "STUB_OPEN_FAILS": "1"},
        )
        assert proc.returncode == 0, proc.stderr
        log = "\n".join(cmds)
        assert "systemd-cryptsetup attach" not in log, log
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "foreign LUKS" in logged, logged

    def test_plain_drive_mounts_read_only_untrusted(self, tmp_path):
        # Unenrolled plain filesystems default to ro-untrusted.
        proc, cmds, _logged, mounts_json, _sd = _run_add(
            "/dev/sdz1", "vfat", tmp_path,
        )
        assert proc.returncode == 0, proc.stderr
        assert re.search(r'mount -o "?ro,', "\n".join(cmds)), cmds
        assert '"trust": "untrusted-ro"' in mounts_json, mounts_json

    def test_trusted_plain_drive_mounts_rw(self, tmp_path):
        # A plain drive whose uuid is on the trusted list mounts rw.
        state_dir = tmp_path / "state"
        state_dir.mkdir(exist_ok=True)
        (state_dir / "trusted.list").write_text(
            "cafef00d-9360\n", encoding="utf-8")
        proc, cmds, _logged, mounts_json, _sd = _run_add(
            "/dev/sdz1", "vfat", tmp_path,
        )
        assert proc.returncode == 0, proc.stderr
        assert re.search(r'mount -o "?rw,', "\n".join(cmds)), cmds
        assert '"trust": "trusted"' in mounts_json, mounts_json


INSTALL_SH = (
    Path(__file__).resolve().parents[3]
    / "services" / "automount" / "install.sh"
)


class TestTrustedListSeeding:
    """WARP-232 finding 10: fleet upgrade must seed trusted.list from the
    existing mounts.json so previously-adopted plain drives stay read-WRITE
    (not silently flip read-only on the next replug). Exercises install.sh's
    _seed_trusted_list_from_state by extracting + running it hermetically."""

    def _run_seed(self, tmp_path: Path, mounts: str):
        state_dir = tmp_path / "state"
        state_dir.mkdir(exist_ok=True)
        (state_dir / "mounts.json").write_text(mounts, encoding="utf-8")
        # Extract just the function + its invocation from install.sh so we don't
        # execute the root-only systemd/mount install steps.
        src = INSTALL_SH.read_text(encoding="utf-8")
        start = src.index("_seed_trusted_list_from_state() {")
        end = src.index("_seed_trusted_list_from_state\n", start) + len(
            "_seed_trusted_list_from_state\n")
        body = src[start:end]
        harness = tmp_path / "seed.sh"
        harness.write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\n"
            'STATE_DIR="${DROPLET_AUTOMOUNT_STATE_DIR}"\n' + body,
            encoding="utf-8", newline="\n")
        os.chmod(harness, 0o755)
        env = dict(os.environ)
        env["DROPLET_AUTOMOUNT_STATE_DIR"] = _posix(state_dir)
        # Pin python3 to this interpreter (Windows alias-shim guard).
        stub_dir = tmp_path / "stub-bin"
        stub_dir.mkdir(exist_ok=True)
        py_stub = stub_dir / "python3"
        py_stub.write_text(
            '#!/usr/bin/env bash\nexec "{}" "$@"\n'.format(
                Path(sys.executable).as_posix()),
            encoding="utf-8", newline="\n")
        os.chmod(py_stub, 0o755)
        env["PATH"] = str(stub_dir) + os.pathsep + env.get("PATH", "")
        proc = subprocess.run(
            [BASH, str(harness)], env=env, capture_output=True, text=True,
            timeout=60,
        )
        tlist = state_dir / "trusted.list"
        seeded = (
            tlist.read_text(encoding="utf-8").split() if tlist.exists() else []
        )
        return proc, seeded, state_dir

    def test_seeds_legacy_and_trusted_plain_drives(self, tmp_path):
        # A legacy entry (no "trust" key — all were rw) AND a post-232 "trusted"
        # entry both seed into trusted.list so they stay rw across the upgrade.
        mounts = json.dumps({"mounts": [
            {"device": "/dev/sda1", "mount": "/m/a", "uuid": "legacy-uuid"},
            {"device": "/dev/sdb1", "mount": "/m/b", "uuid": "trusted-uuid",
             "trust": "trusted"},
        ]})
        proc, seeded, _sd = self._run_seed(tmp_path, mounts)
        assert proc.returncode == 0, proc.stderr
        assert "legacy-uuid" in seeded, seeded
        assert "trusted-uuid" in seeded, seeded

    def test_does_not_seed_enrolled_or_untrusted(self, tmp_path):
        # Enrolled LUKS drives (trust list doesn't apply) and untrusted-ro drives
        # (operator never accepted them) must NOT be seeded.
        mounts = json.dumps({"mounts": [
            {"device": "/dev/sdc1", "mount": "/m/c", "uuid": "enrolled-uuid",
             "trust": "enrolled"},
            {"device": "/dev/sdd1", "mount": "/m/d", "uuid": "ro-uuid",
             "trust": "untrusted-ro"},
        ]})
        proc, seeded, _sd = self._run_seed(tmp_path, mounts)
        assert proc.returncode == 0, proc.stderr
        assert "enrolled-uuid" not in seeded, seeded
        assert "ro-uuid" not in seeded, seeded

    def test_seeding_is_idempotent_via_marker(self, tmp_path):
        # A second run does not re-seed (marker file) and does not duplicate.
        mounts = json.dumps({"mounts": [
            {"device": "/dev/sda1", "mount": "/m/a", "uuid": "u1",
             "trust": "trusted"},
        ]})
        proc1, seeded1, state_dir = self._run_seed(tmp_path, mounts)
        assert proc1.returncode == 0, proc1.stderr
        assert seeded1 == ["u1"], seeded1
        assert (state_dir / ".trusted-seeded").exists()
        # Re-run over the same state dir: marker present → no-op, no dup.
        src = INSTALL_SH.read_text(encoding="utf-8")
        start = src.index("_seed_trusted_list_from_state() {")
        end = src.index("_seed_trusted_list_from_state\n", start) + len(
            "_seed_trusted_list_from_state\n")
        harness = tmp_path / "seed.sh"  # reuse
        harness.write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\n"
            'STATE_DIR="${DROPLET_AUTOMOUNT_STATE_DIR}"\n' + src[start:end],
            encoding="utf-8", newline="\n")
        env = dict(os.environ)
        env["DROPLET_AUTOMOUNT_STATE_DIR"] = _posix(state_dir)
        env["PATH"] = (
            str(tmp_path / "stub-bin") + os.pathsep + env.get("PATH", ""))
        subprocess.run([BASH, str(harness)], env=env, capture_output=True,
                       text=True, timeout=60)
        tlist = (state_dir / "trusted.list").read_text(encoding="utf-8").split()
        assert tlist == ["u1"], "re-seed duplicated the entry: %r" % tlist
