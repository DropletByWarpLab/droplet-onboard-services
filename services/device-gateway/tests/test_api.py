"""HTTP surface: auth, registry CRUD, reads, the plan-only / live write split."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from registry import REDACTED, Registry

from .fakes import FakeDriver

AUTH = {"Authorization": "Bearer pytest-fake-secret"}

RTU = {
    "name": "Rooftop unit 1", "protocol": "modbus", "address": "10.0.0.5", "room": "Roof",
    "points": [
        {"id": "setpoint", "name": "Setpoint", "address": 10, "writable": True,
         "min": 16, "max": 28, "unit": "°C"},
        {"id": "supply_temp", "name": "Supply temp", "address": 11, "unit": "°C"},
    ],
}


@pytest.fixture
def drivers():
    return {p: FakeDriver(p) for p in ("bacnet", "modbus", "snmp", "knx")}


@pytest.fixture
def client(tmp_path, drivers, monkeypatch):
    monkeypatch.setattr(main, "SERVICE_SECRET", "pytest-fake-secret")
    monkeypatch.setattr(main, "LIVE_WRITES", False)
    monkeypatch.setattr(main.state, "registry", Registry(tmp_path / "registry.json"))
    monkeypatch.setattr(main.state, "drivers", drivers)
    monkeypatch.setattr(main.state, "locks", {})
    with TestClient(main.app) as c:
        yield c


def put_rtu(client):
    r = client.put("/devices/rtu-1", json=RTU, headers=AUTH)
    assert r.status_code == 201, r.text
    return r.json()


# --- auth -------------------------------------------------------------------

def test_health_is_open_and_reports_write_mode(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["live_writes"] is False
    assert r.json()["protocols"] == ["bacnet", "modbus", "snmp", "knx"]


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}])
def test_bad_or_missing_token_is_403(client, headers):
    assert client.get("/devices", headers=headers).status_code == 403


def test_unset_secret_fails_closed(client, monkeypatch):
    monkeypatch.setattr(main, "SERVICE_SECRET", "")
    monkeypatch.setattr(main, "ALLOW_NO_AUTH", False)
    r = client.get("/devices", headers=AUTH)
    assert r.status_code == 403 and "not configured" in r.json()["error"]


def test_lifespan_starts_and_stops_drivers(tmp_path, drivers, monkeypatch):
    monkeypatch.setattr(main.state, "registry", Registry(tmp_path / "r.json"))
    monkeypatch.setattr(main.state, "drivers", drivers)
    with TestClient(main.app):
        assert all(d.started for d in drivers.values())
    assert all(d.stopped for d in drivers.values())


# --- registry CRUD ------------------------------------------------------------

def test_create_update_list_delete(client):
    assert put_rtu(client)["id"] == "rtu-1"
    r = client.put("/devices/rtu-1", json={**RTU, "name": "RTU 1"}, headers=AUTH)
    assert r.status_code == 200 and r.json()["name"] == "RTU 1"
    assert [d["id"] for d in client.get("/devices", headers=AUTH).json()["devices"]] == ["rtu-1"]
    assert client.delete("/devices/rtu-1", headers=AUTH).status_code == 204
    assert client.get("/devices/rtu-1", headers=AUTH).status_code == 404
    assert client.delete("/devices/rtu-1", headers=AUTH).status_code == 404


def test_invalid_device_is_422(client):
    bad = {**RTU, "points": [{"id": "sp", "name": "SP", "address": 1, "writable": True}]}
    r = client.put("/devices/rtu-1", json=bad, headers=AUTH)
    assert r.status_code == 422
    assert "min and max" in str(r.json())


def test_path_and_body_id_must_match(client):
    r = client.put("/devices/rtu-1", json={**RTU, "id": "other"}, headers=AUTH)
    assert r.status_code == 400


def test_template_fills_points_and_secret_is_redacted(client):
    body = {"name": "Front printer", "protocol": "snmp", "address": "10.0.0.20",
            "community": "office-ro", "template": "printer"}
    r = client.put("/devices/printer-1", json=body, headers=AUTH)
    assert r.status_code == 201
    assert r.json()["community"] == REDACTED
    assert any(p["id"] == "supply_level" for p in r.json()["points"])
    listed = client.get("/devices", headers=AUTH).json()["devices"][0]
    assert listed["community"] == REDACTED


def test_unknown_template_is_422(client):
    r = client.put("/devices/x", json={"name": "X", "protocol": "snmp", "address": "10.0.0.2",
                                       "template": "toaster"}, headers=AUTH)
    assert r.status_code == 422


# --- reads ------------------------------------------------------------------

def test_values_are_read_per_point(client, drivers):
    put_rtu(client)
    drivers["modbus"].values[("rtu-1", "supply_temp")] = 18.5
    r = client.get("/devices/rtu-1/values", headers=AUTH)
    assert r.status_code == 200
    values = r.json()["values"]
    assert values["supply_temp"] == {"value": 18.5, "error": None}
    assert values["setpoint"]["error"] == "no value"


def test_unreachable_device_is_502(client, drivers):
    put_rtu(client)
    drivers["modbus"].unreachable = True
    r = client.get("/devices/rtu-1/values", headers=AUTH)
    assert r.status_code == 502 and r.json()["detail"]["error"] == "unreachable"


# --- writes -----------------------------------------------------------------

def test_writes_are_plan_only_by_default(client, drivers):
    put_rtu(client)
    r = client.post("/devices/rtu-1/points/setpoint/write", json={"value": 21}, headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"applied": False, "live_writes": False,
                        "plan": {"device_id": "rtu-1", "point_id": "setpoint",
                                 "protocol": "modbus", "value": 21}}
    assert drivers["modbus"].writes == []


def test_live_write_applies_and_reads_back(client, drivers, monkeypatch):
    monkeypatch.setattr(main, "LIVE_WRITES", True)
    put_rtu(client)
    r = client.post("/devices/rtu-1/points/setpoint/write", json={"value": 21.5}, headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["readback"] == {"value": 21.5, "error": None}
    assert drivers["modbus"].writes == [("rtu-1", "setpoint", 21.5)]


@pytest.mark.parametrize("point,value,status", [
    ("setpoint", 40, 422),        # out of bounds
    ("setpoint", True, 422),      # a bool is not a number
    ("setpoint", "21", 422),      # nor is a string
    ("supply_temp", 20, 422),     # read-only
    ("nope", 1, 404),
])
def test_guard_rejections_never_reach_the_driver(client, drivers, monkeypatch, point, value, status):
    monkeypatch.setattr(main, "LIVE_WRITES", True)
    put_rtu(client)
    r = client.post(f"/devices/rtu-1/points/{point}/write", json={"value": value}, headers=AUTH)
    assert r.status_code == status
    assert drivers["modbus"].writes == []


def test_live_write_to_unreachable_device_is_502(client, drivers, monkeypatch):
    monkeypatch.setattr(main, "LIVE_WRITES", True)
    put_rtu(client)
    drivers["modbus"].unreachable = True
    r = client.post("/devices/rtu-1/points/setpoint/write", json={"value": 20}, headers=AUTH)
    assert r.status_code == 502


# --- discovery --------------------------------------------------------------

def test_discovery_unsupported_protocol_is_400(client):
    r = client.post("/discover", json={"protocol": "modbus"}, headers=AUTH)
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "discovery_unsupported"


def test_discovery_marks_registered_devices(client, drivers):
    client.put("/devices/ahu", json={"name": "AHU", "protocol": "bacnet", "address": "10.0.0.9"},
               headers=AUTH)
    drivers["bacnet"].discovered = [
        {"protocol": "bacnet", "address": "10.0.0.9", "device_instance": 1},
        {"protocol": "bacnet", "address": "10.0.0.10", "device_instance": 2},
    ]
    found = client.post("/discover", json={"protocol": "bacnet"}, headers=AUTH).json()["found"]
    assert [f["registered"] for f in found] == [True, False]


def test_templates_listing(client):
    ids = {t["id"] for t in client.get("/templates", headers=AUTH).json()["templates"]}
    assert {"printer", "ups", "host"} <= ids
