"""Lantronix SM8TAT2SA managed switch driver.

Controls the switch via its HTTPS JSON REST API (lighttpd backend).
Authentication uses session cookies obtained from POST /config/login.

API pattern (discovered by probing the switch at 192.168.1.77):
- Auth:   POST /config/login  (form data: username + password → session cookie)
- Read:   GET  /stat/{page}   (returns JSON)
- Write:  POST /stat/{page}   (JSON body, applies config)
- Write:  POST /config/{op}   (JSON body, for system-level operations)

Port layout: 8x GbE copper PoE (1-8) + 2x SFP (9-10)
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .base import (
    SwitchDriver,
    ConnectionLost,
    AuthenticationError,
    SwitchAPIError,
    InvalidPortError,
)

logger = logging.getLogger("droplet.switch.lantronix")

# SM8TAT2SA port configuration
PORT_MIN = 1
PORT_MAX = 10
SFP_PORT_MIN = 9
SFP_PORT_MAX = 10
POE_PORT_MIN = 1
POE_PORT_MAX = 8


class LantronixDriver(SwitchDriver):
    """SM8TAT2SA driver using HTTPS JSON API with session cookie auth."""

    def __init__(self, host: str, port: int, username: str, password: str):
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._client: httpx.AsyncClient | None = None
        self._authenticated = False

    # --- Lifecycle ---

    async def connect(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=f"https://{self._host}:{self._port}",
            verify=False,
            timeout=15.0,
            follow_redirects=False,
        )
        await self._authenticate()
        logger.info("Connected to Lantronix switch at %s:%d", self._host, self._port)

    async def disconnect(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
            self._authenticated = False
        logger.info("Disconnected from switch")

    async def is_connected(self) -> bool:
        if not self._client or not self._authenticated:
            return False
        try:
            resp = await self._client.get("/stat/sysinfo")
            data = resp.json()
            # If we get redirected to login, session expired
            return "redirect_url" not in data
        except Exception:
            return False

    # --- Authentication ---

    async def _authenticate(self) -> None:
        """Authenticate via form POST, capturing session cookie."""
        if not self._client:
            raise ConnectionLost("Client not initialized")

        try:
            resp = await self._client.post(
                "/config/login",
                data={
                    "username": self._username,
                    "password": self._password,
                },
            )

            # Check if login succeeded (switch returns 200 or redirect to main page)
            if resp.status_code in (200, 301, 302):
                # Session cookie is automatically captured by httpx
                self._authenticated = True
                logger.info("Authenticated with switch")
            else:
                raise AuthenticationError(
                    f"Login failed with status {resp.status_code}"
                )

        except httpx.ConnectError as exc:
            raise ConnectionLost(f"Cannot reach switch at {self._host}:{self._port}: {exc}")
        except httpx.TimeoutException as exc:
            raise ConnectionLost(f"Timeout connecting to switch: {exc}")

    async def _request(
        self, method: str, path: str, retry: bool = True, **kwargs
    ) -> dict:
        """Make an authenticated request with auto-reauthentication on session expiry.

        Returns the parsed JSON response. Retries once if the session has expired.
        """
        if not self._client:
            raise ConnectionLost("Not connected to switch")

        try:
            resp = await self._client.request(method, path, **kwargs)
            data = resp.json()

            # Check for session expiry (switch redirects to login)
            if isinstance(data, dict) and "redirect_url" in data:
                if retry:
                    logger.info("Session expired, re-authenticating...")
                    await self._authenticate()
                    return await self._request(method, path, retry=False, **kwargs)
                raise AuthenticationError("Session expired and re-auth failed")

            if isinstance(data, dict) and "error" in data:
                raise SwitchAPIError(resp.status_code, data["error"])

            return data

        except httpx.ConnectError as exc:
            raise ConnectionLost(str(exc))
        except httpx.TimeoutException as exc:
            raise ConnectionLost(f"Timeout: {exc}")
        except httpx.HTTPStatusError as exc:
            raise SwitchAPIError(exc.response.status_code, str(exc))

    def _validate_port(self, port: int) -> None:
        """Validate port number is in range."""
        if not PORT_MIN <= port <= PORT_MAX:
            raise InvalidPortError(
                f"Port {port} out of range ({PORT_MIN}-{PORT_MAX})"
            )

    def _validate_poe_port(self, port: int) -> None:
        """Validate port supports PoE (copper ports only, not SFP)."""
        self._validate_port(port)
        if port >= SFP_PORT_MIN:
            raise InvalidPortError(
                f"Port {port} is SFP — PoE not supported (PoE ports: {POE_PORT_MIN}-{POE_PORT_MAX})"
            )

    # --- System ---

    async def get_system_info(self) -> dict:
        data = await self._request("GET", "/stat/sysinfo")
        raw = data.get("data", data)
        return {
            "model": raw.get("System Name", raw.get("Model", "SM8TAT2SA")),
            "firmware_version": raw.get("Firmware Version", raw.get("Software Version", "")),
            "mac_address": raw.get("MAC Address", raw.get("System MAC", "")),
            "uptime": raw.get("System Uptime", raw.get("Uptime", "")),
            "hostname": raw.get("System Name", ""),
            "port_count": PORT_MAX,
            "poe_budget_mw": None,  # Populated from PoE status
            "driver": "lantronix",
        }

    # --- Port Management ---

    async def get_ports(self) -> list[dict]:
        data = await self._request("GET", "/stat/port")
        raw_ports = data.get("data", data.get("portStatus", []))

        ports = []
        if isinstance(raw_ports, list):
            for entry in raw_ports:
                port_num = entry.get("port", entry.get("Port", 0))
                if isinstance(port_num, str):
                    try:
                        port_num = int(port_num)
                    except ValueError:
                        continue

                ports.append({
                    "port": port_num,
                    "name": f"Port {port_num}",
                    "enabled": entry.get("enabled", entry.get("State", "")) != "Disabled",
                    "link_up": entry.get("link", entry.get("Link", "")) == "Up",
                    "speed": entry.get("speed", entry.get("Speed", "")),
                    "duplex": entry.get("duplex", entry.get("Duplex", "")),
                    "is_sfp": port_num >= SFP_PORT_MIN,
                    "vlan": entry.get("pvid", entry.get("PVID", 1)),
                })
        elif isinstance(raw_ports, dict):
            # Some firmware returns ports as a dict keyed by port number
            for key, entry in raw_ports.items():
                try:
                    port_num = int(key)
                except ValueError:
                    continue

                ports.append({
                    "port": port_num,
                    "name": f"Port {port_num}",
                    "enabled": entry.get("enabled", True),
                    "link_up": entry.get("link", "Down") == "Up",
                    "speed": entry.get("speed", ""),
                    "duplex": entry.get("duplex", ""),
                    "is_sfp": port_num >= SFP_PORT_MIN,
                    "vlan": entry.get("pvid", 1),
                })

        # Ensure all ports are represented
        existing = {p["port"] for p in ports}
        for i in range(PORT_MIN, PORT_MAX + 1):
            if i not in existing:
                ports.append({
                    "port": i,
                    "name": f"Port {i}",
                    "enabled": True,
                    "link_up": False,
                    "speed": "",
                    "duplex": "",
                    "is_sfp": i >= SFP_PORT_MIN,
                    "vlan": 1,
                })

        return sorted(ports, key=lambda p: p["port"])

    async def get_port(self, port: int) -> dict:
        self._validate_port(port)
        all_ports = await self.get_ports()
        for p in all_ports:
            if p["port"] == port:
                return p
        raise SwitchAPIError(404, f"Port {port} not found")

    async def set_port_enabled(self, port: int, enabled: bool) -> None:
        self._validate_port(port)
        await self._request(
            "POST",
            "/config/ports",
            json={"port": port, "enabled": enabled},
        )
        logger.info("Port %d %s", port, "enabled" if enabled else "disabled")

    # --- VLAN Management ---

    async def get_vlans(self) -> list[dict]:
        data = await self._request("GET", "/stat/vlan")
        raw = data.get("data", data.get("vlans", []))

        vlans = []
        if isinstance(raw, list):
            for entry in raw:
                vlans.append({
                    "vlan_id": entry.get("vid", entry.get("vlan_id", 0)),
                    "name": entry.get("name", entry.get("Name", "")),
                    "ports": entry.get("ports", []),
                })
        elif isinstance(raw, dict):
            for vid, entry in raw.items():
                try:
                    vlan_id = int(vid)
                except ValueError:
                    continue
                vlans.append({
                    "vlan_id": vlan_id,
                    "name": entry.get("name", ""),
                    "ports": entry.get("ports", []),
                })

        return vlans

    async def create_vlan(self, vlan_id: int, name: str = "") -> None:
        if not 2 <= vlan_id <= 4094:
            raise SwitchAPIError(400, f"VLAN ID {vlan_id} out of range (2-4094)")
        await self._request(
            "POST",
            "/config/vlan",
            json={"vid": vlan_id, "name": name or f"VLAN{vlan_id}"},
        )
        logger.info("Created VLAN %d (%s)", vlan_id, name)

    async def delete_vlan(self, vlan_id: int) -> None:
        if vlan_id == 1:
            raise SwitchAPIError(400, "Cannot delete default VLAN 1")
        await self._request(
            "POST",
            "/config/vlan_delete",
            json={"vid": vlan_id},
        )
        logger.info("Deleted VLAN %d", vlan_id)

    async def get_vlan_membership(self, vlan_id: int) -> dict:
        data = await self._request("GET", f"/stat/vlan_membership")
        # Parse membership for the requested VLAN
        raw = data.get("data", data)
        membership = {"vlan_id": vlan_id, "ports": []}

        if isinstance(raw, list):
            for entry in raw:
                if entry.get("vid") == vlan_id:
                    membership["ports"] = entry.get("ports", [])
                    break
        elif isinstance(raw, dict):
            vlan_data = raw.get(str(vlan_id), {})
            membership["ports"] = vlan_data.get("ports", [])

        return membership

    async def set_vlan_membership(
        self, vlan_id: int, membership: list[dict]
    ) -> None:
        await self._request(
            "POST",
            "/config/vlan_membership",
            json={"vid": vlan_id, "ports": membership},
        )
        logger.info(
            "Updated VLAN %d membership: %d ports",
            vlan_id,
            len(membership),
        )

    # --- PoE Control ---

    async def get_poe_status(self) -> list[dict]:
        data = await self._request("GET", "/stat/poe_status")
        raw = data.get("data", data.get("ports", []))

        poe_ports = []
        if isinstance(raw, list):
            for entry in raw:
                port_num = entry.get("port", entry.get("Port", 0))
                if isinstance(port_num, str):
                    try:
                        port_num = int(port_num)
                    except ValueError:
                        continue

                poe_ports.append({
                    "port": port_num,
                    "enabled": entry.get("enabled", entry.get("Admin", "")) != "Disabled",
                    "delivering": entry.get("delivering", entry.get("Status", "")) in ("Delivering", "On"),
                    "power_mw": float(entry.get("power_mw", entry.get("Power(mW)", 0))),
                    "class": entry.get("class", entry.get("Class", "")),
                    "max_power_mw": float(entry.get("max_power_mw", entry.get("Max Power(mW)", 30000))),
                })
        elif isinstance(raw, dict):
            for key, entry in raw.items():
                try:
                    port_num = int(key)
                except ValueError:
                    continue
                poe_ports.append({
                    "port": port_num,
                    "enabled": entry.get("enabled", True),
                    "delivering": entry.get("delivering", False),
                    "power_mw": float(entry.get("power_mw", 0)),
                    "class": entry.get("class", ""),
                    "max_power_mw": float(entry.get("max_power_mw", 30000)),
                })

        return sorted(poe_ports, key=lambda p: p["port"])

    async def get_port_poe(self, port: int) -> dict:
        self._validate_poe_port(port)
        all_poe = await self.get_poe_status()
        for p in all_poe:
            if p["port"] == port:
                return p
        # Port exists but no PoE data — return defaults
        return {
            "port": port,
            "enabled": False,
            "delivering": False,
            "power_mw": 0,
            "class": "",
            "max_power_mw": 30000,
        }

    async def set_port_poe(self, port: int, enabled: bool) -> None:
        self._validate_poe_port(port)
        await self._request(
            "POST",
            "/config/poe",
            json={"port": port, "enabled": enabled},
        )
        logger.info("Port %d PoE %s", port, "enabled" if enabled else "disabled")

    # --- Higher-Level Operations ---

    async def detect_wan_port(self) -> dict:
        """Auto-detect WAN uplink port by checking link state and MAC table.

        Heuristic:
        1. SFP ports (9-10) with link up are likely uplinks
        2. Copper port with most MAC addresses is likely the uplink
        3. If no clear winner, suggest port 9 (first SFP)
        """
        ports = await self.get_ports()
        active_sfp = [p for p in ports if p["is_sfp"] and p["link_up"]]

        if active_sfp:
            best = active_sfp[0]
            return {
                "wan_port": best["port"],
                "confidence": "high",
                "reason": f"SFP port {best['port']} has active link ({best['speed']})",
                "link_up": True,
            }

        # No SFP active — check copper ports
        active_copper = [p for p in ports if not p["is_sfp"] and p["link_up"]]
        if active_copper:
            # Highest-speed port is likely the uplink
            best = max(active_copper, key=lambda p: p.get("speed", ""))
            return {
                "wan_port": best["port"],
                "confidence": "medium",
                "reason": f"Copper port {best['port']} has active link ({best['speed']})",
                "link_up": True,
            }

        return {
            "wan_port": SFP_PORT_MIN,
            "confidence": "low",
            "reason": "No active uplink detected — defaulting to SFP port 9",
            "link_up": False,
        }

    async def backup_config(self) -> bytes:
        """Download switch configuration backup."""
        if not self._client:
            raise ConnectionLost("Not connected")
        resp = await self._client.get("/config/download")
        if resp.status_code != 200:
            raise SwitchAPIError(resp.status_code, "Config backup failed")
        return resp.content
