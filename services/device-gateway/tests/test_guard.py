"""guard.plan_write — the write-layer gate every write passes."""

from __future__ import annotations

import math

import pytest

from guard import PointNotFound, WriteRejected, plan_write
from registry import validate_device

DEVICE = validate_device({
    "id": "rtu", "name": "Rooftop unit", "protocol": "modbus", "address": "10.0.0.5",
    "points": [
        {"id": "setpoint", "name": "Setpoint", "address": 10, "writable": True,
         "min": 16, "max": 28, "unit": "°C", "data_type": "int16", "scale": 0.1},
        {"id": "supply_temp", "name": "Supply temp", "address": 11},
        {"id": "fan", "name": "Fan", "table": "coil", "kind": "boolean", "address": 1,
         "writable": True},
    ],
})

TEXT_DEVICE = validate_device({
    "id": "sign", "name": "Sign", "protocol": "snmp", "address": "10.0.0.8", "community": "c",
    "points": [{"id": "msg", "name": "Message", "kind": "text", "oid": "1.3.6.1.2.1.1.6.0",
                "writable": True}],
})


def test_valid_number_plans():
    plan = plan_write(DEVICE, "setpoint", 21.5)
    assert plan.as_dict() == {"device_id": "rtu", "point_id": "setpoint",
                              "protocol": "modbus", "value": 21.5}


def test_unknown_point():
    with pytest.raises(PointNotFound):
        plan_write(DEVICE, "nope", 1)


def test_read_only_point_refused():
    with pytest.raises(WriteRejected, match="read-only"):
        plan_write(DEVICE, "supply_temp", 20)


@pytest.mark.parametrize("value", [15.9, 28.01, -1000])
def test_out_of_bounds_refused(value):
    with pytest.raises(WriteRejected, match="must be at"):
        plan_write(DEVICE, "setpoint", value)


@pytest.mark.parametrize("value", [True, "21", None, math.nan, math.inf])
def test_number_point_rejects_non_numbers(value):
    with pytest.raises(WriteRejected):
        plan_write(DEVICE, "setpoint", value)


@pytest.mark.parametrize("value", [1, 0, "on", None])
def test_boolean_point_takes_only_bools(value):
    with pytest.raises(WriteRejected, match="true or false"):
        plan_write(DEVICE, "fan", value)
    assert plan_write(DEVICE, "fan", True).value is True


def test_text_limits():
    assert plan_write(TEXT_DEVICE, "msg", "Lobby").value == "Lobby"
    with pytest.raises(WriteRejected, match="at most"):
        plan_write(TEXT_DEVICE, "msg", "x" * 256)
    with pytest.raises(WriteRejected, match="takes text"):
        plan_write(TEXT_DEVICE, "msg", 5)
