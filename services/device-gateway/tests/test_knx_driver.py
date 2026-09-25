"""KnxDriver with the xknx connection, reader and sender faked; real DPT codecs."""

from __future__ import annotations

import pytest
from xknx.dpt import DPTBase

from drivers.base import DeviceUnreachable, ProtocolError
from drivers.knx import KnxDriver
from registry import validate_device

from .fakes import FakeTelegram, FakeXknx

DEVICE = validate_device({
    "id": "knx-ip", "name": "KNX interface", "protocol": "knx", "address": "10.0.0.7",
    "points": [
        {"id": "lights", "name": "Open-plan lights", "kind": "boolean",
         "group_address": "1/1/1", "state_address": "1/1/2", "dpt": "1.001", "writable": True},
        {"id": "temp", "name": "Room temp", "group_address": "3/1/1", "dpt": "9.001"},
        {"id": "blinds", "name": "Blinds", "group_address": "2/1/1", "dpt": "5.001",
         "writable": True, "min": 0, "max": 100},
    ],
})


def encode(dpt, value):
    """What a real GroupValueResponse carries: a DPTBinary / DPTArray."""
    return DPTBase.parse_transcoder(dpt).to_knx(value)


class Bus:
    def __init__(self, values=None, fail_start=False):
        self.values = values or {}
        self.sent = []
        self.made = []
        self.fail_start = fail_start
        self.read_from = []

    def factory(self, device):
        x = FakeXknx(fail_start=self.fail_start)
        self.made.append(x)
        return x

    async def read(self, xknx, ga, timeout):
        self.read_from.append(ga)
        return FakeTelegram(self.values[ga]) if ga in self.values else None

    async def send(self, xknx, ga, knx_value):
        self.sent.append((ga, knx_value))


def driver(bus):
    return KnxDriver(timeout=0.2, xknx_factory=bus.factory, read=bus.read, send=bus.send)


@pytest.mark.asyncio
async def test_reads_decode_with_the_point_dpt_and_prefer_state_address():
    bus = Bus({"1/1/2": encode("1.001", True), "3/1/1": encode("9.001", 21.5)})
    out = await driver(bus).read_points(DEVICE, DEVICE.points[:2])
    assert out["lights"].value is True
    assert out["temp"].value == pytest.approx(21.5)
    assert bus.read_from == ["1/1/2", "3/1/1"]


@pytest.mark.asyncio
async def test_no_answer_is_a_point_error():
    out = await driver(Bus()).read_points(DEVICE, DEVICE.points[1:2])
    assert "no answer on 3/1/1" in out["temp"].error


@pytest.mark.asyncio
async def test_one_connection_per_interface_is_reused_and_stopped():
    bus = Bus({"3/1/1": encode("9.001", 20)})
    d = driver(bus)
    await d.read_points(DEVICE, DEVICE.points[1:2])
    await d.read_points(DEVICE, DEVICE.points[1:2])
    assert len(bus.made) == 1 and bus.made[0].started
    await d.stop()
    assert bus.made[0].stopped


@pytest.mark.asyncio
async def test_unreachable_interface():
    with pytest.raises(DeviceUnreachable):
        await driver(Bus(fail_start=True)).read_points(DEVICE, DEVICE.points)


@pytest.mark.asyncio
async def test_write_encodes_to_the_group_address():
    bus = Bus()
    d = driver(bus)
    await d.write_point(DEVICE, DEVICE.point("blinds"), 40)
    await d.write_point(DEVICE, DEVICE.point("lights"), False)
    (ga1, v1), (ga2, v2) = bus.sent
    assert ga1 == "2/1/1" and DPTBase.parse_transcoder("5.001").from_knx(v1) == pytest.approx(40, abs=0.5)
    assert ga2 == "1/1/1" and v2.value is False


@pytest.mark.asyncio
async def test_value_outside_the_dpt_range_is_a_protocol_error():
    wide = validate_device({
        "id": "k", "name": "K", "protocol": "knx", "address": "10.0.0.7",
        "points": [{"id": "pct", "name": "Pct", "group_address": "2/1/2", "dpt": "5.001",
                    "writable": True, "min": 0, "max": 500}],
    })
    bus = Bus()
    with pytest.raises(ProtocolError, match="does not fit"):
        await driver(bus).write_point(wide, wide.point("pct"), 300)
    assert bus.sent == []


@pytest.mark.asyncio
async def test_discover_maps_gateways():
    class Gw:
        ip_addr, port, name = "10.0.0.7", 3671, "MDT IP Interface"
        supports_tunnelling, supports_tunnelling_tcp, supports_routing = True, False, False

    async def scan(timeout):
        return [Gw()]

    found = await KnxDriver(scan=scan).discover(1.0)
    assert found == [{"protocol": "knx", "address": "10.0.0.7", "port": 3671,
                      "name": "MDT IP Interface", "tunnelling": True, "routing": False}]
