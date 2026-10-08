"""SMART facts are explicit, read-only and tied to one physical disk.

No test invokes smartctl, touches host disks, or changes their SMART settings.
The exit mask is not a success/failure code: bit 3 reports failed health, while
bits 0..2 report command/open/read failures.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest


_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"
_UNSUPPORTED = "SMART support is: Unavailable - device lacks SMART capability."


def _load_bridge(monkeypatch, enabled=True):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    monkeypatch.setenv("DRIVE_SMART_ENABLED", "true" if enabled else "false")
    spec = importlib.util.spec_from_file_location("device_bridge_smart_test", _BRIDGE_PATH)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    return bridge


def _payload(passed=True, temp=34, rc=0, **extra):
    return {"smartctl": {"exit_status": rc}, "smart_status": {"passed": passed},
            "temperature": {"current": temp}, **extra}


def _read(monkeypatch, bridge, data, rc=0):
    calls = []

    def fake_run(cmd, timeout):
        calls.append((cmd, timeout))
        return rc, json.dumps(data), ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    return calls


def test_command_failure_does_not_report_passed_health(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    _read(monkeypatch, bridge, _payload(rc=2), rc=2)
    # Regression: the old parser ignored rc and accepted this partial output.
    assert bridge._smart_for("/dev/sdb")[0] is None


@pytest.mark.parametrize("rc", [1, 2, 4, 5, 6, 7, 12, -1, 256])
def test_read_failures_are_unavailable_even_with_partial_json(monkeypatch, rc):
    bridge = _load_bridge(monkeypatch)
    _read(monkeypatch, bridge, _payload(rc=rc), rc=rc)
    assert bridge._smart_for("/dev/sdb") == (None, None, "unavailable")


def test_disabled_never_probes_or_reuses_cached_health(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    calls = _read(monkeypatch, bridge, _payload())
    assert bridge._smart_for("/dev/sdb") == ("PASSED", 34, "available")
    monkeypatch.setattr(bridge, "SMART_ENABLED", False)
    assert bridge._smart_for("/dev/sdb") == (None, None, "disabled")
    assert len(calls) == 1


def test_disabled_is_the_import_default(monkeypatch):
    monkeypatch.delenv("DRIVE_SMART_ENABLED", raising=False)
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    spec = importlib.util.spec_from_file_location("device_bridge_smart_default", _BRIDGE_PATH)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    assert bridge.SMART_ENABLED is False
    assert bridge._smart_for("/dev/sdb") == (None, None, "disabled")


@pytest.mark.parametrize("passed,rc,health", [(True, 0, "PASSED"), (False, 8, "FAILED"),
                                             (False, 24, "FAILED"), (True, 64, "PASSED")])
def test_health_boolean_survives_device_health_exit_bits(monkeypatch, passed, rc, health):
    bridge = _load_bridge(monkeypatch)
    calls = _read(monkeypatch, bridge, _payload(passed=passed, rc=rc), rc=rc)
    assert bridge._smart_for("/dev/sdb") == (health, 34, "available")
    assert calls == [(["smartctl", "-j=o", "-H", "-A", "/dev/sdb"], 8)]


@pytest.mark.parametrize("data", [{}, [], None, {"smart_status": {}},
                                 {"smart_status": {"passed": "true"}},
                                 {"smart_status": {"passed": 1}}])
def test_process_success_without_health_or_measurement_is_unavailable(monkeypatch, data):
    bridge = _load_bridge(monkeypatch)
    _read(monkeypatch, bridge, data)
    assert bridge._smart_for("/dev/sdb") == (None, None, "unavailable")


@pytest.mark.parametrize("status", [None, {}, {"passed": "true"}])
def test_successful_temperature_only_read_keeps_health_unknown(monkeypatch, status):
    bridge = _load_bridge(monkeypatch)
    data = {"temperature": {"current": 34}}
    if status is not None:
        data["smart_status"] = status
    _read(monkeypatch, bridge, data)
    assert bridge._smart_for("/dev/sdb") == (None, 34, "available")


@pytest.mark.parametrize("temp", [None, 34])
@pytest.mark.parametrize("rc", [8, 24])
def test_failed_health_exit_bit_is_not_lost_when_json_omits_verdict(monkeypatch, temp, rc):
    bridge = _load_bridge(monkeypatch)
    data = {"smartctl": {"exit_status": rc}}
    if temp is not None:
        data["temperature"] = {"current": temp}
    _read(monkeypatch, bridge, data, rc=rc)
    assert bridge._smart_for("/dev/sdb") == ("FAILED", temp, "available")


@pytest.mark.parametrize("rc", [1, 2, 4])
def test_error_with_temperature_only_output_is_still_unavailable(monkeypatch, rc):
    bridge = _load_bridge(monkeypatch)
    _read(monkeypatch, bridge, {"temperature": {"current": 34}}, rc=rc)
    assert bridge._smart_for("/dev/sdb") == (None, None, "unavailable")


@pytest.mark.parametrize("rc", [0, 4])
def test_only_affirmative_lack_of_hardware_capability_is_unsupported(monkeypatch, rc):
    bridge = _load_bridge(monkeypatch)
    data = {"smartctl": {"exit_status": rc, "output": [_UNSUPPORTED]},
            "smart_support": {"available": False}}
    _read(monkeypatch, bridge, data, rc=rc)
    assert bridge._smart_for("/dev/sdb") == (None, None, "unsupported")


@pytest.mark.parametrize("data,rc", [
    ({"smart_support": {"available": False}}, 0),
    ({"smart_support": {"available": False}, "smartctl": {"output": [
        "SMART support is: Unknown - Try option -s with argument 'on' to enable it."]}}, 4),
    ({"smart_support": {"available": True, "enabled": False}}, 0),
    ({"smart_support": {"available": False}, "smartctl": {"output": [_UNSUPPORTED]}}, 2),
])
def test_unknown_disabled_hardware_and_open_errors_are_not_unsupported(monkeypatch, data, rc):
    bridge = _load_bridge(monkeypatch)
    _read(monkeypatch, bridge, data, rc=rc)
    assert bridge._smart_for("/dev/sdb") == (None, None, "unavailable")


@pytest.mark.parametrize("temp", [True, False, -3, 0, 120, "34", None, 34.5])
def test_malformed_temperature_does_not_become_a_measurement(monkeypatch, temp):
    bridge = _load_bridge(monkeypatch)
    _read(monkeypatch, bridge, _payload(temp=temp))
    assert bridge._smart_for("/dev/sdb") == ("PASSED", None, "available")


@pytest.mark.parametrize("data,rc", [(_payload(rc=0), 8), (_payload(rc=8), 0),
                                    (_payload(passed=True, rc=8), 8)])
def test_inconsistent_health_or_exit_status_is_unavailable(monkeypatch, data, rc):
    bridge = _load_bridge(monkeypatch)
    _read(monkeypatch, bridge, data, rc=rc)
    assert bridge._smart_for("/dev/sdb") == (None, None, "unavailable")


@pytest.mark.parametrize("failure", ["malformed", "missing", "timeout", "permission"])
def test_probe_failures_are_cached_as_unavailable(monkeypatch, failure):
    bridge = _load_bridge(monkeypatch)
    calls = []

    def fake_run(cmd, timeout):
        calls.append(cmd)
        if failure == "missing":
            raise FileNotFoundError("smartctl")
        if failure == "timeout":
            raise subprocess.TimeoutExpired(cmd, timeout)
        if failure == "permission":
            return 2, "", "Permission denied"
        return 0, "not json", ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    for _ in range(2):
        assert bridge._smart_for("/dev/sdb") == (None, None, "unavailable")
    assert len(calls) == 1


def test_health_temperature_and_status_share_the_five_minute_cache(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    clock = [1000]
    monkeypatch.setattr(bridge.time, "time", lambda: clock[0])
    calls = _read(monkeypatch, bridge, _payload())
    assert bridge._smart_for("/dev/sdb") == ("PASSED", 34, "available")
    clock[0] += 299
    assert bridge._smart_for("/dev/sdb") == ("PASSED", 34, "available")
    assert len(calls) == 1
    _read(monkeypatch, bridge, _payload(passed=False, temp=42, rc=8), rc=8)
    clock[0] += 1
    assert bridge._smart_for("/dev/sdb") == ("FAILED", 42, "available")


def _disk(name, children=None):
    return {"name": name, "type": "disk", "children": children or []}


def test_partition_and_encrypted_mount_resolve_the_same_physical_target(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    tree = {"blockdevices": [_disk("sdb", [{"name": "sdb1", "type": "part", "children": [
        {"name": "droplet-bay-abc", "type": "crypt"}]}])]}
    assert bridge._smart_target(tree, "/dev/sdb1") == "/dev/sdb"
    assert bridge._smart_target(tree, "/dev/mapper/droplet-bay-abc") == "/dev/sdb"
    assert bridge._smart_target(tree, "/dev/sdb") == "/dev/sdb"


def test_raid_and_multiple_disk_lvm_do_not_choose_an_arbitrary_member(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    raid = {"name": "md127", "type": "raid1", "children": [
        {"name": "droplet-pool-abc", "type": "crypt"}]}
    tree = {"blockdevices": [_disk("sdb", [raid]), _disk("sdc", [raid])]}
    assert bridge._smart_target(tree, "/dev/md127") is None
    assert bridge._smart_target(tree, "/dev/mapper/droplet-pool-abc") is None
    lvm = {"name": "data-lv", "type": "lvm"}
    tree = {"blockdevices": [_disk("sdb", [lvm]), _disk("sdc", [lvm])]}
    assert bridge._smart_target(tree, "/dev/mapper/data-lv") is None


@pytest.mark.parametrize("tree,device", [(None, "/dev/sdb"), ({}, "/dev/sdb"),
                                       ({"blockdevices": []}, "/dev/sdb"),
                                       ({"blockdevices": [_disk("sdb")]}, "/dev/missing")])
def test_unverified_topology_does_not_probe_a_device_name_guess(monkeypatch, tree, device):
    bridge = _load_bridge(monkeypatch)
    assert bridge._smart_target(tree, device) is None


@pytest.mark.parametrize("enabled", [True, False])
def test_every_snapshot_drive_has_status_and_uses_physical_disk_reads(monkeypatch, enabled):
    bridge = _load_bridge(monkeypatch, enabled=enabled)
    mounts = "/dev/mapper/droplet-bay-abc /mnt/droplet/bay ext4 rw 0 0\n"
    state = {"mounts": [{"device": "/dev/sdc1", "mount": "/mnt/droplet/usb", "uuid": "u"}]}
    tree = {"blockdevices": [
        _disk("sdb", [{"name": "droplet-bay-abc", "type": "crypt"}]),
        _disk("sdc", [{"name": "sdc1", "type": "part"}]),
    ]}
    from io import StringIO

    def fake_open(path, *args, **kwargs):
        if path == "/proc/mounts":
            return StringIO(mounts)
        if path == "/var/lib/droplet-automount/mounts.json":
            return StringIO(json.dumps(state))
        raise FileNotFoundError(path)

    monkeypatch.setattr(bridge, "open", fake_open, raising=False)
    monkeypatch.setattr(bridge.os.path, "ismount", lambda _: True)
    monkeypatch.setattr(bridge.os.path, "exists", lambda _: True)
    monkeypatch.setattr(bridge, "_os_disk", lambda: "")
    monkeypatch.setattr(bridge, "_whole_disk", lambda dev: "sdc" if dev == "/dev/sdc1" else "sdb")
    monkeypatch.setattr(bridge, "_bytes_for", lambda _: (100_000_000_000, 20_000_000_000, 80_000_000_000))
    monkeypatch.setattr(bridge, "_bus_for", lambda _: "sata")
    monkeypatch.setattr(bridge, "_label_and_uuid_for", lambda _: ("", "b"))
    monkeypatch.setattr(bridge, "_lsblk_disks_json", lambda: tree)
    monkeypatch.setattr(bridge, "_os_disk_filesystems", lambda *_: ([], True))
    monkeypatch.setattr(bridge, "system_disk_info", lambda *_args, **_kwargs: None)
    calls = _read(monkeypatch, bridge, _payload())
    drives = bridge.drives_snapshot(invalidate=True)["drives"]
    assert len(drives) == 2
    assert {d["smart_status"] for d in drives} == {"available" if enabled else "disabled"}
    assert {d["smart"] for d in drives} == {"PASSED" if enabled else None}
    assert {cmd[-1] for cmd, _timeout in calls} == ({"/dev/sdb", "/dev/sdc"} if enabled else set())
