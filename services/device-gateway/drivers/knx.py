"""KNX/IP driver (xknx, MIT).

Lighting, blinds and HVAC in commercial buildings. A device here is one KNX
IP interface (tunnelling) or router (routing); its points are group
addresses with a datapoint type. One connection per interface is kept open
and shared, because KNX IP interfaces offer only a few tunnel slots.
"""

from __future__ import annotations

import asyncio
from typing import Callable

from .base import DeviceUnreachable, ProtocolDriver, ProtocolError, Reading, Value, as_number

_CONNECTION = {
    "tunneling": "TUNNELING",
    "tunneling_tcp": "TUNNELING_TCP",
    "routing": "ROUTING",
}


def default_xknx_factory(device):
    from xknx import XKNX
    from xknx.io import ConnectionConfig, ConnectionType

    kind = getattr(ConnectionType, _CONNECTION[device.connection])
    if device.connection == "routing":
        cfg = ConnectionConfig(connection_type=kind, multicast_group=device.address, multicast_port=device.port)
    else:
        cfg = ConnectionConfig(connection_type=kind, gateway_ip=device.address, gateway_port=device.port)
    return XKNX(connection_config=cfg)


def _transcoder(point):
    from xknx.dpt import DPTBase

    t = DPTBase.parse_transcoder(point.dpt)
    if t is None:
        raise ProtocolError(f"{point.id}: unknown datapoint type {point.dpt}")
    return t


def to_value(point, payload_value) -> Value:
    decoded = _transcoder(point).from_knx(payload_value)
    if point.kind == "boolean":
        return bool(decoded)
    if point.kind == "text":
        return str(decoded)
    return as_number(decoded)


async def _default_read(xknx, group_address: str, timeout: float):
    from xknx.core.value_reader import ValueReader
    from xknx.telegram import GroupAddress

    return await ValueReader(xknx, GroupAddress(group_address), timeout_in_seconds=timeout).read()


async def _default_send(xknx, group_address: str, knx_value) -> None:
    from xknx.telegram import GroupAddress, Telegram
    from xknx.telegram.apci import GroupValueWrite

    await xknx.telegrams.put(
        Telegram(destination_address=GroupAddress(group_address), payload=GroupValueWrite(knx_value))
    )


async def _default_scan(timeout: float) -> list:
    from xknx import XKNX
    from xknx.io import GatewayScanner

    return await GatewayScanner(XKNX(), timeout_in_seconds=timeout).scan()


class KnxDriver(ProtocolDriver):
    protocol = "knx"

    def __init__(
        self,
        timeout: float = 3.0,
        xknx_factory: Callable = default_xknx_factory,
        read=_default_read,
        send=_default_send,
        scan=_default_scan,
    ):
        self.timeout = timeout
        self._factory, self._read, self._send, self._scan = xknx_factory, read, send, scan
        self._conns: dict[tuple, object] = {}
        self._lock = asyncio.Lock()

    async def _xknx(self, device):
        key = (device.connection, device.address, device.port)
        async with self._lock:
            conn = self._conns.get(key)
            if conn is None:
                conn = self._factory(device)
                try:
                    await asyncio.wait_for(conn.start(), self.timeout)
                except Exception as e:
                    raise DeviceUnreachable(f"{device.id}: cannot open KNX {device.connection} to {device.address}: {e}") from e
                self._conns[key] = conn
            return conn

    async def stop(self) -> None:
        for conn in self._conns.values():
            await conn.stop()
        self._conns.clear()

    async def read_points(self, device, points):
        xknx = await self._xknx(device)
        out: dict[str, Reading] = {}
        for p in points:
            telegram = await self._read(xknx, p.state_address or p.group_address, self.timeout)
            if telegram is None:
                out[p.id] = Reading(error=f"{p.id}: no answer on {p.state_address or p.group_address}")
                continue
            try:
                out[p.id] = Reading(value=to_value(p, telegram.payload.value))
            except Exception as e:  # ConversionError on a mismatched DPT
                out[p.id] = Reading(error=f"{p.id}: {e}")
        return out

    async def write_point(self, device, point, value):
        xknx = await self._xknx(device)
        try:
            knx_value = _transcoder(point).to_knx(value)
        except Exception as e:
            raise ProtocolError(f"{point.id}: {value!r} does not fit DPT {point.dpt}: {e}") from e
        await self._send(xknx, point.group_address, knx_value)

    async def discover(self, timeout: float) -> list[dict]:
        found = []
        for gw in await self._scan(timeout):
            found.append({
                "protocol": "knx",
                "address": gw.ip_addr,
                "port": gw.port,
                "name": gw.name,
                "tunnelling": bool(gw.supports_tunnelling or gw.supports_tunnelling_tcp),
                "routing": bool(gw.supports_routing),
            })
        return found
