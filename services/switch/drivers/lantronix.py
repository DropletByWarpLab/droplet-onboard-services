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

import asyncio
import contextlib
import logging
import time
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

# Session management tuning.
#
# The SM8TAT2SA firmware (v1.04.0079, April 2026) idles its web session after
# roughly 30 s of inactivity and responds with `{"redirect_url": "/login"}`
# afterwards. The orchestrator polls /health every 30 s, so without a
# heartbeat every probe lands right at the expiry edge, triggers a re-auth,
# and under that sustained re-auth rate the switch's control plane becomes
# flaky (hangs, "Session expired and re-auth failed"). Pinging /stat/sysinfo
# well inside the idle window keeps a single session alive, drops the probe
# load from ~2 req/s on spikes to a steady 1 req / 20 s, and gives the
# orchestrator a cached answer without hitting the hardware on every poll.
_KEEPALIVE_INTERVAL_S = 20.0
# Treat the connection as live if the keepalive has succeeded within this
# window. 2× the interval gives one missed ping of slack before we flip.
_LIVENESS_WINDOW_S = _KEEPALIVE_INTERVAL_S * 2
# Back-off between failed re-auths so a dead/rebooting switch doesn't get
# hammered with login POSTs from concurrent callers.
_REAUTH_BACKOFF_S = 5.0


class LantronixDriver(SwitchDriver):
    """SM8TAT2SA driver using HTTPS JSON API with session cookie auth.

    Concurrency model:
    * `_auth_lock` serializes login POSTs so parallel callers can't stomp on
      each other's session cookie. All re-auths go through `_authenticate()`,
      which takes the lock; direct callers never write `self._authenticated`.
    * A background `_keepalive_loop` task issues a cheap GET every
      _KEEPALIVE_INTERVAL_S seconds and re-auths on session expiry. This is
      the *only* path that resets `_last_ok_at`, so `is_connected()` — and by
      extension the orchestrator's /health probe — answers from a cached
      liveness bit instead of hitting the switch.
    """

    def __init__(self, host: str, port: int, username: str, password: str):
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._client: httpx.AsyncClient | None = None
        self._authenticated = False
        self._auth_lock = asyncio.Lock()
        self._keepalive_task: asyncio.Task | None = None
        self._last_ok_at: float = 0.0
        self._last_auth_failure_at: float = 0.0

    # --- Lifecycle ---

    async def connect(self) -> None:
        logger.warning(
            "TLS certificate verification disabled for switch at %s:%d "
            "(self-signed cert expected). Set SWITCH_CA_CERT to enable verification.",
            self._host, self._port,
        )
        self._client = httpx.AsyncClient(
            base_url=f"https://{self._host}:{self._port}",
            verify=False,  # Self-signed cert on embedded switch
            timeout=15.0,
            follow_redirects=False,
        )
        await self._authenticate()
        # Mark the startup auth as a fresh ok so is_connected() reports true
        # before the first keepalive tick has landed.
        self._last_ok_at = time.monotonic()
        self._keepalive_task = asyncio.create_task(
            self._keepalive_loop(), name="lantronix-keepalive"
        )
        logger.info("Connected to Lantronix switch at %s:%d", self._host, self._port)

    async def disconnect(self) -> None:
        if self._keepalive_task:
            self._keepalive_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._keepalive_task
            self._keepalive_task = None
        if self._client:
            await self._client.aclose()
            self._client = None
        self._authenticated = False
        logger.info("Disconnected from switch")

    async def is_connected(self) -> bool:
        # Trust the keepalive loop's last result — never hits the switch.
        # If the loop has been unable to refresh `_last_ok_at` for longer
        # than the liveness window, the switch is effectively offline from
        # our perspective, even if `_authenticated` is still True from a
        # stale login.
        if not self._client:
            return False
        return (time.monotonic() - self._last_ok_at) < _LIVENESS_WINDOW_S

    # --- Authentication ---

    async def _authenticate(self) -> None:
        """Authenticate via form POST, capturing session cookie.

        Serialized by `_auth_lock` so concurrent callers share a single
        login attempt rather than racing and invalidating each other's
        session on the switch side.
        """
        if not self._client:
            raise ConnectionLost("Client not initialized")

        async with self._auth_lock:
            # If another coroutine just succeeded, skip the second login.
            # `_last_ok_at` is only updated on a successful response, so a
            # recent value implies the cookie jar is already good.
            if (time.monotonic() - self._last_ok_at) < 1.0:
                return

            # Short-circuit if we just failed — avoids a thundering herd on
            # a rebooting switch where the port is open but auth times out.
            if (time.monotonic() - self._last_auth_failure_at) < _REAUTH_BACKOFF_S:
                raise AuthenticationError(
                    f"Skipping re-auth ({_REAUTH_BACKOFF_S:.0f}s back-off after recent failure)"
                )

            try:
                resp = await self._client.post(
                    "/config/login",
                    data={
                        "username": self._username,
                        "password": self._password,
                    },
                )
                if resp.status_code in (200, 301, 302):
                    self._authenticated = True
                    logger.info("Authenticated with switch")
                else:
                    self._last_auth_failure_at = time.monotonic()
                    raise AuthenticationError(
                        f"Login failed with status {resp.status_code}"
                    )
            except httpx.ConnectError as exc:
                self._last_auth_failure_at = time.monotonic()
                raise ConnectionLost(
                    f"Cannot reach switch at {self._host}:{self._port}: {exc}"
                )
            except httpx.TimeoutException as exc:
                self._last_auth_failure_at = time.monotonic()
                raise ConnectionLost(f"Timeout connecting to switch: {exc}")

    async def _keepalive_loop(self) -> None:
        """Ping /stat/sysinfo at a cadence below the switch's idle timeout.

        Runs forever until cancelled by `disconnect()`. Exceptions are
        logged but never propagate — losing the switch for a while is
        surfaced via `is_connected()` going False, not by crashing the
        task.
        """
        logger.info(
            "Keepalive started (interval=%.1fs, liveness window=%.1fs)",
            _KEEPALIVE_INTERVAL_S, _LIVENESS_WINDOW_S,
        )
        try:
            while True:
                await asyncio.sleep(_KEEPALIVE_INTERVAL_S)
                try:
                    await self._ping()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 — any failure is interesting
                    logger.warning("Keepalive ping failed: %s", exc)
        except asyncio.CancelledError:
            logger.info("Keepalive stopped")
            raise

    async def _ping(self) -> None:
        """One keepalive cycle: GET sysinfo, re-auth if expired, record time."""
        if not self._client:
            return
        resp = await self._client.get("/stat/sysinfo")
        try:
            data = resp.json()
        except Exception:
            data = {}
        if isinstance(data, dict) and "redirect_url" in data:
            logger.info("Keepalive: session expired, re-authenticating")
            await self._authenticate()
            # One retry after re-auth. If that still fails, _last_ok_at is
            # left stale and is_connected() will flip False after the
            # liveness window.
            resp = await self._client.get("/stat/sysinfo")
            try:
                data = resp.json()
            except Exception:
                return
            if isinstance(data, dict) and "redirect_url" in data:
                return
        self._last_ok_at = time.monotonic()

    async def _request(
        self, method: str, path: str, retry: bool = True, **kwargs
    ) -> dict:
        """Make an authenticated request with auto-reauthentication on session expiry.

        Returns the parsed JSON response. Retries once if the session has expired.
        Successful calls also refresh `_last_ok_at` so application traffic
        counts toward liveness the same way keepalive pings do.
        """
        if not self._client:
            raise ConnectionLost("Not connected to switch")

        try:
            resp = await self._client.request(method, path, **kwargs)

            # Guard against non-JSON responses (e.g., HTML error pages)
            content_type = resp.headers.get("content-type", "")
            if "json" not in content_type and "javascript" not in content_type:
                if resp.status_code >= 400:
                    raise SwitchAPIError(resp.status_code, f"Non-JSON response: {resp.text[:200]}")
                # Try parsing anyway — some firmware sends JSON without the header
            try:
                data = resp.json()
            except Exception:
                raise SwitchAPIError(resp.status_code, f"Invalid JSON from switch: {resp.text[:200]}")

            # Check for session expiry (switch redirects to login)
            if isinstance(data, dict) and "redirect_url" in data:
                if retry:
                    logger.info("Session expired, re-authenticating...")
                    await self._authenticate()
                    return await self._request(method, path, retry=False, **kwargs)
                raise AuthenticationError("Session expired and re-auth failed")

            if isinstance(data, dict) and "error" in data:
                raise SwitchAPIError(resp.status_code, data["error"])

            self._last_ok_at = time.monotonic()
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
