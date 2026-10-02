"""Protocol driver interface.

One driver per protocol. A driver never decides WHETHER a write is allowed —
guard.py does, before the driver is called — it only knows HOW to talk to
the device. Reads are per point: one bad register must not hide the rest of
the device, so `read_points` returns a reading (value or error) per point and
raises only when the device itself cannot be reached.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional, Union

Value = Union[bool, int, float, str]


class DriverError(Exception):
    """Base for driver failures."""


class DeviceUnreachable(DriverError):
    """The device did not answer (connect/timeout). Maps to 502."""


class ProtocolError(DriverError):
    """The device answered with an error. Maps to 502."""


class DiscoveryUnsupported(DriverError):
    """The protocol has no discovery (Modbus, SNMP). Maps to 400."""


@dataclass
class Reading:
    value: Optional[Value] = None
    error: Optional[str] = None

    def as_dict(self) -> dict:
        return {"value": self.value, "error": self.error}


def scaled(raw: Union[int, float], scale: float) -> Union[int, float]:
    """Apply a read scale; keep ints when the scale is 1."""
    if scale == 1:
        return raw
    return round(raw * scale, 6)


def as_number(value: object) -> Union[int, float]:
    """Protocol libraries subclass int/float; hand back plain ones."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return int(value)
    return float(value)  # type: ignore[arg-type]


class ProtocolDriver(ABC):
    protocol: str = ""

    async def start(self) -> None:
        """Open long-lived resources (a BACnet socket, KNX tunnels)."""

    async def stop(self) -> None:
        """Release them."""

    @abstractmethod
    async def read_points(self, device, points: list) -> dict[str, Reading]:
        """Read each point. Raise DeviceUnreachable only for the device."""

    @abstractmethod
    async def write_point(self, device, point, value: Value) -> None:
        """Write one already-guarded value."""

    async def discover(self, timeout: float) -> list[dict]:
        raise DiscoveryUnsupported(f"{self.protocol} has no discovery")
