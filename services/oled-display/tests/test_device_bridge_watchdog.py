"""The panel must distinguish a fresh watchdog verdict from missing or stale data."""

from __future__ import annotations

import datetime
import importlib.util
import json
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"
_NOW = datetime.datetime(2026, 10, 5, 18, tzinfo=datetime.timezone.utc)
_PANEL_TOKEN = "pytest-watchdog-panel"
_ADMIN_TOKEN = "pytest-watchdog-admin"
_UNAVAILABLE = {"available": False, "overall": "unavailable",
                "generated_at": None, "checks": {}}


@pytest.fixture
def bridge(monkeypatch, tmp_path):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", _PANEL_TOKEN)
    monkeypatch.setenv("BRIDGE_ADMIN_TOKEN", _ADMIN_TOKEN)
    monkeypatch.setenv("DROPLET_WATCHDOG_STATE_DIR", str(tmp_path))
    spec = importlib.util.spec_from_file_location("device_bridge_watchdog", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.time, "time", lambda: _NOW.timestamp())
    return module


def _status(age=30, overall="ok"):
    generated = _NOW - datetime.timedelta(seconds=age)
    return {
        "schema": 1,
        "generated_at": generated.isoformat().replace("+00:00", "Z"),
        "overall": overall,
        "checks": {
            "wifi": {"status": overall, "message": "probe result",
                     "consecutive_heal_failures": 2 if overall == "escalated" else 0},
            "voice_dsp": {"status": "not_applicable", "message": "hardware absent",
                          "consecutive_heal_failures": 0},
        },
    }


def _write(tmp_path, body):
    (tmp_path / "status.json").write_text(json.dumps(body), encoding="utf-8")


@pytest.mark.parametrize("overall", ["ok", "healed", "heal_failed", "escalated"])
def test_fresh_verdict_is_preserved(bridge, tmp_path, overall):
    body = _status(overall=overall)
    _write(tmp_path, body)
    assert bridge.watchdog_snapshot() == {
        "available": True, "overall": overall, "reported_overall": overall,
        "generated_at": body["generated_at"], "checks": body["checks"],
    }


def test_missing_file_is_unavailable(bridge):
    assert bridge.watchdog_snapshot() == _UNAVAILABLE


def test_truncated_json_is_unavailable(bridge, tmp_path):
    (tmp_path / "status.json").write_text('{"overall":', encoding="utf-8")
    assert bridge.watchdog_snapshot() == _UNAVAILABLE


@pytest.mark.parametrize("field,value", [
    ("schema", True), ("schema", 2), ("overall", "healthy"),
    ("overall", "not_applicable"), ("generated_at", None),
    ("generated_at", "2026-10-05T18:00:00"), ("generated_at", "NaN"),
    ("generated_at", "99999-10-05T18:00:00Z"), ("checks", {}),
    ("checks", []),
])
def test_invalid_contract_is_unavailable(bridge, tmp_path, field, value):
    body = _status()
    body[field] = value
    _write(tmp_path, body)
    assert bridge.watchdog_snapshot() == _UNAVAILABLE


@pytest.mark.parametrize("field,value", [
    ("status", "unknown"), ("status", {}), ("message", None),
    ("consecutive_heal_failures", -1), ("consecutive_heal_failures", True),
])
def test_invalid_check_is_unavailable(bridge, tmp_path, field, value):
    body = _status()
    body["checks"]["wifi"][field] = value
    _write(tmp_path, body)
    assert bridge.watchdog_snapshot() == _UNAVAILABLE


@pytest.mark.parametrize("overall", ["ok", "escalated"])
def test_stale_verdict_keeps_diagnostics_without_reporting_healthy(bridge, tmp_path, overall):
    body = _status(age=601, overall=overall)
    _write(tmp_path, body)
    result = bridge.watchdog_snapshot()
    assert result["available"] is True
    assert result["overall"] == "stale"
    assert result["reported_overall"] == overall
    assert result["checks"] == body["checks"]
    assert result["generated_at"] == body["generated_at"]


@pytest.mark.parametrize("age,expected", [(600, "ok"), (-60, "ok"), (-61, "unavailable")])
def test_freshness_and_clock_skew_boundaries(bridge, tmp_path, age, expected):
    _write(tmp_path, _status(age=age))
    assert bridge.watchdog_snapshot()["overall"] == expected


def _drive_get(bridge, token):
    handler = bridge.Handler.__new__(bridge.Handler)
    handler.command = "GET"
    handler.path = "/watchdog"
    handler.headers = {"X-Droplet-Auth": token} if token else {}
    captured = {}
    handler._send = lambda status, body: captured.update(status=status, body=body)
    handler.do_GET()
    return captured


@pytest.mark.parametrize("token", ["", "wrong-token"])
def test_route_refuses_missing_or_wrong_token_before_reading(bridge, monkeypatch, token):
    def forbidden():
        raise AssertionError("unauthenticated request reached the status reader")

    monkeypatch.setattr(bridge, "watchdog_snapshot", forbidden)
    assert _drive_get(bridge, token) == {
        "status": 401, "body": {"error": "unauthorized"},
    }


@pytest.mark.parametrize("token", [_PANEL_TOKEN, _ADMIN_TOKEN])
def test_route_accepts_both_read_tokens(bridge, tmp_path, token):
    _write(tmp_path, _status())
    assert bridge.ROUTE_CLASSES[("GET", "/watchdog")] == "read"
    result = _drive_get(bridge, token)
    assert result["status"] == 200
    assert result["body"]["available"] is True
    assert result["body"]["overall"] == "ok"
