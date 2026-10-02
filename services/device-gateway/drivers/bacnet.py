"""BACnet/IP driver (BACpypes3, MIT).

The building-automation protocol: HVAC controllers, VAV boxes, air handlers,
chillers, lighting panels. One local BACnet device (UDP 47808 on the host
network) serves every read, write and Who-Is.

Writes go to the point's priority (8-16, default 16 — registry.py refuses
1-7), so a building's life-safety and critical-equipment overrides always
outrank anything the gateway writes.
"""

from __future__ import annotations

import asyncio
import os
from typing import Callable, Optional

from .base import DeviceUnreachable, ProtocolDriver, ProtocolError, Reading, Value, as_number

# The gateway's own BACnet identity. Instance must be unique on the site's
# BACnet network; the default sits at the top of the range, away from the
# low instances controllers ship with.
BACNET_INSTANCE = int(os.environ.get("DEVICE_GATEWAY_BACNET_INSTANCE", "4194000"))
# "<ip>/<prefix>" of the LAN interface; empty = let BACpypes3 pick the host.
BACNET_ADDRESS = os.environ.get("DEVICE_GATEWAY_BACNET_ADDRESS", "")


def default_app_factory():
    from bacpypes3.app import Application
    from bacpypes3.argparse import SimpleArgumentParser

    args = SimpleArgumentParser().parse_args([])
    args.name = "Droplet device gateway"
    args.instance = BACNET_INSTANCE
    args.address = BACNET_ADDRESS or None
    return Application.from_args(args)


def to_value(point, raw) -> Value:
    if point.kind == "text":
        return str(raw)
    attr = getattr(raw, "attr", None)  # Enumerated values (BinaryPV) carry a name
    if point.kind == "boolean":
        if attr in ("active", "inactive"):
            return attr == "active"
        try:
            return int(raw) != 0
        except (TypeError, ValueError) as e:
            raise ProtocolError(f"{point.object}: not a boolean ({raw!r})") from e
    try:
        return as_number(raw)
    except (TypeError, ValueError) as e:
        raise ProtocolError(f"{point.object}: not a number ({raw!r})") from e


def to_bacnet(point, value: Value):
    from bacpypes3.basetypes import BinaryPV
    from bacpypes3.primitivedata import CharacterString, Real, Unsigned

    if point.kind == "text":
        return CharacterString(str(value))
    if point.kind == "boolean":
        return BinaryPV("active" if value else "inactive")
    if point.object.startswith("multi-state-"):
        return Unsigned(int(value))  # states are 1..n
    return Real(float(value))


class BacnetDriver(ProtocolDriver):
    protocol = "bacnet"

    def __init__(self, timeout: float = 3.0, app_factory: Callable[[], object] = default_app_factory):
        self.timeout = timeout
        self._factory = app_factory
        self._app: Optional[object] = None

    def _application(self):
        if self._app is None:
            self._app = self._factory()
        return self._app

    async def stop(self) -> None:
        if self._app is not None:
            self._app.close()
            self._app = None

    async def _call(self, device, coro):
        try:
            return await asyncio.wait_for(coro, self.timeout)
        except asyncio.TimeoutError as e:
            raise DeviceUnreachable(f"{device.id}: no BACnet answer from {device.address}") from e
        except DeviceUnreachable:
            raise
        except Exception as e:  # ErrorRejectAbortNack and friends
            raise ProtocolError(f"{device.id}: {e}") from e

    async def read_points(self, device, points):
        app = self._application()
        out: dict[str, Reading] = {}
        reached = False
        last_unreachable: Optional[DeviceUnreachable] = None
        for p in points:
            try:
                raw = await self._call(device, app.read_property(device.address, p.object, p.property))
                reached = True
                out[p.id] = Reading(value=to_value(p, raw))
            except DeviceUnreachable as e:
                last_unreachable = e
                out[p.id] = Reading(error=str(e))
            except ProtocolError as e:
                reached = True
                out[p.id] = Reading(error=str(e))
        if points and not reached and last_unreachable is not None:
            raise last_unreachable
        return out

    async def write_point(self, device, point, value):
        app = self._application()
        await self._call(
            device,
            app.write_property(
                device.address, point.object, point.property, to_bacnet(point, value),
                priority=point.priority,
            ),
        )

    async def discover(self, timeout: float) -> list[dict]:
        app = self._application()
        i_ams = await app.who_is(timeout=timeout)
        found = []
        for i_am in i_ams or []:
            _, instance = i_am.iAmDeviceIdentifier
            found.append({
                "protocol": "bacnet",
                "address": str(i_am.pduSource),
                "device_instance": int(instance),
                "vendor_id": int(i_am.vendorID),
            })
        return found
