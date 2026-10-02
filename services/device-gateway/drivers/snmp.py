"""SNMP v2c / v3 driver (pysnmp, BSD-2-Clause).

The office-device protocol: printers (Printer-MIB supply levels, alerts),
UPSes (UPS-MIB), PDUs and environment sensors. Writes are SNMP SETs of an
INTEGER (numbers; booleans as TruthValue 1/2) or an OCTET STRING (text).
"""

from __future__ import annotations

from typing import Callable, Optional

from pysnmp.hlapi.v3arch.asyncio import (
    CommunityData,
    ContextData,
    Integer32,
    ObjectIdentity,
    ObjectType,
    OctetString,
    SnmpEngine,
    UdpTransportTarget,
    UsmUserData,
    get_cmd,
    set_cmd,
    usmAesCfb128Protocol,
    usmAesCfb256Protocol,
    usmHMAC192SHA256AuthProtocol,
    usmHMAC384SHA512AuthProtocol,
    usmHMACSHAAuthProtocol,
    usmNoAuthProtocol,
    usmNoPrivProtocol,
)
from pysnmp.proto.rfc1905 import EndOfMibView, NoSuchInstance, NoSuchObject

from .base import DeviceUnreachable, ProtocolDriver, ProtocolError, Reading, Value, scaled

_AUTH = {
    "sha": usmHMACSHAAuthProtocol,
    "sha256": usmHMAC192SHA256AuthProtocol,
    "sha512": usmHMAC384SHA512AuthProtocol,
}
_PRIV = {"aes128": usmAesCfb128Protocol, "aes256": usmAesCfb256Protocol}

# TruthValue (SNMPv2-TC): true(1), false(2).
_TRUE, _FALSE = 1, 2


def _secret(v) -> Optional[str]:
    return v.get_secret_value() if v is not None else None


def auth_data(device):
    if device.version == "2c":
        community = _secret(device.community)
        if not community:
            raise ProtocolError(f"{device.id}: no SNMP community configured")
        return CommunityData(community, mpModel=1)
    auth_key, priv_key = _secret(device.auth_key), _secret(device.priv_key)
    return UsmUserData(
        device.user,
        authKey=auth_key,
        privKey=priv_key,
        authProtocol=_AUTH[device.auth_protocol] if auth_key else usmNoAuthProtocol,
        privProtocol=_PRIV[device.priv_protocol] if priv_key else usmNoPrivProtocol,
    )


def to_value(point, raw) -> Value:
    if isinstance(raw, (NoSuchObject, NoSuchInstance, EndOfMibView)):
        raise ProtocolError(f"{point.oid}: no such object on this device")
    if point.kind == "text":
        if isinstance(raw, OctetString):
            return raw.asOctets().decode("utf-8", errors="replace")
        return raw.prettyPrint()
    try:
        n = int(raw)
    except (TypeError, ValueError) as e:
        raise ProtocolError(f"{point.oid}: not a number ({raw.prettyPrint()})") from e
    if point.kind == "boolean":
        if n not in (_TRUE, _FALSE):
            raise ProtocolError(f"{point.oid}: {n} is not a TruthValue")
        return n == _TRUE
    return scaled(n, point.scale)


def to_snmp(point, value: Value):
    if point.kind == "text":
        # Bytes, not str: pysnmp encodes a str as latin-1.
        return OctetString(str(value).encode("utf-8"))
    if point.kind == "boolean":
        return Integer32(_TRUE if value else _FALSE)
    raw = round(value / point.scale)  # type: ignore[operator]
    return Integer32(raw)


Transport = Callable[..., object]


async def _get(engine, auth, target, oid: str):
    return await get_cmd(engine, auth, target, ContextData(), ObjectType(ObjectIdentity(oid)))


async def _set(engine, auth, target, oid: str, value):
    return await set_cmd(engine, auth, target, ContextData(), ObjectType(ObjectIdentity(oid), value))


class SnmpDriver(ProtocolDriver):
    protocol = "snmp"

    def __init__(
        self,
        timeout: float = 3.0,
        get=_get,
        set_=_set,
        transport: Transport = UdpTransportTarget.create,
    ):
        self.timeout = timeout
        self._get, self._set, self._transport = get, set_, transport
        self._engine: Optional[SnmpEngine] = None

    async def start(self) -> None:
        self._engine = SnmpEngine()

    async def stop(self) -> None:
        if self._engine is not None:
            self._engine.close_dispatcher()
            self._engine = None

    def _eng(self) -> SnmpEngine:
        if self._engine is None:
            self._engine = SnmpEngine()
        return self._engine

    async def _target(self, device):
        try:
            return await self._transport((device.address, device.port), timeout=self.timeout, retries=1)
        except Exception as e:  # DNS / socket failures
            raise DeviceUnreachable(f"{device.id}: {e}") from e

    @staticmethod
    def _check(device, err_ind, err_status, err_index):
        if err_ind:
            # pysnmp reports timeouts as an error indication, not an exception.
            raise DeviceUnreachable(f"{device.id}: {err_ind}")
        if err_status:
            raise ProtocolError(f"{device.id}: {err_status.prettyPrint()} at index {int(err_index)}")

    async def read_points(self, device, points):
        auth, target = auth_data(device), await self._target(device)
        out: dict[str, Reading] = {}
        for p in points:
            err_ind, err_status, err_index, binds = await self._get(self._eng(), auth, target, p.oid)
            if err_ind:
                raise DeviceUnreachable(f"{device.id}: {err_ind}")
            try:
                self._check(device, None, err_status, err_index)
                out[p.id] = Reading(value=to_value(p, binds[0][1]))
            except ProtocolError as e:
                out[p.id] = Reading(error=str(e))
        return out

    async def write_point(self, device, point, value):
        auth, target = auth_data(device), await self._target(device)
        err_ind, err_status, err_index, _ = await self._set(
            self._eng(), auth, target, point.oid, to_snmp(point, value)
        )
        self._check(device, err_ind, err_status, err_index)
