"""ModbusDriver against a fake client that shares pymodbus's real codecs."""

from __future__ import annotations

import pytest

from drivers.base import DeviceUnreachable, ProtocolError
from drivers.modbus import ModbusDriver
from registry import validate_device

from .fakes import FakeModbusClient

DEVICE = validate_device({
    "id": "meter", "name": "Energy meter", "protocol": "modbus", "address": "10.0.0.5",
    "unit_id": 7,
    "points": [
        {"id": "power", "name": "Power", "table": "input", "address": 100, "data_type": "float32"},
        {"id": "temp", "name": "Temp", "address": 200, "data_type": "int16", "scale": 0.1},
        {"id": "setpoint", "name": "Setpoint", "address": 300, "data_type": "int16", "scale": 0.1,
         "writable": True, "min": 10, "max": 30},
        {"id": "limit", "name": "Limit", "address": 400, "data_type": "float32",
         "writable": True, "min": 0, "max": 1000},
        {"id": "relay", "name": "Relay", "table": "coil", "kind": "boolean", "address": 5,
         "writable": True},
    ],
})


@pytest.fixture
def client_box():
    box = {}

    def factory(host, **kw):
        c = FakeModbusClient(host, **kw)
        c.registers.update(box.get("registers", {}))
        c.coils.update(box.get("coils", {}))
        c.errors |= box.get("errors", set())
        c.connect_ok = box.get("connect_ok", True)
        box["last"] = c
        return c

    box["factory"] = factory
    return box


def regs(value, dtype):
    return FakeModbusClient.convert_to_registers(value, getattr(FakeModbusClient.DATATYPE, dtype))


@pytest.mark.asyncio
async def test_reads_scaled_and_typed_values(client_box):
    p = regs(1234.5, "FLOAT32")
    client_box["registers"] = {100: p[0], 101: p[1], 200: regs(-215, "INT16")[0]}
    client_box["coils"] = {5: True}
    out = await ModbusDriver(client_factory=client_box["factory"]).read_points(DEVICE, DEVICE.points)
    assert out["power"].value == pytest.approx(1234.5)
    assert out["temp"].value == pytest.approx(-21.5)
    assert out["relay"].value is True
    assert client_box["last"].closed
    assert client_box["last"].kwargs["port"] == 502
    assert client_box["last"].kwargs["reconnect_delay"] == 0


@pytest.mark.asyncio
async def test_one_bad_register_does_not_hide_the_rest(client_box):
    client_box["errors"] = {200}
    out = await ModbusDriver(client_factory=client_box["factory"]).read_points(DEVICE, DEVICE.points)
    assert out["temp"].error and out["temp"].value is None
    assert out["power"].error is None


@pytest.mark.asyncio
async def test_unreachable_device(client_box):
    client_box["connect_ok"] = False
    with pytest.raises(DeviceUnreachable):
        await ModbusDriver(client_factory=client_box["factory"]).read_points(DEVICE, DEVICE.points)


@pytest.mark.asyncio
async def test_writes_scaled_int16_to_the_unit(client_box):
    driver = ModbusDriver(client_factory=client_box["factory"])
    await driver.write_point(DEVICE, DEVICE.point("setpoint"), 21.5)
    assert client_box["last"].writes == [("register", 300, 215, 7)]


@pytest.mark.asyncio
async def test_writes_float32_across_two_registers(client_box):
    driver = ModbusDriver(client_factory=client_box["factory"])
    await driver.write_point(DEVICE, DEVICE.point("limit"), 750.25)
    kind, addr, values, unit = client_box["last"].writes[0]
    assert (kind, addr, unit) == ("registers", 400, 7)
    assert FakeModbusClient.convert_from_registers(values, FakeModbusClient.DATATYPE.FLOAT32) == pytest.approx(750.25)


@pytest.mark.asyncio
async def test_writes_coil(client_box):
    await ModbusDriver(client_factory=client_box["factory"]).write_point(DEVICE, DEVICE.point("relay"), False)
    assert client_box["last"].writes == [("coil", 5, False, 7)]


@pytest.mark.asyncio
async def test_value_that_does_not_fit_the_register_is_refused(client_box):
    wide = validate_device({
        "id": "m", "name": "M", "protocol": "modbus", "address": "10.0.0.6",
        "points": [{"id": "x", "name": "X", "address": 1, "data_type": "int16",
                    "writable": True, "min": 0, "max": 100000}],
    })
    with pytest.raises(ProtocolError, match="does not fit"):
        await ModbusDriver(client_factory=client_box["factory"]).write_point(wide, wide.point("x"), 40000)
    assert client_box["last"].writes == []
    assert client_box["last"].closed
