"""WARP-2098 — the system/install disk, reported in a key of its own.

The defect this covers: WARP-827 removed the OS/boot disk from `drives` AND
from `disks`, which was right (both lists feed destructive pickers) but left the
owner unable to see the appliance's own disk at all. On this box that is the
disk that fills first — Nextcloud's data directory sits on the docker data-root
at /data, an LV on the install disk, while the storage pool reaches Nextcloud
only as external storage — so "where do my uploads actually go?" had no answer
anywhere in the product.

The invariant here is a PAIR, and both halves are asserted below:
  1. the OS disk is now reportable (name, geometry, per-filesystem usage), and
  2. it is still absent from `drives` and `disks`.
A change that satisfies only the first half is the regression this must not
ship, so `test_reporting_it_does_not_re_admit_it_to_the_inventory` is the one
test to look at first if this file ever goes red.

Same harness as test_device_bridge_disks.py: load device-bridge.py fresh via
importlib with a seeded env, and drive the PURE function with canned lsblk
topology so no real lsblk/findmnt/statvfs on the host is ever touched.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    spec = importlib.util.spec_from_file_location(
        "device_bridge_system_disk_under_test", _BRIDGE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GB = 1_000_000_000

# The live box shape: one 512 GB NVMe carrying the whole install — an ESP, a
# small root LV and the big /data LV the docker data-root (and therefore
# Nextcloud's files) lives on — plus two RAID members for the pool.
_LSBLK = {
    "blockdevices": [
        {
            "name": "nvme0n1", "type": "disk", "size": 512 * GB, "tran": "nvme",
            "model": "Samsung SSD 980", "serial": "S64ANS0T1", "fstype": None,
            "mountpoint": None,
            "children": [
                {"name": "nvme0n1p1", "type": "part", "size": 1 * GB,
                 "fstype": "vfat", "mountpoint": "/boot/efi"},
                {"name": "nvme0n1p2", "type": "part", "size": 511 * GB,
                 "fstype": "LVM2_member", "mountpoint": None},
            ],
        },
        {
            "name": "sda", "type": "disk", "size": 2000 * GB, "tran": "sata",
            "model": "WDC WD20EARZ", "serial": "WD-A",
            "fstype": "linux_raid_member", "mountpoint": None,
        },
    ]
}

# What _os_disk_filesystems would return on that box: root is small, /data is
# where everything actually is. A root-only reading would call this disk 4% full
# while it is really 24% full — the exact reason the breakdown exists.
_OS_FILESYSTEMS = [
    {"mount": "/", "fs": "ext4", "size_bytes": 64 * GB,
     "used_bytes": 20 * GB, "free_bytes": 44 * GB},
    {"mount": "/boot/efi", "fs": "vfat", "size_bytes": 1 * GB,
     "used_bytes": 0, "free_bytes": 1 * GB},
    {"mount": "/data", "fs": "ext4", "size_bytes": 400 * GB,
     "used_bytes": 100 * GB, "free_bytes": 300 * GB},
]


def test_reports_the_os_disk_with_its_real_geometry(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    sys_disk = bridge.system_disk_info(_LSBLK, "nvme0n1", _OS_FILESYSTEMS)
    assert sys_disk["name"] == "nvme0n1"
    assert sys_disk["size_bytes"] == 512 * GB
    assert sys_disk["model"] == "Samsung SSD 980"
    assert sys_disk["serial"] == "S64ANS0T1"
    assert sys_disk["bus"] == "nvme"


def test_usage_covers_every_filesystem_on_the_disk_not_just_root(monkeypatch):
    # The whole point of the breakdown. Nextcloud writes to /data, so a
    # root-only figure (20 GB) would describe a nearly-empty disk while the box
    # is filling up. The honest number is the sum across the disk's extents.
    bridge = _load_bridge(monkeypatch)
    sys_disk = bridge.system_disk_info(_LSBLK, "nvme0n1", _OS_FILESYSTEMS)
    assert sys_disk["used_bytes"] == 120 * GB
    assert sys_disk["used_bytes"] != 20 * GB
    # Free is measured against the WHOLE disk, so unallocated LVM extents count
    # as free rather than vanishing.
    assert sys_disk["free_bytes"] == 512 * GB - 120 * GB


def test_filesystems_are_labelled_by_role_for_the_ui(monkeypatch):
    # The dashboard must never pattern-match host paths; the roles are decided
    # here so both surfaces group identically.
    bridge = _load_bridge(monkeypatch)
    sys_disk = bridge.system_disk_info(_LSBLK, "nvme0n1", _OS_FILESYSTEMS)
    roles = {f["mount"]: f["role"] for f in sys_disk["filesystems"]}
    assert roles == {"/": "root", "/boot/efi": "boot", "/data": "data"}


def test_omitted_when_the_os_disk_is_unknown(monkeypatch):
    # _os_disk() returns "" when it cannot resolve root's disk. Same fail-open
    # contract as the WARP-827 filters: say nothing rather than guess.
    bridge = _load_bridge(monkeypatch)
    assert bridge.system_disk_info(_LSBLK, "", _OS_FILESYSTEMS) is None


def test_omitted_when_os_disk_names_a_partition_not_a_disk(monkeypatch):
    # _whole_disk() falls back to basename(device) when lsblk is unavailable, so
    # _os_disk() can hand back "nvme0n1p2". Reporting that would quote a
    # partition's geometry as the disk's, so require a real type=="disk" node.
    bridge = _load_bridge(monkeypatch)
    assert bridge.system_disk_info(_LSBLK, "nvme0n1p2", _OS_FILESYSTEMS) is None


def test_omitted_when_lsblk_is_missing_or_garbage(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    for tree in (None, {}, {"blockdevices": None}):
        assert bridge.system_disk_info(tree, "nvme0n1", _OS_FILESYSTEMS) is None


def test_usage_is_null_not_zero_when_nothing_could_be_measured(monkeypatch):
    # A real disk whose filesystems all failed statvfs. Zero would render as a
    # pristine empty disk — a claim, and a false one — so the UI is handed null
    # and shows the capacity with "usage unavailable" instead of a 0% meter.
    bridge = _load_bridge(monkeypatch)
    sys_disk = bridge.system_disk_info(_LSBLK, "nvme0n1", [])
    assert sys_disk["size_bytes"] == 512 * GB
    assert sys_disk["used_bytes"] is None
    assert sys_disk["free_bytes"] is None
    assert sys_disk["filesystems"] == []


def test_partial_measurement_reports_null_not_an_undercount(monkeypatch):
    # THE WARP-2098 DEFECT, RECURRING. If /data is unmeasurable (statvfs
    # denied, device vanished mid-walk) while / still measures fine, the
    # survivors sum to 20 GB — a real, non-null number describing a nearly
    # empty disk, on the box whose whole problem is that /data is full.
    # Indistinguishable from a true reading unless we refuse to publish it.
    bridge = _load_bridge(monkeypatch)
    survivors = [f for f in _OS_FILESYSTEMS if f["mount"] != "/data"]
    sys_disk = bridge.system_disk_info(
        _LSBLK, "nvme0n1", survivors, filesystems_complete=False)
    assert sys_disk["used_bytes"] is None
    assert sys_disk["free_bytes"] is None
    assert sys_disk["measurement"] == "partial"
    # The rows that DID measure are still returned — the owner sees what was
    # readable, they just do not get a total that pretends to be the disk.
    assert [f["mount"] for f in sys_disk["filesystems"]] == ["/", "/boot/efi"]
    # Capacity is still known and still shown; only the meter goes away.
    assert sys_disk["size_bytes"] == 512 * GB


def test_complete_measurement_still_publishes_a_total(monkeypatch):
    # The guard on over-correcting: refusing partial totals must not stop the
    # normal path reporting one.
    bridge = _load_bridge(monkeypatch)
    sys_disk = bridge.system_disk_info(
        _LSBLK, "nvme0n1", _OS_FILESYSTEMS, filesystems_complete=True)
    assert sys_disk["used_bytes"] == 120 * GB
    assert sys_disk["measurement"] == "complete"


def test_unknown_disk_size_does_not_render_as_used_of_zero(monkeypatch):
    # lsblk gave no size but the filesystems measured real bytes. Publishing
    # used=120GB with size=0 renders as "120 GB of 0 B" — worse than saying
    # nothing, because it looks like a reading. Null both halves instead.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        {"name": "nvme0n1", "type": "disk", "size": 0, "tran": "nvme",
         "model": "Samsung SSD 980", "serial": "S64ANS0T1"},
    ]}
    sys_disk = bridge.system_disk_info(tree, "nvme0n1", _OS_FILESYSTEMS)
    assert sys_disk["used_bytes"] is None
    assert sys_disk["free_bytes"] is None
    assert sys_disk["measurement"] == "partial"


def test_reporting_it_does_not_re_admit_it_to_the_inventory(monkeypatch):
    # The load-bearing half of the pair. Making the OS disk visible must not put
    # it back into `disks`, where it would become an "Erase & adopt" candidate.
    bridge = _load_bridge(monkeypatch)
    sys_disk = bridge.system_disk_info(_LSBLK, "nvme0n1", _OS_FILESYSTEMS)
    disks = bridge.classify_disks(_LSBLK, "nvme0n1")
    assert sys_disk["name"] == "nvme0n1"
    assert "nvme0n1" not in [d["name"] for d in disks]
    assert [d["name"] for d in disks] == ["sda"]


# ---------------------------------------------------------------------------
# _os_disk_filesystems — the host-side discovery half
# ---------------------------------------------------------------------------

_PROC_MOUNTS = """\
sysfs /sys sysfs rw,nosuid 0 0
proc /proc proc rw,nosuid 0 0
/dev/mapper/ubuntu--vg-ubuntu--lv / ext4 rw,relatime 0 0
/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0
/dev/mapper/ubuntu--vg-droplet--data /data ext4 rw,relatime 0 0
tmpfs /run tmpfs rw,nosuid 0 0
/dev/md127 /mnt/droplet/pool ext4 rw,relatime 0 0
/dev/mapper/ubuntu--vg-ubuntu--lv /mnt/droplet ext4 rw,relatime 0 0
"""

_WHOLE_DISK = {
    "/dev/mapper/ubuntu--vg-ubuntu--lv": "nvme0n1",
    "/dev/nvme0n1p1": "nvme0n1",
    "/dev/mapper/ubuntu--vg-droplet--data": "nvme0n1",
    "/dev/md127": "md127",
}


def _stub_host(bridge, monkeypatch, tmp_path):
    mounts = tmp_path / "mounts"
    mounts.write_text(_PROC_MOUNTS)
    real_open = open

    def fake_open(path, *a, **kw):
        if path == "/proc/mounts":
            return real_open(mounts, *a, **kw)
        return real_open(path, *a, **kw)

    monkeypatch.setattr(bridge, "open", fake_open, raising=False)
    monkeypatch.setattr(bridge.os.path, "exists", lambda p: p.startswith("/dev/"))
    monkeypatch.setattr(bridge, "_whole_disk", lambda d: _WHOLE_DISK.get(d, ""))
    # Every filesystem reports the same numbers, which is what makes the
    # bind-mount double-count visible if the dedupe ever breaks.
    monkeypatch.setattr(bridge, "_bytes_for", lambda p: (100 * GB, 30 * GB, 70 * GB))


def test_discovery_finds_every_filesystem_on_the_os_disk(monkeypatch, tmp_path):
    bridge = _load_bridge(monkeypatch)
    _stub_host(bridge, monkeypatch, tmp_path)
    rows, complete = bridge._os_disk_filesystems({}, "nvme0n1")
    mounts = [r["mount"] for r in rows]
    # /data is found by DISCOVERY, not by a hardcoded path — it only exists
    # after droplet-luks-provision.sh has moved the docker data-root there.
    assert "/data" in mounts
    assert "/" in mounts
    assert "/boot/efi" in mounts
    # The pool is on a different disk and must never be counted here.
    assert "/mnt/droplet/pool" not in mounts
    # Every qualifying mount measured, so the caller may publish a total.
    assert complete is True


def test_discovery_deduplicates_the_root_bind_mount(monkeypatch, tmp_path):
    # The automounter bind-mounts "/" at /mnt/droplet, so root appears in
    # /proc/mounts twice with the same backing device and identical statvfs
    # numbers. Counting both would report double the used bytes — the phantom
    # capacity WARP-1960 fixed in camera storage. One row per device, shortest
    # mount wins.
    bridge = _load_bridge(monkeypatch)
    _stub_host(bridge, monkeypatch, tmp_path)
    rows, complete = bridge._os_disk_filesystems({}, "nvme0n1")
    mounts = [r["mount"] for r in rows]
    assert "/mnt/droplet" not in mounts
    assert mounts.count("/") == 1
    assert len(rows) == 3


def test_discovery_ignores_pseudo_filesystems(monkeypatch, tmp_path):
    # tmpfs/proc/sysfs are on no disk at all; including them would inflate the
    # system disk's usage with memory-backed mounts.
    bridge = _load_bridge(monkeypatch)
    _stub_host(bridge, monkeypatch, tmp_path)
    rows, complete = bridge._os_disk_filesystems({}, "nvme0n1")
    assert not [r for r in rows if r["mount"] in ("/run", "/proc", "/sys")]


def test_discovery_flags_itself_incomplete_when_a_filesystem_cannot_be_measured(
    monkeypatch, tmp_path,
):
    # The other half of the undercount fix. A dropped row must be SIGNALLED,
    # not merely omitted: omitting it silently is what lets the caller sum the
    # survivors and call it the disk.
    bridge = _load_bridge(monkeypatch)
    _stub_host(bridge, monkeypatch, tmp_path)

    real_bytes_for = bridge._bytes_for

    def flaky(path):
        # statvfs denied on /data only — exactly the asymmetry that makes a
        # root-only reading look plausible.
        if path == "/data":
            return 0, 0, 0
        return real_bytes_for(path)

    monkeypatch.setattr(bridge, "_bytes_for", flaky)
    rows, complete = bridge._os_disk_filesystems({}, "nvme0n1")
    assert complete is False
    assert "/data" not in [r["mount"] for r in rows]
    # And end to end: the caller must not publish a total from it.
    sys_disk = bridge.system_disk_info(_LSBLK, "nvme0n1", rows, complete)
    assert sys_disk["used_bytes"] is None
    assert sys_disk["measurement"] == "partial"


def test_discovery_returns_nothing_when_the_os_disk_is_unknown(monkeypatch, tmp_path):
    bridge = _load_bridge(monkeypatch)
    _stub_host(bridge, monkeypatch, tmp_path)
    assert bridge._os_disk_filesystems({}, "") == ([], True)


def test_discovery_does_not_depend_on_proc_mounts_ordering(monkeypatch, tmp_path):
    # Code review (WARP-2098): the root bind-mount alias listed BEFORE the
    # canonical mount, and statvfs failing on the canonical one. The old loop
    # had already recorded the alias's good reading, then let the later failure
    # flag the disk incomplete — a real measurement sat in the map while the
    # caller refused to publish it. A reading belongs to the DEVICE: whichever
    # alias measures counts, the preferred mount still names the row, and the
    # order /proc/mounts lists them in is invisible in the result.
    bridge = _load_bridge(monkeypatch)
    _stub_host(bridge, monkeypatch, tmp_path)
    real_bytes_for = bridge._bytes_for

    def flaky(path):
        if path == "/":
            return 0, 0, 0
        return real_bytes_for(path)

    monkeypatch.setattr(bridge, "_bytes_for", flaky)

    lines = _PROC_MOUNTS.splitlines()
    root = next(l for l in lines if l.split()[1] == "/")
    alias = next(l for l in lines if l.split()[1] == "/mnt/droplet")
    lines.remove(alias)
    lines.insert(lines.index(root), alias)
    (tmp_path / "mounts").write_text("\n".join(lines) + "\n")

    rows, complete = bridge._os_disk_filesystems({}, "nvme0n1")
    assert complete is True
    mounts = [r["mount"] for r in rows]
    assert mounts.count("/") == 1
    assert "/mnt/droplet" not in mounts
    assert next(r for r in rows if r["mount"] == "/")["size_bytes"] == 100 * GB

    # Canonical-first — the shape the live box has — gives the SAME answer.
    (tmp_path / "mounts").write_text(_PROC_MOUNTS)
    assert bridge._os_disk_filesystems({}, "nvme0n1") == (rows, complete)


# ---------------------------------------------------------------------------
# _collapse_by_device — ONE tie-break, shared with drives_snapshot
# ---------------------------------------------------------------------------

def test_collapse_prefers_fstab_then_the_shortest_mount_and_keeps_ejectability(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    rows = bridge._collapse_by_device([
        {"device": "/dev/sdb1", "mount": "/mnt/droplet/data-a0f10a84",
         "source": "automount", "removable": True},
        {"device": "/dev/sdb1", "mount": "/mnt/droplet/data",
         "source": "fstab", "removable": False},
        {"device": "/dev/sdc1", "mount": "/mnt/droplet/zz"},
        {"device": "/dev/sdc1", "mount": "/mnt/droplet/aa"},
    ])
    by_dev = {r["device"]: r for r in rows}
    assert set(by_dev) == {"/dev/sdb1", "/dev/sdc1"}
    assert by_dev["/dev/sdb1"]["mount"] == "/mnt/droplet/data"
    assert by_dev["/dev/sdb1"]["removable"] is True
    # Equal length: the name breaks the tie, so the result is deterministic.
    assert by_dev["/dev/sdc1"]["mount"] == "/mnt/droplet/aa"


def test_discovery_collapses_through_the_shared_helper(monkeypatch, tmp_path):
    # Structural: the dedupe in _os_disk_filesystems must BE the one
    # drives_snapshot uses, so a tie-break fix lands in both or in neither.
    bridge = _load_bridge(monkeypatch)
    _stub_host(bridge, monkeypatch, tmp_path)
    real = bridge._collapse_by_device
    seen = []

    def spy(entries):
        entries = list(entries)
        seen.append(entries)
        return real(entries)

    monkeypatch.setattr(bridge, "_collapse_by_device", spy)
    rows, _complete = bridge._os_disk_filesystems({}, "nvme0n1")
    assert seen, "_os_disk_filesystems deduplicated on its own"
    assert len(rows) == 3
