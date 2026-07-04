"""Unit tests for device-bridge.py's read-only storage-pool path (BUG-3).

The bridge's `GET /pools` parses `/proc/mdstat` (+ `mdadm --detail --scan`)
read-only and maps raw md state strings onto the ADR-019 explicit enums
(PoolStatus / ArrayLevel). It NEVER mutates an array — that lives behind the
auth-gated destructive POST exercised in test_device_bridge_pool_ops.py.

Same harness as test_device_bridge.py: load device-bridge.py fresh via
importlib with a seeded env, and monkeypatch at the `_run` / file-read
boundary so no real mdadm or /proc/mdstat on the host is ever touched.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location("device_bridge_pools_under_test",
                                                  _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# A healthy RAID1 mirror + a degraded RAID5 (one disk missing: [U_U]).
_MDSTAT_HEALTHY_AND_DEGRADED = """Personalities : [raid1] [raid6] [raid5] [raid4]
md0 : active raid1 sdb[1] sda[0]
      1953382464 blocks super 1.2 [2/2] [UU]

md1 : active raid5 sdc[0] sde[2] sdd[1]
      3906764928 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [U_U]

unused devices: <none>
"""

_MDSTAT_RESYNCING = """Personalities : [raid1]
md0 : active raid1 sdb[1] sda[0]
      1953382464 blocks super 1.2 [2/2] [UU]
      [=>...................]  resync = 5.0% (97000000/1953382464) finish=120.0min speed=100000K/sec

unused devices: <none>
"""

_MDSTAT_EMPTY = """Personalities : [raid1] [raid6] [raid5] [raid4]
unused devices: <none>
"""

# The live .87 shape (WARP-936): a freshly-created array that has never been
# written sits "active (auto-read-only)" with resync=PENDING. The
# parenthesised state annotation lives BETWEEN the md state and the raid
# token on the header line and must never be parsed as a member disk.
_MDSTAT_AUTO_READ_ONLY = """Personalities : [raid1]
md127 : active (auto-read-only) raid1 sdb[1] sda[0]
      1953382464 blocks super 1.2 [2/2] [UU]
      \tresync=PENDING

unused devices: <none>
"""


# ---------------------------------------------------------------------------
# Status mapping (raw md tokens -> ADR-019 PoolStatus enum)
# ---------------------------------------------------------------------------

def test_status_mapping_active_clean(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # A fully-up array ([UU], no resync) is `active`.
    assert bridge._pool_status_from_md("active", "[UU]", resyncing=False) == "active"


def test_status_mapping_degraded(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # A missing member ([U_U]) is `degraded` even while md reports "active".
    assert bridge._pool_status_from_md("active", "[U_U]", resyncing=False) == "degraded"


def test_status_mapping_resyncing_takes_precedence(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # Mid-rebuild is `resyncing` regardless of the [U_U] degraded marker.
    assert bridge._pool_status_from_md("active", "[U_U]", resyncing=True) == "resyncing"


def test_status_mapping_failed(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # md reports the array inactive/failed -> `failed`.
    assert bridge._pool_status_from_md("inactive", "", resyncing=False) == "failed"


def test_status_value_is_always_a_known_enum(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    known = {"active", "degraded", "resyncing", "failed", "none"}
    for state in ("active", "inactive", "clean", "", "weird-unknown-token"):
        assert bridge._pool_status_from_md(state, "[UU]", resyncing=False) in known


# ---------------------------------------------------------------------------
# Level mapping (raw md token -> ADR-019 ArrayLevel enum)
# ---------------------------------------------------------------------------

def test_level_mapping(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._array_level_from_md("raid1") == "raid1"
    assert bridge._array_level_from_md("raid5") == "raid5"
    assert bridge._array_level_from_md("raid10") == "raid10"
    # md calls JBOD/concat "linear"; we normalise to the enum's `jbod`.
    assert bridge._array_level_from_md("linear") == "jbod"


# ---------------------------------------------------------------------------
# /proc/mdstat parsing
# ---------------------------------------------------------------------------

def test_parse_mdstat_healthy_and_degraded(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    pools = bridge._parse_mdstat(_MDSTAT_HEALTHY_AND_DEGRADED)
    by_dev = {p["device"]: p for p in pools}
    assert set(by_dev) == {"md0", "md1"}

    md0 = by_dev["md0"]
    assert md0["level"] == "raid1"
    assert md0["status"] == "active"
    assert sorted(md0["members"]) == ["sda", "sdb"]

    md1 = by_dev["md1"]
    assert md1["level"] == "raid5"
    # [U_U] -> one member down -> degraded.
    assert md1["status"] == "degraded"
    assert sorted(md1["members"]) == ["sdc", "sdd", "sde"]


def test_parse_mdstat_resyncing(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    pools = bridge._parse_mdstat(_MDSTAT_RESYNCING)
    assert len(pools) == 1
    assert pools[0]["status"] == "resyncing"


def test_parse_mdstat_empty_returns_no_pools(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._parse_mdstat(_MDSTAT_EMPTY) == []


def test_parse_mdstat_auto_read_only_annotation_is_not_a_member(monkeypatch):
    """WARP-936: the live box's /pools returned members
    ["(auto-read-only)", "sdb", "sda"] because the parser appended any
    header token that didn't start with "raid". Parenthesised state
    annotations are never member disks."""
    bridge = _load_bridge(monkeypatch)
    pools = bridge._parse_mdstat(_MDSTAT_AUTO_READ_ONLY)
    assert len(pools) == 1
    md127 = pools[0]
    assert md127["device"] == "md127"
    assert md127["level"] == "raid1"
    assert sorted(md127["members"]) == ["sda", "sdb"]
    assert "(auto-read-only)" not in md127["members"]


# ---------------------------------------------------------------------------
# pools_snapshot() — the read-only endpoint payload
# ---------------------------------------------------------------------------

def test_pools_snapshot_reads_mdstat(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # Feed the parser our fixture instead of the host's real /proc/mdstat.
    monkeypatch.setattr(bridge, "_read_mdstat",
                        lambda: _MDSTAT_HEALTHY_AND_DEGRADED)
    snap = bridge.pools_snapshot()
    assert snap["count"] == 2
    assert {p["device"] for p in snap["pools"]} == {"md0", "md1"}
    assert "snapshot_at" in snap


def test_pools_snapshot_honest_empty_when_no_array(monkeypatch):
    """The owner's constraint at the read layer: NO fake pool is ever
    synthesised. When md has no arrays, the bridge returns an empty list —
    never a sum of loose drives."""
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_read_mdstat", lambda: _MDSTAT_EMPTY)
    snap = bridge.pools_snapshot()
    assert snap["pools"] == []
    assert snap["count"] == 0


def test_pools_snapshot_no_mdstat_file_is_empty_not_error(monkeypatch):
    # A host without md (no /proc/mdstat) must degrade to "no pools", not raise.
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_read_mdstat", lambda: None)
    snap = bridge.pools_snapshot()
    assert snap["pools"] == []
    assert snap["count"] == 0
