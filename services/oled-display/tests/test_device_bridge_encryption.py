"""WARP-3513 — encrypted-at-rest bay drives: the encryption facts the bridge reports.

Every prepared bay drive is now LUKS2 with ext4 inside, and a pool is LUKS over
md. The orchestrator runs in a container that CANNOT see host block devices, so
the bridge is the only place that can say "this drive is encrypted" — and the
dashboard branches on that answer (`preparation` is derived from
`encryption === "luks2"`, never from null/absence). So the contract here is an
EXPLICIT enum on every drive entry:

  encryption  "luks2" | "none" | "unknown"
  md          bare md array name ("md127") | None

Shapes the fixtures model (lsblk -J; a recent util-linux reports `fsver`):

  single-disk bay   sdb (disk, crypto_LUKS, fsver "2")
                      -> droplet-bay-1a2b3c4d (crypt, ext4, mounted)
  LUKS-over-md pool sda,sdb (disk, linux_raid_member)
                      -> md127 (raid1, crypto_LUKS, fsver "2")
                        -> droplet-bay-cafef00d (crypt, ext4, mounted)

Same harness as test_device_bridge_disks.py: load device-bridge.py fresh via
importlib with a seeded env and drive the PURE helpers with canned lsblk JSON,
so no real lsblk / cryptsetup / mount on the host is ever touched.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"

GB = 1_000_000_000
TB = 1_800_000_000_000


def _load_bridge(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    spec = importlib.util.spec_from_file_location(
        "device_bridge_encryption_under_test", _BRIDGE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _node(name, type_="part", fstype=None, fsver=None, mountpoint=None,
          children=None, size=0, **extra):
    node = {
        "name": name,
        "type": type_,
        "size": size,
        "fstype": fstype,
        "fsver": fsver,
        "mountpoint": mountpoint,
        **extra,
    }
    if children is not None:
        node["children"] = children
    return node


def _disk(name, fstype=None, fsver=None, children=None, size=TB,
          mountpoint=None, tran="sata"):
    return _node(name, "disk", fstype=fstype, fsver=fsver, mountpoint=mountpoint,
                 children=children, size=size, tran=tran,
                 model="WDC WD20EARZ", serial="WD-" + name.upper())


_BAY_MNT = "/mnt/droplet/drive-9e8d7c6b"
_POOL_MNT = "/mnt/droplet/pool-3c4d5e6f"
_PLAIN_MNT = "/mnt/droplet/data-0123abcd"


def _bay_crypt(mapper="droplet-bay-1a2b3c4d", mountpoint=_BAY_MNT):
    # The dm-crypt node: lsblk NAME is the MAPPER name, TYPE is "crypt", and the
    # ext4 lives here — not on the backing disk.
    return _node(mapper, "crypt", fstype="ext4", fsver="1.0", mountpoint=mountpoint)


def _pool_member(name, md_fstype="crypto_LUKS", md_fsver="2", mounted=True,
                 crypt=True):
    # md nodes show up under EVERY member disk, each with its own copy of the
    # subtree — exactly what lsblk prints.
    md_children = None
    if crypt:
        md_children = [_bay_crypt("droplet-bay-cafef00d",
                                  _POOL_MNT if mounted else None)]
    return _disk(name, fstype="linux_raid_member", fsver="1.2", children=[
        _node("md127", "raid1", fstype=md_fstype, fsver=md_fsver,
              children=md_children),
    ])


_OS_DISK = _disk("nvme0n1", size=512 * GB, tran="nvme", children=[
    _node("nvme0n1p1", fstype="vfat", fsver="FAT32", mountpoint="/boot/efi"),
    _node("nvme0n1p2", fstype="ext4", fsver="1.0", mountpoint="/"),
])

# One box carrying every shape at once: the OS disk, a single-disk LUKS bay, a
# LUKS-over-md pool and a legacy plain drive.
_TREE = {
    "blockdevices": [
        _OS_DISK,
        _disk("sdb", fstype="crypto_LUKS", fsver="2", children=[_bay_crypt()]),
        _pool_member("sdc"),
        _pool_member("sdd"),
        _disk("sde", children=[
            _node("sde1", fstype="ext4", fsver="1.0", mountpoint=_PLAIN_MNT),
        ]),
    ]
}


# ---------------------------------------------------------------------------
# 1. _lsblk_disks_json asks for FSVER (and degrades, not disappears, without it)
# ---------------------------------------------------------------------------

_LEGACY_COLUMNS = ("NAME", "TYPE", "SIZE", "FSTYPE", "MOUNTPOINT", "TRAN",
                   "MODEL", "SERIAL")


def test_lsblk_asks_for_the_fsver_column(monkeypatch):
    # The LUKS container VERSION is what separates "luks2" from "unknown", and
    # lsblk only reports it through FSVER.
    bridge = _load_bridge(monkeypatch)
    seen = []

    def fake_run(cmd, timeout=15):
        seen.append(list(cmd))
        return 0, json.dumps({"blockdevices": [{"name": "sdb", "fsver": "2"}]}), ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    tree = bridge._lsblk_disks_json()
    assert tree == {"blockdevices": [{"name": "sdb", "fsver": "2"}]}
    assert len(seen) == 1, "one lsblk subprocess per read on a host that supports FSVER"
    cmd = seen[0]
    assert cmd[:4] == ["lsblk", "-J", "-b", "-o"]
    columns = cmd[4].split(",")
    assert "FSVER" in columns
    # Additive: every column the inventory already relied on is still requested.
    for col in _LEGACY_COLUMNS:
        assert col in columns


def test_lsblk_without_fsver_support_degrades_instead_of_losing_the_inventory(monkeypatch):
    # An older util-linux rejects the WHOLE -o list ("unknown column: FSVER") and
    # prints nothing — which would take the entire disks inventory with it, a
    # regression for every box that is not on the new lsblk. Retry once without
    # the column: the inventory survives and LUKS reads "unknown", never a
    # wrongly-confident "luks2".
    bridge = _load_bridge(monkeypatch)
    seen = []
    legacy_tree = {"blockdevices": [
        {"name": "sdb", "type": "disk", "size": TB, "fstype": "crypto_LUKS",
         "mountpoint": None, "tran": "sata", "model": "WDC", "serial": "WD-B"},
    ]}

    def fake_run(cmd, timeout=15):
        seen.append(list(cmd))
        if "FSVER" in cmd[4].split(","):
            return 1, "", "lsblk: unknown column: FSVER"
        return 0, json.dumps(legacy_tree), ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    tree = bridge._lsblk_disks_json()
    assert tree == legacy_tree
    assert len(seen) == 2
    assert "FSVER" not in seen[1][4].split(",")
    for col in _LEGACY_COLUMNS:
        assert col in seen[1][4].split(",")
    assert bridge.classify_disks(tree, "nvme0n1")[0]["encryption"] == "unknown"


# What `lsblk -J -b -o NAME,TYPE,SIZE,FSTYPE,FSVER,MOUNTPOINT,TRAN,MODEL,SERIAL`
# prints on a box carrying every shape (modelled on util-linux 2.39 / Ubuntu
# 24.04): numeric sizes with -b, `fsver` as a STRING ("2", "1.0"), explicit nulls
# for empty columns.
_LSBLK_RAW_WHOLE_BOX = """{
   "blockdevices": [
      {
         "name": "nvme0n1", "type": "disk", "size": 512110190592, "fstype": null, "fsver": null, "mountpoint": null, "tran": "nvme", "model": "Samsung SSD 980 PRO 512GB", "serial": "S5GXNX0T123456A",
         "children": [
            {"name": "nvme0n1p1", "type": "part", "size": 1127219200, "fstype": "vfat", "fsver": "FAT32", "mountpoint": "/boot/efi", "tran": null, "model": null, "serial": null},
            {"name": "nvme0n1p2", "type": "part", "size": 510981693440, "fstype": "ext4", "fsver": "1.0", "mountpoint": "/", "tran": null, "model": null, "serial": null}
         ]
      },{
         "name": "sda", "type": "disk", "size": 2000398934016, "fstype": "linux_raid_member", "fsver": "1.2", "mountpoint": null, "tran": "sata", "model": "WDC WD20EARZ-00A", "serial": "WD-WCAZA1234567",
         "children": [
            {"name": "md127", "type": "raid1", "size": 2000264691712, "fstype": "crypto_LUKS", "fsver": "2", "mountpoint": null, "tran": null, "model": null, "serial": null,
               "children": [
                  {"name": "droplet-bay-cafef00d", "type": "crypt", "size": 2000248565760, "fstype": "ext4", "fsver": "1.0", "mountpoint": "/mnt/droplet/pool-3c4d5e6f", "tran": null, "model": null, "serial": null}
               ]
            }
         ]
      },{
         "name": "sdb", "type": "disk", "size": 2000398934016, "fstype": "linux_raid_member", "fsver": "1.2", "mountpoint": null, "tran": "sata", "model": "WDC WD20EARZ-00A", "serial": "WD-WCAZA7654321",
         "children": [
            {"name": "md127", "type": "raid1", "size": 2000264691712, "fstype": "crypto_LUKS", "fsver": "2", "mountpoint": null, "tran": null, "model": null, "serial": null,
               "children": [
                  {"name": "droplet-bay-cafef00d", "type": "crypt", "size": 2000248565760, "fstype": "ext4", "fsver": "1.0", "mountpoint": "/mnt/droplet/pool-3c4d5e6f", "tran": null, "model": null, "serial": null}
               ]
            }
         ]
      },{
         "name": "sdc", "type": "disk", "size": 4000787030016, "fstype": "crypto_LUKS", "fsver": "2", "mountpoint": null, "tran": "usb", "model": "Elements 25A2", "serial": "575834314142",
         "children": [
            {"name": "droplet-bay-1a2b3c4d", "type": "crypt", "size": 4000770252800, "fstype": "ext4", "fsver": "1.0", "mountpoint": "/mnt/droplet/drive-9e8d7c6b", "tran": null, "model": null, "serial": null}
         ]
      },{
         "name": "sdd", "type": "disk", "size": 4000787030016, "fstype": "crypto_LUKS", "fsver": "2", "mountpoint": null, "tran": "usb", "model": "Elements 25A2", "serial": "575834314143"
      }
   ]
}
"""


def test_a_realistic_lsblk_print_end_to_end(monkeypatch):
    # Raw text -> _lsblk_disks_json -> classify_disks / _encryption_for / _md_for,
    # with nothing but the subprocess boundary faked.
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda cmd, timeout=15: (0, _LSBLK_RAW_WHOLE_BOX, ""))
    tree = bridge._lsblk_disks_json()
    disks = {d["name"]: d for d in bridge.classify_disks(tree, "nvme0n1")}
    assert set(disks) == {"sda", "sdb", "sdc", "sdd"}
    for member in ("sda", "sdb"):
        assert disks[member]["state"] == "pool_member"
        assert disks[member]["md"] == "md127"
        assert disks[member]["md_mounted"] is True
        assert disks[member]["encryption"] == "luks2"
    assert disks["sdc"]["state"] == "in_use"            # the mounted single-disk bay
    assert disks["sdc"]["encryption"] == "luks2"
    assert disks["sdd"]["state"] == "foreign"           # a LOCKED bay ...
    assert disks["sdd"]["encryption"] == "luks2"        # ... told apart by `encryption`
    assert bridge._encryption_for(tree, "/dev/mapper/droplet-bay-1a2b3c4d") == "luks2"
    assert bridge._encryption_for(tree, "/dev/mapper/droplet-bay-cafef00d") == "luks2"
    assert bridge._md_for(tree, "/dev/mapper/droplet-bay-cafef00d") == "md127"
    assert bridge._md_for(tree, "/dev/mapper/droplet-bay-1a2b3c4d") is None
    assert bridge._encryption_for(tree, "/dev/nvme0n1p2") == "none"


def test_lsblk_garbage_or_missing_still_returns_none(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    for out in ("", "not json", "[1, 2]", "null"):
        monkeypatch.setattr(bridge, "_run", lambda cmd, timeout=15, o=out: (0, o, ""))
        assert bridge._lsblk_disks_json() is None
    monkeypatch.setattr(bridge, "_run",
                        lambda cmd, timeout=15: (1, "", "lsblk: not found"))
    assert bridge._lsblk_disks_json() is None


# ---------------------------------------------------------------------------
# 2. _encryption_for — pure, never raises
# ---------------------------------------------------------------------------

def test_encryption_for_the_luks_container_itself(monkeypatch):
    # automount state records the BACKING device (/dev/sdb); the container node
    # carries crypto_LUKS + fsver "2" itself.
    bridge = _load_bridge(monkeypatch)
    assert bridge._encryption_for(_TREE, "/dev/sdb") == "luks2"


def test_encryption_for_the_unlocked_mapper(monkeypatch):
    # /proc/mounts shows the MAPPER; lsblk NAME for it is the mapper name and
    # its direct parent is the crypto_LUKS container.
    bridge = _load_bridge(monkeypatch)
    assert bridge._encryption_for(
        _TREE, "/dev/mapper/droplet-bay-1a2b3c4d") == "luks2"


def test_encryption_for_a_luks_over_md_pool(monkeypatch):
    # Both the md array (the LUKS container) and the crypt node above it.
    bridge = _load_bridge(monkeypatch)
    assert bridge._encryption_for(_TREE, "/dev/md127") == "luks2"
    assert bridge._encryption_for(
        _TREE, "/dev/mapper/droplet-bay-cafef00d") == "luks2"


def test_encryption_for_any_ancestor_crypt_counts(monkeypatch):
    # LVM (or anything else) stacked on a dm-crypt node: the encrypted ancestor
    # is two levels up, and the filesystem is still encrypted at rest.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [
        _disk("sdl", fstype="crypto_LUKS", fsver="2", children=[
            _node("cryptlvm", "crypt", fstype="LVM2_member", children=[
                _node("vg-data", "lvm", fstype="ext4", fsver="1.0",
                      mountpoint="/mnt/droplet/data-aaaa1111"),
            ]),
        ]),
    ]}
    assert bridge._encryption_for(tree, "/dev/mapper/vg-data") == "luks2"


def test_encryption_for_plain_drive_and_plain_md_is_none(monkeypatch):
    # Node found, no LUKS anywhere in its lineage => "none" (a known fact, not
    # a failure to look).
    bridge = _load_bridge(monkeypatch)
    plain_pool = {"blockdevices": [
        _disk("sda", fstype="linux_raid_member", children=[
            _node("md0", "raid1", fstype="ext4", fsver="1.0", mountpoint=_POOL_MNT)]),
        _disk("sdb", fstype="linux_raid_member", children=[
            _node("md0", "raid1", fstype="ext4", fsver="1.0", mountpoint=_POOL_MNT)]),
    ]}
    assert bridge._encryption_for(_TREE, "/dev/sde1") == "none"
    assert bridge._encryption_for(_TREE, "/dev/sde") == "none"
    assert bridge._encryption_for(plain_pool, "/dev/md0") == "none"


def test_encryption_for_the_os_partition_is_none(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._encryption_for(_TREE, "/dev/nvme0n1p2") == "none"


def test_encryption_for_crypt_without_a_luks_parent_is_none(monkeypatch):
    # A dm-crypt node whose parent carries no crypto_LUKS signature (plain-mode
    # dm-crypt) is not something we can call LUKS2 — and not something we can
    # honestly call "luks2 container of unknown version" either.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [_disk("sdx", children=[
        _node("cryptplain", "crypt", fstype="ext4", fsver="1.0",
              mountpoint="/mnt/droplet/x-1"),
    ])]}
    assert bridge._encryption_for(tree, "/dev/mapper/cryptplain") == "none"


@pytest.mark.parametrize("fsver", ["1", "", None, "3", "luks2", " "])
def test_encryption_for_luks_with_any_other_version_is_unknown(monkeypatch, fsver):
    # Only an explicit "2" is luks2. LUKS1 (or a missing/odd version) must not
    # be treated as the prepared state.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [_disk("sdl", fstype="crypto_LUKS", fsver=fsver, children=[
        _bay_crypt("droplet-bay-0ldbay00"),
    ])]}
    assert bridge._encryption_for(tree, "/dev/sdl") == "unknown"
    assert bridge._encryption_for(tree, "/dev/mapper/droplet-bay-0ldbay00") == "unknown"


def test_encryption_for_luks_with_the_fsver_key_absent_is_unknown(monkeypatch):
    # lsblk too old to know FSVER: the key is simply missing from every node.
    bridge = _load_bridge(monkeypatch)
    disk = _disk("sdl", fstype="crypto_LUKS", children=[_bay_crypt("droplet-bay-0ldbay00")])
    del disk["fsver"]
    assert bridge._encryption_for({"blockdevices": [disk]}, "/dev/sdl") == "unknown"


def test_encryption_for_a_node_that_is_not_in_the_tree_is_unknown(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._encryption_for(_TREE, "/dev/sdz") == "unknown"
    assert bridge._encryption_for(_TREE, "/dev/mapper/droplet-bay-deadbeef") == "unknown"


def test_encryption_for_matches_the_whole_name_not_a_prefix(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._encryption_for(
        _TREE, "/dev/mapper/droplet-bay-1a2b3c4") == "unknown"
    assert bridge._encryption_for(
        _TREE, "/dev/mapper/droplet-bay-1a2b3c4dd") == "unknown"
    assert bridge._encryption_for(_TREE, "/dev/sd") == "unknown"


@pytest.mark.parametrize("tree", [
    None, {}, [], "garbage", 7, {"blockdevices": None}, {"blockdevices": []},
    {"blockdevices": "sdb"}, {"blockdevices": [None, 5, "sdb", ["sdb"], {"name": None}]},
])
def test_encryption_for_without_a_usable_tree_is_unknown_and_never_raises(
    monkeypatch, tree,
):
    bridge = _load_bridge(monkeypatch)
    assert bridge._encryption_for(tree, "/dev/sdb") == "unknown"
    assert bridge._md_for(tree, "/dev/md127") is None


@pytest.mark.parametrize("children", ["oops", {"name": "x"}, [None, 3, "x", ["y"]], 5])
def test_encryption_for_malformed_children_never_raise(monkeypatch, children):
    # The node IS in the tree (no LUKS in its lineage => "none"); its malformed
    # `children` value must neither raise nor invent a descendant.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [{"name": "sdb", "type": "disk", "fstype": None,
                              "children": children}]}
    assert bridge._encryption_for(tree, "/dev/sdb") == "none"
    assert bridge._encryption_for(tree, "/dev/sdz") == "unknown"
    assert bridge._md_for(tree, "/dev/sdb") is None


@pytest.mark.parametrize("device", [None, "", "/", "/dev/", 0, 12, [], {}])
def test_encryption_for_a_garbage_device_is_unknown_and_never_raises(monkeypatch, device):
    bridge = _load_bridge(monkeypatch)
    assert bridge._encryption_for(_TREE, device) == "unknown"
    assert bridge._md_for(_TREE, device) is None


def test_encryption_for_uses_the_first_match_when_an_md_node_repeats(monkeypatch):
    # md127 appears under EVERY member disk. The first occurrence decides — even
    # when a later copy disagrees — so the answer cannot depend on how many
    # members the array has.
    bridge = _load_bridge(monkeypatch)
    luks_first = {"blockdevices": [
        _pool_member("sdc"),
        _pool_member("sdd", md_fstype="ext4", md_fsver="1.0"),
    ]}
    assert bridge._encryption_for(luks_first, "/dev/md127") == "luks2"
    plain_first = {"blockdevices": [
        _pool_member("sdc", md_fstype="ext4", md_fsver="1.0", crypt=False),
        _pool_member("sdd"),
    ]}
    assert bridge._encryption_for(plain_first, "/dev/md127") == "none"


def test_encryption_for_does_not_mutate_the_tree(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    snapshot = copy.deepcopy(_TREE)
    for dev in ("/dev/sdb", "/dev/md127", "/dev/sde1", "/dev/nope"):
        bridge._encryption_for(_TREE, dev)
        bridge._md_for(_TREE, dev)
    assert _TREE == snapshot


# ---------------------------------------------------------------------------
# 3. _md_for — the bare md array name, or None
# ---------------------------------------------------------------------------

def test_md_for_the_array_and_everything_beneath_it(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._md_for(_TREE, "/dev/md127") == "md127"
    # The mounted filesystem of a LUKS-over-md pool is the crypt child — it is
    # beneath the array, so the array is its owner.
    assert bridge._md_for(_TREE, "/dev/mapper/droplet-bay-cafef00d") == "md127"


def test_md_for_is_none_for_a_single_disk_bay_and_plain_drives(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._md_for(_TREE, "/dev/sdb") is None
    assert bridge._md_for(_TREE, "/dev/mapper/droplet-bay-1a2b3c4d") is None
    assert bridge._md_for(_TREE, "/dev/sde1") is None
    assert bridge._md_for(_TREE, "/dev/nvme0n1p2") is None


def test_md_for_a_member_disk_is_none_the_disk_is_not_beneath_the_array(monkeypatch):
    # Direction matters: the array is a CHILD of its member disks. A member is
    # reported through classify_disks' `md`, not through this helper.
    bridge = _load_bridge(monkeypatch)
    assert bridge._md_for(_TREE, "/dev/sdc") is None


def test_md_for_a_partition_of_an_md_array(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [_disk("sda", fstype="linux_raid_member", children=[
        _node("md1", "raid1", children=[
            _node("md1p1", fstype="ext4", mountpoint="/mnt/droplet/p-1"),
        ]),
    ])]}
    assert bridge._md_for(tree, "/dev/md1p1") == "md1"


def test_md_for_a_volume_stacked_several_levels_beneath_the_array(monkeypatch):
    # md0 -> LUKS (crypt) -> LVM volume: still owned by md0, and still encrypted.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [_disk("sda", fstype="linux_raid_member", children=[
        _node("md0", "raid1", fstype="crypto_LUKS", fsver="2", children=[
            _node("cryptlvm", "crypt", fstype="LVM2_member", children=[
                _node("vg-data", "lvm", fstype="ext4", fsver="1.0",
                      mountpoint="/mnt/droplet/data-4"),
            ]),
        ]),
    ])]}
    assert bridge._md_for(tree, "/dev/mapper/vg-data") == "md0"
    assert bridge._encryption_for(tree, "/dev/mapper/vg-data") == "luks2"


def test_md_for_names_the_nearest_array_when_arrays_are_nested(monkeypatch):
    # RAID10-by-hand: md0 + md1 mirrors under an md10 stripe. The filesystem
    # sits on md10, so that is the array that owns it.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [_disk("sda", fstype="linux_raid_member", children=[
        _node("md0", "raid1", fstype="linux_raid_member", children=[
            _node("md10", "raid0", fstype="crypto_LUKS", fsver="2", children=[
                _bay_crypt("droplet-bay-ab12cd34", _POOL_MNT),
            ]),
        ]),
    ])]}
    assert bridge._md_for(tree, "/dev/mapper/droplet-bay-ab12cd34") == "md10"
    assert bridge._md_for(tree, "/dev/md0") == "md0"


@pytest.mark.parametrize("name", ["md5sums", "mdata", "md", "mdadm0", "md_d0", "xmd1"])
def test_md_for_only_md_followed_by_digits_is_an_array(monkeypatch, name):
    # A dm volume that merely STARTS with "md" is not an md array. The old
    # classifier matched on startswith("md"); the new contract is ^md\d+$.
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [_disk("sdq", children=[
        _node(name, "lvm", fstype="ext4", mountpoint="/mnt/droplet/q-1"),
    ])]}
    assert bridge._md_for(tree, "/dev/mapper/" + name) is None


# ---------------------------------------------------------------------------
# 4. drives_snapshot: `encryption` + `md` on EVERY drive entry
# ---------------------------------------------------------------------------

_STATE_PATH = "/var/lib/droplet-automount/mounts.json"

_PROC_MOUNTS = f"""\
sysfs /sys sysfs rw,nosuid 0 0
/dev/nvme0n1p2 / ext4 rw,relatime 0 0
/dev/nvme0n1p2 /mnt/droplet ext4 rw,relatime 0 0
/dev/mapper/droplet-bay-1a2b3c4d {_BAY_MNT} ext4 rw,nosuid,nodev,noatime,prjquota 0 0
/dev/mapper/droplet-bay-cafef00d {_POOL_MNT} ext4 rw,nosuid,nodev,noatime,prjquota 0 0
/dev/sde1 {_PLAIN_MNT} ext4 rw,nosuid,nodev,noatime 0 0
"""

# What the automounter records for a hot-plugged LUKS bay: `device` is the
# BACKING device, `mapper` the unlocked dm node (WARP-232).
_AUTOMOUNT_BAY = {
    "device": "/dev/sdb",
    "mount": _BAY_MNT,
    "label": "drive",
    "uuid": "9e8d7c6b-1111-4222-8333-444455556666",
    "trust": "enrolled",
    "mapper": "/dev/mapper/droplet-bay-1a2b3c4d",
}

_WHOLE_DISK = {
    "/dev/sdb": "sdb",
    "/dev/mapper/droplet-bay-1a2b3c4d": "sdb",
    "/dev/mapper/droplet-bay-cafef00d": "sdd",
    "/dev/md127": "sdd",
    "/dev/sde1": "sde",
}

_EXPECTED_ENTRY_KEYS = {
    "device", "parent_disk", "mount", "label", "uuid", "size_bytes",
    "used_bytes", "free_bytes", "mounted", "fs", "bus", "readonly", "smart",
    "temp_c", "removable", "source",
    # WARP-3513 — the only two additions.
    "encryption", "md",
}


def _stub_snapshot_host(bridge, monkeypatch, tmp_path, *, tree=_TREE,
                        proc_mounts=_PROC_MOUNTS, automount_mounts=None):
    """Make drives_snapshot hermetic: canned /proc/mounts + automount state +
    lsblk tree, no subprocess, no statvfs. Returns the list the lsblk stub
    appends to (one entry per lsblk read)."""
    mounts_file = tmp_path / "proc-mounts"
    mounts_file.write_text(proc_mounts)
    state_file = tmp_path / "automount-mounts.json"
    if automount_mounts is not None:
        state_file.write_text(json.dumps({"mounts": automount_mounts}))
    real_open = open

    def fake_open(path, *a, **kw):
        p = str(path)
        if p == "/proc/mounts":
            return real_open(mounts_file, *a, **kw)
        if p == _STATE_PATH:
            if automount_mounts is None:
                raise FileNotFoundError(p)
            return real_open(state_file, *a, **kw)
        return real_open(path, *a, **kw)

    monkeypatch.setattr(bridge, "open", fake_open, raising=False)
    monkeypatch.setattr(bridge.os.path, "ismount", lambda p: True)
    monkeypatch.setattr(bridge.os.path, "exists", lambda p: str(p).startswith("/dev/"))
    monkeypatch.setattr(bridge, "_os_disk", lambda: "nvme0n1")
    monkeypatch.setattr(bridge, "_whole_disk",
                        lambda d: "nvme0n1" if "nvme0n1" in (d or "") else _WHOLE_DISK.get(d, ""))
    monkeypatch.setattr(bridge, "_bytes_for", lambda p: (100 * GB, 10 * GB, 90 * GB))
    monkeypatch.setattr(bridge, "_bus_for", lambda d: "sata")
    monkeypatch.setattr(bridge, "_label_and_uuid_for", lambda d: ("", ""))
    reads = []

    def fake_lsblk():
        reads.append(1)
        return tree

    monkeypatch.setattr(bridge, "_lsblk_disks_json", fake_lsblk)
    return reads


def _by_mount(snap):
    return {d["mount"]: d for d in snap["drives"]}


def test_every_drive_entry_carries_encryption_and_md(tmp_path, monkeypatch):
    bridge = _load_bridge(monkeypatch)
    _stub_snapshot_host(bridge, monkeypatch, tmp_path, automount_mounts=[_AUTOMOUNT_BAY])
    snap = bridge.drives_snapshot(invalidate=True)
    drives = _by_mount(snap)
    assert set(drives) == {_BAY_MNT, _POOL_MNT, _PLAIN_MNT}
    for entry in snap["drives"]:
        assert entry["encryption"] in ("luks2", "none", "unknown")
        assert "md" in entry


def test_automount_branch_bay_is_luks2_via_its_backing_device(tmp_path, monkeypatch):
    # The automount-state entry's `device` is /dev/sdb (the container), not the
    # mapper /proc/mounts shows.
    bridge = _load_bridge(monkeypatch)
    _stub_snapshot_host(bridge, monkeypatch, tmp_path, automount_mounts=[_AUTOMOUNT_BAY])
    bay = _by_mount(bridge.drives_snapshot(invalidate=True))[_BAY_MNT]
    assert bay["source"] == "automount"
    assert bay["device"] == "/dev/sdb"
    assert bay["encryption"] == "luks2"
    assert bay["md"] is None


def test_proc_mounts_branch_pool_is_luks2_over_md(tmp_path, monkeypatch):
    # No automount entry: the /proc/mounts pass reports the MAPPER as the device.
    bridge = _load_bridge(monkeypatch)
    _stub_snapshot_host(bridge, monkeypatch, tmp_path, automount_mounts=[_AUTOMOUNT_BAY])
    pool = _by_mount(bridge.drives_snapshot(invalidate=True))[_POOL_MNT]
    assert pool["source"] == "fstab"
    assert pool["device"] == "/dev/mapper/droplet-bay-cafef00d"
    assert pool["encryption"] == "luks2"
    assert pool["md"] == "md127"


def test_proc_mounts_branch_single_disk_bay_without_automount_state(tmp_path, monkeypatch):
    # The same bay, seen only through /proc/mounts (no automount state file).
    bridge = _load_bridge(monkeypatch)
    _stub_snapshot_host(bridge, monkeypatch, tmp_path, automount_mounts=None)
    bay = _by_mount(bridge.drives_snapshot(invalidate=True))[_BAY_MNT]
    assert bay["source"] == "fstab"
    assert bay["device"] == "/dev/mapper/droplet-bay-1a2b3c4d"
    assert bay["encryption"] == "luks2"
    assert bay["md"] is None


def test_automount_entry_for_a_pool_backing_device_reports_md(tmp_path, monkeypatch):
    # A pool the automounter tracks: device = the md array (the LUKS container),
    # mapper = the unlocked node.
    bridge = _load_bridge(monkeypatch)
    pool_entry = {
        "device": "/dev/md127", "mount": _POOL_MNT, "label": "pool",
        "uuid": "3c4d5e6f-1111-4222-8333-444455556666", "trust": "enrolled",
        "mapper": "/dev/mapper/droplet-bay-cafef00d",
    }
    _stub_snapshot_host(bridge, monkeypatch, tmp_path, automount_mounts=[pool_entry])
    pool = _by_mount(bridge.drives_snapshot(invalidate=True))[_POOL_MNT]
    assert pool["source"] == "automount"
    assert pool["device"] == "/dev/md127"
    assert pool["encryption"] == "luks2"
    assert pool["md"] == "md127"


def test_plain_drive_is_none_with_no_md(tmp_path, monkeypatch):
    bridge = _load_bridge(monkeypatch)
    _stub_snapshot_host(bridge, monkeypatch, tmp_path, automount_mounts=[_AUTOMOUNT_BAY])
    plain = _by_mount(bridge.drives_snapshot(invalidate=True))[_PLAIN_MNT]
    assert plain["encryption"] == "none"
    assert plain["md"] is None


def test_unreadable_lsblk_marks_every_entry_unknown_not_none(tmp_path, monkeypatch):
    # "unknown" is the honest answer when lsblk could not be read. Reporting
    # "none" there would call an encrypted bay plaintext (and the reverse would
    # be worse).
    bridge = _load_bridge(monkeypatch)
    _stub_snapshot_host(bridge, monkeypatch, tmp_path, tree=None,
                        automount_mounts=[_AUTOMOUNT_BAY])
    snap = bridge.drives_snapshot(invalidate=True)
    assert snap["drives"], "mounted drives must still be listed without lsblk"
    for entry in snap["drives"]:
        assert entry["encryption"] == "unknown"
        assert entry["md"] is None
    assert snap["disks"] == []


def test_snapshot_reuses_the_single_lsblk_read(tmp_path, monkeypatch):
    # The annotation must ride the tree classify_disks/system_disk_info already
    # use — a second lsblk per snapshot doubles the cost of a 10 s poll.
    bridge = _load_bridge(monkeypatch)
    reads = _stub_snapshot_host(bridge, monkeypatch, tmp_path,
                                automount_mounts=[_AUTOMOUNT_BAY])
    bridge.drives_snapshot(invalidate=True)
    assert len(reads) == 1


def test_snapshot_change_is_additive_only(tmp_path, monkeypatch):
    # No key removed or renamed, no value changed: older orchestrators keep
    # working. The only difference is the two new keys on each drive entry.
    bridge = _load_bridge(monkeypatch)
    _stub_snapshot_host(bridge, monkeypatch, tmp_path, automount_mounts=[_AUTOMOUNT_BAY])
    snap = bridge.drives_snapshot(invalidate=True)
    for entry in snap["drives"]:
        assert set(entry) == _EXPECTED_ENTRY_KEYS
    assert {"drives", "count", "os_disk", "disks", "snapshot_at"} <= set(snap)
    assert snap["count"] == len(snap["drives"]) == 3
    assert snap["os_disk"] == "nvme0n1"
    bay = _by_mount(snap)[_BAY_MNT]
    assert (bay["label"], bay["uuid"], bay["fs"], bay["readonly"], bay["removable"]) == (
        "drive", "9e8d7c6b-1111-4222-8333-444455556666", "ext4", False, True)


def test_snapshot_disks_carry_encryption_too(tmp_path, monkeypatch):
    # The whole-disk inventory gains `encryption` on every entry (item 4b), and
    # the LUKS-over-md members stay pool members although the mounted node is
    # the crypt child of the array (item 5).
    bridge = _load_bridge(monkeypatch)
    _stub_snapshot_host(bridge, monkeypatch, tmp_path, automount_mounts=[_AUTOMOUNT_BAY])
    disks = {d["name"]: d for d in bridge.drives_snapshot(invalidate=True)["disks"]}
    assert set(disks) == {"sdb", "sdc", "sdd", "sde"}
    assert disks["sdb"]["state"] == "in_use" and disks["sdb"]["encryption"] == "luks2"
    assert disks["sde"]["state"] == "in_use" and disks["sde"]["encryption"] == "none"
    for member in ("sdc", "sdd"):
        assert disks[member]["state"] == "pool_member"
        assert disks[member]["md"] == "md127"
        assert disks[member]["md_mounted"] is True
        assert disks[member]["encryption"] == "luks2"


# ---------------------------------------------------------------------------
# 7. eject_drive: a LUKS bay mounts through its MAPPER, the state records the
#    BACKING device — the guard must accept either, and nothing else.
# ---------------------------------------------------------------------------

_BAY_MAPPER = "/dev/mapper/droplet-bay-1a2b3c4d"


def _stub_eject_host(bridge, monkeypatch, tmp_path, *, state_mounts, mounted,
                     aliases=None, proc_mounts=None):
    """Hermetic eject_drive. `mounted` is {mountpoint: device} as /proc/mounts
    reports it; `aliases` maps a path to the realpath the kernel would resolve it
    to (e.g. /dev/mapper/x -> /dev/dm-3). With `proc_mounts` (text) the REAL
    _device_at_mountpoint reads it instead of being stubbed from `mounted`.
    Returns (state_file, commands_run, snapshot_calls)."""
    aliases = aliases or {}
    state_file = tmp_path / "mounts.json"
    state_file.write_text(json.dumps({"mounts": state_mounts}))
    tmp_state = tmp_path / "mounts.json.tmp"
    real_open, real_replace = open, os.replace

    proc_mounts_file = tmp_path / "proc-mounts-eject"
    if proc_mounts is not None:
        proc_mounts_file.write_text(proc_mounts)

    def fake_open(path, *a, **kw):
        p = str(path)
        if p == _STATE_PATH:
            return real_open(state_file, *a, **kw)
        if p == _STATE_PATH + ".tmp":
            return real_open(tmp_state, *a, **kw)
        if p == "/proc/mounts" and proc_mounts is not None:
            return real_open(proc_mounts_file, *a, **kw)
        return real_open(path, *a, **kw)

    def fake_replace(src, dst, *a, **kw):
        if str(dst) == _STATE_PATH:
            return real_replace(tmp_state, state_file)
        return real_replace(src, dst, *a, **kw)

    monkeypatch.setattr(bridge, "open", fake_open, raising=False)
    monkeypatch.setattr(bridge.os, "replace", fake_replace)
    monkeypatch.setattr(bridge.os.path, "realpath", lambda p: aliases.get(p, p))
    monkeypatch.setattr(bridge.os.path, "ismount", lambda p: p in mounted)
    if proc_mounts is None:
        monkeypatch.setattr(bridge, "_device_at_mountpoint", lambda mp: mounted.get(mp))
    ran = []

    def fake_run(cmd, timeout=15):
        ran.append(list(cmd))
        return 0, "", ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    snapshots = []
    monkeypatch.setattr(bridge, "drives_snapshot",
                        lambda invalidate=False: snapshots.append(invalidate) or {})
    return state_file, ran, snapshots


def _umounts(ran):
    return [c for c in ran if c and c[0] == "umount"]


def test_eject_accepts_a_luks_bay_mounted_through_its_mapper(tmp_path, monkeypatch):
    # The regression: entry.device is /dev/sdb, the kernel has the MAPPER at the
    # mount point, so the old guard refused every bay eject as a "mismatch".
    bridge = _load_bridge(monkeypatch)
    state_file, ran, snapshots = _stub_eject_host(
        bridge, monkeypatch, tmp_path,
        state_mounts=[_AUTOMOUNT_BAY],
        mounted={_BAY_MNT: _BAY_MAPPER})
    ok, info = bridge.eject_drive(_AUTOMOUNT_BAY["uuid"])
    assert ok is True, info
    assert info == {"ejected": _AUTOMOUNT_BAY["uuid"], "mount": _BAY_MNT}
    assert _umounts(ran) == [["umount", _BAY_MNT]]
    # forgotten from the automount state + snapshot invalidated
    assert json.loads(state_file.read_text())["mounts"] == []
    assert snapshots == [True]


def test_eject_reads_the_mapper_from_a_real_proc_mounts_line(tmp_path, monkeypatch):
    # End to end through the REAL _device_at_mountpoint: the kernel's own
    # /proc/mounts line names the mapper (octal-escaped path and all).
    bridge = _load_bridge(monkeypatch)
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path,
        state_mounts=[_AUTOMOUNT_BAY],
        mounted={_BAY_MNT: _BAY_MAPPER},
        proc_mounts=(
            "sysfs /sys sysfs rw,nosuid 0 0\n"
            f"{_BAY_MAPPER} {_BAY_MNT} ext4 rw,nosuid,nodev,noatime,prjquota 0 0\n"))
    ok, info = bridge.eject_drive(_AUTOMOUNT_BAY["uuid"])
    assert ok is True, info
    assert _umounts(ran) == [["umount", _BAY_MNT]]


def test_eject_refuses_when_proc_mounts_names_another_device(tmp_path, monkeypatch):
    bridge = _load_bridge(monkeypatch)
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path,
        state_mounts=[_AUTOMOUNT_BAY],
        mounted={_BAY_MNT: "/dev/sdz1"},
        proc_mounts=f"/dev/sdz1 {_BAY_MNT} ext4 rw,noatime 0 0\n")
    ok, info = bridge.eject_drive(_AUTOMOUNT_BAY["uuid"])
    assert ok is False and "mismatch" in info
    assert ran == []


def test_eject_compares_realpaths_for_the_mapper(tmp_path, monkeypatch):
    # /proc/mounts may print /dev/dm-3 where the state recorded the
    # /dev/mapper/ symlink for the same node.
    bridge = _load_bridge(monkeypatch)
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path,
        state_mounts=[_AUTOMOUNT_BAY],
        mounted={_BAY_MNT: "/dev/dm-3"},
        aliases={_BAY_MAPPER: "/dev/dm-3"})
    ok, info = bridge.eject_drive(_AUTOMOUNT_BAY["uuid"])
    assert ok is True, info
    assert len(_umounts(ran)) == 1


def test_eject_still_accepts_the_backing_device_for_a_bay(tmp_path, monkeypatch):
    # Either recorded device is acceptable — including the original `device`.
    bridge = _load_bridge(monkeypatch)
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path,
        state_mounts=[_AUTOMOUNT_BAY],
        mounted={_BAY_MNT: "/dev/sdb"})
    ok, _info = bridge.eject_drive(_AUTOMOUNT_BAY["uuid"])
    assert ok is True
    assert len(_umounts(ran)) == 1


def test_eject_refuses_when_neither_recorded_device_is_what_is_mounted(tmp_path, monkeypatch):
    # The guard exists so a stale/poisoned entry cannot redirect the umount to a
    # mount point that now hosts something else. Accepting the mapper must not
    # weaken that: the kernel's device has to be one of the entry's OWN two.
    bridge = _load_bridge(monkeypatch)
    state_file, ran, snapshots = _stub_eject_host(
        bridge, monkeypatch, tmp_path,
        state_mounts=[_AUTOMOUNT_BAY],
        mounted={_BAY_MNT: "/dev/mapper/droplet-bay-ffffffff"})
    ok, info = bridge.eject_drive(_AUTOMOUNT_BAY["uuid"])
    assert ok is False
    assert "mismatch" in info
    assert _umounts(ran) == [], "nothing may be unmounted on a mismatch"
    assert ran == [], "not even a sync"
    assert [m["uuid"] for m in json.loads(state_file.read_text())["mounts"]] == [
        _AUTOMOUNT_BAY["uuid"]]
    assert snapshots == []


def test_eject_refuses_a_plain_device_mismatch_when_a_mapper_is_recorded(tmp_path, monkeypatch):
    # The entry's device is /dev/sdb (+ mapper), but the kernel has a DIFFERENT
    # drive's partition at that mount point.
    bridge = _load_bridge(monkeypatch)
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path,
        state_mounts=[_AUTOMOUNT_BAY],
        mounted={_BAY_MNT: "/dev/sdc1"})
    ok, info = bridge.eject_drive(_AUTOMOUNT_BAY["uuid"])
    assert ok is False and "mismatch" in info
    assert _umounts(ran) == []


_PLAIN_USB = {
    "device": "/dev/sdc1", "mount": "/mnt/droplet/usb-aaaa1111", "label": "usb",
    "uuid": "aaaa1111-0000-4000-8000-000000000000", "trust": "trusted",
}


def test_eject_plain_drive_behaviour_is_unchanged(tmp_path, monkeypatch):
    bridge = _load_bridge(monkeypatch)
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path, state_mounts=[_PLAIN_USB],
        mounted={_PLAIN_USB["mount"]: "/dev/sdc1"})
    ok, info = bridge.eject_drive(_PLAIN_USB["uuid"])
    assert ok is True, info
    assert _umounts(ran) == [["umount", _PLAIN_USB["mount"]]]


def test_eject_plain_drive_mismatch_still_refuses(tmp_path, monkeypatch):
    # No mapper recorded: the entry's `device` is the only accepted answer.
    bridge = _load_bridge(monkeypatch)
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path, state_mounts=[_PLAIN_USB],
        mounted={_PLAIN_USB["mount"]: "/dev/sdd1"})
    ok, info = bridge.eject_drive(_PLAIN_USB["uuid"])
    assert ok is False and "mismatch" in info
    assert _umounts(ran) == []


def test_eject_guard_is_skipped_only_when_the_kernel_view_is_unknown(tmp_path, monkeypatch):
    # Unchanged semantics: when /proc/mounts has no line for the mount point
    # (actual_dev is None) the existing guard does not block. Pinned so the
    # mapper change cannot turn "unknown" into a refusal or an accept-anything.
    bridge = _load_bridge(monkeypatch)
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path, state_mounts=[_AUTOMOUNT_BAY],
        mounted={_BAY_MNT: None})  # a mount point the kernel lists no device for
    ok, _info = bridge.eject_drive(_AUTOMOUNT_BAY["uuid"])
    assert ok is True
    assert len(_umounts(ran)) == 1


def test_eject_without_a_recorded_device_or_mapper_is_unchanged(tmp_path, monkeypatch):
    # An entry that records neither (legacy/odd state) was never guarded by the
    # device check; adding the mapper must not start refusing it.
    bridge = _load_bridge(monkeypatch)
    legacy = {k: v for k, v in _PLAIN_USB.items() if k != "device"}
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path, state_mounts=[legacy],
        mounted={legacy["mount"]: "/dev/sdc1"})
    ok, _info = bridge.eject_drive(legacy["uuid"])
    assert ok is True
    assert len(_umounts(ran)) == 1


def test_eject_still_refuses_a_mount_outside_the_droplet_tree(tmp_path, monkeypatch):
    # A poisoned entry pointing outside /mnt/droplet is refused before the
    # device guard is even consulted.
    bridge = _load_bridge(monkeypatch)
    poisoned = dict(_AUTOMOUNT_BAY, mount="/etc")
    _state, ran, _snap = _stub_eject_host(
        bridge, monkeypatch, tmp_path, state_mounts=[poisoned],
        mounted={"/etc": _BAY_MAPPER})
    ok, info = bridge.eject_drive(_AUTOMOUNT_BAY["uuid"])
    assert ok is False and "non-/mnt/droplet" in info
    assert ran == []
