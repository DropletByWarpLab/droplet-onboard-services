"""Hermetic tests for droplet-usb-enroll.sh's boot-device guard (WARP-2151).

_guard_not_rootfs gates cmd_enroll — which luksFormats the target device —
with the same one-hop PKNAME comparison droplet-automount.sh used: on an LVM
root the mapper node's PKNAME is the PV *partition* (nvme0n1p3), not the
disk, so the ESP and /boot partitions matched nothing and
`enroll /dev/nvme0n1p1` would have run cryptsetup luksFormat against the
live boot partition. Same PATH-stub approach as test_automount_script.py:
findmnt/lsblk are stubs, the TPM device is pointed at a path that does not
exist, so nothing destructive can ever run.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "scripts" / "host" / "droplet-usb-enroll.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def _posix(p: Path) -> str:
    return str(p).replace("\\", "/")


_STUBS = {
    # findmnt: only the root-source query answers; $STUB_ROOT_SRC picks the
    # plain-partition root (default) or the LVM mapper node.
    "findmnt": r"""
last=; for a in "$@"; do last="$a"; done
if [ "$last" = "/" ]; then printf '%s\n' "${STUB_ROOT_SRC:-/dev/nvme0n1p2}"; exit 0; fi
exit 1
""",
    # lsblk: the inverse-tree walk (NAME,TYPE) models LVM mapper -> PV
    # partition -> disk and plain partition -> disk; PKNAME keeps the old
    # one-hop shape for regression comparison.
    "lsblk": r"""
case " $* " in
  *" NAME,TYPE "*)
    dev="$(basename "${@: -1}")"
    case "$dev" in
      *--vg-*) printf '%s lvm\nnvme0n1p3 part\nnvme0n1 disk\n' "$dev" ;;
      nvme*p[0-9]*) printf '%s part\n%s disk\n' "$dev" "${dev%p*}" ;;
      nvme*) printf '%s disk\n' "$dev" ;;
      sd*[0-9]) printf '%s part\n%s disk\n' "$dev" "$(printf '%s' "$dev" | sed 's/[0-9]*$//')" ;;
      sd*) printf '%s disk\n' "$dev" ;;
      *) : ;;
    esac
    exit 0 ;;
  *" PKNAME "*)
    dev="$(basename "${@: -1}")"
    case "$dev" in
      nvme*p[0-9]*) printf '%s\n' "${dev%p*}" ;;
      sd*[0-9]) printf '%s' "$dev" | sed 's/[0-9]*$//'; echo ;;
      *) : ;;
    esac
    exit 0 ;;
esac
exit 0
""",
}


def _run_enroll(device: str, tmp_path: Path, extra_env: dict | None = None):
    stub_dir = tmp_path / "stub-bin"
    stub_dir.mkdir(exist_ok=True)
    for name, body in _STUBS.items():
        stub = stub_dir / name
        stub.write_text("#!/usr/bin/env bash\n" + body.lstrip("\n"),
                        encoding="utf-8", newline="\n")
        os.chmod(stub, 0o755)
    env = dict(os.environ)
    env.update({
        "MSYS2_ARG_CONV_EXCL": "*",
        # A TPM that does not exist: the control test proves the guard was
        # PASSED by dying at the _require_tpm stage, never at luksFormat.
        "DROPLET_TPM_DEVICE": _posix(tmp_path / "no-such-tpm"),
        "DROPLET_AUTOMOUNT_STATE_DIR": _posix(tmp_path / "state"),
        "DROPLET_USB_RUNTIME_DIR": _posix(tmp_path / "run"),
        "DROPLET_ENV_FILE": _posix(tmp_path / "no-such.env"),
        "PATH": str(stub_dir) + os.pathsep + env.get("PATH", ""),
    })
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [BASH, str(SCRIPT), "enroll", device],
        env=env, capture_output=True, text=True, timeout=60,
    )


class TestEnrollBootGuard:
    LVM_ROOT = {"STUB_ROOT_SRC": "/dev/mapper/ubuntu--vg-ubuntu--lv"}

    @pytest.mark.parametrize("device", ["/dev/nvme0n1p1", "/dev/nvme0n1p2"])
    def test_lvm_root_boot_partition_is_refused(self, device, tmp_path):
        proc = _run_enroll(device, tmp_path, extra_env=self.LVM_ROOT)
        assert proc.returncode == 2, (proc.returncode, proc.stderr)
        assert "refusing to enroll" in proc.stderr, proc.stderr

    def test_plain_root_sibling_still_refused(self, tmp_path):
        # Regression pin for the non-LVM shape the old one-hop guard covered.
        proc = _run_enroll("/dev/nvme0n1p1", tmp_path)
        assert proc.returncode == 2, (proc.returncode, proc.stderr)
        assert "refusing to enroll" in proc.stderr, proc.stderr

    def test_other_disk_passes_the_guard(self, tmp_path):
        # Control: a USB partition on another disk gets PAST the guard — the
        # run must die later, at the missing-TPM check, not on the refusal.
        proc = _run_enroll("/dev/sdb1", tmp_path, extra_env=self.LVM_ROOT)
        assert proc.returncode == 2, (proc.returncode, proc.stderr)
        assert "refusing to enroll" not in proc.stderr, proc.stderr
        assert "cannot enroll a TPM keyslot" in proc.stderr, proc.stderr
