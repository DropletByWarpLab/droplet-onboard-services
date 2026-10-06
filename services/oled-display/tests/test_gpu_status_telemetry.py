"""GPU-first status must describe the inference card and report lost telemetry honestly."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import display as display_module
from display import TFTDisplay


@pytest.fixture
def telemetry(sim_display, monkeypatch):
    monkeypatch.delenv("PANEL_GPU_CARD", raising=False)
    monkeypatch.setattr(display_module.psutil, "cpu_percent", lambda **_kw: 21)
    monkeypatch.setattr(display_module.psutil, "virtual_memory", lambda: SimpleNamespace(percent=43))
    monkeypatch.setattr(display_module.psutil, "disk_usage", lambda _p: SimpleNamespace(percent=57))
    monkeypatch.setattr(sim_display, "_get_cpu_temp", lambda: 58)
    monkeypatch.setattr(sim_display, "_get_ip", lambda: "127.0.0.1")
    monkeypatch.setattr(sim_display, "_get_gpu", lambda: 12)
    monkeypatch.setattr(sim_display, "_get_gpu_temp", lambda: 34)
    return sim_display


def _responses(monkeypatch, disp, gpu, watchdog=None):
    calls = []

    def fetch(path, timeout):
        calls.append((path, timeout))
        return gpu if path == "/gpu" else watchdog

    monkeypatch.setattr(disp, "_bridge_get", fetch)
    return calls


def test_canonical_gpu_and_watchdog_are_sampled_with_bounded_timeouts(telemetry, monkeypatch):
    watchdog = {"available": True, "overall": "heal_failed", "generated_at": "2026-10-05T18:00:00Z",
                "checks": {"wifi": {"status": "heal_failed", "message": "radio unavailable",
                                    "consecutive_heal_failures": 1}}}
    calls = _responses(monkeypatch, telemetry,
                       {"available": True, "busy_percent": 96.4, "temp_c": 67.6}, watchdog)
    stats = telemetry._gather_stats()
    assert stats["gpu"] == 96
    assert stats["gpu_temp"] == 68
    assert stats["cpu"] == 21 and stats["mem"] == 43 and stats["temp"] == 58
    assert stats["watchdog"] == {key: watchdog[key] for key in ("available", "overall", "generated_at")}
    assert calls == [("/gpu", 3.0), ("/watchdog", 1.0)]


def test_missing_bridge_uses_local_gpu_and_marks_watchdog_unavailable(telemetry, monkeypatch):
    _responses(monkeypatch, telemetry, None)
    stats = telemetry._gather_stats()
    assert stats["gpu"] == 12 and stats["gpu_temp"] == 34
    assert stats["watchdog"] == {"available": False, "overall": "unavailable",
                                "generated_at": None}


@pytest.mark.parametrize("snapshot", [
    {"available": False}, {}, [], "invalid", {"available": "true"},
])
def test_explicit_or_malformed_gpu_absence_does_not_substitute_local_card(
        telemetry, monkeypatch, snapshot):
    _responses(monkeypatch, telemetry, snapshot)
    stats = telemetry._gather_stats()
    assert stats["gpu"] is None and stats["gpu_temp"] is None


@pytest.mark.parametrize("value", [None, True, "97", float("nan"), float("inf"), -1, 101])
def test_invalid_gpu_busy_is_unknown_and_clears_previous_sample(telemetry, monkeypatch, value):
    telemetry.update_stats({"gpu": 97, "gpu_temp": 62})
    _responses(monkeypatch, telemetry, {"available": True, "busy_percent": value, "temp_c": 64})
    stats = telemetry._gather_stats()
    telemetry.update_stats(stats)
    assert stats["gpu"] is None
    assert telemetry._v3["gpu"] is None
    assert telemetry._v3["sparks_gpu"] == []
    assert telemetry._v3["gpu_temp"] == 64


@pytest.mark.parametrize("value", [None, True, "62", float("nan"), float("-inf"), 0, 121])
def test_invalid_gpu_temperature_does_not_claim_a_valid_temperature(telemetry, monkeypatch, value):
    _responses(monkeypatch, telemetry, {"available": True, "busy_percent": 97, "temp_c": value})
    stats = telemetry._gather_stats()
    assert stats["gpu"] == 97 and stats["gpu_temp"] is None


def test_operator_panel_pin_overrides_canonical_card(telemetry, monkeypatch):
    monkeypatch.setenv("PANEL_GPU_CARD", "card2")
    _responses(monkeypatch, telemetry, {"available": True, "busy_percent": 97, "temp_c": 62})
    stats = telemetry._gather_stats()
    assert stats["gpu"] == 12 and stats["gpu_temp"] == 34


@pytest.fixture
def sysfs(tmp_path, monkeypatch):
    drm = tmp_path / "drm"
    drm.mkdir()
    monkeypatch.setattr(display_module, "_SYS_DRM", str(drm))
    monkeypatch.setattr(display_module, "_SYS_GPU_LOAD_GLOBS", (str(tmp_path / "platform" / "*.gpu" / "load"),))
    monkeypatch.delenv("PANEL_GPU_CARD", raising=False)
    return tmp_path


def _write(root, rel, value):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(value), encoding="utf-8")


def _card(root, name, busy, vram, temp=62000, vendor="0x1002"):
    base = f"drm/{name}/device"
    _write(root, f"{base}/vendor", vendor)
    _write(root, f"{base}/mem_info_vram_total", vram)
    _write(root, f"{base}/hwmon/hwmon0/temp1_input", temp)
    if busy is not None:
        _write(root, f"{base}/gpu_busy_percent", busy)


def test_local_fallback_selects_largest_vram_not_idle_igpu(sysfs):
    _card(sysfs, "card0", 0, 512 * 1024**2, temp=41000)
    _card(sysfs, "card2", 98, 16 * 1024**3, temp=67000)
    assert TFTDisplay._get_gpu() == 98
    assert TFTDisplay._get_gpu_temp() == 67


@pytest.mark.parametrize("busy", [None, "invalid", 101])
def test_nvidia_without_usable_busy_counter_never_reports_amd_igpu_as_idle(sysfs, busy):
    _card(sysfs, "card0", 0, 512 * 1024**2, temp=41000)
    _card(sysfs, "card2", busy, 0, temp=67000, vendor="0x10de")
    assert TFTDisplay._get_gpu() is None
    assert TFTDisplay._get_gpu_temp() == 67


def test_missing_operator_pin_does_not_fall_through_to_jetson(sysfs, monkeypatch):
    _write(sysfs, "platform/17000000.gpu/load", 910)
    monkeypatch.setenv("PANEL_GPU_CARD", "card9")
    assert TFTDisplay._get_gpu() is None
    assert TFTDisplay._get_gpu_temp() is None


def test_bridge_without_drm_card_preserves_jetson_devfreq(sysfs, sim_display, monkeypatch):
    _write(sysfs, "platform/17000000.gpu/load", 910)
    _responses(monkeypatch, sim_display, {"available": False})
    stats = sim_display._gather_stats()
    assert stats["gpu"] == 91
    assert stats["gpu_temp"] is None


def test_malformed_selected_load_does_not_swap_temperature_or_fall_back_to_igpu(sysfs):
    _card(sysfs, "card0", "invalid", 16 * 1024**3, temp=92000)
    _card(sysfs, "card2", 41, 512 * 1024**2, temp=47000)
    assert TFTDisplay._get_gpu() is None
    assert TFTDisplay._get_gpu_temp() == 92


def test_gpu_history_keeps_newest_bounded_samples_then_clears_on_loss(sim_display):
    assert sim_display._v3["sparks_gpu"] == []
    values = [i % 101 for i in range(sim_display._v3_spark_len + 7)]
    for value in values:
        sim_display.update_stats({"gpu": value, "gpu_temp": 62, "cpu": 21, "mem": 43})
    assert sim_display._v3["sparks_gpu"] == [float(v) for v in values[-sim_display._v3_spark_len:]]
    sim_display.update_stats({"gpu": None, "gpu_temp": None})
    assert sim_display._v3["gpu"] is None and sim_display._v3["gpu_temp"] is None
    assert sim_display._v3["sparks_gpu"] == []
    sim_display.update_stats({"gpu": 0})
    assert sim_display._v3["sparks_gpu"] == [0.0]


def test_explicit_null_clears_all_sensors_but_omitted_values_are_retained(sim_display):
    keys = ("gpu", "gpu_temp", "cpu", "mem", "disk", "temp")
    sim_display.update_stats(dict.fromkeys(keys, 42))
    sim_display.update_stats({"watchdog": {"available": True, "overall": "ok"}})
    assert all(sim_display._v3[key] == 42 for key in keys)
    sim_display.update_stats(dict.fromkeys((*keys, "watchdog"), None))
    assert all(sim_display._v3[key] is None for key in (*keys, "watchdog"))
    assert all(sim_display._v3[key] == [] for key in ("sparks_gpu", "sparks_cpu", "sparks_mem", "sparks_disk"))
