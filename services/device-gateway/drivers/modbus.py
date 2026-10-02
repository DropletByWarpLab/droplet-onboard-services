"""Modbus TCP driver (pymodbus, BSD-3-Clause).

Connections are short-lived — one per request — because many Modbus
devices accept a single TCP client and hold it until it closes; a
long-lived gateway connection would lock out the building's own BMS.
"""

from __future__ import annotations

from typing import Callable

from pymodbus.client import AsyncModbusTcpClient
from pymodbus.exceptions import ModbusException

from .base import (
    DeviceUnreachable,
    ProtocolDriver,
    ProtocolError,
    Reading,
    Value,
    as_number,
    scaled,
)

_WIDTH = {"int16": 1, "uint16": 1, "int32": 2, "uint32": 2, "float32": 2}
_RANGE = {
    "int16": (-(2**15), 2**15 - 1),
    "uint16": (0, 2**16 - 1),
    "int32": (-(2**31), 2**31 - 1),
    "uint32": (0, 2**32 - 1),
}

ClientFactory = Callable[..., object]


class ModbusDriver(ProtocolDriver):
    protocol = "modbus"

    def __init__(self, timeout: float = 3.0, client_factory: ClientFactory = AsyncModbusTcpClient):
        self.timeout = timeout
        self._factory = client_factory

    async def _connect(self, device):
        # reconnect_delay=0 turns off pymodbus's background reconnect: the
        # connection is ours for one request only.
        client = self._factory(
            device.address, port=device.port, timeout=self.timeout, retries=1, reconnect_delay=0
        )
        try:
            ok = await client.connect()
        except (OSError, ModbusException) as e:
            raise DeviceUnreachable(f"{device.id}: {e}") from e
        if not ok:
            client.close()
            raise DeviceUnreachable(f"{device.id}: no Modbus answer at {device.address}:{device.port}")
        return client

    @staticmethod
    def _dtype(client, point):
        return getattr(client.DATATYPE, point.data_type.upper())

    async def _read_one(self, client, device, point) -> Value:
        kw = {"device_id": device.unit_id}
        if point.table in ("coil", "discrete"):
            fn = client.read_coils if point.table == "coil" else client.read_discrete_inputs
            rr = await fn(point.address, count=1, **kw)
            if rr.isError():
                raise ProtocolError(str(rr))
            return bool(rr.bits[0])
        fn = client.read_holding_registers if point.table == "holding" else client.read_input_registers
        rr = await fn(point.address, count=_WIDTH[point.data_type], **kw)
        if rr.isError():
            raise ProtocolError(str(rr))
        raw = client.convert_from_registers(
            rr.registers, self._dtype(client, point), word_order=point.word_order
        )
        return scaled(as_number(raw), point.scale)

    async def read_points(self, device, points):
        client = await self._connect(device)
        out: dict[str, Reading] = {}
        try:
            for p in points:
                try:
                    out[p.id] = Reading(value=await self._read_one(client, device, p))
                except (ProtocolError, ModbusException) as e:
                    out[p.id] = Reading(error=str(e))
        finally:
            client.close()
        return out

    def _registers(self, client, point, value: Value) -> list[int]:
        raw = value / point.scale  # type: ignore[operator]
        if point.data_type != "float32":
            raw = round(raw)
            lo, hi = _RANGE[point.data_type]
            if not lo <= raw <= hi:
                raise ProtocolError(f"{point.id}: {value} does not fit {point.data_type}")
        return client.convert_to_registers(
            raw, self._dtype(client, point), word_order=point.word_order
        )

    async def write_point(self, device, point, value):
        client = await self._connect(device)
        kw = {"device_id": device.unit_id}
        try:
            if point.table == "coil":
                rr = await client.write_coil(point.address, bool(value), **kw)
            else:
                regs = self._registers(client, point, value)
                if len(regs) == 1:
                    rr = await client.write_register(point.address, regs[0], **kw)
                else:
                    rr = await client.write_registers(point.address, regs, **kw)
            if rr.isError():
                raise ProtocolError(f"{device.id}/{point.id}: {rr}")
        except ModbusException as e:
            raise ProtocolError(f"{device.id}/{point.id}: {e}") from e
        finally:
            client.close()
