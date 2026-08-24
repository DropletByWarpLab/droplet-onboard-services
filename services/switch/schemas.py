"""Pydantic models for the switch service REST API."""

from pydantic import BaseModel, Field
from typing import Literal, Optional


# --- Response models ---

class HealthResponse(BaseModel):
    status: str
    connected: bool
    switch_host: str
    driver: str
    # WARP-2111: NO `system_info` field. /health is auth-exempt on a
    # 0.0.0.0:8081 host-network bind, so echoing get_system_info() (switch
    # model, firmware, MAC, hostname) leaked hardware inventory to any
    # unauthenticated LAN client. The detail is served by the bearer-gated
    # GET /system/info; /health is liveness + auth-config only.
    error: Optional[str] = None
    # Whether SERVICE_SECRET is set (presence ONLY — never the value). /health is
    # auth-exempt, so it can falsely read "ok" while every privileged route is
    # failing closed (403) on a missing secret; this lets the orchestrator
    # health check warn that auth is unconfigured. Defaults True (assume
    # configured) for the SWITCH_ALLOW_NO_AUTH dev path, where it is irrelevant.
    auth_configured: bool = True


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
    driver: str = "openwrt"


# --- Request models ---

class CreateVlanRequest(BaseModel):
    vlan_id: int = Field(..., ge=2, le=4094)
    name: str = Field(default="", max_length=32)


class SetVlanMembershipRequest(BaseModel):
    """A VLAN membership write, with its INTENT declared rather than guessed.

    `mode` exists because the two intents look identical on the wire — a
    one-element list is both "move this port here" and "this VLAN now has
    exactly one member" — and getting it wrong in the second direction strands
    the fabric (replacing VLAN 1's member list drops the uplink, the AP and the
    appliance, which have no remote recovery).

    * ``merge`` (default) — every entry is an ACCESS move: the port becomes the
      VLAN's untagged member and every other member is preserved. Entries that
      cannot be expressed as an access move (``tagged`` or ``member: false``)
      are refused with a 400 that names ``replace``, so a full-membership
      caller is never silently downgraded to merge semantics.
    * ``replace`` — write the whole member list (the historical behaviour).

    Merge is the default because the blast radii are not symmetric: a wrong
    merge leaves a stale member (visible, fixable with an explicit replace); a
    wrong replace needs a rack visit.
    """

    ports: list[VlanPortMembership]
    mode: Literal["merge", "replace"] = "merge"


class SetPortPoeRequest(BaseModel):
    enabled: bool


class CameraSetupRequest(BaseModel):
    """One-click camera VLAN setup on the switch.

    WARP-2165: the port defaults used to be the literals [1..8] and [9, 10] —
    the copper bank and SFP cage of a GS1900-10HP. That is a property of one
    variant, not of the fleet, so an 8HP got a trunk of two ports it does not
    have. Both now default to EMPTY, which the endpoint reads as "derive from
    the device": uplinks = the unit's SFP ports, cameras = the remaining
    copper ports minus the protected uplink. Callers that know better still
    pass explicit lists.
    """
    vlan_id: int = Field(default=100, ge=2, le=4094)
    camera_ports: list[int] = Field(default_factory=list)
    uplink_ports: list[int] = Field(default_factory=list)


class CameraSetupResult(BaseModel):
    status: str
    vlan_id: int
    camera_ports: list[int]
    uplink_ports: list[int]
    message: str
    # WARP-1176 (PYNET-001): machine-readable plan-only signal. status
    # ("planned" vs "ok") and the message already say it in prose, but every
    # other switch write response carries an explicit dry_run boolean —
    # consumers (orchestrator, dashboard, the setup_camera_ports LLM tool)
    # must never have to parse the message to learn nothing was written.
    dry_run: bool = False


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
