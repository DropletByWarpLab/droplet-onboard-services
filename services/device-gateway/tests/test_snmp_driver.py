"""SnmpDriver with the pysnmp command functions swapped for fakes."""

from __future__ import annotations

import pytest
from pysnmp.hlapi.v3arch.asyncio import (
    CommunityData,
    Integer32,
    OctetString,
    UsmUserData,
    usmAesCfb128Protocol,
    usmHMAC192SHA256AuthProtocol,
)
from pysnmp.proto.rfc1902 import Gauge32, TimeTicks
from pysnmp.proto.rfc1905 import NoSuchObject

from drivers.base import DeviceUnreachable, ProtocolError
from drivers.snmp import SnmpDriver, auth_data
from registry import validate_device

DEVICE = validate_device({
    "id": "ups", "name": "UPS", "protocol": "snmp", "address": "10.0.0.3", "community": "ro",
    "points": [
        {"id": "charge", "name": "Charge", "oid": "1.3.6.1.2.1.33.1.2.4.0"},
        {"id": "uptime", "name": "Uptime", "oid": "1.3.6.1.2.1.1.3.0", "scale": 0.01},
        {"id": "name", "name": "Name", "kind": "text", "oid": "1.3.6.1.2.1.1.5.0"},
        {"id": "alarm", "name": "Alarm", "kind": "boolean", "oid": "1.3.6.1.4.1.9.1.0"},
        {"id": "gone", "name": "Gone", "oid": "1.3.6.1.4.1.9.2.0"},
        {"id": "location", "name": "Location", "kind": "text", "oid": "1.3.6.1.2.1.1.6.0",
         "writable": True},
        {"id": "beeper", "name": "Beeper", "kind": "boolean", "oid": "1.3.6.1.4.1.9.3.0",
         "writable": True},
    ],
})

MIB = {
    "1.3.6.1.2.1.33.1.2.4.0": Gauge32(87),
    "1.3.6.1.2.1.1.3.0": TimeTicks(123456),
    "1.3.6.1.2.1.1.5.0": OctetString("ups-lobby".encode()),
    "1.3.6.1.4.1.9.1.0": Integer32(2),
    "1.3.6.1.4.1.9.2.0": NoSuchObject(""),
}


class Agent:
    def __init__(self, timeout=False):
        self.timeout = timeout
        self.sets = []
        self.auths = []

    async def get(self, engine, auth, target, oid):
        self.auths.append(auth)
        if self.timeout:
            return "No SNMP response received before timeout", 0, 0, ()
        return None, 0, 0, ((oid, MIB[oid]),)

    async def set_(self, engine, auth, target, oid, value):
        self.sets.append((oid, value))
        return None, 0, 0, ()


async def transport(addr, **kw):
    return ("target", addr, kw)


def driver(agent):
    return SnmpDriver(get=agent.get, set_=agent.set_, transport=transport)


@pytest.mark.asyncio
async def test_reads_numbers_text_truthvalues_and_scale():
    out = await driver(Agent()).read_points(DEVICE, DEVICE.points[:4])
    assert out["charge"].value == 87
    assert out["uptime"].value == pytest.approx(1234.56)
    assert out["name"].value == "ups-lobby"
    assert out["alarm"].value is False  # TruthValue false(2)


@pytest.mark.asyncio
async def test_missing_object_is_a_point_error():
    out = await driver(Agent()).read_points(DEVICE, [DEVICE.point("gone")])
    assert "no such object" in out["gone"].error


@pytest.mark.asyncio
async def test_timeout_is_unreachable():
    with pytest.raises(DeviceUnreachable):
        await driver(Agent(timeout=True)).read_points(DEVICE, DEVICE.points[:1])


@pytest.mark.asyncio
async def test_set_text_as_utf8_and_boolean_as_truthvalue():
    agent = Agent()
    d = driver(agent)
    await d.write_point(DEVICE, DEVICE.point("location"), "Réception")
    await d.write_point(DEVICE, DEVICE.point("beeper"), True)
    (oid1, v1), (oid2, v2) = agent.sets
    assert oid1 == "1.3.6.1.2.1.1.6.0" and bytes(v1).decode("utf-8") == "Réception"
    assert oid2 == "1.3.6.1.4.1.9.3.0" and int(v2) == 1


def test_v2c_without_community_is_refused():
    d = validate_device({"id": "p", "name": "P", "protocol": "snmp", "address": "10.0.0.4"})
    with pytest.raises(ProtocolError, match="no SNMP community"):
        auth_data(d)
    assert isinstance(auth_data(DEVICE), CommunityData)


def test_v3_auth_priv_protocols():
    d = validate_device({"id": "p", "name": "P", "protocol": "snmp", "address": "10.0.0.4",
                         "version": "3", "user": "droplet", "auth_key": "authpass1",
                         "priv_key": "privpass1"})
    usm = auth_data(d)
    assert isinstance(usm, UsmUserData)
    assert usm.authentication_protocol == usmHMAC192SHA256AuthProtocol
    assert usm.privacy_protocol == usmAesCfb128Protocol
