"""SNMP point templates for common office devices."""

from __future__ import annotations

import pytest

from registry import validate_device
from templates import TEMPLATES, apply_template, listing


@pytest.mark.parametrize("name", sorted(TEMPLATES))
def test_every_template_validates_and_is_read_only(name):
    body = apply_template({"id": "dev", "name": "Dev", "protocol": TEMPLATES[name]["protocol"],
                           "address": "10.0.0.2", "community": "public", "template": name})
    device = validate_device(body)
    assert len(device.points) == len(TEMPLATES[name]["points"])
    assert not any(p.writable for p in device.points)


def test_template_does_not_override_explicit_points():
    body = {"id": "d", "protocol": "snmp", "template": "ups",
            "points": [{"id": "x", "name": "X", "oid": "1.3.6.1.2.1.1.3.0"}]}
    assert apply_template(body)["points"] == body["points"]


def test_unknown_and_mismatched_templates():
    with pytest.raises(ValueError, match="unknown template"):
        apply_template({"protocol": "snmp", "template": "toaster"})
    with pytest.raises(ValueError, match="for snmp devices"):
        apply_template({"protocol": "modbus", "template": "printer"})


def test_no_template_is_a_no_op():
    body = {"protocol": "modbus", "points": []}
    assert apply_template(body) is body


def test_listing():
    ids = {t["id"] for t in listing()}
    assert {"printer", "ups", "host"} <= ids
