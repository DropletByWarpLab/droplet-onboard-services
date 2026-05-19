"""ops.system — psutil-backed snapshot wrappers.

These talk to the real psutil so they double as smoke tests on the
runtime platform. They make NO assertions about absolute values
(every machine differs) — only about shape, types, and obvious
sanity (e.g. memory.used <= memory.total).
"""
from __future__ import annotations

import time

import pytest

from ops import system as sys_mod


class TestSnapshot:

    def test_returns_dataclass(self):
        snap = sys_mod.snapshot()
        assert isinstance(snap, sys_mod.SystemSnapshot)

    def test_timestamp_is_recent(self):
        snap = sys_mod.snapshot()
        # Should be within the last 5s of "now". Generous to avoid CI
        # clock-skew flakes.
        assert abs(time.time() - snap.timestamp) < 5

    def test_host_info_shape(self):
        snap = sys_mod.snapshot()
        h = snap.host
        assert isinstance(h.hostname, str) and h.hostname
        assert h.boot_time_epoch > 0
        assert h.uptime_seconds >= 0
        assert h.process_count > 0

    def test_cpu_info_shape(self):
        snap = sys_mod.snapshot()
        cpu = snap.cpu
        assert 0.0 <= cpu.percent <= 100.0
        assert cpu.cores_logical >= 1
        assert len(cpu.per_core) == cpu.cores_logical
        for p in cpu.per_core:
            assert 0.0 <= p <= 100.0
        # load_avg is None on Windows, three floats on Linux/macOS
        if cpu.load_avg_1m is not None:
            assert isinstance(cpu.load_avg_1m, float)
            assert isinstance(cpu.load_avg_5m, float)
            assert isinstance(cpu.load_avg_15m, float)

    def test_mem_info_consistent(self):
        snap = sys_mod.snapshot()
        m = snap.memory
        assert m.total_bytes > 0
        assert m.used_bytes >= 0
        assert m.used_bytes <= m.total_bytes
        assert 0.0 <= m.percent <= 100.0
        # Swap may be 0 on a fresh container — only test non-negative.
        assert m.swap_total_bytes >= 0
        assert m.swap_used_bytes >= 0

    def test_disks_skip_boring_fstypes(self):
        snap = sys_mod.snapshot()
        for d in snap.disks:
            assert d.fstype.lower() not in sys_mod._BORING_FSTYPES, d
            assert d.total_bytes > 0
            assert 0.0 <= d.percent <= 100.0

    def test_network_has_at_least_one_iface(self):
        # Even an air-gapped container has `lo`. If THIS fails the
        # platform is too weird to monitor.
        snap = sys_mod.snapshot()
        assert len(snap.network) >= 1
        for n in snap.network:
            assert isinstance(n.name, str) and n.name
            assert n.bytes_sent >= 0
            assert n.bytes_recv >= 0

    def test_snapshot_dict_is_json_safe(self):
        import json
        d = sys_mod.snapshot_dict()
        # Round-trip — everything must serialise.
        json.dumps(d)
        # Same top-level shape as the dataclass
        assert {"timestamp", "host", "cpu", "memory", "disks", "network"} <= d.keys()


class TestPlatformQuirks:

    def test_load_avg_swallows_attribute_error(self, monkeypatch):
        # Pretend we're on Windows by making getloadavg raise.
        import psutil
        def boom():
            raise AttributeError("simulating Windows")
        monkeypatch.setattr(psutil, "getloadavg", boom)
        a, b, c = sys_mod._load_avg()
        assert a is None and b is None and c is None

    def test_load_avg_swallows_oserror(self, monkeypatch):
        import psutil
        def boom():
            raise OSError("simulating /proc unavailable")
        monkeypatch.setattr(psutil, "getloadavg", boom)
        a, b, c = sys_mod._load_avg()
        assert a is None and b is None and c is None
