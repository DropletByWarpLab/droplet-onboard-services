"""Pydantic models for the switch service REST API."""

from pydantic import BaseModel, Field
from typing import Optional


# --- Response models ---

class HealthResponse(BaseModel):
    status: str
    connected: bool
    switch_host: str
    driver: str
    system_info: Optional[dict] = None
    error: Optional[str] = None


class PortStatus(BaseModel):
    port: int
    name: str
    enabled: bool
    link_up: bool
    speed: Optional[str] = None
    duplex: Optional[str] = None
    is_sfp: bool = False
    vlan: Optional[int] = None
    poe: Optional[dict] = None


class PoEPortStatus(BaseModel):
    port: int
    enabled: bool
    delivering: bool
    power_mw: float = 0
    class_: Optional[str] = Field(None, alias="class")
    max_power_mw: float = 30000


class VlanInfo(BaseModel):
    vlan_id: int
    name: str = ""
    ports: list[dict] = []


class VlanPortMembership(BaseModel):
    port: int
    tagged: bool = False
    member: bool = True


class WanDetectionResult(BaseModel):
    wan_port: int
    confidence: str
    reason: str
    link_up: bool = False


class SwitchSystemInfo(BaseModel):
    model: str
    firmware_version: str = ""
    mac_address: str = ""
    uptime: Optional[str] = None
    hostname: str = ""
    port_count: int = 10
    poe_budget_mw: Optional[float] = None
    driver: str = "lantronix"


# --- Request models ---

class CreateVlanRequest(BaseModel):
    vlan_id: int = Field(..., ge=2, le=4094)
    name: str = Field(default="", max_length=32)


class SetVlanMembershipRequest(BaseModel):
    ports: list[VlanPortMembership]


class SetPortPoeRequest(BaseModel):
    enabled: bool


class CameraSetupRequest(BaseModel):
    """One-click camera VLAN setup on the switch."""
    vlan_id: int = Field(default=100, ge=2, le=4094)
    camera_ports: list[int] = Field(default=[1, 2, 3, 4, 5, 6, 7, 8])
    uplink_ports: list[int] = Field(default=[9, 10])


class CameraSetupResult(BaseModel):
    status: str
    vlan_id: int
    camera_ports: list[int]
    uplink_ports: list[int]
    message: str
