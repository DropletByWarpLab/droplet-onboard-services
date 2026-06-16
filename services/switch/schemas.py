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


# --- Bring-up provisioning (ADR-018 item 9) ---

class ProvisionRequest(BaseModel):
    """Optional overrides for an event-driven re-run of the bring-up
    provisioner via POST /provision. All fields default to the env-derived
    config (build_provision_config); a caller can force a one-off profile
    without changing the service env."""

    profile: Optional[str] = Field(
        default=None,
        description="flat-lan | segmented. Defaults to SWITCH_VLAN_PROFILE.",
    )


class ProvisionConfigResponse(BaseModel):
    """Read-only echo of the bring-up provisioning config + persisted state.

    Feeds the orchestrator §7 /api/switch/status aggregation (ADR-018 item 12).
    All desired-state values are EXPLICIT (env-derived); last_provisioned_at is
    the persisted reconcile stamp (None until the first successful reconcile).
    """

    vlan_profile: str
    auto_managed: bool
    protected_port: int
    camera_ports: list[int] = []
    ap_ports: list[int] = []
    client_ports: list[int] = []
    poe_budget_w: int
    last_provisioned_at: Optional[str] = None


class ProvisionResult(BaseModel):
    """Outcome of a reconcile_switch run.

    status: noop | applied | refused | skipped | error
      - noop:    already at desired state
      - applied: one or more ports moved
      - refused: segmented requested but camera-VLAN routing absent (stayed
                 flat-lan)
      - skipped: switch absent / unreadable
      - error:   a write didn't verify on read-back
    profile_applied: the profile actually enforced (segmented downgrades to
                     flat-lan on a refusal).
    ports_changed: access ports moved to their desired VLAN.
    skipped_reason: human-readable cause for refused/skipped/error.
    """

    status: str
    profile_applied: str
    ports_changed: list[int] = []
    skipped_reason: Optional[str] = None
