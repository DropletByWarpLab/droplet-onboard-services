"""Unit tests for the WARP-936 adoptable-disks inventory in device-bridge.py.

The bridge's /drives snapshot historically enumerated MOUNTED filesystems
only, so a present-but-unmounted disk (Stefan's two RAID-member WD drives)
was invisible to every layer above. WARP-936 adds an additive, cached
`lsblk -J` walk that emits a top-level `disks` array: every whole disk
except the OS disk and <100MB devices, each with an EXPLICIT state enum
(in_use | pool_member | foreign | available) — never a guess, never a
mount-gated omission.

Same harness as test_device_bridge_pools.py: load device-bridge.py fresh via
importlib with a seeded env, and monkeypatch at the `_lsblk_disks_json` /
`_os_disk` boundary so no real lsblk/findmnt on the host is ever touched.
NOTE: this suite DOES run in CI — .github/workflows/oled-display-panel-tests.yml
runs the whole tests/ directory on every PR touching services/oled-display
(WARP-1641 widened it from an explicit file list). The older note here said the
opposite, which was true when it was written and has not been since.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"
_RULES_PATH = (
    Path(__file__).resolve().parents[2] / "automount" / "99-droplet-automount.rules"
)


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_disks_under_test", _BRIDGE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _disk(name, size, fstype=None, mountpoint=None, tran="sata",
          model="", serial="", children=None, fsver=None):
    return {
        "name": name,
        "type": "disk",
        "size": size,
        "fstype": fstype,
        # WARP-3513: lsblk's FSVER column ("2" on a LUKS2 container).
        "fsver": fsver,
        "mountpoint": mountpoint,
        "tran": tran,
        "model": model,
        "serial": serial,
        **({"children": children} if children is not None else {}),
    }


def _part(name, fstype=None, mountpoint=None, type_="part", children=None,
          fsver=None):
    return {
        "name": name,
        "type": type_,
        "size": 0,
        "fstype": fstype,
        "fsver": fsver,
        "mountpoint": mountpoint,
        **({"children": children} if children is not None else {}),
    }


TB = 1_800_000_000_000

# The live .87 shape: OS NVMe with mounted partitions, plus sda+sdb as
# linux_raid_member disks of an unmounted, unformatted md127.
_LSBLK_LIVE_BOX = {
    "blockdevices": [
        _disk("nvme0n1", 512_000_000_000, tran="nvme", model="Samsung 980",
              children=[
                  _part("nvme0n1p1", fstype="vfat", mountpoint="/boot/efi"),
                  _part("nvme0n1p2", fstype="ext4", mountpoint="/"),
              ]),
        _disk("sda", TB, fstype="linux_raid_member", model="WDC WD20EARZ",
              serial="WD-A", children=[_part("md127", type_="raid1")]),
        _disk("sdb", TB, fstype="linux_raid_member", model="WDC WD20EARZ",
              serial="WD-B", children=[_part("md127", type_="raid1")]),
    ]
}

# WARP-1336 — the HEALTHY live box shape: same sda+sdb raid1 members, but the
# md127 array carries a MOUNTED ext4 filesystem (the pool works). The only
# mounted descendant of each member is the array itself, so the members must
# classify pool_member (Reclaim stays reachable) — never in_use.
_POOL_MNT = "/mnt/droplet/a0f10a84-7116-46a7-a3e3-5e00ea1c7d08"
_LSBLK_MOUNTED_POOL = {
    "blockdevices": [
        _disk("nvme0n1", 512_000_000_000, tran="nvme", model="Samsung 980",
              children=[
                  _part("nvme0n1p1", fstype="vfat", mountpoint="/boot/efi"),
                  _part("nvme0n1p2", fstype="ext4", mountpoint="/"),
              ]),
        _disk("sda", TB, fstype="linux_raid_member", model="WDC WD20EARZ",
              serial="WD-A",
              children=[_part("md127", type_="raid1", fstype="ext4",
                              mountpoint=_POOL_MNT)]),
        _disk("sdb", TB, fstype="linux_raid_member", model="WDC WD20EARZ",
              serial="WD-B",
              children=[_part("md127", type_="raid1", fstype="ext4",
                              mountpoint=_POOL_MNT)]),
    ]
}


# ---------------------------------------------------------------------------
# classify_disks — the pure classification layer
# ---------------------------------------------------------------------------

def test_os_disk_is_never_listed(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    disks = bridge.classify_disks(_LSBLK_LIVE_BOX, "nvme0n1")
    assert "nvme0n1" not in [d["name"] for d in disks]


def test_raid_member_disks_classified_pool_member_with_md_name(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    disks = bridge.classify_disks(_LSBLK_LIVE_BOX, "nvme0n1")
    by_name = {d["name"]: d for d in disks}
    assert set(by_name) == {"sda", "sdb"}
    for d in by_name.values():
        assert d["state"] == "pool_member"
        assert d["md"] == "md127"
        assert d["size_bytes"] == TB


def test_foreign_disk_has_signature_but_nothing_mounted(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sdc", TB, children=[_part("sdc1", fstype="ntfs")]),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert disks[0]["state"] == "foreign"


def test_available_disk_has_no_signature_at_all(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [_disk("sdd", TB)]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert disks[0]["state"] == "available"


def test_mounted_disk_or_child_is_in_use(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        # Child filesystem mounted → in_use, even though the disk node isn't.
        _disk("sde", TB, children=[
            _part("sde1", fstype="ext4", mountpoint="/mnt/droplet/data"),
        ]),
        # Whole-disk filesystem mounted directly (the drive_adopt shape).
        _disk("sdf", TB, fstype="ext4", mountpoint="/mnt/droplet/fresh"),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert [d["state"] for d in disks] == ["in_use", "in_use"]


def test_member_of_mounted_array_is_pool_member_with_md(monkeypatch):
    # WARP-1336 — rewrite of the old test_in_use_wins_over_pool_member, which
    # codified the bug: on a healthy box the pool filesystem IS mounted, and
    # "mounted anywhere below the disk" made every member classify in_use
    # with no `md`, so the dashboard's Reclaim affordance (gated on
    # state==="pool_member" && md) was unreachable exactly when the pool
    # worked. A mount on the md array a disk backs means the ARRAY is in use,
    # not the disk: the member stays pool_member and names its array.
    bridge = _load_bridge(monkeypatch)
    disks = bridge.classify_disks(_LSBLK_MOUNTED_POOL, "nvme0n1")
    by_name = {d["name"]: d for d in disks}
    assert set(by_name) == {"sda", "sdb"}
    for d in by_name.values():
        assert d["state"] == "pool_member"
        assert d["md"] == "md127"
        assert d["md_mounted"] is True


def test_mounted_array_member_stays_non_adoptable(monkeypatch):
    # WARP-1336 guard — adopt eligibility must NOT widen. The dashboard offers
    # plain "Erase & adopt" only for foreign/available; a pool member (mounted
    # array or not) is routed to Reclaim, never adopt (wipefs on an md-held
    # member fails EBUSY anyway).
    bridge = _load_bridge(monkeypatch)
    for tree in (_LSBLK_MOUNTED_POOL, _LSBLK_LIVE_BOX):
        for d in bridge.classify_disks(tree, "nvme0n1"):
            assert d["state"] not in ("foreign", "available")
            assert d["state"] == "pool_member"


def test_direct_or_plain_partition_mount_still_wins_as_in_use(monkeypatch):
    # WARP-1336 — the carve-out covers ONLY mounts on the md array itself. A
    # raid member whose OTHER (non-md) partition carries a mounted filesystem
    # is genuinely in use; the md annotation still rides along so the
    # member→array linkage survives the state.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sda", TB, children=[
            _part("sda1", fstype="linux_raid_member", children=[
                _part("md0", type_="raid1", fstype="ext4",
                      mountpoint="/mnt/droplet/pool"),
            ]),
            _part("sda2", fstype="ext4", mountpoint="/mnt/scratch"),
        ]),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert disks[0]["state"] == "in_use"
    assert disks[0]["md"] == "md0"
    assert disks[0]["md_mounted"] is True


def test_mounted_md_without_member_signature_stays_in_use(monkeypatch):
    # Degenerate shape: an md descendant is mounted but the disk carries no
    # linux_raid_member signature anywhere. Fail closed — in_use, never
    # adoptable (and not pool_member: without the signature there is nothing
    # drive_reclaim could --zero-superblock).
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sdx", TB, children=[
            _part("md9", type_="raid1", fstype="ext4",
                  mountpoint="/mnt/droplet/odd"),
        ]),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert disks[0]["state"] == "in_use"


def test_unmounted_array_member_reports_md_mounted_false(monkeypatch):
    # WARP-1336 — md_mounted lets the UI phrase reclaim copy honestly (a
    # mounted array is live data; an unmounted one is leftover metadata).
    bridge = _load_bridge(monkeypatch)
    disks = bridge.classify_disks(_LSBLK_LIVE_BOX, "nvme0n1")
    assert disks and all(d["md_mounted"] is False for d in disks)


def test_tiny_devices_are_dropped(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [_disk("sdg", 50 * 1024 * 1024)]}  # 50MB CIRCUITPY-ish
    assert bridge.classify_disks(tree, "nvme0n1") == []


def test_non_disk_nodes_are_ignored(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        {"name": "loop0", "type": "loop", "size": TB, "fstype": "squashfs",
         "mountpoint": None},
        {"name": "md127", "type": "raid1", "size": TB, "fstype": None,
         "mountpoint": None},
    ]}
    assert bridge.classify_disks(tree, "nvme0n1") == []


def test_unknown_os_disk_fails_open_but_mounted_root_still_in_use(monkeypatch):
    # _os_disk() can return "" (undeterminable). The OS disk then stays listed
    # (fail open, same as WARP-827) but classifies as in_use because its root
    # partition is mounted — so it is never presented as adoptable.
    bridge = _load_bridge(monkeypatch)
    disks = bridge.classify_disks(_LSBLK_LIVE_BOX, "")
    by_name = {d["name"]: d for d in disks}
    assert by_name["nvme0n1"]["state"] == "in_use"


def test_classify_handles_missing_or_garbage_input(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge.classify_disks(None, "nvme0n1") == []
    assert bridge.classify_disks({}, "nvme0n1") == []
    assert bridge.classify_disks({"blockdevices": None}, "nvme0n1") == []


# ---------------------------------------------------------------------------
# WARP-3513 — every prepared bay drive is LUKS2 (ext4 inside). Two things the
# whole-disk inventory must get right:
#   1. an explicit `encryption` enum on each disk, so the dashboard can tell a
#      LOCKED bay (a crypto_LUKS disk nothing has unlocked) from a random
#      foreign disk — both are `foreign` state, only one is ours to unlock;
#   2. the WARP-1336 regression guard. With LUKS in the middle the MOUNTED node
#      is the crypt child of the md array, whose NAME ("droplet-bay-xxxxxxxx")
#      does not start with "md". The old name-prefix test therefore flipped every
#      pool member to in_use and dropped pool_member + md + md_mounted, making
#      Reclaim unreachable exactly when the pool works. Ownership is now decided
#      by ANCESTRY: an md node, or anything beneath one, is the ARRAY in use.
# ---------------------------------------------------------------------------

_BAY_MNT = "/mnt/droplet/drive-9e8d7c6b"
_LUKS_POOL_MNT = "/mnt/droplet/pool-3c4d5e6f"
_VALID_ENCRYPTION = ("luks2", "none", "unknown")


def _crypt(name, mountpoint=None):
    # The dm-crypt node: lsblk NAME is the mapper name, the ext4 lives here.
    return _part(name, fstype="ext4", fsver="1.0", mountpoint=mountpoint,
                 type_="crypt")


def _luks_pool_member(name, serial, mounted=True, md_fsver="2", unlocked=True):
    # LUKS over md: sdX (linux_raid_member) -> md127 (raid1, crypto_LUKS)
    #               -> droplet-bay-cafef00d (crypt, ext4, mounted)
    children = ([_crypt("droplet-bay-cafef00d",
                        _LUKS_POOL_MNT if mounted else None)]
                if unlocked else None)
    return _disk(name, TB, fstype="linux_raid_member", fsver="1.2",
                 model="WDC WD20EARZ", serial=serial,
                 children=[_part("md127", type_="raid1", fstype="crypto_LUKS",
                                 fsver=md_fsver, children=children)])


_OS_NVME = _disk("nvme0n1", 512_000_000_000, tran="nvme", model="Samsung 980",
                 children=[
                     _part("nvme0n1p1", fstype="vfat", mountpoint="/boot/efi"),
                     _part("nvme0n1p2", fstype="ext4", mountpoint="/"),
                 ])


def test_luks_over_md_members_stay_pool_member_when_the_pool_is_mounted(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _OS_NVME,
        _luks_pool_member("sda", "WD-A"),
        _luks_pool_member("sdb", "WD-B"),
    ]}
    by_name = {d["name"]: d for d in bridge.classify_disks(tree, "nvme0n1")}
    assert set(by_name) == {"sda", "sdb"}
    for d in by_name.values():
        assert d["state"] == "pool_member", (
            "a mount on the crypt child of the md array is the ARRAY in use, "
            "not the member disk (WARP-1336)")
        assert d["md"] == "md127"
        assert d["md_mounted"] is True
        assert d["encryption"] == "luks2"


def test_luks_over_md_members_are_still_never_adoptable(monkeypatch):
    # The Reclaim route (pool_member + md) must stay reachable, and adopt
    # eligibility must not widen: foreign/available only.
    bridge = _load_bridge(monkeypatch)
    for unlocked in (True, False):
        tree = {"blockdevices": [
            _luks_pool_member("sda", "WD-A", unlocked=unlocked),
            _luks_pool_member("sdb", "WD-B", unlocked=unlocked),
        ]}
        for d in bridge.classify_disks(tree, "nvme0n1"):
            assert d["state"] == "pool_member"
            assert d["state"] not in ("foreign", "available")
            assert d["md"] == "md127"


def test_luks_over_md_pool_that_is_not_unlocked_reports_md_mounted_false(monkeypatch):
    # md127 carries crypto_LUKS but nothing has opened it: no crypt child.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _luks_pool_member("sda", "WD-A", unlocked=False),
        _luks_pool_member("sdb", "WD-B", unlocked=False),
    ]}
    for d in bridge.classify_disks(tree, "nvme0n1"):
        assert d["state"] == "pool_member"
        assert d["md"] == "md127"
        assert d["md_mounted"] is False
        assert d["encryption"] == "luks2"


def test_luks_over_md_pool_unlocked_but_not_mounted(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _luks_pool_member("sda", "WD-A", mounted=False),
        _luks_pool_member("sdb", "WD-B", mounted=False),
    ]}
    for d in bridge.classify_disks(tree, "nvme0n1"):
        assert d["state"] == "pool_member"
        assert d["md_mounted"] is False


def test_plain_pool_classification_is_unchanged(monkeypatch):
    # The pre-WARP-3513 shape (ext4 straight on md127): same states, same md
    # linkage — plus the new `encryption`, which is "none" for it.
    bridge = _load_bridge(monkeypatch)
    for tree, md_mounted in ((_LSBLK_MOUNTED_POOL, True), (_LSBLK_LIVE_BOX, False)):
        by_name = {d["name"]: d for d in bridge.classify_disks(tree, "nvme0n1")}
        assert set(by_name) == {"sda", "sdb"}
        for d in by_name.values():
            assert d["state"] == "pool_member"
            assert d["md"] == "md127"
            assert d["md_mounted"] is md_mounted
            assert d["encryption"] == "none"


def test_luks_bay_on_a_single_disk_is_in_use_when_mounted(monkeypatch):
    # sdb (crypto_LUKS) -> droplet-bay-1a2b3c4d (crypt, ext4, mounted). The
    # mounted node is NOT beneath any md array, so the disk itself is in use.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sdb", TB, fstype="crypto_LUKS", fsver="2", model="WDC WD20EARZ",
              serial="WD-B",
              children=[_crypt("droplet-bay-1a2b3c4d", _BAY_MNT)]),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert len(disks) == 1
    assert disks[0]["state"] == "in_use"
    assert disks[0]["encryption"] == "luks2"
    assert "md" not in disks[0] and "md_mounted" not in disks[0]


def test_locked_luks_bay_is_foreign_but_marked_luks2(monkeypatch):
    # A crypto_LUKS disk nothing has unlocked: no children, nothing mounted.
    # Its STATE is still `foreign` (it has a signature, nothing is mounted) —
    # `encryption` is what lets the UI say "locked bay" instead of "unknown disk".
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sdb", TB, fstype="crypto_LUKS", fsver="2"),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert disks[0]["state"] == "foreign"
    assert disks[0]["encryption"] == "luks2"
    assert disks[0]["fstype"] == "crypto_LUKS"


def test_locked_luks1_container_is_foreign_with_unknown_encryption(monkeypatch):
    # Only an explicit LUKS2 is ours. LUKS1 / a missing version is "unknown" —
    # never the prepared state.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sdb", TB, fstype="crypto_LUKS", fsver="1"),
        _disk("sdc", TB, fstype="crypto_LUKS", fsver=None),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert [d["state"] for d in disks] == ["foreign", "foreign"]
    assert [d["encryption"] for d in disks] == ["unknown", "unknown"]


def test_crypt_child_mounted_outside_md_marks_the_disk_in_use(monkeypatch):
    # LUKS on a PARTITION: sdc -> sdc1 (crypto_LUKS) -> crypt (mounted). Not
    # beneath an md array => in_use, and encryption comes from the descendant.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sdc", TB, children=[
            _part("sdc1", fstype="crypto_LUKS", fsver="2", children=[
                _crypt("droplet-bay-5d6e7f80", "/mnt/droplet/drive-aa00bb11"),
            ]),
        ]),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert disks[0]["state"] == "in_use"
    assert disks[0]["encryption"] == "luks2"


def test_mount_outside_md_on_a_pool_member_still_wins_as_in_use(monkeypatch):
    # The carve-out is ancestry, not "anything encrypted". A member whose OTHER
    # partition carries a mounted LUKS bay is genuinely in use; the md linkage
    # rides along (md_mounted describes the ARRAY side only).
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sda", TB, children=[
            _part("sda1", fstype="linux_raid_member", children=[
                _part("md0", type_="raid1", fstype="crypto_LUKS", fsver="2",
                      children=[_crypt("droplet-bay-cafef00d")]),
            ]),
            _part("sda2", fstype="crypto_LUKS", fsver="2", children=[
                _crypt("droplet-bay-99887766", "/mnt/droplet/extra-99887766"),
            ]),
        ]),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert disks[0]["state"] == "in_use"
    assert disks[0]["md"] == "md0"
    assert disks[0]["md_mounted"] is False
    assert disks[0]["encryption"] == "luks2"


def test_lvm_beneath_an_md_array_is_the_array_in_use(monkeypatch):
    # Ancestry rule, pinned for the non-LUKS stack too: an LV (or a partition of
    # a partitionable md) beneath the array is the ARRAY in use. A mount on a
    # descendant that is NOT beneath an md (a plain partition, LVM straight on
    # the disk) is still the disk in use.
    bridge = _load_bridge(monkeypatch)
    beneath = {"blockdevices": [
        _disk("sda", TB, fstype="linux_raid_member", children=[
            _part("md0", type_="raid1", children=[
                _part("vg-data", type_="lvm", fstype="ext4",
                      mountpoint="/mnt/droplet/data-1"),
            ]),
        ]),
        _disk("sdb", TB, fstype="linux_raid_member", children=[
            _part("md1", type_="raid1", children=[
                _part("md1p1", fstype="ext4", mountpoint="/mnt/droplet/data-2"),
            ]),
        ]),
    ]}
    for d in bridge.classify_disks(beneath, "nvme0n1"):
        assert d["state"] == "pool_member"
        assert d["md_mounted"] is True
    beside = {"blockdevices": [
        _disk("sdc", TB, children=[
            _part("vg-data", type_="lvm", fstype="ext4",
                  mountpoint="/mnt/droplet/data-3"),
        ]),
    ]}
    assert bridge.classify_disks(beside, "nvme0n1")[0]["state"] == "in_use"


def test_a_mount_several_levels_beneath_an_md_array_is_still_the_array_in_use(monkeypatch):
    # Ancestry holds at ANY depth, not just for the array's direct child:
    # md0 -> LUKS (crypt) -> LVM volume -> mount.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sda", TB, fstype="linux_raid_member", children=[
            _part("md0", type_="raid1", fstype="crypto_LUKS", fsver="2", children=[
                _part("cryptlvm", type_="crypt", fstype="LVM2_member", children=[
                    _part("vg-data", type_="lvm", fstype="ext4", fsver="1.0",
                          mountpoint="/mnt/droplet/data-4"),
                ]),
            ]),
        ]),
    ]}
    d = bridge.classify_disks(tree, "nvme0n1")[0]
    assert d["state"] == "pool_member"
    assert d["md"] == "md0"
    assert d["md_mounted"] is True
    assert d["encryption"] == "luks2"


def test_md_ownership_is_decided_by_ancestry_not_by_name_prefix(monkeypatch):
    # A mounted dm volume that merely STARTS with "md" is not an md array: the
    # old startswith("md") test invented md="mdbackup" + md_mounted for it.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sdc", TB, children=[
            _part("sdc1", fstype="LVM2_member", children=[
                _part("mdbackup", type_="lvm", fstype="ext4",
                      mountpoint="/mnt/droplet/backup-1"),
            ]),
        ]),
    ]}
    disks = bridge.classify_disks(tree, "nvme0n1")
    assert disks[0]["state"] == "in_use"
    assert "md" not in disks[0]
    assert "md_mounted" not in disks[0]


def test_encryption_looks_at_the_disk_and_every_descendant(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    cases = {
        # container ON the disk
        "sda": _disk("sda", TB, fstype="crypto_LUKS", fsver="2"),
        # container on a partition
        "sdb": _disk("sdb", TB, children=[
            _part("sdb1", fstype="crypto_LUKS", fsver="2")]),
        # container is the md array above the disk (LUKS over md)
        "sdc": _luks_pool_member("sdc", "WD-C", unlocked=False),
        # a luks2 container beats a legacy one sharing the disk
        "sdd": _disk("sdd", TB, children=[
            _part("sdd1", fstype="crypto_LUKS", fsver="1"),
            _part("sdd2", fstype="crypto_LUKS", fsver="2")]),
    }
    tree = {"blockdevices": list(cases.values())}
    by_name = {d["name"]: d for d in bridge.classify_disks(tree, "nvme0n1")}
    assert {n: by_name[n]["encryption"] for n in cases} == {n: "luks2" for n in cases}


def test_encryption_is_none_without_any_luks_container(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sda", TB, children=[_part("sda1", fstype="ntfs")]),
        _disk("sdb", TB),
        _disk("sdc", TB, fstype="ext4", mountpoint="/mnt/droplet/fresh"),
        # crypt node whose parent carries NO LUKS signature is not LUKS
        _disk("sdd", TB, children=[
            _part("plain-dmcrypt", type_="crypt", fstype="ext4")]),
    ]}
    by_name = {d["name"]: d for d in bridge.classify_disks(tree, "nvme0n1")}
    assert {d["encryption"] for d in by_name.values()} == {"none"}


def test_every_disk_entry_carries_an_explicit_encryption_enum(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    trees = (
        _LSBLK_LIVE_BOX, _LSBLK_MOUNTED_POOL,
        {"blockdevices": [_luks_pool_member("sda", "WD-A"),
                          _disk("sdb", TB, fstype="crypto_LUKS", fsver="2")]},
    )
    for tree in trees:
        disks = bridge.classify_disks(tree, "nvme0n1")
        assert disks
        for d in disks:
            assert d["encryption"] in _VALID_ENCRYPTION


def test_encryption_addition_is_purely_additive_for_existing_fixtures(monkeypatch):
    # No key removed or renamed; the only new key on a disk entry is `encryption`.
    bridge = _load_bridge(monkeypatch)
    old_keys = {"name", "size_bytes", "state", "fstype", "bus", "model", "serial",
                "md", "md_mounted"}
    for d in bridge.classify_disks(_LSBLK_MOUNTED_POOL, "nvme0n1"):
        assert set(d) == old_keys | {"encryption"}
    plain = bridge.classify_disks({"blockdevices": [_disk("sdd", TB)]}, "nvme0n1")[0]
    assert set(plain) == (old_keys - {"md", "md_mounted"}) | {"encryption"}


# ---------------------------------------------------------------------------
# drives_snapshot — the additive `disks` field on the /drives payload
# ---------------------------------------------------------------------------

def test_drives_snapshot_includes_disks_field(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_os_disk", lambda: "nvme0n1")
    monkeypatch.setattr(bridge, "_lsblk_disks_json", lambda: _LSBLK_LIVE_BOX)
    snap = bridge.drives_snapshot(invalidate=True)
    assert "disks" in snap
    assert {d["name"] for d in snap["disks"]} == {"sda", "sdb"}
    # Existing mounted-drives semantics unchanged: still a list, still present.
    assert isinstance(snap["drives"], list)


def test_drives_snapshot_disks_empty_when_lsblk_unavailable(monkeypatch):
    # A host without lsblk (or unparsable output) degrades to an empty disks
    # list — never an error, never a missing key.
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_os_disk", lambda: "nvme0n1")
    monkeypatch.setattr(bridge, "_lsblk_disks_json", lambda: None)
    snap = bridge.drives_snapshot(invalidate=True)
    assert snap["disks"] == []


# ---------------------------------------------------------------------------
# udev automount rule — whole-disk nodes must be matched (WARP-936; the
# drive_adopt whole-disk filesystem previously went dark on reboot because
# the KERNEL match covered partitions only)
# ---------------------------------------------------------------------------

def test_automount_rule_matches_whole_disk_nodes():
    text = _RULES_PATH.read_text(encoding="utf-8")
    kernel_line = next(
        line for line in text.splitlines()
        if line.startswith("KERNEL!=") and "GOTO" in line
    )
    # KERNEL!="a|b|c", GOTO=... — the accepted device set is the quoted
    # alternation. Whole-disk nodes must be whole alternatives.
    alternation = kernel_line.split('"')[1]
    tokens = alternation.split("|")
    for pattern in ("sd[a-z]", "sd[a-z][a-z]", "nvme[0-9]n[0-9]"):
        assert pattern in tokens, (
            f"udev KERNEL match must include whole-disk pattern {pattern!r} "
            "or an adopted whole-disk filesystem never remounts after reboot"
        )

