"""Host sensor discovery for the rack panel's TEMP and GPU cells.

The bug these guard: on the AMD mini-rack box the panel showed `TEMP 0°` and
`GPU —` forever. Two independent causes —

  * `_get_cpu_temp()` only read `/sys/class/thermal`, and that box has no CPU
    thermal zone at all (Zen temperature is behind `k10temp` in hwmon), so it
    fell through to a `0.0` floor that rendered as a confident `0°`;
  * `gpu` was never gathered by anything, so `layout_wide` drew an em dash for
    a value nothing ever produced.

Every case below builds a fake sysfs tree, because the real one differs on
every box in the fleet and none of it exists on the CI runner.
"""

from __future__ import annotations

import pytest

import display as display_module
from display import TFTDisplay


# --------------------------------------------------------------------------
# fixture helpers — write a sysfs-shaped tree under tmp_path
# --------------------------------------------------------------------------

def _write(root, rel: str, value: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(value)


@pytest.fixture
def sysfs(tmp_path, monkeypatch):
    """Point every sensor root at an empty fixture tree.

    Defaults to "this host has nothing": each test adds only the nodes its
    scenario is about, so no test silently depends on the real /sys.
    """
    for name, sub in (("_SYS_THERMAL", "thermal"),
                      ("_SYS_HWMON", "hwmon"),
                      ("_SYS_DRM", "drm")):
        d = tmp_path / sub
        d.mkdir()
        monkeypatch.setattr(display_module, name, str(d))
    # No Jetson devfreq node unless a test asks for one.
    monkeypatch.setattr(display_module, "_SYS_GPU_LOAD_GLOBS",
                        (str(tmp_path / "nonexistent" / "*" / "load"),))
    monkeypatch.delenv("PANEL_GPU_CARD", raising=False)
    return tmp_path


# --------------------------------------------------------------------------
# CPU temperature
# --------------------------------------------------------------------------

def test_no_sensors_at_all_returns_none_not_zero(sysfs):
    """The whole point. A 0 here renders `0°` on the glass — a confident,
    wrong claim that the box is at freezing. `None` renders `—`."""
    assert TFTDisplay._get_cpu_temp() is None


def test_thermal_zone_is_read(sysfs):
    _write(sysfs, "thermal/thermal_zone0/type", "x86_pkg_temp\n")
    _write(sysfs, "thermal/thermal_zone0/temp", "54000\n")
    assert TFTDisplay._get_cpu_temp() == pytest.approx(54.0)


def test_hottest_zone_wins(sysfs):
    for i, (kind, milli) in enumerate((("cpu-thermal", "41000"),
                                       ("soc0-thermal", "67000"),
                                       ("cpu1-thermal", "52000"))):
        _write(sysfs, f"thermal/thermal_zone{i}/type", kind)
        _write(sysfs, f"thermal/thermal_zone{i}/temp", milli)
    assert TFTDisplay._get_cpu_temp() == pytest.approx(67.0)


def test_gpu_and_pll_zones_are_skipped(sysfs):
    """A GPU zone must not be reported under a cell labelled TEMP, even when
    it is the hottest thing in the box."""
    _write(sysfs, "thermal/thermal_zone0/type", "CPU-therm")
    _write(sysfs, "thermal/thermal_zone0/temp", "48000")
    _write(sysfs, "thermal/thermal_zone1/type", "GPU-therm")
    _write(sysfs, "thermal/thermal_zone1/temp", "91000")
    _write(sysfs, "thermal/thermal_zone2/type", "PLL-therm")
    _write(sysfs, "thermal/thermal_zone2/temp", "88000")
    assert TFTDisplay._get_cpu_temp() == pytest.approx(48.0)


def test_blank_zone_read_does_not_poison_the_result(sysfs):
    """The exact failure that made psutil unusable here: some Jetson zones
    return an empty string. It must be skipped, not treated as 0."""
    _write(sysfs, "thermal/thermal_zone0/type", "BCPU-therm")
    _write(sysfs, "thermal/thermal_zone0/temp", "")
    _write(sysfs, "thermal/thermal_zone1/type", "CPU-therm")
    _write(sysfs, "thermal/thermal_zone1/temp", "45500")
    assert TFTDisplay._get_cpu_temp() == pytest.approx(45.5)


def test_out_of_range_zone_is_rejected(sysfs):
    """Unpopulated sensors report placeholders (0, -273000, 2^31). None of
    them are temperatures."""
    _write(sysfs, "thermal/thermal_zone0/type", "acpitz")
    _write(sysfs, "thermal/thermal_zone0/temp", "-273000")
    assert TFTDisplay._get_cpu_temp() is None


def test_k10temp_hwmon_fallback_when_no_thermal_zone(sysfs):
    """The mini-rack box exactly: zero CPU thermal zones, temperature only
    reachable through k10temp's Tctl."""
    _write(sysfs, "hwmon/hwmon2/name", "k10temp\n")
    _write(sysfs, "hwmon/hwmon2/temp1_label", "Tctl\n")
    _write(sysfs, "hwmon/hwmon2/temp1_input", "61375\n")
    assert TFTDisplay._get_cpu_temp() == pytest.approx(61.375)


def test_hwmon_ignores_non_cpu_drivers(sysfs):
    """nvme and the amdgpu die both live in hwmon and both run hot. Reporting
    either as CPU temperature is the bug this whitelist prevents."""
    _write(sysfs, "hwmon/hwmon0/name", "nvme")
    _write(sysfs, "hwmon/hwmon0/temp1_input", "84000")
    _write(sysfs, "hwmon/hwmon1/name", "amdgpu")
    _write(sysfs, "hwmon/hwmon1/temp1_input", "95000")
    assert TFTDisplay._get_cpu_temp() is None


def test_hwmon_prefers_tctl_over_per_ccd_inputs(sysfs):
    """k10temp exposes Tccd1..N alongside Tctl. The CCD sensors read cooler,
    so taking the max across all of them would understate the package."""
    _write(sysfs, "hwmon/hwmon3/name", "k10temp")
    _write(sysfs, "hwmon/hwmon3/temp1_label", "Tctl")
    _write(sysfs, "hwmon/hwmon3/temp1_input", "58000")
    _write(sysfs, "hwmon/hwmon3/temp3_label", "Tccd1")
    _write(sysfs, "hwmon/hwmon3/temp3_input", "49000")
    assert TFTDisplay._get_cpu_temp() == pytest.approx(58.0)


def test_thermal_zone_wins_over_hwmon(sysfs):
    """hwmon is a *fallback*. An ARM box with a real CPU zone keeps today's
    behaviour byte for byte."""
    _write(sysfs, "thermal/thermal_zone0/type", "cpu-thermal")
    _write(sysfs, "thermal/thermal_zone0/temp", "44000")
    _write(sysfs, "hwmon/hwmon0/name", "k10temp")
    _write(sysfs, "hwmon/hwmon0/temp1_label", "Tctl")
    _write(sysfs, "hwmon/hwmon0/temp1_input", "77000")
    assert TFTDisplay._get_cpu_temp() == pytest.approx(44.0)


# --------------------------------------------------------------------------
# GPU utilisation
# --------------------------------------------------------------------------

def test_no_gpu_returns_none(sysfs):
    assert TFTDisplay._get_gpu() is None


def test_amdgpu_busy_percent_is_read(sysfs):
    _write(sysfs, "drm/card0/device/gpu_busy_percent", "37\n")
    assert TFTDisplay._get_gpu() == 37


def test_zero_percent_is_a_real_reading(sysfs):
    """An idle GPU is 0, and that is data, not absence. Only a *missing*
    sensor may render the em dash."""
    _write(sysfs, "drm/card0/device/gpu_busy_percent", "0")
    assert TFTDisplay._get_gpu() == 0


def test_connector_directories_are_not_mistaken_for_cards(sysfs):
    """`/sys/class/drm` is mostly connectors — card1-HDMI-A-3 is the very node
    this panel hangs off. Only `cardN` is a GPU."""
    _write(sysfs, "drm/card1-HDMI-A-3/status", "connected")
    _write(sysfs, "drm/card1-DP-1/status", "disconnected")
    _write(sysfs, "drm/card1/device/gpu_busy_percent", "12")
    assert TFTDisplay._get_gpu() == 12


def test_lowest_numbered_card_wins_and_sorts_numerically(sysfs):
    """Deterministic card choice. String sort would put card10 first."""
    _write(sysfs, "drm/card10/device/gpu_busy_percent", "99")
    _write(sysfs, "drm/card2/device/gpu_busy_percent", "8")
    assert TFTDisplay._get_gpu() == 8


def test_card_without_busy_node_is_skipped(sysfs):
    """A display-only or headless card exposes no gpu_busy_percent; fall
    through to the next one rather than reporting nothing."""
    (sysfs / "drm" / "card0" / "device").mkdir(parents=True)
    _write(sysfs, "drm/card1/device/gpu_busy_percent", "22")
    assert TFTDisplay._get_gpu() == 22


def test_panel_gpu_card_env_pins_the_card(sysfs, monkeypatch):
    _write(sysfs, "drm/card0/device/gpu_busy_percent", "5")
    _write(sysfs, "drm/card1/device/gpu_busy_percent", "64")
    monkeypatch.setenv("PANEL_GPU_CARD", "card1")
    assert TFTDisplay._get_gpu() == 64


def test_panel_gpu_card_pointing_at_a_missing_card_reports_nothing(
        sysfs, monkeypatch):
    """An explicit pin that cannot be honoured must not silently fall back to
    a different GPU — the operator asked for that card specifically."""
    _write(sysfs, "drm/card0/device/gpu_busy_percent", "5")
    monkeypatch.setenv("PANEL_GPU_CARD", "card9")
    assert TFTDisplay._get_gpu() is None


def test_jetson_devfreq_load_is_converted_from_per_mille(sysfs, monkeypatch):
    _write(sysfs, "platform/17000000.gpu/load", "455\n")
    monkeypatch.setattr(display_module, "_SYS_GPU_LOAD_GLOBS",
                        (str(sysfs / "platform" / "*.gpu" / "load"),))
    assert TFTDisplay._get_gpu() == 46


# --------------------------------------------------------------------------
# plumbing: sensors -> _gather_stats -> _v3 -> the wide panel's cells
# --------------------------------------------------------------------------

def test_gather_stats_carries_temp_and_gpu(sysfs, sim_display):
    _write(sysfs, "hwmon/hwmon0/name", "k10temp")
    _write(sysfs, "hwmon/hwmon0/temp1_label", "Tctl")
    _write(sysfs, "hwmon/hwmon0/temp1_input", "59600")
    _write(sysfs, "drm/card0/device/gpu_busy_percent", "41")

    stats = sim_display._gather_stats()
    assert stats["temp"] == 60          # rounded
    assert stats["gpu"] == 41


def test_gather_stats_reports_none_when_the_host_has_no_sensors(
        sysfs, sim_display):
    stats = sim_display._gather_stats()
    assert stats["temp"] is None
    assert stats["gpu"] is None


def test_cold_panel_state_is_none_not_zero(sim_display):
    """Before any stats frame lands. `layout_wide._num()` turns these into
    em dashes; a 0 would render `0°` / `0%`."""
    assert sim_display._v3["temp"] is None
    assert sim_display._v3["gpu"] is None


def test_update_stats_mirrors_gpu_into_v3(sim_display):
    """`gpu` missing from update_stats()' key tuple is precisely how a value
    can be gathered correctly and still never reach the glass."""
    sim_display.update_stats({"cpu": 12, "temp": 58, "gpu": 73})
    assert sim_display._v3["gpu"] == 73
    assert sim_display._v3["temp"] == 58


def test_a_sensor_going_away_clears_the_cell(sim_display):
    """Every other key keeps its last value when a frame omits it. temp/gpu
    must not: a card that unbinds would otherwise leave a frozen reading on
    the panel indefinitely, which reads as live."""
    sim_display.update_stats({"temp": 58, "gpu": 73})
    sim_display.update_stats({"temp": None, "gpu": None})
    assert sim_display._v3["temp"] is None
    assert sim_display._v3["gpu"] is None


def test_wide_panel_renders_the_values_it_is_given(sysfs, sim_display,
                                                   monkeypatch):
    """End to end through the real cell renderer: em dashes with no sensors,
    real numbers once the sysfs nodes exist."""
    import layout_wide as lw
    monkeypatch.setattr(display_module, "WIDTH", 1424)
    monkeypatch.setattr(display_module, "HEIGHT", 280)

    drawn: list[str] = []
    real_text = display_module._v3_text

    def _spy(draw, text, x, y, **kw):
        drawn.append(str(text))
        return real_text(draw, text, x, y, **kw)

    monkeypatch.setattr(display_module, "_v3_text", _spy)

    from PIL import Image, ImageDraw
    img = Image.new("RGB", (1424, 280))

    sim_display.update_stats(sim_display._gather_stats())
    lw._cell_health(sim_display, ImageDraw.Draw(img), sim_display._v3)
    assert "—" in drawn, "no sensors present: TEMP/GPU must render em dashes"

    drawn.clear()
    _write(sysfs, "hwmon/hwmon0/name", "k10temp")
    _write(sysfs, "hwmon/hwmon0/temp1_label", "Tctl")
    _write(sysfs, "hwmon/hwmon0/temp1_input", "62000")
    _write(sysfs, "drm/card0/device/gpu_busy_percent", "44")

    sim_display.update_stats(sim_display._gather_stats())
    lw._cell_health(sim_display, ImageDraw.Draw(img), sim_display._v3)
    assert "62°" in drawn
    assert "44%" in drawn
