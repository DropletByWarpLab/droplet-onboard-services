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
          model="", serial="", children=None):
    return {
        "name": name,
        "type": "disk",
        "size": size,
        "fstype": fstype,
        "mountpoint": mountpoint,
        "tran": tran,
        "model": model,
        "serial": serial,
        **({"children": children} if children is not None else {}),
    }


def _part(name, fstype=None, mountpoint=None, type_="part", children=None):
    return {
        "name": name,
        "type": type_,
        "size": 0,
        "fstype": fstype,
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

