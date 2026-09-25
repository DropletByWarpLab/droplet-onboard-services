"""ModbusDriver end to end against pymodbus's own TCP server on loopback.

The unit tests fake the client; this one proves the driver's real wiring
(connect, device_id, register codecs, word order, close) against a real
Modbus stack.
"""

from __future__ import annotations

import asyncio
import socket

import pytest
import pytest_asyncio
from pymodbus.datastore import (
    ModbusDeviceContext,
    ModbusSequentialDataBlock,
    ModbusServerContext,
)
from pymodbus.server import ModbusTcpServer

from drivers.base import DeviceUnreachable
from drivers.modbus import ModbusDriver
from registry import validate_device

UNIT = 3


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def server():
    port = free_port()
    # Data blocks are 1-based internally: protocol address N lives at N + 1.
    ctx = ModbusDeviceContext(
        hr=ModbusSequentialDataBlock(1, [0] * 100),
        ir=ModbusSequentialDataBlock(1, [0] * 100),
        co=ModbusSequentialDataBlock(1, [False] * 100),
        di=ModbusSequentialDataBlock(1, [False] * 100),
    )
    srv = ModbusTcpServer(ModbusServerContext(devices={UNIT: ctx}, single=False),
                          address=("127.0.0.1", port))
    task = asyncio.create_task(srv.serve_forever())
    for _ in range(50):
        try:
            _, w = await asyncio.open_connection("127.0.0.1", port)
            w.close()
            break
        except OSError:
            await asyncio.sleep(0.02)
    yield port, ctx
    await srv.shutdown()
    task.cancel()


def device(port):
    return validate_device({
        "id": "plc", "name": "PLC", "protocol": "modbus", "address": "127.0.0.1",
        "port": port, "unit_id": UNIT,
        "points": [
            {"id": "setpoint", "name": "Setpoint", "address": 10, "data_type": "int16",
             "scale": 0.1, "writable": True, "min": 10, "max": 30},
            {"id": "flow", "name": "Flow", "address": 20, "data_type": "float32",
             "word_order": "little", "writable": True, "min": 0, "max": 500},
            {"id": "pump", "name": "Pump", "table": "coil", "kind": "boolean", "address": 4,
             "writable": True},
        ],
    })


@pytest.mark.asyncio
async def test_write_then_read_round_trips_through_a_real_modbus_stack(server):
    port, _ = server
    dev = device(port)
    driver = ModbusDriver(timeout=2)
    await driver.write_point(dev, dev.point("setpoint"), 21.5)
    await driver.write_point(dev, dev.point("flow"), 123.25)
    await driver.write_point(dev, dev.point("pump"), True)
    out = await driver.read_points(dev, dev.points)
    assert out["setpoint"].value == pytest.approx(21.5)
    assert out["flow"].value == pytest.approx(123.25)
    assert out["pump"].value is True


@pytest.mark.asyncio
async def test_nothing_listening_is_unreachable():
    dev = device(free_port())
    with pytest.raises(DeviceUnreachable):
        await ModbusDriver(timeout=0.5).read_points(dev, dev.points)
