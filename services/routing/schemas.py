"""Pydantic models for the routing service REST API."""

from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, Union


# --- Request models ---

class SetSsidRequest(BaseModel):
    radio: str = Field(default="radio0", description="Radio device name")
    iface_section: str = Field(default="default_radio0", description="Wireless interface UCI section")
    ssid: str = Field(..., min_length=1, max_length=32, description="New SSID name")


class SetPasswordRequest(BaseModel):
    iface_section: str = Field(default="default_radio0", description="Wireless interface UCI section")
    password: str = Field(..., min_length=8, max_length=63, description="New WiFi password")
    encryption: str = Field(default="sae-mixed", description="Encryption method")


class SetChannelRequest(BaseModel):
    radio_section: str = Field(default="radio0", description="Radio UCI section")
    channel: str = Field(..., description="Channel number or 'auto'")


class CreateGuestNetworkRequest(BaseModel):
    radio: str = Field(default="radio0", description="Radio device name")
    ssid: str = Field(..., min_length=1, max_length=32, description="Guest network SSID")
    password: str = Field(..., min_length=8, max_length=63, description="Guest network password")
    network: str = Field(default="guest", description="Network name for the guest zone")


class StaticLeaseRequest(BaseModel):
    name: str = Field(..., min_length=1, description="Friendly device name")
    mac: str = Field(..., pattern=r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$", description="MAC address")
    ip: str = Field(..., description="Static IP to assign")
    leasetime: str = Field(default="infinite", description="Lease duration")


class SetDnsRequest(BaseModel):
    servers: list[str] = Field(..., min_length=1, description="List of DNS server IPs")


# Hostname grammar: lowercase labels, up to 253 chars total, no trailing dot.
# The label regex rejects leading/trailing hyphens per RFC 1123. We keep it
# lowercase because dnsmasq treats hostnames case-insensitively anyway and
# normalizing on the way in avoids duplicate-section edge cases.
_HOSTNAME_PATTERN = r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"
_IPV4_PATTERN = r"^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$"


class DnsHostnameRequest(BaseModel):
    """Register (or update) a static hostname → IP in dnsmasq.

    Used to make the Droplet reachable at e.g. `droplet.lan` from any device
    using the OpenWrt router as its DNS server. Writes a UCI `config domain`
    section which dnsmasq reads as an `address=/host/ip` rule.
    """

    hostname: str = Field(..., min_length=1, max_length=253, pattern=_HOSTNAME_PATTERN,
                          description="Hostname to resolve (lowercase, e.g. 'droplet.lan')")
    ip: str = Field(..., pattern=_IPV4_PATTERN, description="IPv4 address the hostname should resolve to")


class BlockDeviceRequest(BaseModel):
    mac: str = Field(..., pattern=r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$", description="MAC address to block")
    name: Optional[str] = Field(default=None, description="Optional rule name")


class UnblockDeviceRequest(BaseModel):
    mac: str = Field(..., pattern=r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$", description="MAC address to unblock")


class PortForwardRequest(BaseModel):
    name: str = Field(..., min_length=1, description="Rule name")
    src_port: str = Field(..., description="External port")
    dest_ip: str = Field(..., description="Internal destination IP")
    dest_port: str = Field(..., description="Internal destination port")
    proto: str = Field(default="tcp", description="Protocol (tcp, udp, tcpudp)")


class ApplyConfigRequest(BaseModel):
    configs: list[str] = Field(..., min_length=1, description="Config names to apply (e.g. ['network', 'wireless'])")
    # WARP-41: 60s matches the orchestrator's confirmation token TTL so a Tier 2
    # token can never outlive the apply window on the router side.
    timeout: int = Field(default=60, ge=10, le=120, description="Rollback timeout in seconds")


class CreateVlanRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=15, pattern=r"^[a-z0-9_]+$", description="Interface name")
    vid: int = Field(..., ge=2, le=4094, description="VLAN ID (2-4094)")
    parent_device: str = Field(default="br-lan", description="Parent bridge device")
    ipaddr: str = Field(default=None, description="Gateway IP for the VLAN (e.g. 192.168.100.1)")
    netmask: str = Field(default="255.255.255.0", description="Subnet mask")


class CameraSubnetSetupRequest(BaseModel):
    """All-in-one camera subnet setup: VLAN + firewall zone + DHCP + rules."""
    vlan_id: int = Field(default=100, ge=2, le=4094, description="VLAN ID for camera subnet")
    subnet: str = Field(default="192.168.100.1", description="Gateway IP for camera subnet")
    netmask: str = Field(default="255.255.255.0", description="Subnet mask")
    dhcp_start: int = Field(default=100, ge=2, le=254, description="DHCP pool start")
    dhcp_limit: int = Field(default=150, ge=1, le=253, description="DHCP pool size")
    leasetime: str = Field(default="12h", description="DHCP lease duration")


# --- Response models ---

class HealthResponse(BaseModel):
    status: str
    connected: bool
    router_host: str
    board: Optional[dict] = None
    error: Optional[str] = None


class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None


# --- Firewall response models (WARP-42) ---
#
# These mirror the OpenWrt UCI section shape. Every field is optional because
# OpenWrt may omit keys when a default applies, and `extra="allow"` means the
# dashboard keeps working even if OpenWrt adds a new field we didn't anticipate.
# The inner `.anonymous`, `.type`, `.name` meta-keys are preserved as-is.


class FirewallZone(BaseModel):
    """A `config zone` section from /etc/config/firewall."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    name: Optional[str] = None
    # `network` can be a single string or a list in OpenWrt — uci returns
    # whatever is on disk. Keeping it loose at the type boundary.
    network: Optional[Union[str, list[str]]] = None
    input: Optional[str] = None
    output: Optional[str] = None
    forward: Optional[str] = None
    masq: Optional[str] = None


class FirewallRule(BaseModel):
    """A `config rule` section from /etc/config/firewall."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    name: Optional[str] = None
    src: Optional[str] = None
    dest: Optional[str] = None
    src_mac: Optional[str] = None
    proto: Optional[Union[str, list[str]]] = None
    src_port: Optional[str] = None
    dest_port: Optional[str] = None
    target: Optional[str] = None
    enabled: Optional[str] = None


class FirewallRedirect(BaseModel):
    """A `config redirect` (port-forward / NAT) section."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    name: Optional[str] = None
    src: Optional[str] = None
    dest: Optional[str] = None
    proto: Optional[Union[str, list[str]]] = None
    src_dport: Optional[str] = None
    dest_ip: Optional[str] = None
    dest_port: Optional[str] = None
    target: Optional[str] = None
    enabled: Optional[str] = None


class FirewallZoneCollection(BaseModel):
    """Wire shape of `GET /firewall/zones`."""

    model_config = ConfigDict(extra="allow")
    values: dict[str, FirewallZone] = Field(default_factory=dict)


class FirewallRuleCollection(BaseModel):
    model_config = ConfigDict(extra="allow")
    values: dict[str, FirewallRule] = Field(default_factory=dict)


class FirewallRedirectCollection(BaseModel):
    model_config = ConfigDict(extra="allow")
    values: dict[str, FirewallRedirect] = Field(default_factory=dict)
