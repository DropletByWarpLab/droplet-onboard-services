"""BacnetDriver against a fake BACpypes3 application, with real BACnet types."""

from __future__ import annotations

import asyncio

import pytest
from bacpypes3.basetypes import BinaryPV
from bacpypes3.primitivedata import CharacterString, Real, Unsigned

from drivers.base import DeviceUnreachable
from drivers.bacnet import BacnetDriver
from registry import validate_device

from .fakes import FakeBacnetApp

ADDR = "10.0.0.9"
DEVICE = validate_device({
    "id": "ahu", "name": "Air handler", "protocol": "bacnet", "address": ADDR,
    "device_instance": 1201,
    "points": [
        {"id": "zone_temp", "name": "Zone temp", "object": "analog-input,1", "unit": "°C"},
        {"id": "fan", "name": "Fan", "kind": "boolean", "object": "binary-value,3",
         "writable": True, "priority": 12},
        {"id": "mode", "name": "Mode", "object": "multi-state-value,2", "writable": True,
         "min": 1, "max": 4},
        {"id": "label", "name": "Label", "kind": "text", "object": "device,1201",
         "property": "object-name"},
        {"id": "setpoint", "name": "Setpoint", "object": "analog-value,1", "writable": True,
         "min": 16, "max": 28},
    ],
})


def driver(app, timeout=0.2):
    return BacnetDriver(timeout=timeout, app_factory=lambda: app)


@pytest.mark.asyncio
async def test_reads_real_binary_enum_and_text():
    app = FakeBacnetApp()
    app.props = {
        (ADDR, "analog-input,1", "present-value"): Real(21.25),
        (ADDR, "binary-value,3", "present-value"): BinaryPV("active"),
        (ADDR, "multi-state-value,2", "present-value"): Unsigned(3),
        (ADDR, "device,1201", "object-name"): CharacterString("AHU-1"),
        (ADDR, "analog-value,1", "present-value"): Real(22.0),
    }
    out = await driver(app).read_points(DEVICE, DEVICE.points)
    assert out["zone_temp"].value == pytest.approx(21.25)
    assert out["fan"].value is True
    assert out["mode"].value == 3 and type(out["mode"].value) is int
    assert out["label"].value == "AHU-1"


@pytest.mark.asyncio
async def test_a_rejected_property_is_a_point_error():
    app = FakeBacnetApp()
    app.props[(ADDR, "analog-input,1", "present-value")] = Real(20)
    app.errors[(ADDR, "binary-value,3", "present-value")] = RuntimeError("unknown-object")
    out = await driver(app).read_points(DEVICE, DEVICE.points[:2])
    assert out["zone_temp"].value == 20
    assert "unknown-object" in out["fan"].error


@pytest.mark.asyncio
async def test_silent_device_is_unreachable():
    class Silent(FakeBacnetApp):
        async def read_property(self, *a):
            await asyncio.sleep(1)

    with pytest.raises(DeviceUnreachable):
        await driver(Silent(), timeout=0.05).read_points(DEVICE, DEVICE.points[:2])


@pytest.mark.asyncio
async def test_writes_use_bacnet_types_and_the_point_priority():
    app = FakeBacnetApp()
    d = driver(app)
    await d.write_point(DEVICE, DEVICE.point("setpoint"), 21.5)
    await d.write_point(DEVICE, DEVICE.point("fan"), False)
    await d.write_point(DEVICE, DEVICE.point("mode"), 2)
    (a1, o1, p1, v1, pr1), (_, o2, _, v2, pr2), (_, o3, _, v3, _) = app.writes
    assert (a1, o1, p1, pr1) == (ADDR, "analog-value,1", "present-value", 16)
    assert isinstance(v1, Real) and float(v1) == 21.5
    assert isinstance(v2, BinaryPV) and v2.attr == "inactive" and pr2 == 12
    assert isinstance(v3, Unsigned) and int(v3) == 2


@pytest.mark.asyncio
async def test_discover_maps_i_ams():
    class IAm:
        iAmDeviceIdentifier = ("device", 1201)
        pduSource = "10.0.0.9"
        vendorID = 5

    app = FakeBacnetApp()
    app.i_ams = [IAm()]
    found = await driver(app).discover(1.0)
    assert found == [{"protocol": "bacnet", "address": "10.0.0.9", "device_instance": 1201, "vendor_id": 5}]


@pytest.mark.asyncio
async def test_stop_closes_the_application():
    app = FakeBacnetApp()
    d = driver(app)
    await d.read_points(DEVICE, [])
    await d.stop()
    assert app.closed
