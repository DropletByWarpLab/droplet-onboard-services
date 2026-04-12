"""Pydantic models for the routing service REST API."""

from pydantic import BaseModel, Field
from typing import Optional


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
    timeout: int = Field(default=30, ge=10, le=120, description="Rollback timeout in seconds")


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
