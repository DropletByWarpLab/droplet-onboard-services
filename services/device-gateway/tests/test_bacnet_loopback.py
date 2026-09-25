"""BacnetDriver end to end against a second, real BACpypes3 device on loopback.

The unit tests fake the application; this one proves the driver's real
wiring (address parsing, ReadProperty/WriteProperty, type conversion)
against a real BACnet/IP stack.
"""

from __future__ import annotations

import socket

import pytest
import pytest_asyncio
from bacpypes3.app import Application
from bacpypes3.argparse import SimpleArgumentParser
from bacpypes3.local.analog import AnalogValueObject
from bacpypes3.local.binary import BinaryValueObject

from drivers.bacnet import BacnetDriver
from registry import validate_device


def free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_app(instance: int, port: int) -> Application:
    args = SimpleArgumentParser().parse_args([])
    args.instance, args.name, args.address = instance, f"test-{instance}", f"127.0.0.1/32:{port}"
    return Application.from_args(args)


@pytest_asyncio.fixture
async def controller():
    port = free_udp_port()
    app = make_app(1201, port)
    common = dict(statusFlags=[0, 0, 0, 0], eventState="normal", outOfService=False)
    setpoint = AnalogValueObject(objectIdentifier=("analog-value", 1), objectName="setpoint",
                                 presentValue=20.0, units="degreesCelsius", **common)
    fan = BinaryValueObject(objectIdentifier=("binary-value", 1), objectName="fan",
                            presentValue="inactive", **common)
    app.add_object(setpoint)
    app.add_object(fan)
    yield port, setpoint, fan
    app.close()


@pytest.mark.asyncio
async def test_read_write_read_through_a_real_bacnet_stack(controller):
    port, setpoint, fan = controller
    gw_port = free_udp_port()
    driver = BacnetDriver(timeout=2, app_factory=lambda: make_app(4194000, gw_port))
    dev = validate_device({
        "id": "ahu", "name": "AHU", "protocol": "bacnet", "address": f"127.0.0.1:{port}",
        "points": [
            {"id": "sp", "name": "Setpoint", "object": "analog-value,1", "writable": True,
             "min": 10, "max": 30},
            {"id": "fan", "name": "Fan", "kind": "boolean", "object": "binary-value,1",
             "writable": True},
            {"id": "name", "name": "Name", "kind": "text", "object": "analog-value,1",
             "property": "object-name"},
        ],
    })
    try:
        before = await driver.read_points(dev, dev.points)
        assert before["sp"].value == pytest.approx(20.0)
        assert before["fan"].value is False
        assert before["name"].value == "setpoint"

        await driver.write_point(dev, dev.point("sp"), 22.5)
        await driver.write_point(dev, dev.point("fan"), True)

        after = await driver.read_points(dev, dev.points)
        assert after["sp"].value == pytest.approx(22.5)
        assert after["fan"].value is True
        assert float(setpoint.presentValue) == pytest.approx(22.5)
        assert fan.presentValue.attr == "active"
    finally:
        await driver.stop()
