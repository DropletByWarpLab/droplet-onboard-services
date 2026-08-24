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
    # WARP-1338: $STUB_FS_LABEL (optional) supplies a label, so the md-pool
    # tests can model droplet-storage-pool.sh's `mkfs -L pool` output.
    # WARP-1361: $STUB_FS_UUID (optional) overrides the UUID so the legacy
    # md-pool tests can model the live box's full-GUID filesystems, and
    # $STUB_TYPE_EMPTY_ONCE (a marker-file path) makes the FIRST TYPE probe
    # come back empty — the boot race where the add uevent fires while the
    # array is still assembling.
    "blkid": r"""
printf 'blkid %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" -s TYPE "*)
    if [ -n "${STUB_TYPE_EMPTY_ONCE:-}" ] && [ ! -e "${STUB_TYPE_EMPTY_ONCE}" ]; then
      touch "${STUB_TYPE_EMPTY_ONCE}"
      exit 0
    fi
    [ -n "${STUB_FS_TYPE:-}" ] && printf '%s\n' "$STUB_FS_TYPE"; exit 0 ;;
  *" -s LABEL "*)
    if [ -n "${STUB_FS_LABEL:-}" ]; then printf '%s\n' "$STUB_FS_LABEL"; exit 0; fi
    exit 2 ;;
  *" -s UUID "*) printf '%s\n' "${STUB_FS_UUID:-cafef00d-9360}"; exit 0 ;;
esac
exit 0
""",
    # WARP-1361: mount honors $STUB_MOUNT_FAIL_ONCE (a marker-file path) —
    # the first call fails EBUSY-style, later calls succeed. Models an
    # auto-read-only / mdadm-readonly array refusing the first rw mount.
    "mount": r"""
printf 'mount %s\n' "$*" >> "$CMD_LOG"
if [ -n "${STUB_MOUNT_FAIL_ONCE:-}" ] && [ ! -e "${STUB_MOUNT_FAIL_ONCE}" ]; then
  touch "${STUB_MOUNT_FAIL_ONCE}"
  exit 32
fi
exit 0
""",
    # WARP-1361: mdadm answers --detail --export from $STUB_MD_NAME (the md
    # superblock name, "<homehost>:<N>"). Default = the droplet-made shape
    # (mdadm --create on the box, shipping hostname droplet-sys). Tests set a
    # foreign name to model a hot-plugged alien array. --readwrite is logged
    # for the auto-read-only assertions.
    "mdadm": r"""
printf 'mdadm %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" --detail "*)
    [ -n "${STUB_MD_NAME-droplet-sys:127}" ] \
      && printf 'MD_NAME=%s\n' "${STUB_MD_NAME-droplet-sys:127}"
    exit 0 ;;
esac
exit 0
""",
    # WARP-1361: hostname backs the "array made on THIS box" homehost check.
    "hostname": "printf '%s\\n' \"${STUB_HOSTNAME:-droplet-sys}\"\nexit 0\n",
    # WARP-1361: every log line is mirrored to the journal via logger — the
    # live md127 no-mount was undiagnosable from journalctl because the
    # script only wrote a file. Logged so tests can assert the mirroring.
    "logger": "printf 'logger %s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 0\n",
    # lsblk: PKNAME of the boot partition -> its disk; PKNAME of a whole disk
    # -> empty; SIZE -> big enough to pass the 100 MiB guard.
    # WARP-2151: the NAME,TYPE case answers the inverse-tree walk
    # (-rnso NAME,TYPE <node>) the boot-disk guard resolves physical disks
    # with. It models the two shipped topologies — LVM mapper -> PV partition
    # -> disk, and plain partition -> disk. md nodes resolve to their member
    # disks (never the OS disk), preserving the WARP-1361 pool posture.
    # WARP-2152: the FSTYPE,LABEL case lists a whole disk's content for the
    # install-media check; $STUB_ISO_DISK marks one disk as the DROPLET
    # install stick (hybrid-ISO signature + ESP + 'writable' persistence).
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
  *" NAME,TYPE "*)
    dev="$(basename "${@: -1}")"
    case "$dev" in
      *--vg-*) printf '%s lvm\nnvme0n1p3 part\nnvme0n1 disk\n' "$dev" ;;
      nvme*p[0-9]*) printf '%s part\n%s disk\n' "$dev" "${dev%p*}" ;;
      nvme*) printf '%s disk\n' "$dev" ;;
      md*) printf '%s raid1\nsdy1 part\nsdy disk\nsdz1 part\nsdz disk\n' "$dev" ;;
      sd*[0-9]) printf '%s part\n%s disk\n' "$dev" "$(printf '%s' "$dev" | sed 's/[0-9]*$//')" ;;
      sd*) printf '%s disk\n' "$dev" ;;
      *) : ;;
    esac
    exit 0 ;;
  *" FSTYPE,LABEL "*)
    dev="$(basename "${@: -1}")"
    if [ -n "${STUB_ISO_DISK:-}" ] && [ "$dev" = "$STUB_ISO_DISK" ]; then
      printf 'iso9660 DROPLET_0_2_2_1\niso9660 DROPLET_0_2_2_1\nvfat ESP\next4 writable\n'
    fi
    exit 0 ;;
  *" SIZE "*) printf '2000000000000\n'; exit 0 ;;
esac
exit 0
""",
    # findmnt: root fs lives on the NVMe OS disk; nothing else is mounted.
    # WARP-2151 seams: $STUB_ROOT_SRC overrides the root SOURCE (default is
    # the plain nvme0n1p2 root the older tests model; the LVM tests point it
    # at the mapper node), and `--source <dev>` queries answer
    # $STUB_DEV_TARGET when set (a device the OS already mounted somewhere).
    "findmnt": r"""
printf 'findmnt %s\n' "$*" >> "$CMD_LOG"
last=; has_source=0
for a in "$@"; do
  [ "$a" = "--source" ] && has_source=1
  last="$a"
done
if [ "$has_source" = 1 ]; then
  if [ -n "${STUB_DEV_TARGET:-}" ]; then printf '%s\n' "$STUB_DEV_TARGET"; exit 0; fi
  exit 1
fi
if [ "$last" = "/" ]; then printf '%s\n' "${STUB_ROOT_SRC:-/dev/nvme0n1p2}"; exit 0; fi
exit 1
""",
    "mountpoint": "printf 'mountpoint %s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 1\n",
}
for _tool in ("umount", "chown", "curl", "docker", "flock"):
    # `flock` guards the mounts.json read-modify-write (PYNET-009). Git-Bash
    # on a Windows dev host ships no flock binary, which 127'd every state_add
    # path; these hermetic tests are single-process, so a no-op stub is a
    # faithful stand-in on every host (Linux CI included).
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


def _run_add(device: str, fs_type: str, tmp_path: Path, extra_env: dict | None = None,
             stub_overrides: dict | None = None):
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
        # Git-Bash (MSYS) rewrites POSIX-looking args (/dev/sdz1 ->
        # C:/Program Files/Git/dev/sdz1) when bash crosses into the NATIVE
        # python the stub execs, corrupting the device recorded in
        # mounts.json. Disable the conversion for these hermetic runs; the
        # var is ignored everywhere but Windows.
        "MSYS2_ARG_CONV_EXCL": "*",
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


class TestBootDiskGuard:
    """WARP-2151 — the boot-sibling guard must survive a dm/LVM-stacked root.

    Live failure (192.168.9.195, first boot of the 0.2.2.1 media,
    2026-08-24): root is /dev/mapper/ubuntu--vg-ubuntu--lv, and PKNAME of
    that mapper node is the PV *partition* (nvme0n1p3), so the old one-hop
    sibling comparisons matched nothing — droplet-automount unmounted /boot
    and /boot/efi and re-adopted both as user drives. Kernel + GRUB updates
    then write to the stale rootfs /boot directory (the same divergence
    found on the customer-site box 2026-08-13)."""

    LVM_ROOT = {"STUB_ROOT_SRC": "/dev/mapper/ubuntu--vg-ubuntu--lv"}

    @pytest.mark.parametrize(
        "device,fs",
        [
            ("/dev/nvme0n1p1", "vfat"),   # the ESP (1 GiB on this media)
            ("/dev/nvme0n1p2", "ext4"),   # /boot
        ],
    )
    def test_lvm_root_boot_partitions_skip(self, device, fs, tmp_path):
        proc, cmds, logged, _mj, _sd = _run_add(
            device, fs, tmp_path, extra_env=self.LVM_ROOT)
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "sibling of boot device" in logged, logged

    def test_plain_root_sibling_still_skips(self, tmp_path):
        # Regression pin for the non-LVM shape the old one-hop PKNAME guard
        # did cover: root directly on nvme0n1p2, adding the ESP.
        proc, cmds, logged, _mj, _sd = _run_add(
            "/dev/nvme0n1p1", "vfat", tmp_path)
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "sibling of boot device" in logged, logged

    def test_lvm_root_other_disk_still_mounts(self, tmp_path):
        # Control: the disk-set walk must not go over-broad — a data drive
        # on a different physical disk still mounts on an LVM-root box.
        proc, cmds, _l, _mj, _sd = _run_add(
            "/dev/sdb1", "ext4", tmp_path, extra_env=self.LVM_ROOT)
        assert proc.returncode == 0, proc.stderr
        assert any(c.startswith("mount ") for c in cmds), cmds


class TestRelocateGuard:
    """WARP-2151, second seam: the relocate step must never steal a mount
    the OS put somewhere else. On the live box it logged "already mounted at
    /boot; unmounting to relocate" and took the boot fs out from under the
    running system."""

    def test_system_mount_is_never_relocated(self, tmp_path):
        # A device already mounted OUTSIDE $MOUNT_BASE (fstab: /boot,
        # /boot/efi, a pool pinned at /mnt/nvr, an operator mount) is
        # system-managed: skip the device, no umount, no mount.
        proc, cmds, logged, _mj, _sd = _run_add(
            "/dev/sdb1", "ext4", tmp_path,
            extra_env={"STUB_DEV_TARGET": "/boot"})
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("umount ") for c in cmds), cmds
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "not relocating" in logged, logged

    def test_stale_automount_path_still_relocates(self, tmp_path):
        # Control: the case the relocate exists for — the same device left
        # mounted at a stale tail under $MOUNT_BASE (re-enumerated /dev/sdX,
        # desktop udisks) — must keep relocating to the derived path.
        stale = _posix(tmp_path / "mnt" / "stale-00000000")
        proc, cmds, logged, _mj, _sd = _run_add(
            "/dev/sdb1", "ext4", tmp_path,
            extra_env={"STUB_DEV_TARGET": stale})
        assert proc.returncode == 0, proc.stderr
        assert any(c.startswith("umount ") for c in cmds), cmds
        assert any(c.startswith("mount ") for c in cmds), cmds
        assert "unmounting to relocate" in logged, logged


class TestInstallMediaGuard:
    """WARP-2152 — the live install stick is not user storage. It stays
    plugged in (WARP-2143 flips boot priority instead of demanding a pull),
    so every boot delivers add events for the hybrid-ISO disk node, its ESP
    and its 'writable' persistence partition. The live box surfaced that
    partition as a ~55 GB USB drive and carried a failed
    droplet-automount@sda unit on every boot."""

    ISO = {"STUB_ISO_DISK": "sda"}

    def test_install_stick_partition_skips(self, tmp_path):
        # sda3 — ext4, label 'writable', ~55 GB — must never be adopted.
        proc, cmds, logged, _mj, _sd = _run_add(
            "/dev/sda3", "ext4", tmp_path, extra_env=self.ISO)
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "install medium" in logged, logged

    def test_install_stick_whole_disk_skips_cleanly(self, tmp_path):
        # The whole-disk node is the one that FAILED live (iso9660 is
        # mountable, the mount hit EBUSY, the unit went red every boot).
        # Must be exit 0 with no mount attempted.
        proc, cmds, logged, _mj, _sd = _run_add(
            "/dev/sda", "iso9660", tmp_path, extra_env=self.ISO)
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "install medium" in logged, logged

    def test_ordinary_usb_partition_still_mounts(self, tmp_path):
        # Control: without the DROPLET_* iso9660 signature on its disk, a
        # USB data partition keeps mounting.
        proc, cmds, _l, _mj, _sd = _run_add("/dev/sdb1", "ext4", tmp_path)
        assert proc.returncode == 0, proc.stderr
        assert any(c.startswith("mount ") for c in cmds), cmds


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
            "MSYS2_ARG_CONV_EXCL": "*",  # see _run_add
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


# =====================================================================
# WARP-1338 — Nextcloud external-storage registration wiring.
#
# The add-path registration must (a) fire only when provisioning opted in
# via NEXTCLOUD_AUTO_REGISTER=1 (the env file a root unit loads — the
# in-script default stays 0), (b) respect the trust gate: never expose an
# untrusted hot-plugged stick to Nextcloud (supply-chain posture), while
# md-pool filesystems — owner-created via the confirm-gated pool flow —
# always count as trusted, (c) use the container name from the same env
# (live boxes run droplet-nextcloud-1, not the old docker-nextcloud-1
# default), and (d) register for the whole household (no
# files_external:applicable / --add-user=admin scoping — browsing acts as
# each user's OWN Nextcloud account, so an admin-scoped mount was
# invisible to everyone else).
# =====================================================================

# Registration-aware docker stub: files_external:list answers from
# $STUB_NC_LIST (default: empty list), files_external:create reports the
# id line real occ prints. Everything is logged for the assertions.
_NC_DOCKER_STUB = r"""
printf 'docker %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" files_external:list "*)
    if [ -n "${STUB_NC_LIST:-}" ] && [ -f "${STUB_NC_LIST:-}" ]; then
      cat "$STUB_NC_LIST"
    else
      printf '[]\n'
    fi
    exit 0 ;;
  *" files_external:create "*)
    printf 'Storage created with id 7\n'; exit 0 ;;
esac
exit 0
"""

_REGISTER_ENV = {
    "NEXTCLOUD_AUTO_REGISTER": "1",
    "NEXTCLOUD_CONTAINER": "droplet-nextcloud-1",
}


class TestNextcloudRegistration:
    def _trusted(self, tmp_path: Path, uuid: str = "cafef00d-9360"):
        state_dir = tmp_path / "state"
        state_dir.mkdir(exist_ok=True)
        (state_dir / "trusted.list").write_text(uuid + "\n", encoding="utf-8")

    def test_trusted_drive_registers_with_env_container(self, tmp_path):
        # Opted in + trusted → the occ chain runs inside the container the
        # env names (droplet-nextcloud-1 — the live compose-project name).
        self._trusted(tmp_path)
        proc, cmds, _l, _mj, _sd = _run_add(
            "/dev/sdz1", "vfat", tmp_path, extra_env=_REGISTER_ENV,
            stub_overrides={"docker": _NC_DOCKER_STUB})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert "docker exec -u 33 droplet-nextcloud-1 php occ app:enable files_external" in joined, joined
        # Unlabeled vfat drive: automount names it drive-<short-uuid>.
        assert "files_external:create /drive-cafef00d local null::null -c datadir=/host/drive-cafef00d" in joined, joined

    def test_untrusted_stick_never_registers_even_when_opted_in(self, tmp_path):
        # The supply-chain gate: an unknown hot-plugged stick mounts ro and is
        # NEVER exposed to Nextcloud, opt-in or not.
        proc, cmds, logged, mounts_json, _sd = _run_add(
            "/dev/sdz1", "vfat", tmp_path, extra_env=_REGISTER_ENV,
            stub_overrides={"docker": _NC_DOCKER_STUB})
        assert proc.returncode == 0, proc.stderr
        assert '"trust": "untrusted-ro"' in mounts_json, mounts_json
        joined = "\n".join(cmds)
        assert "files_external:create" not in joined, joined
        assert "skip" in logged.lower() and "untrusted" in logged.lower(), logged

    def test_registration_stays_off_without_the_env_opt_in(self, tmp_path):
        # The in-script default is 0 (deliberate opt-out posture) —
        # provisioning opts in via /etc/droplet/automount.env; with no env
        # even a trusted drive is not auto-registered.
        self._trusted(tmp_path)
        proc, cmds, logged, _mj, _sd = _run_add(
            "/dev/sdz1", "vfat", tmp_path,
            stub_overrides={"docker": _NC_DOCKER_STUB})
        assert proc.returncode == 0, proc.stderr
        assert "files_external:create" not in "\n".join(cmds), cmds
        assert "auto-register disabled" in logged, logged

    def test_registration_is_household_wide_not_admin_scoped(self, tmp_path):
        # WARP-1338 AC4: no files_external:applicable / --add-user scoping —
        # an unscoped mount is visible to every household user's own account.
        self._trusted(tmp_path)
        proc, cmds, _l, _mj, _sd = _run_add(
            "/dev/sdz1", "vfat", tmp_path, extra_env=_REGISTER_ENV,
            stub_overrides={"docker": _NC_DOCKER_STUB})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert "files_external:create" in joined, joined
        assert "files_external:applicable" not in joined, joined
        assert "--add-user" not in joined, joined

    def test_md_pool_mount_is_trusted_rw_and_registers_at_stable_name(self, tmp_path):
        # An md array filesystem (labelled "pool" by droplet-storage-pool.sh's
        # mkfs -L) is owner-created, not hot-plugged: it mounts rw WITHOUT a
        # trusted.list entry and registers. The mount tail must be the same
        # label-<short-uuid> derivation the pool script uses at creation time,
        # so the registration + driveContentsHref never dangle across reboots.
        proc, cmds, _l, mounts_json, _sd = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={**_REGISTER_ENV, "STUB_FS_LABEL": "pool"},
            stub_overrides={"docker": _NC_DOCKER_STUB})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert re.search(r'mount -o "?rw,.* /dev/md127 .*/pool-cafef00d', joined), joined
        assert '"trust": "trusted"' in mounts_json, mounts_json
        assert "files_external:create /pool-cafef00d local null::null -c datadir=/host/pool-cafef00d" in joined, joined

    def test_already_registered_mount_is_not_created_twice(self, tmp_path):
        # Idempotence: an existing datadir entry short-circuits the create.
        self._trusted(tmp_path)
        nc_list = tmp_path / "nc-list.json"
        nc_list.write_text(
            '[{"mount_id": 7, "mount_point": "/drive-cafef00d", '
            '"datadir":"/host/drive-cafef00d"}]\n', encoding="utf-8")
        proc, cmds, _l, _mj, _sd = _run_add(
            "/dev/sdz1", "vfat", tmp_path,
            extra_env={**_REGISTER_ENV, "STUB_NC_LIST": _posix(nc_list)},
            stub_overrides={"docker": _NC_DOCKER_STUB})
        assert proc.returncode == 0, proc.stderr
        assert "files_external:create" not in "\n".join(cmds), cmds


# =====================================================================
# WARP-1338 — `reconcile` action: one-shot boot/upgrade registration of the
# ALREADY-mounted /mnt/droplet/* paths (pool mounts are created by
# droplet-storage-pool.sh, and a fleet-upgraded box's mounts predate
# registration entirely). Since WARP-1361 the only thing it MOUNTS is an
# assembled-but-unmounted droplet pool array (TestReconcileMountsUnmountedPools);
# it mirrors the add-path trust gate and is idempotent.
# =====================================================================

_RECONCILE_STUBS = {
    "docker": _NC_DOCKER_STUB,
    # mountpoint: true only for targets listed in $STUB_MOUNTED.
    "mountpoint": r"""
printf 'mountpoint %s\n' "$*" >> "$CMD_LOG"
tgt=; for a in "$@"; do tgt="$a"; done
grep -qxF "$tgt" "$STUB_MOUNTED" 2>/dev/null && exit 0
exit 1
""",
    # findmnt: TARGET -> SOURCE from the $STUB_MOUNT_TABLE ("target source");
    # WARP-1361: --source does the inverse lookup (SOURCE -> TARGET), which
    # backs the reconcile mount-loop's "already mounted?" idempotence check.
    "findmnt": r"""
printf 'findmnt %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" --source "*)
    src=; for a in "$@"; do src="$a"; done
    hits="$(awk -v s="$src" '$2 == s { print $1 }' "$STUB_MOUNT_TABLE" 2>/dev/null)"
    [ -n "$hits" ] || exit 1
    printf '%s\n' "$hits"
    exit 0 ;;
esac
tgt=; for a in "$@"; do tgt="$a"; done
hits="$(awk -v t="$tgt" '$1 == t { print $2 }' "$STUB_MOUNT_TABLE" 2>/dev/null)"
[ -n "$hits" ] || exit 1
printf '%s\n' "$hits"
exit 0
""",
    # blkid: SOURCE -> UUID from $STUB_BLKID_TABLE ("source uuid");
    # WARP-1361: SOURCE -> TYPE from $STUB_TYPE_TABLE ("source fstype") so
    # the reconcile mount loop can probe an unmounted array's filesystem.
    "blkid": r"""
printf 'blkid %s\n' "$*" >> "$CMD_LOG"
src=; for a in "$@"; do src="$a"; done
case " $* " in
  *" -s UUID "*)
    awk -v s="$src" '$1 == s { print $2 }' "$STUB_BLKID_TABLE" 2>/dev/null
    exit 0 ;;
  *" -s TYPE "*)
    awk -v s="$src" '$1 == s { print $2 }' "${STUB_TYPE_TABLE:-/nonexistent}" 2>/dev/null
    exit 0 ;;
esac
exit 0
""",
}


class TestReconcile:
    def _run_reconcile(self, tmp_path: Path, mounts: dict[str, str],
                       trusted: list[str] | None = None,
                       blkid: dict[str, str] | None = None,
                       extra_env: dict | None = None,
                       dev_nodes: list[str] | None = None,
                       node_types: dict[str, str] | None = None,
                       node_uuids: dict[str, str] | None = None):
        """mounts: mount-dir name -> backing source device.

        WARP-1361: dev_nodes lists md device names to place in the hermetic
        device dir (DROPLET_AUTOMOUNT_DEV_DIR) so the reconcile mount loop
        can enumerate assembled-but-unmounted arrays; node_types/node_uuids
        feed the blkid stub tables for those nodes.
        """
        base = tmp_path / "mnt"
        base.mkdir(exist_ok=True)
        state_dir = tmp_path / "state"
        state_dir.mkdir(exist_ok=True)
        dev_dir = tmp_path / "dev"
        dev_dir.mkdir(exist_ok=True)
        for name in (dev_nodes or []):
            (dev_dir / name).touch()
        if trusted:
            (state_dir / "trusted.list").write_text(
                "".join(u + "\n" for u in trusted), encoding="utf-8")
        mounted = tmp_path / "stub-mounted.txt"
        table = tmp_path / "stub-mount-table.txt"
        blkid_table = tmp_path / "stub-blkid-table.txt"
        type_table = tmp_path / "stub-type-table.txt"
        lines_mounted, lines_table = [], []
        for name, src in mounts.items():
            (base / name).mkdir(exist_ok=True)
            tgt = _posix(base / name)
            lines_mounted.append(tgt + "\n")
            lines_table.append(f"{tgt} {src}\n")
        mounted.write_text("".join(lines_mounted), encoding="utf-8")
        table.write_text("".join(lines_table), encoding="utf-8")
        blkid_map = dict(blkid or {})
        for name, u in (node_uuids or {}).items():
            blkid_map[_posix(dev_dir / name)] = u
        blkid_table.write_text(
            "".join(f"{s} {u}\n" for s, u in blkid_map.items()),
            encoding="utf-8")
        type_table.write_text(
            "".join(f"{_posix(dev_dir / n)} {t}\n"
                    for n, t in (node_types or {}).items()),
            encoding="utf-8")

        env = {
            **_REGISTER_ENV,
            "STUB_MOUNTED": _posix(mounted),
            "STUB_MOUNT_TABLE": _posix(table),
            "STUB_BLKID_TABLE": _posix(blkid_table),
            "STUB_TYPE_TABLE": _posix(type_table),
            "DROPLET_AUTOMOUNT_DEV_DIR": _posix(dev_dir),
            "DROPLET_NC_WAIT_TRIES": "2",
            "DROPLET_NC_WAIT_INTERVAL": "0",
        }
        if extra_env:
            env.update(extra_env)

        stub_dir = tmp_path / "stub-bin"
        stub_dir.mkdir(exist_ok=True)
        stubs = dict(_STUBS)
        stubs.update(_RECONCILE_STUBS)
        for name, body in stubs.items():
            stub = stub_dir / name
            stub.write_text("#!/usr/bin/env bash\n" + body.lstrip("\n"),
                            encoding="utf-8", newline="\n")
            os.chmod(stub, 0o755)
        py_stub = stub_dir / "python3"
        py_stub.write_text(
            '#!/usr/bin/env bash\nexec "{}" "$@"\n'.format(
                Path(sys.executable).as_posix()),
            encoding="utf-8", newline="\n")
        os.chmod(py_stub, 0o755)

        log = tmp_path / "cmd-log.txt"
        log.write_text("", encoding="utf-8")
        run_env = dict(os.environ)
        run_env.update({
            "CMD_LOG": _posix(log),
            "DROPLET_AUTOMOUNT_BASE": _posix(base),
            "DROPLET_AUTOMOUNT_STATE_DIR": _posix(state_dir),
            "DROPLET_AUTOMOUNT_LOG": _posix(tmp_path / "automount.log"),
            "BRIDGE_ENV_FILE": _posix(tmp_path / "no-such.env"),
            "PATH": str(stub_dir) + os.pathsep + run_env.get("PATH", ""),
        })
        run_env.update(env)
        proc = subprocess.run(
            [BASH, str(SCRIPT), "reconcile"],
            env=run_env, capture_output=True, text=True, timeout=120,
        )
        cmds = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln]
        logged = ""
        script_log = tmp_path / "automount.log"
        if script_log.exists():
            logged = script_log.read_text(encoding="utf-8")
        return proc, cmds, logged

    def test_registers_md_pool_mount(self, tmp_path):
        proc, cmds, _l = self._run_reconcile(
            tmp_path, {"pool-cafef00d": "/dev/md127"})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert "docker exec -u 33 droplet-nextcloud-1 php occ files_external:create /pool-cafef00d" in joined, joined

    def test_registers_trusted_plain_and_skips_untrusted(self, tmp_path):
        proc, cmds, logged = self._run_reconcile(
            tmp_path,
            {"family-aaaa1111": "/dev/sdz1", "stray-bbbb2222": "/dev/sdy1"},
            trusted=["aaaa1111-uuid"],
            blkid={"/dev/sdz1": "aaaa1111-uuid", "/dev/sdy1": "bbbb2222-uuid"})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert "files_external:create /family-aaaa1111" in joined, joined
        assert "files_external:create /stray-bbbb2222" not in joined, joined
        assert "skip untrusted" in logged, logged

    def test_registers_enrolled_luks_mapper_mount(self, tmp_path):
        proc, cmds, _l = self._run_reconcile(
            tmp_path, {"vault-cafe1234": "/dev/mapper/droplet-usb-cafe1234"})
        assert proc.returncode == 0, proc.stderr
        assert "files_external:create /vault-cafe1234" in "\n".join(cmds), cmds

    def test_is_idempotent_when_already_registered(self, tmp_path):
        # Real occ json escapes slashes ("\/host\/..."): the escaped shape is
        # what the boot-time reconcile actually sees, so pin it here (the
        # add-path test pins the unescaped shape — both must short-circuit).
        nc_list = tmp_path / "nc-list.json"
        nc_list.write_text(
            '[{"mount_id": 3, "mount_point": "\\/pool-cafef00d", '
            '"datadir":"\\/host\\/pool-cafef00d"}]\n', encoding="utf-8")
        proc, cmds, _l = self._run_reconcile(
            tmp_path, {"pool-cafef00d": "/dev/md127"},
            extra_env={"STUB_NC_LIST": _posix(nc_list)})
        assert proc.returncode == 0, proc.stderr
        assert "files_external:create" not in "\n".join(cmds), cmds

    def test_noop_without_the_env_opt_in(self, tmp_path):
        proc, cmds, logged = self._run_reconcile(
            tmp_path, {"pool-cafef00d": "/dev/md127"},
            extra_env={"NEXTCLOUD_AUTO_REGISTER": ""})
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("docker") for c in cmds), cmds
        assert "disabled" in logged, logged

    def test_seeds_trusted_list_for_mounted_md_pool(self, tmp_path):
        # WARP-1338 review: the add-path blanket-trusts /dev/md* only to keep
        # pools created BEFORE pool_format seeded trusted.list from flipping
        # read-only on reboot. Reconcile must converge those legacy pools onto
        # explicit trusted.list membership (grep-guarded, idempotent) — the
        # prerequisite for a follow-up that drops the blanket md rule.
        proc, _cmds, logged = self._run_reconcile(
            tmp_path, {"pool-cafef00d": "/dev/md127"},
            blkid={"/dev/md127": "mdpool-uuid-1234"})
        assert proc.returncode == 0, proc.stderr
        tlist = tmp_path / "state" / "trusted.list"
        assert tlist.exists(), logged
        assert tlist.read_text(encoding="utf-8").split() == \
            ["mdpool-uuid-1234"], tlist.read_text(encoding="utf-8")
        # Idempotent: a second boot's reconcile must not duplicate the entry.
        proc2, _c2, _l2 = self._run_reconcile(
            tmp_path, {"pool-cafef00d": "/dev/md127"},
            blkid={"/dev/md127": "mdpool-uuid-1234"})
        assert proc2.returncode == 0, proc2.stderr
        assert tlist.read_text(encoding="utf-8").split() == \
            ["mdpool-uuid-1234"], tlist.read_text(encoding="utf-8")

    def test_seeds_md_pool_trust_even_without_nc_opt_in(self, tmp_path):
        # Trust is a mount-time property, not a registration one: a box that
        # never opted into Nextcloud auto-register still converges its legacy
        # pool onto trusted.list (the reconcile's registration half stays a
        # no-op there).
        proc, cmds, _l = self._run_reconcile(
            tmp_path, {"pool-cafef00d": "/dev/md127"},
            blkid={"/dev/md127": "mdpool-uuid-1234"},
            extra_env={"NEXTCLOUD_AUTO_REGISTER": ""})
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("docker") for c in cmds), cmds
        tlist = tmp_path / "state" / "trusted.list"
        assert tlist.exists() and "mdpool-uuid-1234" in \
            tlist.read_text(encoding="utf-8").split(), cmds

    def test_prunes_dangling_host_registrations(self, tmp_path):
        # WARP-1338 review: the udev remove path deregisters only on a LIVE
        # remove event. A drive unplugged while the box was off — or a legacy
        # pool renamed to the automount <label>-<short-uuid> derivation on its
        # first post-upgrade boot — leaves a registration whose /host/<tail>
        # no longer exists: a dead GUID-named folder in every user's Files
        # root. Reconcile must prune /host/-datadir entries whose tail is no
        # longer mounted (that is exactly the state the remove handler would
        # have deregistered), and must leave BOTH still-mounted /host entries
        # AND non-/host external storages alone.
        dead = "9a8b7c6d-0e1f-2a3b-4c5d-6e7f8090a0b0"
        nc_list = tmp_path / "nc-list.json"
        nc_list.write_text(
            '[{"mount_point":"\\/pool-cafef00d",'
            '"datadir":"\\/host\\/pool-cafef00d","mount_id":3},'
            '{"mount_point":"\\/' + dead + '",'
            '"datadir":"\\/host\\/' + dead + '","mount_id":9},'
            '{"mount_point":"\\/other",'
            '"datadir":"\\/media\\/other","mount_id":5}]\n',
            encoding="utf-8")
        proc, cmds, logged = self._run_reconcile(
            tmp_path, {"pool-cafef00d": "/dev/md127"},
            extra_env={"STUB_NC_LIST": _posix(nc_list)})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        # The dangling GUID tail is deregistered…
        assert "files_external:delete -y 9" in joined, joined
        assert "pruning" in logged and dead in logged, logged
        # …the mounted pool registration and the non-/host storage are NOT.
        assert "files_external:delete -y 3" not in joined, joined
        assert "files_external:delete -y 5" not in joined, joined

    def test_gives_up_cleanly_when_nextcloud_never_answers(self, tmp_path):
        # Boot race: the container may not answer occ within the bounded wait
        # — the oneshot must exit 0 (no failed unit) and register nothing;
        # the next boot retries.
        down_docker = (
            "printf 'docker %s\\n' \"$*\" >> \"$CMD_LOG\"\nexit 1\n"
        )
        proc, cmds, _l = self._run_reconcile(
            tmp_path, {"pool-cafef00d": "/dev/md127"},
            extra_env={"DROPLET_NC_WAIT_TRIES": "2"})
        # sanity: default stub answers; now the down-container variant:
        stub_dir = tmp_path / "stub-bin"
        (stub_dir / "docker").write_text(
            "#!/usr/bin/env bash\n" + down_docker, encoding="utf-8",
            newline="\n")
        os.chmod(stub_dir / "docker", 0o755)
        log = tmp_path / "cmd-log.txt"
        log.write_text("", encoding="utf-8")
        run_env = dict(os.environ)
        run_env.update({
            "CMD_LOG": _posix(log),
            "DROPLET_AUTOMOUNT_BASE": _posix(tmp_path / "mnt"),
            "DROPLET_AUTOMOUNT_STATE_DIR": _posix(tmp_path / "state"),
            "DROPLET_AUTOMOUNT_LOG": _posix(tmp_path / "automount.log"),
            "BRIDGE_ENV_FILE": _posix(tmp_path / "no-such.env"),
            "STUB_MOUNTED": _posix(tmp_path / "stub-mounted.txt"),
            "STUB_MOUNT_TABLE": _posix(tmp_path / "stub-mount-table.txt"),
            "STUB_BLKID_TABLE": _posix(tmp_path / "stub-blkid-table.txt"),
            "DROPLET_NC_WAIT_TRIES": "2",
            "DROPLET_NC_WAIT_INTERVAL": "0",
            "PATH": str(stub_dir) + os.pathsep + run_env.get("PATH", ""),
        })
        run_env.update(_REGISTER_ENV)
        proc = subprocess.run(
            [BASH, str(SCRIPT), "reconcile"],
            env=run_env, capture_output=True, text=True, timeout=120,
        )
        assert proc.returncode == 0, proc.stderr
        joined = log.read_text(encoding="utf-8")
        assert "files_external:create" not in joined, joined


# =====================================================================
# WARP-1361 — the storage pool filesystem must come back on EVERY boot.
#
# Live failure (192.168.1.87, 2026-07-17): after a reboot md127 reassembled
# healthy but auto-read-only, its ext4 was mounted NOWHERE, and
# droplet-automount@md127.service "Finished" with zero journal output.
# The add path must (a) keep a LEGACY pool (unlabeled fs, GUID mount dir,
# never on trusted.list) at its historical /mnt/droplet/<fs-uuid> path and
# mount it rw via the droplet md signature (mdadm homehost), (b) keep new
# labeled/trusted pools on the stable <label>-<short-uuid> name, (c) handle
# an auto-read-only array (mdadm --readwrite + retry), (d) never rw-mount a
# FOREIGN md array (untrusted-ro path), and (e) log a reason on EVERY skip,
# mirrored to the journal via logger -t droplet-automount.
# =====================================================================

LEGACY_POOL_UUID = "a0f10a84-7116-46a7-a3e3-5e00ea1c7d08"


class TestMdPoolRemountOnBoot:
    def test_legacy_unlabeled_droplet_pool_mounts_rw_at_uuid_path(self, tmp_path):
        # The live-box shape: unlabeled ext4 on md127, fs UUID never seeded
        # into trusted.list, historical mount dir /mnt/droplet/<fs-uuid>.
        # The droplet raid signature (homehost) makes it trusted: mounted rw
        # at the SAME GUID path (never renamed — the dashboard, the Nextcloud
        # registration and the owner's bookmarks all point at it), the
        # trust list is seeded, and registration follows.
        proc, cmds, logged, mounts_json, state_dir = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={**_REGISTER_ENV, "STUB_FS_UUID": LEGACY_POOL_UUID},
            stub_overrides={"docker": _NC_DOCKER_STUB})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert re.search(
            r'mount -o "?rw,\S+ /dev/md127 \S*/' + LEGACY_POOL_UUID, joined
        ), joined
        assert "drive-a0f10a84" not in joined, (
            "legacy pool mount was renamed to the drive-<short-uuid> "
            "derivation — bookmarks/registration dangle: %s" % joined
        )
        assert '"trust": "trusted"' in mounts_json, mounts_json
        tlist = state_dir / "trusted.list"
        assert tlist.exists() and LEGACY_POOL_UUID in \
            tlist.read_text(encoding="utf-8").split(), (
                "mount-time trust seeding missing for the legacy pool"
            )
        assert ("files_external:create /%s" % LEGACY_POOL_UUID) in joined, joined

    def test_pool_on_trust_list_mounts_rw_at_stable_name(self, tmp_path):
        # A labeled+trusted pool (the WARP-1338 pool_format shape) mounts rw
        # at the stable <label>-<short-uuid> name via trusted.list alone —
        # even when the signature probe says nothing useful.
        state_dir = tmp_path / "state"
        state_dir.mkdir(exist_ok=True)
        (state_dir / "trusted.list").write_text(
            "cafef00d-9360\n", encoding="utf-8")
        proc, cmds, _l, mounts_json, _sd = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={"STUB_FS_LABEL": "pool",
                       "STUB_MD_NAME": "somebody-nas:0"})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert re.search(
            r'mount -o "?rw,\S+ /dev/md127 \S*/pool-cafef00d', joined), joined
        assert '"trust": "trusted"' in mounts_json, mounts_json

    def test_auto_read_only_array_gets_mdadm_readwrite_then_mounts(self, tmp_path):
        # AC 2: if the rw mount fails because the array is (auto-)read-only,
        # flip it with mdadm --readwrite and retry — never leave a healthy
        # pool fs unmounted or read-only.
        marker = tmp_path / "mount-failed-once"
        proc, cmds, logged, mounts_json, _sd = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={"STUB_FS_LABEL": "pool",
                       "STUB_MOUNT_FAIL_ONCE": _posix(marker)})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert "mdadm --readwrite /dev/md127" in joined, joined
        mount_calls = [c for c in cmds if c.startswith("mount ")]
        assert len(mount_calls) == 2, mount_calls
        assert '"trust": "trusted"' in mounts_json, mounts_json
        assert "read-only" in logged, logged

    def test_foreign_md_array_mounts_read_only_untrusted(self, tmp_path):
        # AC (d): a foreign array (crafted/alien superblock — mdadm's
        # incremental-assembly udev rules WILL auto-assemble hot-plugged
        # disks) follows the untrusted read-only path, never rw, never
        # registered, with the reason logged.
        proc, cmds, logged, mounts_json, _sd = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={**_REGISTER_ENV, "STUB_MD_NAME": "somebody-nas:0"},
            stub_overrides={"docker": _NC_DOCKER_STUB})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert re.search(r'mount -o "?ro,', joined), joined
        assert not re.search(r'mount -o "?rw,', joined), joined
        assert '"trust": "untrusted-ro"' in mounts_json, mounts_json
        assert "foreign md array" in logged, logged
        assert "files_external:create" not in joined, joined

    def test_renamed_box_homehost_still_counts_as_droplet(self, tmp_path):
        # An array made ON this box carries homehost == the box hostname
        # (mdadm's "local to host" convention) — a renamed box must not
        # orphan its own pool into the foreign path.
        proc, cmds, _l, mounts_json, _sd = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={"STUB_MD_NAME": "myhomebox:0",
                       "STUB_HOSTNAME": "myhomebox"})
        assert proc.returncode == 0, proc.stderr
        assert re.search(r'mount -o "?rw,', "\n".join(cmds)), cmds
        assert '"trust": "trusted"' in mounts_json, mounts_json

    def test_boot_add_race_settles_until_array_readable(self, tmp_path):
        # The live silent no-op: the boot add uevent fires while the array is
        # still assembling — blkid sees no filesystem on the FIRST probe and
        # nothing ever re-fires. The script must give an md node a bounded
        # settle window and re-probe instead of bailing on probe #1.
        marker = tmp_path / "type-empty-once"
        proc, cmds, logged, _mj, _sd = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={"STUB_FS_LABEL": "pool",
                       "STUB_TYPE_EMPTY_ONCE": _posix(marker),
                       "DROPLET_MD_SETTLE_TRIES": "3",
                       "DROPLET_MD_SETTLE_INTERVAL": "0"})
        assert proc.returncode == 0, proc.stderr
        assert re.search(r'mount -o "?rw,', "\n".join(cmds)), cmds
        assert "readable" in logged, logged

    def test_md_never_readable_skips_with_logged_reason_and_journal_mirror(
            self, tmp_path):
        # AC 4 (no silent exits): an md node that never becomes readable
        # still exits 0 (no failed unit) but SAYS SO — in the log file AND
        # mirrored to the journal (logger -t droplet-automount). The live
        # failure was undiagnosable precisely because journalctl had nothing.
        proc, cmds, logged, _mj, _sd = _run_add(
            "/dev/md127", "", tmp_path,
            extra_env={"DROPLET_MD_SETTLE_TRIES": "2",
                       "DROPLET_MD_SETTLE_INTERVAL": "0"})
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "md127" in logged and "no readable filesystem" in logged, logged
        assert any(c.startswith("logger -t droplet-automount") for c in cmds), (
            "skip reason was not mirrored to the journal: %r" % cmds
        )


# =====================================================================
# WARP-1361 — the boot reconcile mounts assembled-but-unmounted droplet
# pool arrays (idempotent safety net when the per-device udev path misses,
# e.g. the add uevent fired before the array was readable and nothing
# re-fired on activation — exactly the live md127 reboot).
# =====================================================================


class TestReconcileMountsUnmountedPools:
    # Reuse the harness without subclassing (subclassing would re-collect
    # every TestReconcile test a second time).
    _run_reconcile = TestReconcile._run_reconcile

    def test_mounts_assembled_but_unmounted_droplet_array(self, tmp_path):
        proc, cmds, logged = self._run_reconcile(
            tmp_path, {},
            dev_nodes=["md127"],
            node_types={"md127": "ext4"},
            node_uuids={"md127": LEGACY_POOL_UUID})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert re.search(
            r'mount -o "?rw,\S+ \S*/md127 \S*/' + LEGACY_POOL_UUID, joined
        ), joined
        assert ("files_external:create /%s" % LEGACY_POOL_UUID) in joined, joined
        tlist = tmp_path / "state" / "trusted.list"
        assert tlist.exists() and LEGACY_POOL_UUID in \
            tlist.read_text(encoding="utf-8").split(), logged

    def test_stays_idempotent_when_pool_already_mounted(self, tmp_path):
        dev_path = _posix(tmp_path / "dev" / "md127")
        proc, cmds, logged = self._run_reconcile(
            tmp_path, {LEGACY_POOL_UUID: dev_path},
            dev_nodes=["md127"],
            node_types={"md127": "ext4"},
            node_uuids={"md127": LEGACY_POOL_UUID})
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "already mounted" in logged, logged

    def test_skips_foreign_md_array_with_logged_reason(self, tmp_path):
        # AC 3: never auto-mount an arbitrary foreign md array rw from the
        # reconcile — skip it with the reason logged.
        proc, cmds, logged = self._run_reconcile(
            tmp_path, {},
            dev_nodes=["md127"],
            node_types={"md127": "ext4"},
            node_uuids={"md127": "feedface-0000-1111-2222-333344445555"},
            extra_env={"STUB_MD_NAME": "somebody-nas:0"})
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "foreign md array" in logged, logged

    def test_skips_unformatted_array_with_logged_reason(self, tmp_path):
        proc, cmds, logged = self._run_reconcile(
            tmp_path, {},
            dev_nodes=["md127"])
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "no readable filesystem" in logged, logged

    def test_never_seeds_trusted_list_for_mounted_foreign_md(self, tmp_path):
        # The seeding loop must not graduate a mounted-read-only FOREIGN
        # array onto trusted.list — that would flip it rw on the next boot,
        # defeating the untrusted posture the add path just enforced.
        proc, _cmds, logged = self._run_reconcile(
            tmp_path, {"alienpool-feedface": "/dev/md9"},
            blkid={"/dev/md9": "feedface-uuid"},
            extra_env={"STUB_MD_NAME": "somebody-nas:0"})
        assert proc.returncode == 0, proc.stderr
        tlist = tmp_path / "state" / "trusted.list"
        seeded = (
            tlist.read_text(encoding="utf-8").split() if tlist.exists() else []
        )
        assert "feedface-uuid" not in seeded, seeded
        assert "foreign" in logged, logged


# =====================================================================
# WARP-1361 review fixes — the md add path is hot on EVERY boot now, so:
#  (1) never a recursive chown on a pool remount (a terabyte-scale
#      `chown -R` blows the unit's TimeoutStartSec mid-add and flips the
#      ownership of files Nextcloud wrote as uid 33 through the
#      /mnt/droplet -> /host bind);
#  (2) the whole probe+mount+register section takes a per-device lock so
#      the udev add and the reconcile-spawned add for the same node can't
#      race a check-then-mount into a stacked duplicate mount + duplicate
#      Nextcloud registration (the duplicate class WARP-1338 fixed);
#  (3) is_droplet_md's homehost fallback accepts exactly the shipping
#      droplet-sys convention — not any droplet-prefixed stranger;
#  (4) the legacy GUID mount name goes through the same charset guard as
#      labels (blkid output is never trusted as a path component);
#  (5) "already mounted at the right path" verifies the live mount is
#      actually rw when the drive earned rw — a pre-existing ro mount of
#      a healthy pool is remounted read-write (AC2 edge);
#  (6) the reconcile md enumeration logs a reason for EVERY skip — the
#      crafted-name and mdNpM-partition continues were silent (AC4).
# =====================================================================


class TestWarp1361ReviewFixes:
    _run_reconcile = TestReconcile._run_reconcile

    def test_md_remount_chowns_mount_root_only_never_recursive(self, tmp_path):
        proc, cmds, _l, _mj, _sd = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={"STUB_FS_LABEL": "pool"})
        assert proc.returncode == 0, proc.stderr
        chowns = [c for c in cmds if c.startswith("chown ")]
        assert chowns, cmds
        assert not any(c.startswith("chown -R") for c in chowns), (
            "recursive chown on a pool remount — this path runs on every "
            "boot; a terabyte-scale chown -R exceeds TimeoutStartSec and "
            "flips Nextcloud's uid-33 file ownership: %r" % chowns)
        expected = "chown 1000:1000 " + _posix(
            tmp_path / "mnt" / "pool-cafef00d")
        assert expected in chowns, chowns

    def test_plain_trusted_drive_keeps_the_recursive_chown(self, tmp_path):
        # Control: the plain-drive first-mount behavior is unchanged (that
        # path only runs on plug events, not every boot).
        state_dir = tmp_path / "state"
        state_dir.mkdir(exist_ok=True)
        (state_dir / "trusted.list").write_text(
            "cafef00d-9360\n", encoding="utf-8")
        proc, cmds, _l, _mj, _sd = _run_add("/dev/sdz1", "ext4", tmp_path)
        assert proc.returncode == 0, proc.stderr
        assert any(c.startswith("chown -R 1000:1000 ") for c in cmds), cmds

    def test_add_takes_a_per_device_lock_before_the_mount_section(self, tmp_path):
        proc, cmds, _l, _mj, state_dir = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={"STUB_FS_LABEL": "pool"})
        assert proc.returncode == 0, proc.stderr
        assert (state_dir / ".lock-dev-md127").exists(), (
            "per-device lock file not created — the udev add and the "
            "reconcile-spawned add can double-mount/double-register")
        lock_idx = next(
            (i for i, c in enumerate(cmds) if c == "flock 8"), None)
        mount_idx = next(
            (i for i, c in enumerate(cmds) if c.startswith("mount ")), None)
        assert lock_idx is not None, cmds
        assert mount_idx is not None and lock_idx < mount_idx, (
            "the per-device lock must be taken BEFORE the check-then-mount "
            "section: %r" % cmds)

    def test_droplet_prefixed_foreign_homehost_is_not_trusted(self, tmp_path):
        # is_droplet_md's fallback accepts exactly the shipping droplet-sys
        # convention. "dropletnas", "droplet-foo" etc. are strangers — the
        # homehost string is attacker-writable regardless, so the fallback
        # must never be wider than the documented convention.
        proc, cmds, logged, mounts_json, _sd = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={"STUB_MD_NAME": "dropletnas:0"})
        assert proc.returncode == 0, proc.stderr
        assert '"trust": "untrusted-ro"' in mounts_json, mounts_json
        assert re.search(r'mount -o "?ro,', "\n".join(cmds)), cmds
        assert "foreign md array" in logged, logged

    def test_legacy_guid_mount_name_is_charset_guarded(self, tmp_path):
        # blkid UUIDs are hex+dashes today; the guard future-proofs the path
        # construction so crafted metadata can never smuggle a separator or
        # shell-relevant byte into the mount path.
        proc, cmds, _l, _mj, _sd = _run_add(
            "/dev/md127", "ext4", tmp_path,
            extra_env={"STUB_FS_UUID": "evil/uu id$(pwn)"})
        assert proc.returncode == 0, proc.stderr
        # The RAW uuid may appear in log lines (trusted.list stores raw fs
        # uuids) — but never as a path component under the mount base.
        assert not any("mnt/evil/uu" in c for c in cmds), cmds
        expected_mount = _posix(tmp_path / "mnt" / "evil-uu-id--pwn-")
        assert any(
            c.startswith("mount ") and c.endswith(" " + expected_mount)
            for c in cmds), cmds

    def test_dotdot_label_never_escapes_the_mount_base(self, tmp_path):
        # tr -c 'A-Za-z0-9._-' '-' allows '.' through, and the trailing sed
        # only trims leading/trailing DASHES — a LABEL of exactly ".." with no
        # UUID to append a disambiguating suffix survives sanitization
        # unchanged, so MOUNT="${MOUNT_BASE}/.." resolves to the mount base's
        # PARENT directory instead of a name under it.
        dotdot_blkid_stub = r"""
printf 'blkid %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" -s TYPE "*) [ -n "${STUB_FS_TYPE:-}" ] && printf '%s\n' "$STUB_FS_TYPE"; exit 0 ;;
  *" -s LABEL "*) printf '..\n'; exit 0 ;;
  *" -s UUID "*) exit 0 ;;
esac
exit 0
"""
        proc, cmds, _l, _mj, _sd = _run_add(
            "/dev/sdz1", "ext4", tmp_path,
            stub_overrides={"blkid": dotdot_blkid_stub})
        assert proc.returncode == 0, proc.stderr
        forbidden_mount = _posix(tmp_path / "mnt" / "..")
        assert not any(
            c.startswith("mount ") and c.endswith(" " + forbidden_mount)
            for c in cmds), (
            "a '..' LABEL with no UUID collapsed the mount name to '..', "
            "landing the mount OUTSIDE the mount base: %r" % cmds)

    def test_preexisting_ro_mount_of_trusted_pool_is_remounted_rw(self, tmp_path):
        # AC2 edge: the pool is healthy and already mounted at the right
        # path — but read-only (e.g. an earlier boot mounted the
        # auto-read-only array ro). "Already mounted" must not short-circuit
        # the rw guarantee: flip the array readwrite and remount in place.
        dev_dir = tmp_path / "dev"
        dev_dir.mkdir(exist_ok=True)
        dev = dev_dir / "md127"
        dev.touch()
        mount = tmp_path / "mnt" / "pool-cafef00d"
        findmnt_stub = r"""
printf 'findmnt %s\n' "$*" >> "$CMD_LOG"
last=; for a in "$@"; do last="$a"; done
case " $* " in
  *" OPTIONS "*) printf 'ro,noatime\n'; exit 0 ;;
  *" --source "*) printf '%s\n' "$STUB_EXISTING_MOUNT"; exit 0 ;;
esac
if [ "$last" = "/" ]; then printf '/dev/nvme0n1p2\n'; exit 0; fi
if [ "$last" = "$STUB_EXISTING_MOUNT" ]; then
  printf '%s\n' "$STUB_EXISTING_DEV"; exit 0
fi
exit 1
"""
        mountpoint_stub = (
            "printf 'mountpoint %s\\n' \"$*\" >> \"$CMD_LOG\"\n"
            "tgt=; for a in \"$@\"; do tgt=\"$a\"; done\n"
            "[ \"$tgt\" = \"$STUB_EXISTING_MOUNT\" ] && exit 0\n"
            "exit 1\n")
        proc, cmds, logged, _mj, _sd = _run_add(
            _posix(dev), "ext4", tmp_path,
            extra_env={"STUB_FS_LABEL": "pool",
                       "STUB_EXISTING_MOUNT": _posix(mount),
                       "STUB_EXISTING_DEV": _posix(dev)},
            stub_overrides={"findmnt": findmnt_stub,
                            "mountpoint": mountpoint_stub})
        assert proc.returncode == 0, proc.stderr
        joined = "\n".join(cmds)
        assert "already mounted" in logged, logged
        assert ("mount -o remount,rw " + _posix(mount)) in joined, (
            "a pre-existing ro mount of a healthy trusted pool was left "
            "read-only: %s" % joined)
        assert ("mdadm --readwrite " + _posix(dev)) in joined, joined
        # No fresh full mount attempt — the flip happens in place.
        assert not any(
            re.match(r'mount -o "?r[wo],', c) for c in cmds), cmds

    def test_reconcile_logs_a_reason_for_partition_and_crafted_md_nodes(
            self, tmp_path):
        # AC4: every skip path says why. The md enumeration's continues for
        # mdNpM partition nodes and crafted names were the two silent ones.
        proc, cmds, logged = self._run_reconcile(
            tmp_path, {}, dev_nodes=["md0p1", "mdX"])
        assert proc.returncode == 0, proc.stderr
        assert not any(c.startswith("mount ") for c in cmds), cmds
        assert "skip md0p1" in logged, logged
        assert "skip mdX" in logged, logged
