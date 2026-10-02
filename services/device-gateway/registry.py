"""Device + point registry for the device gateway.

The registry is the ONLY source of what the gateway may touch. A device is a
controller reachable over one protocol; a point is one named value on it (a
BACnet object property, a Modbus register, an SNMP OID, a KNX group address).

Write safety lives here as data, not as inference:
  * a point is writable only when `writable` is explicitly true;
  * a writable number MUST declare `min` and `max` (checked at registration,
    re-checked by guard.py on every write);
  * protocol rules that make a write meaningless are rejected at registration
    (a Modbus input register or discrete input cannot be written; BACnet
    priorities 1-7 are life-safety / critical / minimum-on-off and are never
    offered to the AI).

Secrets (SNMP community / v3 keys) are stored in the registry file (0600,
Vault volume) and are redacted on every API read. A PUT that omits a secret
keeps the stored one, so the dashboard can edit a device without re-entering it.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Annotated, Literal, Optional, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    SerializationInfo,
    TypeAdapter,
    field_serializer,
    field_validator,
    model_validator,
)

SLUG = r"^[a-z0-9][a-z0-9_-]{0,63}$"
TEXT_MAX = 255

PointKind = Literal["number", "boolean", "text"]
Protocol = Literal["bacnet", "modbus", "snmp", "knx"]
PROTOCOLS: tuple[str, ...] = ("bacnet", "modbus", "snmp", "knx")


class PointBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=SLUG)
    name: str = Field(min_length=1, max_length=120)
    kind: PointKind = "number"
    unit: Optional[str] = Field(default=None, max_length=32)
    writable: bool = False
    min: Optional[float] = None
    max: Optional[float] = None

    @model_validator(mode="after")
    def _bounds(self):
        if self.min is not None and self.max is not None and self.min >= self.max:
            raise ValueError(f"point {self.id}: min must be below max")
        if self.writable and self.kind == "number" and (self.min is None or self.max is None):
            raise ValueError(
                f"point {self.id}: a writable number needs both min and max"
            )
        return self


class ModbusPoint(PointBase):
    table: Literal["holding", "input", "coil", "discrete"] = "holding"
    address: int = Field(ge=0, le=65535)
    data_type: Literal["int16", "uint16", "int32", "uint32", "float32"] = "uint16"
    word_order: Literal["big", "little"] = "big"
    scale: float = 1.0

    @model_validator(mode="after")
    def _table_rules(self):
        bit_table = self.table in ("coil", "discrete")
        if bit_table and self.kind != "boolean":
            raise ValueError(f"point {self.id}: {self.table} points are boolean")
        if not bit_table and self.kind == "boolean":
            raise ValueError(f"point {self.id}: register points are numbers")
        if self.kind == "text":
            raise ValueError(f"point {self.id}: Modbus text points are not supported")
        if self.writable and self.table in ("input", "discrete"):
            raise ValueError(f"point {self.id}: {self.table} tables are read-only")
        if self.scale == 0:
            raise ValueError(f"point {self.id}: scale cannot be 0")
        return self


class SnmpPoint(PointBase):
    oid: str = Field(pattern=r"^\.?\d+(\.\d+)+$")
    scale: float = 1.0

    @field_validator("scale")
    @classmethod
    def _nonzero(cls, v: float) -> float:
        if v == 0:
            raise ValueError("scale cannot be 0")
        return v


# BACnet write priorities 1-7 are manual life safety, automatic life safety,
# (3-5 critical equipment control), minimum on/off (6) and 7. The AI never
# writes above "manual operator" (8); 16 (lowest) is the default.
BACNET_MIN_PRIORITY = 8


class BacnetPoint(PointBase):
    object: str = Field(pattern=r"^[a-z][a-z-]*,\d+$")
    property: str = Field(default="present-value", pattern=r"^[a-z][a-z-]*$")
    priority: int = Field(default=16, ge=BACNET_MIN_PRIORITY, le=16)


class KnxPoint(PointBase):
    group_address: str
    state_address: Optional[str] = None
    dpt: str = Field(min_length=1, max_length=32)

    @field_validator("group_address", "state_address")
    @classmethod
    def _ga(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        from xknx.telegram import GroupAddress

        try:
            GroupAddress(v)
        except Exception as e:  # xknx raises its own CouldNotParseAddress
            raise ValueError(f"invalid KNX group address {v!r}") from e
        return v

    @field_validator("dpt")
    @classmethod
    def _dpt(cls, v: str) -> str:
        from xknx.dpt import DPTBase

        if DPTBase.parse_transcoder(v) is None:
            raise ValueError(f"unknown KNX datapoint type {v!r}")
        return v


class DeviceBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=SLUG)
    name: str = Field(min_length=1, max_length=120)
    address: str = Field(min_length=1, max_length=255)
    room: Optional[str] = Field(default=None, max_length=64)
    template: Optional[str] = Field(default=None, max_length=32)

    @model_validator(mode="after")
    def _unique_points(self):
        ids = [p.id for p in self.points]  # type: ignore[attr-defined]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"duplicate point ids: {sorted(dupes)}")
        return self

    def point(self, point_id: str):
        for p in self.points:  # type: ignore[attr-defined]
            if p.id == point_id:
                return p
        return None


class ModbusDevice(DeviceBase):
    protocol: Literal["modbus"]
    port: int = Field(default=502, ge=1, le=65535)
    unit_id: int = Field(default=1, ge=0, le=255)
    points: list[ModbusPoint] = Field(default_factory=list, max_length=256)


SECRET_FIELDS = ("community", "auth_key", "priv_key")
REDACTED = "********"


class SnmpDevice(DeviceBase):
    protocol: Literal["snmp"]
    port: int = Field(default=161, ge=1, le=65535)
    version: Literal["2c", "3"] = "2c"
    community: Optional[SecretStr] = None
    user: Optional[str] = Field(default=None, max_length=64)
    auth_protocol: Literal["sha", "sha256", "sha512"] = "sha256"
    auth_key: Optional[SecretStr] = None
    priv_protocol: Literal["aes128", "aes256"] = "aes128"
    priv_key: Optional[SecretStr] = None
    points: list[SnmpPoint] = Field(default_factory=list, max_length=256)

    @model_validator(mode="after")
    def _creds(self):
        if self.version == "3" and not self.user:
            raise ValueError("SNMPv3 needs a user")
        return self

    @field_serializer(*SECRET_FIELDS, when_used="always")
    def _secret(self, v: Optional[SecretStr], info: SerializationInfo):
        if v is None:
            return None
        if (info.context or {}).get("reveal"):
            return v.get_secret_value()
        return REDACTED


class BacnetDevice(DeviceBase):
    protocol: Literal["bacnet"]
    device_instance: Optional[int] = Field(default=None, ge=0, le=4194302)
    points: list[BacnetPoint] = Field(default_factory=list, max_length=256)


class KnxDevice(DeviceBase):
    protocol: Literal["knx"]
    connection: Literal["tunneling", "tunneling_tcp", "routing"] = "tunneling"
    port: int = Field(default=3671, ge=1, le=65535)
    points: list[KnxPoint] = Field(default_factory=list, max_length=256)


Device = Annotated[
    Union[ModbusDevice, SnmpDevice, BacnetDevice, KnxDevice],
    Field(discriminator="protocol"),
]
DeviceAdapter: TypeAdapter = TypeAdapter(Device)
_DeviceList: TypeAdapter = TypeAdapter(list[Device])


def public(device) -> dict:
    """The API shape: secrets redacted."""
    return device.model_dump(mode="json")


class Registry:
    """JSON-file-backed registry. Writes are atomic (temp file + rename, 0600)."""

    def __init__(self, path: str | os.PathLike):
        self.path = Path(path)
        self._devices: dict[str, object] = {}
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            self._devices = {}
            return
        raw = json.loads(self.path.read_text() or "[]")
        self._devices = {d.id: d for d in _DeviceList.validate_python(raw)}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = [
            d.model_dump(mode="json", context={"reveal": True})
            for d in self._devices.values()
        ]
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".registry-")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=2)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def all(self) -> list:
        return list(self._devices.values())

    def get(self, device_id: str):
        return self._devices.get(device_id)

    def put(self, device) -> bool:
        """Create or replace. Returns True when created. Omitted secrets are
        carried over from the stored device of the same protocol."""
        existing = self._devices.get(device.id)
        if isinstance(existing, SnmpDevice) and isinstance(device, SnmpDevice):
            keep = {
                f: getattr(existing, f)
                for f in SECRET_FIELDS
                if getattr(device, f) is None and getattr(existing, f) is not None
            }
            if keep:
                device = device.model_copy(update=keep)
        self._devices[device.id] = device
        self._save()
        return existing is None

    def delete(self, device_id: str) -> bool:
        if device_id not in self._devices:
            return False
        del self._devices[device_id]
        self._save()
        return True


def validate_device(payload: dict):
    """Parse a device body. Raises pydantic.ValidationError."""
    return DeviceAdapter.validate_python(payload)


_SLUG_RE = re.compile(SLUG)


def is_slug(s: str) -> bool:
    return bool(_SLUG_RE.match(s))
