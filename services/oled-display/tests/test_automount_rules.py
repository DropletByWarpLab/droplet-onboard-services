"""Pin the udev automount rule's device coverage (WARP-936).

services/automount/99-droplet-automount.rules is the ONLY thing that
re-mounts user storage after a reboot. Two adopted-storage shapes depend on
its KERNEL match:

  * drive_adopt makes a WHOLE-DISK filesystem (no partition table), so the
    bare disk nodes (sda / sdaa / nvme0n1) must match — before WARP-936 only
    partitions did and every adopted drive went dark on reboot.
  * pool_format makes a filesystem on an md ARRAY (md127), so md nodes must
    match too — otherwise a formatted pool never re-mounts after a reboot and
    the dashboard's "Format & mount" flow silently loses its mount.

droplet-automount.sh keeps the match safe: it skips devices without a
filesystem signature and refuses anything backing the boot disk.
"""

from __future__ import annotations

import fnmatch
import re
from pathlib import Path

RULES = (
    Path(__file__).resolve().parents[3]
    / "services" / "automount" / "99-droplet-automount.rules"
)


def _kernel_patterns() -> list[str]:
    text = RULES.read_text(encoding="utf-8")
    m = re.search(r'KERNEL!="([^"]+)"', text)
    assert m, "expected the negated KERNEL match gate in the rules file"
    return m.group(1).split("|")


def _matches(kernel: str) -> bool:
    return any(fnmatch.fnmatchcase(kernel, pat) for pat in _kernel_patterns())


def test_rules_file_exists():
    assert RULES.exists(), f"missing {RULES}"


def test_partitions_still_match():
    for k in ("sda1", "sdb2", "nvme0n1p1"):
        assert _matches(k), k


def test_whole_disk_nodes_match():
    # WARP-936: drive_adopt's whole-device filesystem must remount on reboot.
    for k in ("sda", "sdz", "sdaa", "nvme0n1"):
        assert _matches(k), k


def test_md_array_nodes_match():
    # WARP-936 UX-review fix: pool_format now mounts the array; the mount must
    # survive a reboot via the same automount path (mdadm assembles the array
    # at boot → udev add event → droplet-automount@md127).
    for k in ("md0", "md127"):
        assert _matches(k), k


def test_boot_and_display_devices_do_not_match():
    # The eMMC boot medium and dm/loop devices must stay out of the KERNEL
    # gate (mmcblk is also rejected explicitly a line later; dm-* and loop*
    # are re-refused inside droplet-automount.sh).
    for k in ("mmcblk0", "mmcblk0p1", "dm-0", "loop0", "zram0"):
        assert not _matches(k), k
