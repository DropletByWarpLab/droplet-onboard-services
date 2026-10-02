"""Driver registry: one driver instance per protocol."""

from __future__ import annotations

from .bacnet import BacnetDriver
from .base import ProtocolDriver
from .knx import KnxDriver
from .modbus import ModbusDriver
from .snmp import SnmpDriver


def create_drivers(timeout: float) -> dict[str, ProtocolDriver]:
    return {
        "bacnet": BacnetDriver(timeout=timeout),
        "modbus": ModbusDriver(timeout=timeout),
        "snmp": SnmpDriver(timeout=timeout),
        "knx": KnxDriver(timeout=timeout),
    }
