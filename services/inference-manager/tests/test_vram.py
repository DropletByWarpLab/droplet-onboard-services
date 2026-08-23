"""Tests for the VRAM detection module."""

from __future__ import annotations

from pathlib import Path

import pytest


def _write_meminfo(tmp_path: Path, kb_total: int) -> Path:
    p = tmp_path / "meminfo"
    p.write_text(f"MemTotal:     {kb_total} kB\nMemFree: 100 kB\n")
    return p


def test_detects_total_minus_reserve(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    # 8 GiB in kB
    meminfo = _write_meminfo(tmp_path, 8 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 6


def test_override_env_wins(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_OVERRIDE_GB", "12")
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    meminfo = _write_meminfo(tmp_path, 4 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 12


def test_invalid_override_falls_back(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_OVERRIDE_GB", "not-a-number")
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    meminfo = _write_meminfo(tmp_path, 16 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 14


def test_missing_meminfo_returns_zero(tmp_path, monkeypatch):
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(tmp_path / "nope"))

    assert vram.detected_vram_gb() == 0


def test_unparseable_meminfo_returns_zero(tmp_path, monkeypatch):
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    p = tmp_path / "meminfo"
    p.write_text("garbage without MemTotal\n")
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(p))

    assert vram.detected_vram_gb() == 0


def test_detection_failure_emits_structured_event(tmp_path, monkeypatch):
    """On meminfo failure, the documented `vram_detection_failed` structured
    event is emitted (RESILIENCE.md tells operators to grep for it). See LLM-08.
    """
    from structlog.testing import capture_logs

    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    missing = tmp_path / "nope"
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(missing))

    with capture_logs() as logs:
        assert vram.detected_vram_gb() == 0

    events = [e for e in logs if e.get("event") == "vram_detection_failed"]
    assert len(events) == 1, f"expected one vram_detection_failed event, got: {logs}"
    assert events[0]["path"] == str(missing)
    assert events[0]["log_level"] == "warning"


def test_caches_result(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    meminfo = _write_meminfo(tmp_path, 16 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    first = vram.detected_vram_gb()
    # Mutate underlying file — cache should not refresh
    meminfo.write_text("MemTotal: 1 kB\n")
    second = vram.detected_vram_gb()
    assert first == second == 14


def _write_dgpu_node(tmp_path: Path, card: str, bytes_total: int) -> None:
    node = tmp_path / "drm" / card / "device" / "mem_info_vram_total"
    node.parent.mkdir(parents=True, exist_ok=True)
    node.write_text(str(bytes_total))


def _dgpu_glob(tmp_path: Path) -> str:
    return str(tmp_path / "drm" / "card*" / "device" / "mem_info_vram_total")


# ── WARP-1111 §7.4: dGPU sysfs detection ──


def test_dgpu_sysfs_preferred_over_meminfo(tmp_path, monkeypatch):
    """A dedicated-GPU sysfs node wins over /proc/meminfo, and its number is
    used as-is (no VRAM_RESERVE_GB subtraction — the GPU's memory isn't
    shared with the OS)."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    # 17,095,983,104 B is the live-box's real reading for its "16 GB" card
    # (architecture brief §3.1) — rounds to 16, not floors to 15.
    _write_dgpu_node(tmp_path, "card0", 17_095_983_104)
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))
    # meminfo would give a very different (wrong, for a dGPU host) answer —
    # prove it's not what's being read.
    meminfo = _write_meminfo(tmp_path, 30 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 16


def test_dgpu_sysfs_picks_max_across_cards(tmp_path, monkeypatch):
    """A box with both a dedicated card and an integrated GPU (e.g. this
    appliance's Raphael iGPU) reports both sysfs nodes — take the larger,
    landing on the dedicated card without identifying it by vendor ID."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    _write_dgpu_node(tmp_path, "card0", 536_870_912)  # ~512 MiB iGPU
    _write_dgpu_node(tmp_path, "card1", 17_179_869_184)  # exactly 16 GiB dGPU
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    assert vram.detected_vram_gb() == 16


def test_dgpu_sysfs_skips_unreadable_node(tmp_path, monkeypatch):
    """A garbage/unreadable sysfs node is skipped, not fatal — the remaining
    readable node still wins."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    node = tmp_path / "drm" / "card0" / "device" / "mem_info_vram_total"
    node.parent.mkdir(parents=True, exist_ok=True)
    node.write_text("not-a-number")
    _write_dgpu_node(tmp_path, "card1", 8_589_934_592)  # exactly 8 GiB
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    assert vram.detected_vram_gb() == 8


def test_dgpu_sysfs_absent_falls_back_to_meminfo(tmp_path, monkeypatch):
    """No dGPU sysfs node at all (unified-memory host) — behave exactly as
    before this change."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))  # no nodes written
    meminfo = _write_meminfo(tmp_path, 8 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    assert vram.detected_vram_gb() == 6


def test_override_wins_over_dgpu_sysfs(tmp_path, monkeypatch):
    import vram
    monkeypatch.setenv("VRAM_OVERRIDE_GB", "12")
    _write_dgpu_node(tmp_path, "card0", 17_179_869_184)
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    assert vram.detected_vram_gb() == 12


def test_dgpu_detection_emits_structured_event_with_source(tmp_path, monkeypatch):
    from structlog.testing import capture_logs

    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    _write_dgpu_node(tmp_path, "card0", 17_179_869_184)
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    with capture_logs() as logs:
        assert vram.detected_vram_gb() == 16

    events = [e for e in logs if e.get("event") == "vram_detected"]
    assert len(events) == 1, f"expected one vram_detected event, got: {logs}"
    assert events[0]["source"] == "dgpu_sysfs"
    assert events[0]["vram_gb"] == 16


def test_unified_memory_detection_emits_structured_event_with_source(tmp_path, monkeypatch):
    from structlog.testing import capture_logs

    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))  # no nodes
    meminfo = _write_meminfo(tmp_path, 8 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))

    with capture_logs() as logs:
        assert vram.detected_vram_gb() == 6

    events = [e for e in logs if e.get("event") == "vram_detected"]
    assert len(events) == 1
    assert events[0]["source"] == "unified_memory"
    assert events[0]["vram_gb"] == 6


def test_dgpu_sysfs_result_is_cached(tmp_path, monkeypatch):
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    _write_dgpu_node(tmp_path, "card0", 17_179_869_184)
    monkeypatch.setattr(vram, "_DGPU_VRAM_GLOB", _dgpu_glob(tmp_path))

    first = vram.detected_vram_gb()
    _write_dgpu_node(tmp_path, "card0", 1)  # mutate — cache should not refresh
    second = vram.detected_vram_gb()
    assert first == second == 16


def test_failed_detection_is_not_cached(tmp_path, monkeypatch):
    """A transient meminfo read failure must NOT be cached — the next call
    re-attempts detection so a device that hit an OOM event self-heals instead
    of staying stuck at 0 GB headroom until restart (WARP-194)."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setenv("VRAM_RESERVE_GB", "2")
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(tmp_path / "nope"))

    # First call: meminfo unreadable → 0, and crucially the 0 is not cached.
    assert vram.detected_vram_gb() == 0
    assert vram._cached_gb is None

    # meminfo becomes readable again → detection recovers on the next call.
    meminfo = _write_meminfo(tmp_path, 16 * 1024 * 1024)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(meminfo))
    assert vram.detected_vram_gb() == 14
