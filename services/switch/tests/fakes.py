"""In-memory fake SwitchDriver for unit tests.

CRITICAL: EVERY switch test runs against this fake — no test, fixture, or
provisioner path may ever open a socket to real hardware.

The fake models the one thing the provisioner reasons about: per-port VLAN
membership. It records writes so a test can assert idempotence (no writes when
already at desired state) and that the protected/uplink port is never moved.

It also models a switch whose VLAN reads fail: set `raise_on_vlan_read` /
`raise_on_membership_read` to a SwitchAPIError(404) to prove the provisioner
is tolerant (logs + no-op) rather than crashing.
"""

from __future__ import annotations

from drivers.base import SwitchDriver, SwitchAPIError


class FakeSwitchDriver(SwitchDriver):
    """Deterministic in-memory switch.

    ``port_vlans`` maps port -> the untagged access VLAN it currently sits on
    (its PVID). ``trunk_ports`` is the set of ports configured as tagged trunks
    (the uplink) — those carry every VLAN and are never reassigned an access
    VLAN. ``vlans`` is the set of VLAN ids that exist on the device.
    """

    def __init__(
        self,
        port_vlans: dict[int, int] | None = None,
        trunk_ports: set[int] | None = None,
        vlans: set[int] | None = None,
        connected: bool = True,
    ) -> None:
        # Default: 10-port switch, every access port untagged on VLAN 1,
        # ports 9/10 the SFP trunk/uplink.
        self.port_vlans: dict[int, int] = (
            dict(port_vlans)
            if port_vlans is not None
            else {p: 1 for p in range(1, 9)}
        )
        self.trunk_ports: set[int] = (
            set(trunk_ports) if trunk_ports is not None else {9, 10}
        )
        self.vlans: set[int] = set(vlans) if vlans is not None else {1}

        self._connected = connected

        # --- observability for assertions ---
        self.membership_writes: list[tuple[int, list[dict]]] = []
        self.created_vlans: list[int] = []
        self.backup_calls: int = 0
        self.write_order: list[str] = []

        # --- fault injection (models v1.04 endpoint 404s) ---
        self.raise_on_vlan_read: Exception | None = None
        self.raise_on_membership_read: Exception | None = None
        self.empty_vlan_read: bool = False

    # --- Lifecycle ---

    async def connect(self) -> None:
        self._connected = True

    async def disconnect(self) -> None:
        self._connected = False

    async def is_connected(self) -> bool:
        return self._connected

    # --- System ---

    async def get_system_info(self) -> dict:
        return {
            "model": "Fake 10-Port PoE Switch",
            "firmware_version": "0.0.0-fake",
            "mac_address": "aa:bb:cc:dd:ee:ff",
            "uptime": "1d",
            "hostname": "fake-switch",
            "port_count": 10,
            "poe_budget_mw": 120000,
            "driver": "fake",
        }

    # --- Ports ---

    async def get_ports(self) -> list[dict]:
        ports = []
        for p in sorted(set(self.port_vlans) | self.trunk_ports):
            ports.append(
                {
                    "port": p,
                    "name": f"Port {p}",
                    "enabled": True,
                    "link_up": True,
                    "speed": "1Gbps",
                    "duplex": "full",
                    "is_sfp": p >= 9,
                    "vlan": self.port_vlans.get(p, 1),
                }
            )
        return ports

    async def get_port(self, port: int) -> dict:
        for entry in await self.get_ports():
            if entry["port"] == port:
                return entry
        raise SwitchAPIError(404, f"Port {port} not found")

    async def get_port_status(self) -> list[dict]:
        # Mirror the real drivers' get_port_status shape (the §7 link/speed
        # source): every port up at "1 Gb", SFP flag by position.
        return [
            {"port": p, "link_up": True, "speed": "1 Gb", "is_sfp": p >= 9}
            for p in range(1, 11)
        ]

    async def set_port_enabled(self, port: int, enabled: bool) -> None:
        return None

    # --- VLANs ---

    async def get_vlans(self) -> list[dict]:
        if self.raise_on_vlan_read is not None:
            raise self.raise_on_vlan_read
        if self.empty_vlan_read:
            return []
        return [{"vlan_id": v, "name": f"VLAN{v}", "ports": []} for v in sorted(self.vlans)]

    async def create_vlan(self, vlan_id: int, name: str = "") -> None:
        self.vlans.add(vlan_id)
        self.created_vlans.append(vlan_id)
        self.write_order.append(f"create_vlan:{vlan_id}")

    async def delete_vlan(self, vlan_id: int) -> None:
        self.vlans.discard(vlan_id)

    async def get_vlan_membership(self, vlan_id: int) -> dict:
        if self.raise_on_membership_read is not None:
            raise self.raise_on_membership_read
        ports = []
        # Untagged access members of this VLAN.
        for p, v in sorted(self.port_vlans.items()):
            if v == vlan_id:
                ports.append({"port": p, "tagged": False, "member": True})
        # Trunk ports are tagged members of every VLAN.
        for p in sorted(self.trunk_ports):
            ports.append({"port": p, "tagged": True, "member": True})
        return {"vlan_id": vlan_id, "ports": ports}

    async def set_vlan_membership(self, vlan_id: int, membership: list[dict]) -> None:
        self.membership_writes.append((vlan_id, membership))
        self.write_order.append(f"set_membership:{vlan_id}")
        # Apply untagged access members to the in-memory PVID map so a
        # read-back after the write reflects the change (idempotence test).
        for entry in membership:
            port = entry["port"]
            if entry.get("member") and not entry.get("tagged"):
                if port not in self.trunk_ports:
                    self.port_vlans[port] = vlan_id

    # --- PoE ---

    async def get_poe_status(self) -> list[dict]:
        return []

    async def get_port_poe(self, port: int) -> dict:
        return {"port": port, "enabled": False, "delivering": False}

    async def set_port_poe(self, port: int, enabled: bool) -> None:
        return None

    # --- Higher-level ---

    async def detect_wan_port(self) -> dict:
        return {"wan_port": 9, "confidence": "high", "reason": "fake"}

    async def backup_config(self) -> bytes:
        self.backup_calls += 1
        self.write_order.append("backup")
        return b"fake-config-backup"


class FakeRoutingClient:
    """Stand-in for the routing-service cross-check.

    ``cameras_present`` is the explicit presence flag the segmented profile
    double-gates on (ADR-018: never inferred from absence). ``raise_exc`` lets
    a test simulate the routing service being unreachable.
    """

    def __init__(self, cameras_present: bool | None = True, raise_exc: Exception | None = None):
        self._cameras_present = cameras_present
        self._raise = raise_exc
        self.calls = 0

    async def cameras_present(self) -> bool | None:
        self.calls += 1
        if self._raise is not None:
            raise self._raise
        return self._cameras_present
