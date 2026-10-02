"""Registry validation: write safety is declared data, checked at registration."""

from __future__ import annotations

import json
import os
import stat

import pytest
from pydantic import ValidationError

from registry import REDACTED, Registry, public, validate_device


def modbus(**point):
    return {
        "id": "ahu-1", "name": "AHU 1", "protocol": "modbus", "address": "10.0.0.5",
        "points": [{"id": "p", "name": "P", "address": 1, **point}],
    }


def test_writable_number_needs_bounds():
    with pytest.raises(ValidationError, match="needs both min and max"):
        validate_device(modbus(writable=True))
    validate_device(modbus(writable=True, min=0, max=10))


def test_min_below_max():
    with pytest.raises(ValidationError, match="min must be below max"):
        validate_device(modbus(min=5, max=5))


@pytest.mark.parametrize("table", ["input", "discrete"])
def test_modbus_read_only_tables_cannot_be_writable(table):
    kind = "boolean" if table == "discrete" else "number"
    with pytest.raises(ValidationError, match="read-only"):
        validate_device(modbus(table=table, kind=kind, writable=True, min=0, max=1))


def test_modbus_bit_tables_are_boolean_and_registers_are_numbers():
    with pytest.raises(ValidationError, match="boolean"):
        validate_device(modbus(table="coil", kind="number"))
    with pytest.raises(ValidationError, match="numbers"):
        validate_device(modbus(table="holding", kind="boolean"))
    validate_device(modbus(table="coil", kind="boolean", writable=True))


def test_duplicate_point_ids_rejected():
    body = modbus()
    body["points"].append(dict(body["points"][0]))
    with pytest.raises(ValidationError, match="duplicate point ids"):
        validate_device(body)


def test_ids_are_slugs():
    with pytest.raises(ValidationError):
        validate_device({**modbus(), "id": "AHU 1"})


@pytest.mark.parametrize("priority", [1, 2, 5, 6, 7])
def test_bacnet_life_safety_priorities_refused(priority):
    with pytest.raises(ValidationError):
        validate_device({
            "id": "vav", "name": "VAV", "protocol": "bacnet", "address": "10.0.0.9",
            "points": [{"id": "sp", "name": "Setpoint", "object": "analog-value,1",
                        "priority": priority}],
        })


def test_bacnet_defaults_to_lowest_priority():
    d = validate_device({
        "id": "vav", "name": "VAV", "protocol": "bacnet", "address": "10.0.0.9",
        "points": [{"id": "sp", "name": "Setpoint", "object": "analog-value,1"}],
    })
    assert d.points[0].priority == 16
    assert d.points[0].property == "present-value"


@pytest.mark.parametrize("field,value", [("group_address", "not/a/ga/x"), ("dpt", "99.999")])
def test_knx_addresses_and_dpts_are_validated(field, value):
    point = {"id": "l", "name": "Lights", "kind": "boolean", "group_address": "1/2/3", "dpt": "1.001"}
    point[field] = value
    with pytest.raises(ValidationError):
        validate_device({"id": "knx", "name": "KNX", "protocol": "knx", "address": "10.0.0.7",
                         "points": [point]})


def test_snmp_v3_needs_user():
    with pytest.raises(ValidationError, match="needs a user"):
        validate_device({"id": "ups", "name": "UPS", "protocol": "snmp", "address": "10.0.0.3",
                         "version": "3"})


def test_unknown_fields_rejected():
    with pytest.raises(ValidationError):
        validate_device({**modbus(), "surprise": True})


def snmp_device(**over):
    return validate_device({
        "id": "printer", "name": "Printer", "protocol": "snmp", "address": "10.0.0.20",
        "community": "s3cret", "points": [], **over,
    })


def test_secrets_redacted_in_api_but_kept_on_disk(tmp_path):
    reg = Registry(tmp_path / "registry.json")
    reg.put(snmp_device())
    assert public(reg.get("printer"))["community"] == REDACTED
    on_disk = json.loads((tmp_path / "registry.json").read_text())
    assert on_disk[0]["community"] == "s3cret"
    mode = stat.S_IMODE(os.stat(tmp_path / "registry.json").st_mode)
    assert mode == 0o600


def test_put_without_secret_keeps_stored_one(tmp_path):
    reg = Registry(tmp_path / "registry.json")
    assert reg.put(snmp_device()) is True
    assert reg.put(snmp_device(name="Front printer", community=None)) is False
    stored = reg.get("printer")
    assert stored.name == "Front printer"
    assert stored.community.get_secret_value() == "s3cret"


def test_registry_round_trips(tmp_path):
    path = tmp_path / "registry.json"
    reg = Registry(path)
    reg.put(validate_device(modbus(writable=True, min=0, max=10, scale=0.1)))
    reg.put(snmp_device())
    again = Registry(path)
    assert [d.id for d in again.all()] == ["ahu-1", "printer"]
    assert again.get("ahu-1").points[0].scale == 0.1
    assert again.get("printer").community.get_secret_value() == "s3cret"
    assert again.delete("ahu-1") is True
    assert again.delete("ahu-1") is False
    assert [d.id for d in Registry(path).all()] == ["printer"]


def test_missing_registry_file_is_empty(tmp_path):
    assert Registry(tmp_path / "none.json").all() == []
