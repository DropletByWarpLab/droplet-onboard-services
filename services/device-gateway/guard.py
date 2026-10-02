"""Write guard: every write is planned here before any driver sees it.

The orchestrator also gates writes (Tier-2 confirmation + audit), but this
service runs network_mode: host on the LAN side of the Vault and talks to
unauthenticated field protocols, so it enforces its own rules at the layer
that performs the write — never trusting the caller to have checked:

  1. the point exists and is explicitly `writable`;
  2. the value's type matches the point's kind (a bool is never a number);
  3. a number is finite and inside the point's [min, max];
  4. text is at most TEXT_MAX characters.

`plan_write` returns the coerced value; main.py then applies it only when
DEVICE_GATEWAY_LIVE_WRITES is on (plan-only otherwise).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Union

from registry import TEXT_MAX

Value = Union[bool, int, float, str]


class WriteRejected(ValueError):
    """The write violates the point's contract. Maps to 422."""


class PointNotFound(LookupError):
    """No such point on the device. Maps to 404."""


@dataclass(frozen=True)
class WritePlan:
    device_id: str
    point_id: str
    protocol: str
    value: Value

    def as_dict(self) -> dict:
        return {
            "device_id": self.device_id,
            "point_id": self.point_id,
            "protocol": self.protocol,
            "value": self.value,
        }


def coerce(point, value: object) -> Value:
    if point.kind == "boolean":
        if not isinstance(value, bool):
            raise WriteRejected(f"{point.id} takes true or false")
        return value
    if point.kind == "text":
        if not isinstance(value, str):
            raise WriteRejected(f"{point.id} takes text")
        if len(value) > TEXT_MAX:
            raise WriteRejected(f"{point.id} takes at most {TEXT_MAX} characters")
        return value
    # number
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WriteRejected(f"{point.id} takes a number")
    if not math.isfinite(value):
        raise WriteRejected(f"{point.id} takes a finite number")
    if point.min is not None and value < point.min:
        raise WriteRejected(f"{point.id} must be at least {point.min:g}")
    if point.max is not None and value > point.max:
        raise WriteRejected(f"{point.id} must be at most {point.max:g}")
    return value


def plan_write(device, point_id: str, value: object) -> WritePlan:
    point = device.point(point_id)
    if point is None:
        raise PointNotFound(f"device {device.id} has no point {point_id}")
    if not point.writable:
        raise WriteRejected(f"{point_id} is read-only")
    return WritePlan(device.id, point_id, device.protocol, coerce(point, value))
