"""Abstract switch driver interface.

This is THE contract that all switch implementations must follow.
The FastAPI service (main.py) only calls methods on this interface —
it never imports a concrete driver directly.

Implementations:
- OpenWrtSwitchDriver: Droplet-OpenWrt-imaged switch (Zyxel GS1900 family)
  via ubus-over-HTTP as `droplet-ai`
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


class PoweredMemberError(SwitchError):
    """Refused: this port powers a device the fabric depends on (WARP-1734).

    ADR-035 §7. Cutting PoE to an enrolled fabric member is the one action in
    this rack with NO remote recovery: a de-powered device cannot roll itself
    back, cannot confirm, and cannot be reached to undo the change. It is
    therefore a hard refusal rather than a warning — the caller must pass
    ``force=True``, which is the operator saying "I know this darkens the AP".
    """
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
                "model": "Zyxel GS1900-10HP A1",
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

    async def get_port_status(self) -> list[dict]:
        """Live link state + speed per port — the real link/speed source.

        Returns one dict per physical port::

            {"port": int, "link_up": bool, "speed": str, "is_sfp": bool,
             "traffic": {"rx_bytes": int, "tx_bytes": int} | None}

        ``speed`` is a display label ("1 Gb" / "10 Gb" / "" when down).
        ``traffic`` carries the port's cumulative byte counters when the driver
        reports them and ``None`` when it can't — the two are distinct claims
        (WARP-1716), so absence is never flattened to zero. A driver whose
        primary port read (``get_ports``) cannot report link state overrides
        this with a dedicated read. The default derives from ``get_ports`` so
        every driver — and the test fakes — answer this without bespoke code.
        The orchestrator §7 aggregation joins this read in.
        """
        out: list[dict] = []
        for p in await self.get_ports():
            out.append({
                "port": p.get("port"),
                "link_up": bool(p.get("link_up")),
                "speed": p.get("speed") or "",
                "is_sfp": bool(p.get("is_sfp")),
                "traffic": p.get("traffic"),
            })
        return out

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
        """Set port membership for a VLAN. REPLACES the VLAN's whole member list.

        membership: list of {"port": int, "tagged": bool, "member": bool}

        Callers that mean "add ONE port to its access VLAN" must use
        set_port_access_vlan — passing a single-port list here wipes every other
        member (audit 2026-08-06).
        """
        ...

    # NOT abstract: a correct default composes the two membership primitives,
    # so no existing backend or test fake needs to change. The OpenWrt driver
    # overrides this to operate on RAW uci entries (a read→re-serialise there is
    # lossy — a bare VLAN-1 entry comes back tagged).
    async def set_port_access_vlan(self, port: int, vlan_id: int) -> None:
        """Make `port` the untagged (access/PVID) member of `vlan_id` WITHOUT
        disturbing that VLAN's other members, and remove it from every other
        VLAN's untagged membership (a port has exactly one access VLAN; tagged
        trunk memberships are left alone).

        The provisioner previously called set_vlan_membership with a single-port
        list to "move" a port, which replaced the VLAN's entire member list and
        could strand the uplink/AP/appliance on VLAN 1 (audit 2026-08-06).
        """
        target = await self.get_vlan_membership(vlan_id)
        members = [m for m in target.get("ports", []) if m.get("port") != port]
        members.append({"port": port, "tagged": False, "member": True})
        await self.set_vlan_membership(vlan_id, members)
        for v in await self.get_vlans():
            vid = v.get("vlan_id")
            if vid == vlan_id:
                continue
            vm = await self.get_vlan_membership(vid)
            kept = [
                m for m in vm.get("ports", [])
                if not (m.get("port") == port and not m.get("tagged"))
            ]
            if len(kept) != len(vm.get("ports", [])):
                await self.set_vlan_membership(vid, kept)

    # --- PoE Control ---

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

    # --- Topology (WARP-1734, ADR-035 §6) ---

    # NOT abstract, deliberately: FDB is an optional capability, and the
    # contract below already defines the answer for a backend that lacks it
    # ("returns []"). Forcing every driver to implement a method whose only
    # correct implementation would be `return []` buys nothing and breaks
    # every existing backend the day topology lands.
    async def get_fdb(self) -> list[dict]:
        """Which MAC addresses the switch has learned, and on which port.

        This is the port↔device edge — the switch is the only device in the
        fabric that knows it, and without it the control plane cannot answer
        "what is plugged into port N", so it cannot know that cutting PoE on
        a port would darken the AP serving the household's Wi-Fi.

        Returns one entry per LEARNED address (the switch's own permanent
        addresses and CPU-side ports are excluded by the source, not here)::

            [{"mac": "80:ea:0b:39:ae:23", "port": "lan2", "vlan": 1}, ...]

        Returns [] — never raises — when the backend cannot supply an FDB
        (a driver without the capability, or a switch image whose ACL does
        not grant the read). Absence of topology must degrade the guard to
        "cannot prove this port is safe", never break unrelated calls.
        """
        return []

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
