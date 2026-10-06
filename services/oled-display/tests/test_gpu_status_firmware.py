"""GPU-first front-panel telemetry on stubbed CircuitPython hardware."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
_PYPORTAL_DIR = _TESTS_DIR.parent / "pyportal"
for path in (str(_TESTS_DIR), str(_PYPORTAL_DIR)):
    if path not in sys.path:
        sys.path.insert(0, path)

from _cpstubs import install as install_stubs  # noqa: E402


@pytest.fixture
def firmware():
    install_stubs()
    sys.modules.pop("code", None)
    code = importlib.import_module("code")
    yield code
    sys.modules.pop("code", None)


def _labels(code):
    def descend(group):
        for child in group:
            if isinstance(child, code.label.Label):
                yield child
            elif isinstance(child, code.displayio.Group):
                yield from descend(child)

    return list(descend(code.board.DISPLAY.root_group))


def test_gpu_is_the_hero_and_history_source(firmware, monkeypatch):
    code = firmware
    code.handle({"mode": "stats", "data": {
        "gpu": 81, "cpu": 24, "mem": 47, "gpu_temp": 72, "temp": 54,
    }})
    code.state["sparks"]["gpu"] = [10, 50, 90]
    code.state["sparks"]["cpu"] = [24, 24, 24]
    seen = {}
    original_tracked = code._tracked
    original_sparkline = code._v3_sparkline

    def tracked(group, text, **kwargs):
        seen.setdefault("captions", []).append(text)
        return original_tracked(group, text, **kwargs)

    def sparkline(group, x, y, width, height, series, color, fill):
        seen["history"] = series
        return original_sparkline(group, x, y, width, height, series, color, fill)

    monkeypatch.setattr(code, "_tracked", tracked)
    monkeypatch.setattr(code, "_v3_sparkline", sparkline)
    code.render_system()
    assert "GPU LOAD" in seen["captions"]
    assert "CPU LOAD" not in seen["captions"]
    assert seen["history"] == [10, 50, 90]
    labels = _labels(code)
    assert any(lbl.text == "81%" and lbl.anchored_position == (20, 84)
               for lbl in labels)
    assert [lbl.text for lbl in labels if lbl.y == 200] == [
        "24%", "47%", "72°C", "54°C"]


def test_unknown_telemetry_stays_unknown_and_uses_available_dash_font(
        firmware, monkeypatch):
    code = firmware
    monkeypatch.setattr(code, "_hero_font", lambda: object())
    code.render_system()
    labels = _labels(code)
    hero = next(lbl for lbl in labels if lbl.anchored_position == (20, 84))
    assert hero.text == "--"
    assert hero.font is code.terminalio.FONT
    assert [lbl.text for lbl in labels if lbl.y == 200] == ["--"] * 4
    assert all(code.state["sparks"][key] == [] for key in code.state["sparks"])


def test_null_stats_clear_stale_values_without_inventing_zero(firmware):
    code = firmware
    known = {"gpu": 81, "cpu": 24, "mem": 47, "gpu_temp": 72, "temp": 54}
    code.handle({"mode": "stats", "data": known})
    code.handle({"mode": "stats", "data": {key: None for key in known}})
    code.render_system()
    assert all(code.state[key] is None for key in known)
    assert [lbl.text for lbl in _labels(code) if lbl.y == 200] == ["--"] * 4
    for key in known:
        assert code.state["sparks"][key] == []
    code.handle({"mode": "stats", "data": {"gpu": 40}})
    assert code.state["sparks"]["gpu"] == [40.0]


def test_zero_gpu_is_known_and_histories_are_bounded(firmware):
    code = firmware
    for value in range(60):
        code.handle({"mode": "stats", "data": {"gpu": value, "gpu_temp": 50}})
    assert code.state["sparks"]["gpu"] == list(range(12, 60))
    assert len(code.state["sparks"]["gpu_temp"]) == code._SPARK_LEN
    assert code.state["sparks"]["cpu"] == []
    code.handle({"mode": "stats", "data": {"gpu": 0}})
    code.render_system()
    assert any(lbl.text == "0%" and lbl.anchored_position == (20, 84)
               for lbl in _labels(code))


def test_temperature_colors_and_units(firmware):
    code = firmware
    code.handle({"mode": "stats", "data": {"gpu_temp": 85, "temp": 70}})
    code.render_system()
    labels = _labels(code)
    assert any(lbl.text == "85°C" and lbl.color == code.RED for lbl in labels)
    assert any(lbl.text == "70°C" and lbl.color == code.ORANGE for lbl in labels)


@pytest.mark.parametrize("overall,label,color_name", [
    ("ok", "OK", "GREEN"),
    ("healed", "HEALED", "GREEN"),
    ("heal_failed", "FAULT", "ORANGE"),
    ("escalated", "CRITICAL", "RED"),
    ("stale", "STALE", "ORANGE"),
    ("unavailable", "NO DATA", "LABEL_3"),
])
def test_watchdog_summary_and_header_reflect_health(
        firmware, overall, label, color_name):
    code = firmware
    code.handle({"mode": "stats", "data": {"watchdog": {
        "available": overall != "unavailable", "overall": overall,
        "generated_at": None, "checks": {},
    }}})
    code.render_system()
    labels = _labels(code)
    color = getattr(code, color_name)
    assert any(lbl.text == "WATCHDOG " + label and lbl.y == 226
               and lbl.color == color for lbl in labels)
    assert any(lbl.text == label and lbl.anchored_position[1] == 15
               and lbl.color == color for lbl in labels)
    if overall in ("heal_failed", "escalated", "stale", "unavailable"):
        assert not any(lbl.text == "OK" for lbl in labels)
