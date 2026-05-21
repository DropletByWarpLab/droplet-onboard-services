"""Abstract switch driver interface.

This is THE contract that all switch implementations must follow.
The FastAPI service (main.py) only calls methods on this interface —
it never imports a concrete driver directly.

Implementations:
- LantronixDriver: SM8TAT2SA via HTTPS JSON API (prototype)
- ASICDriver: Custom PCB via SPI/I2C registers (production — future)

To swap drivers: set SWITCH_DRIVER=asic in the environment.
Nothing else changes — same REST endpoints, same orchestrator client,
same LLM tools, same dashboard.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


# --- Exceptions ---

class SwitchError(Exception):
    """Base exception for all switch driver errors."""
    pass


class ConnectionLost(SwitchError):
    """Cannot reach the switch device."""
    pass


class AuthenticationError(SwitchError):
    """Invalid credentials or session expired and re-auth failed."""
    pass


class SwitchAPIError(SwitchError):
    """The switch API returned an error."""

    def __init__(self, code: int = 0, message: str = ""):
        self.code = code
        self.is_client_error = 400 <= code < 500
        super().__init__(message or f"Switch API error {code}")


class InvalidPortError(SwitchError):
    """Port number is out of range or not supported for this operation."""
    pass


# --- Abstract Driver ---

class SwitchDriver(ABC):
    """Abstract interface for managed switch control.

    All methods are async. Return types are plain dicts/lists —
    Pydantic validation happens at the API layer in schemas.py.
    """

    # --- Lifecycle ---

    @abstractmethod
    async def connect(self) -> None:
        """Establish connection to the switch. Raises ConnectionLost on failure."""
        ...

    @abstractmethod
    async def disconnect(self) -> None:
        """Cleanly disconnect from the switch."""
        ...

    @abstractmethod
    async def is_connected(self) -> bool:
        """Check if the switch is currently reachable."""
        ...

    # --- System ---

    @abstractmethod
    async def get_system_info(self) -> dict:
        """Get switch model, firmware version, MAC address, uptime, etc.

        Returns:
            {
                "model": "SM8TAT2SA",
                "firmware_version": "1.2.3",
                "mac_address": "aa:bb:cc:dd:ee:ff",
                "uptime": 123456,
                "hostname": "switch-1",
                "port_count": 10,
                "poe_budget_mw": 120000,
            }
        """
        ...

    # --- Port Management ---

    @abstractmethod
    async def get_ports(self) -> list[dict]:
        """Get status of all ports.

        Returns list of:
            {
                "port": 1,
                "name": "Port 1",
                "enabled": True,
                "link_up": True,
                "speed": "1Gbps",
                "duplex": "full",
                "is_sfp": False,
                "vlan": 1,
                "poe": {"enabled": True, "delivering": True, "power_mw": 12500},
            }
        """
        ...

    @abstractmethod
    async def get_port(self, port: int) -> dict:
        """Get status of a single port."""
        ...

    @abstractmethod
    async def set_port_enabled(self, port: int, enabled: bool) -> None:
        """Enable or disable a port."""
        ...

    # --- VLAN Management ---

    @abstractmethod
    async def get_vlans(self) -> list[dict]:
        """List all configured VLANs.

        Returns list of:
            {
                "vlan_id": 100,
                "name": "cameras",
                "ports": [
                    {"port": 1, "tagged": False, "member": True},
                    {"port": 9, "tagged": True, "member": True},
                    ...
                ],
            }
        """
        ...

    @abstractmethod
    async def create_vlan(self, vlan_id: int, name: str = "") -> None:
        """Create a new VLAN."""
        ...

    @abstractmethod
    async def delete_vlan(self, vlan_id: int) -> None:
        """Delete a VLAN."""
        ...

    @abstractmethod
    async def get_vlan_membership(self, vlan_id: int) -> dict:
        """Get port membership for a specific VLAN.

        Returns:
            {
                "vlan_id": 100,
                "ports": [
                    {"port": 1, "tagged": False, "member": True},
                    ...
                ],
            }
        """
        ...

    @abstractmethod
    async def set_vlan_membership(
        self, vlan_id: int, membership: list[dict]
    ) -> None:
        """Set port membership for a VLAN.

        membership: list of {"port": int, "tagged": bool, "member": bool}
        """
        ...

    # --- PoE Control ---

    @abstractmethod
    async def get_mac_table(self) -> list[dict]:
        """Read the switch's dynamic MAC-address forwarding table.

        Returns the set of MACs the switch has learned, with the port
        and VLAN they were learned on. Used by the smart-port watcher
        to detect a new device appearing on an access port.

        Returns list of:
            {
                "port": 7,
                "mac": "E4:30:22:50:2A:FD",
                "vlan": 1,
                "type": "dynamic" | "static",
            }
        """
        ...

    @abstractmethod
    async def get_poe_status(self) -> list[dict]:
        """Get PoE status for all PoE-capable ports.

        Returns list of:
            {
                "port": 1,
                "enabled": True,
                "delivering": True,
                "power_mw": 12500,
                "class": "Class 3",
                "max_power_mw": 30000,
            }
        """
        ...

    @abstractmethod
    async def get_port_poe(self, port: int) -> dict:
        """Get PoE status for a single port."""
        ...

    @abstractmethod
    async def set_port_poe(self, port: int, enabled: bool) -> None:
        """Enable or disable PoE on a port. Raises InvalidPortError for SFP ports."""
        ...

    # --- Higher-Level Operations ---

    @abstractmethod
    async def detect_wan_port(self) -> dict:
        """Auto-detect which port is the WAN uplink.

        Heuristic: look for the port with an active link that has
        the highest MAC address count or non-local traffic patterns.

        Returns:
            {
                "wan_port": 9,
                "confidence": "high",
                "reason": "SFP port with upstream MAC addresses",
            }
        """
        ...

    @abstractmethod
    async def backup_config(self) -> bytes:
        """Download a backup of the switch configuration."""
        ...
