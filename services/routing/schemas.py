"""Pydantic models for the routing service REST API."""

import os
import re

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from typing import Optional, Union


# ---------------------------------------------------------------------------
# Wireless defaults are deployment-shape-specific and MUST NOT be hardcoded.
#
# The historical `radio0` / `default_radio0` / `wlan0` literals only ever
# matched a long-gone build. The shipped router host runs an MT7922 whose
# radio section is `radio3` / `default_radio3` (see
# openwrt/files/etc/config/wireless); a single-box's radio enumerates as
# `wlp14s0`/similar. Defaulting writes (`/wireless/ssid`, `/wireless/channel`,
# AP approve) to `radio0`/`default_radio0` therefore `uci set`s a section that
# doesn't exist on the real router → ubus NOT_FOUND or an orphan section that
# never reaches a radio. That is the "no host-specific hardcoded defaults;
# must be shape-agnostic or configured" rule (NET-02).
#
# Resolution order: explicit per-request field > deployment env > last-resort
# literal. The shipped compose sets DROPLET_WIFI_* for its shape; a future
# follow-up can auto-detect the active radio/device from `wireless.status()`
# / `iwinfo` and drop the literal fallback entirely.
_DEFAULT_WIFI_RADIO = os.environ.get("DROPLET_WIFI_RADIO", "radio0")
_DEFAULT_WIFI_IFACE_SECTION = os.environ.get(
    "DROPLET_WIFI_IFACE_SECTION", "default_radio0"
)


# --- Request models ---

class SetSsidRequest(BaseModel):
    radio: str = Field(default_factory=lambda: _DEFAULT_WIFI_RADIO, description="Radio device name")
    iface_section: str = Field(default_factory=lambda: _DEFAULT_WIFI_IFACE_SECTION, description="Wireless interface UCI section")
    ssid: str = Field(..., min_length=1, max_length=32, description="New SSID name")


class SetPasswordRequest(BaseModel):
    iface_section: str = Field(default_factory=lambda: _DEFAULT_WIFI_IFACE_SECTION, description="Wireless interface UCI section")
    password: str = Field(..., min_length=8, max_length=63, description="New WiFi password")
    encryption: str = Field(default="sae-mixed", description="Encryption method")


class SetChannelRequest(BaseModel):
    radio_section: str = Field(default_factory=lambda: _DEFAULT_WIFI_RADIO, description="Radio UCI section")
    channel: str = Field(..., description="Channel number or 'auto'")


class CreateGuestNetworkRequest(BaseModel):
    radio: str = Field(default_factory=lambda: _DEFAULT_WIFI_RADIO, description="Radio device name")
    ssid: str = Field(..., min_length=1, max_length=32, description="Guest network SSID")
    password: str = Field(..., min_length=8, max_length=63, description="Guest network password")
    network: str = Field(default="guest", description="Network name for the guest zone")


class SetUpnpRequest(BaseModel):
    enabled: bool = Field(..., description="Enable UPnP + NAT-PMP automatic port opening")


class StaticLeaseRequest(BaseModel):
    name: str = Field(..., min_length=1, description="Friendly device name")
    mac: str = Field(..., pattern=r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$", description="MAC address")
    ip: str = Field(..., description="Static IP to assign")
    leasetime: str = Field(default="infinite", description="Lease duration")


class SetDnsRequest(BaseModel):
    servers: list[str] = Field(..., min_length=1, description="List of DNS server IPs")


# dnsmasq lease-time grammar: a positive integer followed by a unit
# (s/m/h/d/w — seconds/minutes/hours/days/weeks), or the literal `infinite`.
# Mirrors what dnsmasq's `--dhcp-range` lease-time field accepts; a bad string
# is silently ignored by dnsmasq, so we reject it at the boundary (a clean 422)
# rather than write junk the box quietly drops.
_LEASETIME_PATTERN = re.compile(r"^(infinite|\d+[smhdw])$")


class DhcpPoolRequest(BaseModel):
    """Reshape the LAN DHCP pool range + lease time (`dhcp lan` section).

    `start`/`limit` bounds copy CameraSubnetSetupRequest's pool fields: start is
    the first host octet handed out (2-254), limit is how many addresses the
    pool spans (1-253). `leasetime` accepts dnsmasq formats only.
    """

    start: int = Field(..., ge=2, le=254, description="First host octet in the pool")
    limit: int = Field(..., ge=1, le=253, description="Number of addresses in the pool")
    leasetime: str = Field(
        default="12h",
        description="Lease duration: a dnsmasq value like '12h', '30m', or 'infinite'",
    )

    @field_validator("leasetime")
    @classmethod
    def _check_leasetime(cls, v: str) -> str:
        if not _LEASETIME_PATTERN.match(v):
            raise ValueError(
                "leasetime must be a dnsmasq value like '12h', '30m', or 'infinite'"
            )
        return v


# Hostname grammar: lowercase labels, up to 253 chars total, no trailing dot.
# The label regex rejects leading/trailing hyphens per RFC 1123. We keep it
# lowercase because dnsmasq treats hostnames case-insensitively anyway and
# normalizing on the way in avoids duplicate-section edge cases.
_HOSTNAME_PATTERN = r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"
_IPV4_PATTERN = r"^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$"
# A single TCP/UDP port or a `lo-hi` range. The pattern bounds the shape
# (1-5 digits, optional `-range`); the field_validator below enforces the
# numeric 1-65535 bounds and lo<=hi that a regex can't express cleanly.
_PORT_OR_RANGE_PATTERN = r"^\d{1,5}(-\d{1,5})?$"


def _validate_port_or_range(value: str) -> str:
    """Enforce that each port in a single-port or `lo-hi` range is 1-65535
    and (for ranges) lo <= hi. Raises ValueError → pydantic 422."""
    parts = value.split("-")
    nums = []
    for p in parts:
        n = int(p)  # pattern already guarantees digits
        if not (1 <= n <= 65535):
            raise ValueError(f"port {n} out of range (1-65535)")
        nums.append(n)
    if len(nums) == 2 and nums[0] > nums[1]:
        raise ValueError(f"port range start {nums[0]} > end {nums[1]}")
    return value


class DnsHostnameRequest(BaseModel):
    """Register (or update) a static hostname → IP in dnsmasq.

    Used to make the Droplet reachable at e.g. `droplet.lan` from any device
    using the OpenWrt router as its DNS server. Writes a UCI `config domain`
    section which dnsmasq reads as an `address=/host/ip` rule.
    """

    hostname: str = Field(..., min_length=1, max_length=253, pattern=_HOSTNAME_PATTERN,
                          description="Hostname to resolve (lowercase, e.g. 'droplet.lan')")
    ip: str = Field(..., pattern=_IPV4_PATTERN, description="IPv4 address the hostname should resolve to")


class HostnameRequest(BaseModel):
    """Change the system hostname (`system @system[0] hostname`).

    Reuses the same RFC-1123 label grammar as DnsHostnameRequest. A hostname
    change re-keys mDNS/.local + the dashboard status line, so the orchestrator
    gates it Tier 2 (confirmable) — this schema just validates the shape.
    """

    hostname: str = Field(
        ..., min_length=1, max_length=63, pattern=_HOSTNAME_PATTERN,
        description="New hostname (lowercase RFC-1123 label, e.g. 'studio-droplet')",
    )


class NtpRequest(BaseModel):
    """Toggle the in-container OpenWrt time daemon (sysntpd)."""

    enabled: bool = Field(..., description="Enable the appliance's OpenWrt NTP daemon")


class SysupgradeRequest(BaseModel):
    """KAN-8 — flash a staged OpenWrt sysupgrade image. BRICK RISK.

    `image_path` is the path of an image already staged on the router (e.g. under
    `/tmp`); this schema only validates the request shape. The owner-only Tier-3
    confirm AND the PRIMARY_ROUTER deployment-shape gate are enforced in the
    orchestrator ABOVE this route — the routing service is the SDK's HTTP face.
    """

    image_path: str = Field(
        ..., min_length=1, max_length=512,
        description="Path of the staged sysupgrade image on the router (e.g. /tmp/...img.gz)",
    )
    preserve_config: bool = Field(
        default=True,
        description="Keep /etc/config across the flash (sysupgrade -v); False adds -n for a clean flash",
    )


class BlockDeviceRequest(BaseModel):
    mac: str = Field(..., pattern=r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$", description="MAC address to block")
    name: Optional[str] = Field(default=None, description="Optional rule name")


class UnblockDeviceRequest(BaseModel):
    mac: str = Field(..., pattern=r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$", description="MAC address to unblock")


class PortForwardRequest(BaseModel):
    """NET-09: validate the only previously-unvalidated network mutator.

    Port-forwarding exposes WAN ingress, so loose validation here is the
    riskiest place to skip it. `dest_ip` must be a literal IPv4 (reusing
    the same `_IPV4_PATTERN` as DnsHostnameRequest), and the port fields
    must be a single port or a `lo-hi` range with each endpoint in
    1-65535 — rejecting hostnames, CIDRs, whitespace, and garbage with a
    clean 422 instead of silently writing a broken/never-matching DNAT
    rule into UCI. This is validation only; no port forward is created.
    """

    name: str = Field(..., min_length=1, max_length=63, description="Rule name")
    src_port: str = Field(
        ..., pattern=_PORT_OR_RANGE_PATTERN,
        description="External port or 'lo-hi' range (1-65535)",
    )
    dest_ip: str = Field(
        ..., pattern=_IPV4_PATTERN, description="Internal destination IPv4"
    )
    dest_port: str = Field(
        ..., pattern=_PORT_OR_RANGE_PATTERN,
        description="Internal destination port or 'lo-hi' range (1-65535)",
    )
    proto: str = Field(default="tcp", description="Protocol (tcp, udp, tcpudp)")

    @field_validator("src_port", "dest_port")
    @classmethod
    def _check_port_bounds(cls, v: str) -> str:
        return _validate_port_or_range(v)

    @field_validator("proto")
    @classmethod
    def _check_proto(cls, v: str) -> str:
        allowed = {"tcp", "udp", "tcpudp"}
        if v not in allowed:
            raise ValueError(f"proto must be one of {sorted(allowed)}")
        return v


_FW_TARGETS = {"ACCEPT", "REJECT", "DROP"}


class AddFirewallRuleRequest(BaseModel):
    """A generic firewall traffic rule. `target` and `proto` are validated at the
    boundary so a malformed value can never reach UCI + choke a firewall reload."""

    name: str = Field(..., min_length=1, max_length=63, description="Rule name")
    src: str = Field(..., min_length=1, max_length=32, description="Source zone")
    dest: str = Field(..., min_length=1, max_length=32, description="Destination zone")
    proto: str = Field(default="tcp", description="Protocol (tcp, udp, tcpudp)")
    dest_port: Optional[str] = Field(
        default=None, pattern=_PORT_OR_RANGE_PATTERN,
        description="Destination port or 'lo-hi' range (1-65535)",
    )
    src_port: Optional[str] = Field(
        default=None, pattern=_PORT_OR_RANGE_PATTERN,
        description="Source port or 'lo-hi' range (1-65535)",
    )
    target: str = Field(default="REJECT", description="ACCEPT | REJECT | DROP")
    enabled: str = Field(default="1", description="'1' enabled, '0' disabled")

    @field_validator("proto")
    @classmethod
    def _check_proto(cls, v: str) -> str:
        allowed = {"tcp", "udp", "tcpudp"}
        if v not in allowed:
            raise ValueError(f"proto must be one of {sorted(allowed)}")
        return v

    @field_validator("target")
    @classmethod
    def _check_target(cls, v: str) -> str:
        if v not in _FW_TARGETS:
            raise ValueError(f"target must be one of {sorted(_FW_TARGETS)}")
        return v

    @field_validator("enabled")
    @classmethod
    def _check_enabled(cls, v: str) -> str:
        if v not in {"0", "1"}:
            raise ValueError("enabled must be '0' or '1'")
        return v


class SetZonePolicyRequest(BaseModel):
    """Set a zone's default input/output/forward policy. Each policy field is
    optional (only the provided ones change) and restricted to the UCI targets."""

    zone: str = Field(..., min_length=1, max_length=32, description="Zone name")
    input: Optional[str] = Field(default=None, description="ACCEPT | REJECT | DROP")
    output: Optional[str] = Field(default=None, description="ACCEPT | REJECT | DROP")
    forward: Optional[str] = Field(default=None, description="ACCEPT | REJECT | DROP")

    @field_validator("input", "output", "forward")
    @classmethod
    def _check_policy(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in _FW_TARGETS:
            raise ValueError(f"policy must be one of {sorted(_FW_TARGETS)}")
        return v

    @model_validator(mode="after")
    def _at_least_one_policy(self) -> "SetZonePolicyRequest":
        if self.input is None and self.output is None and self.forward is None:
            raise ValueError("at least one of input, output, or forward must be provided")
        return self


# WARP-613: phone-home egress control.
class PhoneHomeDeviceRequest(BaseModel):
    mac: str = Field(..., pattern=r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$", description="MAC address")
    blocked: bool = Field(..., description="True to block phone-home (WAN egress), False to restore")


class PhoneHomeCamerasRequest(BaseModel):
    blocked: bool = Field(..., description="True to block the camera VLAN from phoning home, False to restore")


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


# ---------------------------------------------------------------------------
# Interface Add / Edit (KAN-10)
# ---------------------------------------------------------------------------
# UCI `config interface` section name: lowercase letters, digits, underscores —
# the same grammar CreateVlanRequest.name uses, so a name the SDK can `uci set`.
_INTERFACE_NAME_PATTERN = r"^[a-z0-9_]+$"
# Logical L2 device (bridge / vlan / ethernet). Conservative shell-safe charset:
# alnum plus the device punctuation OpenWrt uses (`-`, `.`, `_`, `@`). Bounds the
# shape; the SDK normalises nothing here — a bad device fails honestly at apply.
_DEVICE_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._@-]{0,30}$"
# The protocols the dashboard interface editor offers. Restricting the set keeps
# a typo'd proto from writing a section ifup can't bring up (NET-class hazard).
_INTERFACE_PROTOS = ("static", "dhcp", "dhcpv6", "none", "pppoe")


class CreateInterfaceRequest(BaseModel):
    """Create (or overwrite) a `config interface` section (KAN-10).

    `force` is the explicit extra-confirm for a write that targets the
    management interface (the interface the dashboard is reached on). The route
    refuses a management-interface write unless `force` is True — a wrong
    proto/address there cuts the dashboard's own connectivity.
    """

    name: str = Field(..., min_length=1, max_length=15, pattern=_INTERFACE_NAME_PATTERN,
                      description="UCI interface section name (e.g. 'iot')")
    proto: str = Field(..., description="Protocol: static / dhcp / dhcpv6 / none / pppoe")
    device: Optional[str] = Field(default=None, pattern=_DEVICE_PATTERN,
                                  description="Logical L2 device (e.g. 'br-lan.20')")
    ipaddr: Optional[str] = Field(default=None, pattern=_IPV4_PATTERN,
                                  description="Static IPv4 (required-ish for proto=static)")
    netmask: Optional[str] = Field(default=None, pattern=_IPV4_PATTERN,
                                   description="Subnet mask for a static interface")
    gateway: Optional[str] = Field(default=None, pattern=_IPV4_PATTERN,
                                   description="Upstream gateway for a static interface")
    force: bool = Field(default=False,
                        description="Explicit extra-confirm to allow a management-interface write")

    @field_validator("proto")
    @classmethod
    def _check_proto(cls, v: str) -> str:
        if v not in _INTERFACE_PROTOS:
            raise ValueError(f"proto must be one of {', '.join(_INTERFACE_PROTOS)}")
        return v


class EditInterfaceRequest(BaseModel):
    """Update only the supplied options on an existing `config interface` (KAN-10).

    At least one editable field must be present — an empty edit is a no-op the
    route rejects before minting a confirm token. `force` carries the same
    management-interface extra-confirm semantics as CreateInterfaceRequest.
    """

    proto: Optional[str] = Field(default=None, description="Protocol to switch to")
    device: Optional[str] = Field(default=None, pattern=_DEVICE_PATTERN)
    ipaddr: Optional[str] = Field(default=None, pattern=_IPV4_PATTERN)
    netmask: Optional[str] = Field(default=None, pattern=_IPV4_PATTERN)
    gateway: Optional[str] = Field(default=None, pattern=_IPV4_PATTERN)
    force: bool = Field(default=False,
                        description="Explicit extra-confirm to allow a management-interface edit")

    @field_validator("proto")
    @classmethod
    def _check_proto(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in _INTERFACE_PROTOS:
            raise ValueError(f"proto must be one of {', '.join(_INTERFACE_PROTOS)}")
        return v

    @model_validator(mode="after")
    def _require_a_change(self) -> "EditInterfaceRequest":
        if not any(
            getattr(self, f) is not None
            for f in ("proto", "device", "ipaddr", "netmask", "gateway")
        ):
            raise ValueError("provide at least one field to change")
        return self


# ---------------------------------------------------------------------------
# VPN (WireGuard)
# ---------------------------------------------------------------------------
#
# Interface name grammar matches what `uci set network.<name>` accepts: lower
# alpha first, then alpha/digit/underscore, max 15 chars (Linux IFNAMSIZ - 1).
# WireGuard public/private keys are 32-byte Curve25519, base64-encoded — exactly
# 43 chars of `[A-Za-z0-9+/]` followed by a single `=` pad.
_WG_IFACE_PATTERN = r"^[a-z][a-z0-9_]{0,14}$"
_WG_KEY_PATTERN = r"^[A-Za-z0-9+/]{43}=$"
# CIDR like "10.13.13.2/32" — single IPv4 with mask. We don't accept comma-
# separated lists at the schema layer; callers pass a list of CIDRs and we
# join with "," before writing to uci. Keeps validation per-element clean.
_CIDR_PATTERN = (
    r"^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)/(?:3[0-2]|[12]?\d)$"
)


class VpnSetupRequest(BaseModel):
    """One-shot bootstrap of the WireGuard server interface + firewall."""

    interface: str = Field(
        default="wg0",
        pattern=_WG_IFACE_PATTERN,
        description="UCI section name for the wireguard interface (default 'wg0')",
    )
    listen_port: int = Field(
        default=51820, ge=1, le=65535,
        description="UDP port WireGuard listens on. Forward this from your upstream router.",
    )
    address: str = Field(
        default="10.13.13.1/24",
        pattern=_CIDR_PATTERN,
        description="Server's CIDR address inside the VPN subnet (e.g. '10.13.13.1/24').",
    )


class VpnPeerCreateRequest(BaseModel):
    """Create a new peer; server generates the keypair and returns the priv key
    in the response body. Caller MUST treat the returned `private_key` as
    write-once — show it to the user (e.g. via QR) and discard."""

    interface: str = Field(default="wg0", pattern=_WG_IFACE_PATTERN)
    description: str = Field(
        default="", max_length=128,
        description="Free-form label, e.g. \"Alice's iPhone\"",
    )
    allowed_ips: list[str] = Field(
        ..., min_length=1, max_length=8,
        description=(
            "List of CIDRs that route to this peer on the server side. For a "
            "single-device peer this is typically one /32, e.g. ['10.13.13.5/32']."
        ),
    )
    persistent_keepalive: int = Field(
        default=25, ge=0, le=600,
        description="Seconds between keepalives. 0 disables.",
    )

    @field_validator("allowed_ips")
    @classmethod
    def _validate_allowed_ips(cls, v: list[str]) -> list[str]:
        # Per-element CIDR validation. Pydantic's `pattern=` doesn't apply to
        # list items, so we walk the list ourselves.
        cidr_re = re.compile(_CIDR_PATTERN)
        for item in v:
            if not cidr_re.fullmatch(item):
                raise ValueError(f"invalid CIDR: {item!r}")
        return v


class VpnOverlayPeerRequest(BaseModel):
    """WARP-1385 — install/refresh a DIRECT-PUNCH overlay peer (ADR-030).

    Unlike VpnPeerCreateRequest (which generates the keypair server-side and
    returns the private key), an overlay peer brings its OWN key: the phone was
    enrolled with HQ, so the box installs the phone's public key with the
    phone's observed `endpoint` + a keepalive so WireGuard's own initiations
    punch outbound. Idempotent: re-installing the same public_key replaces the
    prior section (refresh), so a re-connect just updates the endpoint."""

    interface: str = Field(default="wg0", pattern=_WG_IFACE_PATTERN)
    public_key: str = Field(
        ..., pattern=_WG_KEY_PATTERN,
        description="Phone's WireGuard public key, base64-encoded (43 chars + '=').",
    )
    # The phone's observed public mapping (STUN reflexive) as IPv4:port. IPv6 is
    # tracked as a follow-up caveat in ADR-030's client stories.
    endpoint: str = Field(
        ...,
        pattern=r"^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d):(?:[1-9]\d{0,4})$",
        description="Peer's observed endpoint host:port, e.g. '203.0.113.7:51820'.",
    )
    allowed_ips: list[str] = Field(
        ..., min_length=1, max_length=8,
        description="CIDRs that route to this peer (typically one /32).",
    )
    persistent_keepalive: int = Field(
        default=25, ge=1, le=600,
        description="Seconds between keepalives — the box side of the punch.",
    )
    description: str = Field(default="", max_length=128)

    @field_validator("allowed_ips")
    @classmethod
    def _validate_allowed_ips(cls, v: list[str]) -> list[str]:
        cidr_re = re.compile(_CIDR_PATTERN)
        for item in v:
            if not cidr_re.fullmatch(item):
                raise ValueError(f"invalid CIDR: {item!r}")
        return v


class VpnPeerDeleteRequest(BaseModel):
    """Remove all peer sections matching `public_key` from `interface`."""

    interface: str = Field(default="wg0", pattern=_WG_IFACE_PATTERN)
    public_key: str = Field(
        ..., pattern=_WG_KEY_PATTERN,
        description="Peer's WireGuard public key, base64-encoded (43 chars + '=').",
    )


# ---------------------------------------------------------------------------
# AP onboarding (WARP-446)
# ---------------------------------------------------------------------------
#
# MAC validation re-uses the canonical AA:BB:CC:DD:EE:FF shape used by
# every other MAC field in this schema file. Case-insensitive on the
# wire; the SDK normalises to uppercase at the boundary.
#
# SSID grammar matches `SetSsidRequest.ssid` (1..32 chars). Encryption
# key min-length 8 matches the WPA2-PSK min-length so we don't push a
# config the AP's hostapd will reject.

_MAC_PATTERN = r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$"


class ApApproveRequest(BaseModel):
    """Approve a discovered extender AP and push wireless config.

    `radio` defaults to the deployment's configured primary radio
    (`DROPLET_WIFI_RADIO`, falling back to `radio0` only when unset). On the
    shipped router host the MT7922's primary 5 GHz AP is `radio3`, so the
    compose for that shape sets `DROPLET_WIFI_RADIO=radio3`; the dashboard's
    wizard surfaces this as the primary household band. `encryption` defaults
    to `psk2+ccmp` (WPA2-PSK, AES-only) — same posture as the main router's
    default config.
    """

    radio: str = Field(default_factory=lambda: _DEFAULT_WIFI_RADIO, min_length=1, max_length=16)
    ssid: str = Field(..., min_length=1, max_length=32)
    encryption: str = Field(default="psk2+ccmp", min_length=3, max_length=32)
    # 8 chars = WPA2-PSK minimum; 63 chars = max passphrase length.
    encryption_key: str = Field(..., min_length=8, max_length=63)
    network: str = Field(default="lan", min_length=1, max_length=15)


class ApTestSeedRequest(BaseModel):
    """Test-only payload to inject a discovered AP into the mock router.

    The production discovery path is the mDNS poller in the orchestrator;
    the routing service only sees the result. This endpoint exists so
    pytest can drive the full state machine without simulating
    multicast. Reject 404 when `router_instance` isn't a MockRouter.
    """

    mac: str = Field(..., pattern=_MAC_PATTERN)
    model: Optional[str] = None
    serial: Optional[str] = None
    version: Optional[str] = None
    last_ip: Optional[str] = None
    hostname: Optional[str] = None


class ApBandSteeringRequest(BaseModel):
    """Toggle the external AP's band-steering master switch (WARP-1703).

    Maps 1:1 onto the AP image's `droplet.wifi.band_steering` uci option
    (droplet-edge-router PR #5): '1' unifies the SSIDs + runs dawn (802.11k/v
    steering), '0' splits them and stops dawn. The AP's own procd reload
    trigger re-applies on commit — the routing service only sets + commits.
    """

    enabled: bool = Field(..., description="Enable 802.11k/v band steering on the AP")


# --- Response models ---

class HealthResponse(BaseModel):
    status: str
    connected: bool
    router_host: str
    board: Optional[dict] = None
    error: Optional[str] = None
    # WARP-826: the explicit deployment-topology posture
    # (PRIMARY_ROUTER | DOWNSTREAM_ROUTER | UNKNOWN), carried alongside `connected`
    # so the orchestrator derives `routerConnected` from real reachability and can
    # tell a LAN-only single-box (WAN handled by the host → UNKNOWN) apart from an
    # unreachable router instead of rendering it OFFLINE. Best-effort: null when the
    # router is unreachable or the (non-fatal) topology probe fails.
    topology: Optional[str] = None


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
