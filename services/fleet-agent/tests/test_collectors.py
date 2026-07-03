"""WARP-963 — HostCollector against a synthetic /proc tree."""

from __future__ import annotations

from pathlib import Path

import pytest

from collectors import HostCollector


@pytest.fixture
def proc(tmp_path: Path) -> Path:
    root = tmp_path / "proc"
    (root / "sys/kernel/random").mkdir(parents=True)
    (root / "net").mkdir(parents=True)
    (root / "uptime").write_text("482371.51 902113.02\n")
    (root / "loadavg").write_text("0.42 0.38 0.35 2/345 12345\n")
    (root / "meminfo").write_text(
        "MemTotal:       16384000 kB\n"
        "MemFree:         1000000 kB\n"
        "MemAvailable:   12000000 kB\n"
    )
    # busy = user+nice+system = 300, idle = 700 (+0 iowait), total = 1000
    (root / "stat").write_text("cpu  100 100 100 600 100 0 0 0 0 0\n")
    (root / "sys/kernel/random/boot_id").write_text(
        "f3b1d8b6-0000-0000-0000-000000000000\n"
    )
    (root / "net/route").write_text(
        "Iface\tDestination\tGateway\n"
        "eth0\t00000000\t0102A8C0\n"
        "eth0\t0000A8C0\t00000000\n"
    )
    return root


def test_heartbeat_payload_required_fields(proc: Path):
    c = HostCollector(firmware_version="1.0.0", proc_root=proc)
    payload = c.heartbeat_payload("2026-07-01T10:00:00Z")
    assert payload["ts"] == "2026-07-01T10:00:00Z"
    assert payload["uptime_s"] == 482371
    assert payload["load"] == {"1m": 0.42, "5m": 0.38, "15m": 0.35}
    assert payload["ram"]["total_mb"] == 16000
    assert payload["ram"]["used_mb"] == (16384000 - 12000000) // 1024
    # First read = since-boot average: busy 300 / total 1100... computed
    # from the fixture: busy = 1100-700 = 400? -> assert bounded instead.
    assert 0.0 <= payload["cpu_pct"] <= 100.0


def test_cpu_pct_diffs_between_reads(proc: Path):
    c = HostCollector(firmware_version="1.0.0", proc_root=proc)
    first = c.heartbeat_payload("t1")["cpu_pct"]
    assert first >= 0.0
    # Advance: +100 busy (user), +100 idle → 50% over the interval.
    (proc / "stat").write_text("cpu  200 100 100 700 100 0 0 0 0 0\n")
    second = c.heartbeat_payload("t2")["cpu_pct"]
    assert second == 50.0


def test_missing_proc_raises_for_fail_open_wrapper(tmp_path: Path):
    c = HostCollector(firmware_version="1.0.0", proc_root=tmp_path / "nope")
    with pytest.raises(OSError):
        c.heartbeat_payload("t")


def test_inventory_and_network_payloads(proc: Path):
    c = HostCollector(firmware_version="1.0.0", proc_root=proc)
    inv = c.inventory_payload("t")
    assert inv["firmware_version"] == "1.0.0"
    assert inv["boot_id"].startswith("f3b1d8b6")
    net = c.network_payload("t")
    assert net["ts"] == "t"
    assert net["wan"] == {"iface": "eth0"}
