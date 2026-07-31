"""OpenWrt managed switch driver (WARP-1674).

Controls a switch running the Droplet OpenWrt image — first target: the Zyxel
GS1900-10HP A1 (droplet-edge-router `switch/` subtree) at 192.168.9.2 on the
edge-router shape — via ubus-over-HTTP JSON-RPC (`POST /ubus`), authenticating
as the per-unit `droplet-ai` rpcd user. Same transport and account model as
services/routing's SDK against the Pi edge router; async httpx here to match
this service's driver contract.

Data sources (all granted by the switch's droplet-ai ACL):
- system board / system info       → model, firmware, hostname, uptime
- network.device status            → per-port link, speed, duplex, MAC
- uci get network (bridge-vlan)    → VLANs, per-port PVID/tagging
- poe info + uci get poe           → PoE status, budget, per-port admin state

Writes go through uci (`uci set/add/delete/commit`) + a runtime reload
(`poe reload` / `network reload`). The GS1900 image has NO `file exec` grant
at all, so nothing here shells out. Writes are gated by ``plan_only``
(default ON): the uci write shapes are built from the committed image config
and have not yet been confirmed against flashed hardware (the lab unit still
runs stock firmware — see droplet-edge-router/switch/docs/STATUS.md). Reads
are exact.

Port layout (GS1900-10HP): 8x GbE copper PoE (lan1-lan8, 77 W budget) +
2x SFP (lan9-lan10, no PoE). uci names ports "lanN"; the REST/§7 contract
speaks bare integers — `_port_name`/`_port_from_name` translate at the edge.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Awaitable, Callable, Optional

import httpx

from .base import (
    SwitchDriver,
    ConnectionLost,
    AuthenticationError,
    SwitchAPIError,
    InvalidPortError,
)

logger = logging.getLogger("droplet.switch.openwrt")

# GS1900-10HP port configuration.
PORT_MIN = 1
PORT_MAX = 10
POE_PORT_MIN = 1
POE_PORT_MAX = 8
SFP_PORT_MIN = 9
SFP_PORT_MAX = 10

# ubus wire constants (same values as services/routing's SDK).
NULL_SESSION = "0" * 32
UBUS_PERMISSION_DENIED = 6

# Re-login this many seconds before the rpcd session's own expiry.
_SESSION_SLACK_S = 30.0

# IEEE 802.3 per-port ceilings by the mode string realtek-poe reports.
_POE_MODE_MAX_MW = {"PoE": 15400, "PoE+": 30000, "PoE++": 60000}

#: Injectable transport for tests: takes the JSON-RPC payload dict, returns the
#: parsed response dict. Production uses httpx against http://host:port/ubus.
Transport = Callable[[dict], Awaitable[dict]]


def _port_name(port: int) -> str:
    return f"lan{port}"


def _port_from_name(name: str) -> Optional[int]:
    m = re.fullmatch(r"lan(\d+)", name or "")
    return int(m.group(1)) if m else None


def _speed_fields(speed: Any) -> tuple[str, str]:
    """netifd reports e.g. "1000F" / "100H" / "-1F" (down). → (label, duplex)."""
    s = str(speed or "")
    m = re.fullmatch(r"(-?\d+)([FH]?)", s)
    if not m:
        return "", ""
    mbps = int(m.group(1))
    if mbps <= 0:
        return "", ""
    label = f"{mbps // 1000} Gb" if mbps % 1000 == 0 else f"{mbps} Mb"
    duplex = {"F": "full", "H": "half"}.get(m.group(2), "")
    return label, duplex


def _format_uptime(seconds: Any) -> Optional[str]:
    try:
        total = int(seconds)
    except (TypeError, ValueError):
        return None
    if total < 0:
        return None
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def _parse_bridge_vlan_ports(entries: Any) -> list[dict]:
    """uci bridge-vlan `ports` entries ("lan1:u*", "lan9:t", bare "lan3") →
    the base-class membership shape. `u` = untagged, `*` = PVID; a bare entry
    is tagged (netifd's default)."""
    out: list[dict] = []
    for entry in entries or []:
        name, _, flags = str(entry).partition(":")
        port = _port_from_name(name)
        if port is None:
            continue
        out.append({
            "port": port,
            "tagged": "u" not in flags,
            "member": True,
            "pvid": "*" in flags,
        })
    return sorted(out, key=lambda p: p["port"])


class OpenWrtSwitchDriver(SwitchDriver):
    """Droplet-image OpenWrt switch over ubus-over-HTTP as `droplet-ai`.

    Concurrency model: `_auth_lock` serializes rpcd logins so parallel
    callers can't stomp each other's session token; every ubus call
    refreshes the session lazily (rpcd extends expiry on use, so no
    keepalive scheduler is needed).
    """

    def __init__(
        self,
        host: str,
        port: int = 80,
        username: str = "droplet-ai",
        password: str = "",
        plan_only: bool = True,
        timeout_s: float = 8.0,
        transport: Optional[Transport] = None,
    ) -> None:
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._plan_only = plan_only
        self._timeout_s = timeout_s
        self._base_url = f"http://{host}:{port}/ubus"
        self._transport = transport
        self._client: Optional[httpx.AsyncClient] = None
        self._session_token: Optional[str] = None
        self._session_expires_at: float = 0.0
        self._auth_lock = asyncio.Lock()
        self._rpc_id = 0

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------
    def _next_id(self) -> int:
        self._rpc_id += 1
        return self._rpc_id

    async def _post(self, payload: dict) -> dict:
        if self._transport is not None:
            try:
                return await self._transport(payload)
            except httpx.HTTPError as exc:
                raise ConnectionLost(
                    f"Cannot reach switch at {self._base_url}: {exc}"
                ) from exc
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout_s)
        try:
            res = await self._client.post(self._base_url, json=payload)
        except httpx.HTTPError as exc:
            raise ConnectionLost(f"Cannot reach switch at {self._base_url}: {exc}") from exc
        if res.status_code != 200:
            raise ConnectionLost(
                f"Switch ubus endpoint returned HTTP {res.status_code} at {self._base_url}"
            )
        try:
            return res.json()
        except json.JSONDecodeError as exc:
            raise ConnectionLost(f"Malformed ubus response from {self._base_url}") from exc

    async def _rpc(self, session: str, obj: str, method: str, args: Optional[dict] = None) -> Any:
        """One ubus call → response data. Raises SwitchAPIError on non-zero
        ubus status (carrying the ubus code), ConnectionLost on transport
        failure. Credential classification happens only at the login site."""
        resp = await self._post({
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "call",
            "params": [session, obj, method, args or {}],
        })
        if "error" in resp:
            message = resp["error"].get("message", str(resp["error"]))
            raise SwitchAPIError(code=0, message=f"ubus error on {obj}.{method}: {message}")
        result = resp.get("result", [])
        if not result:
            raise SwitchAPIError(code=0, message=f"Empty ubus result for {obj}.{method}")
        code = result[0]
        if code != 0:
            raise SwitchAPIError(code=code, message=f"ubus status {code} on {obj}.{method}")
        return result[1] if len(result) > 1 else {}

    async def _login(self) -> None:
        async with self._auth_lock:
            if self._session_token and time.monotonic() < self._session_expires_at:
                return  # a concurrent caller re-authed while we waited
            try:
                data = await self._rpc(NULL_SESSION, "session", "login", {
                    "username": self._username,
                    "password": self._password,
                })
            except SwitchAPIError as exc:
                if exc.code == UBUS_PERMISSION_DENIED:
                    raise AuthenticationError(
                        f"Switch rejected rpcd credentials for user "
                        f"'{self._username}' — the per-unit droplet-ai password "
                        f"has likely rotated (reflash). Re-sync "
                        f"docker/secrets/switch_password."
                    ) from exc
                raise
            self._session_token = data.get("ubus_rpc_session")
            if not self._session_token:
                raise AuthenticationError("Switch login returned no session token")
            timeout = float(data.get("timeout", 300))
            self._session_expires_at = time.monotonic() + timeout - _SESSION_SLACK_S
            logger.info("Authenticated to switch as %s (session %ds)", self._username, int(timeout))

    async def _ubus(self, obj: str, method: str, args: Optional[dict] = None) -> Any:
        if not self._session_token or time.monotonic() >= self._session_expires_at:
            await self._login()
        try:
            return await self._rpc(self._session_token, obj, method, args)
        except SwitchAPIError as exc:
            # An expired/revoked session also reports PERMISSION_DENIED — one
            # forced re-login retry distinguishes it from a genuine ACL gap.
            if exc.code != UBUS_PERMISSION_DENIED:
                raise
            self._session_token = None
            await self._login()
            return await self._rpc(self._session_token, obj, method, args)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def connect(self) -> None:
        try:
            await self._login()
        except (ConnectionLost, AuthenticationError):
            raise
        except SwitchAPIError as exc:
            raise ConnectionLost(f"Switch login failed: {exc}") from exc

    async def disconnect(self) -> None:
        if self._session_token:
            try:
                await self._rpc(self._session_token, "session", "destroy",
                                {"ubus_rpc_session": self._session_token})
            except (ConnectionLost, SwitchAPIError):
                pass
            self._session_token = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def is_connected(self) -> bool:
        try:
            await self._ubus("system", "board")
            return True
        except (ConnectionLost, AuthenticationError, SwitchAPIError):
            return False

    # ------------------------------------------------------------------
    # System
    # ------------------------------------------------------------------
    async def _poe_info(self) -> dict:
        """`poe info` — tolerant: a build without realtek-poe (or a pre-flash
        stock unit) reports no PoE rather than failing every system read."""
        try:
            return await self._ubus("poe", "info")
        except (SwitchAPIError, ConnectionLost):
            return {}

    async def get_system_info(self) -> dict:
        board = await self._ubus("system", "board")
        info = await self._ubus("system", "info")
        poe = await self._poe_info()
        release = board.get("release") or {}
        mac = ""
        try:
            dev = await self._ubus("network.device", "status", {"name": "switch"})
            mac = dev.get("macaddr", "")
        except (SwitchAPIError, ConnectionLost):
            pass
        budget_w = poe.get("budget")
        return {
            # board.model already carries the vendor ("Zyxel GS1900-10HP A1").
            "model": board.get("model", "OpenWrt switch"),
            "firmware_version": release.get("version", ""),
            "mac_address": mac,
            "uptime": _format_uptime(info.get("uptime")),
            "hostname": board.get("hostname", ""),
            "port_count": PORT_MAX,
            "poe_budget_mw": float(budget_w) * 1000 if budget_w is not None else None,
            "driver": "openwrt",
        }

    # ------------------------------------------------------------------
    # Ports
    # ------------------------------------------------------------------
    async def _pvid_by_port(self) -> dict[int, int]:
        out: dict[int, int] = {}
        for vlan in await self._bridge_vlans():
            for p in vlan["ports"]:
                if p.get("pvid"):
                    out[p["port"]] = vlan["vlan_id"]
        return out

    async def get_ports(self) -> list[dict]:
        devices = await self._ubus("network.device", "status")
        if not isinstance(devices, dict):
            devices = {}
        try:
            pvids = await self._pvid_by_port()
        except (SwitchAPIError, ConnectionLost):
            pvids = {}
        poe_by_port = {p["port"]: p for p in await self.get_poe_status()}
        out = []
        for port in range(PORT_MIN, PORT_MAX + 1):
            st = devices.get(_port_name(port)) or {}
            speed_label, duplex = _speed_fields(st.get("speed"))
            entry = {
                "port": port,
                "name": f"Port {port}",
                "enabled": bool(st.get("up", False)),
                "link_up": bool(st.get("carrier", False)),
                "speed": speed_label,
                "duplex": duplex,
                "is_sfp": SFP_PORT_MIN <= port <= SFP_PORT_MAX,
                "vlan": pvids.get(port, 1),
            }
            if port in poe_by_port:
                p = poe_by_port[port]
                entry["poe"] = {
                    "enabled": p["enabled"],
                    "delivering": p["delivering"],
                    "power_mw": p["power_mw"],
                }
            out.append(entry)
        return out

    async def get_port(self, port: int) -> dict:
        self._validate_port(port)
        for entry in await self.get_ports():
            if entry["port"] == port:
                return entry
        raise InvalidPortError(f"Port {port} not reported by the switch")

    async def set_port_enabled(self, port: int, enabled: bool) -> None:
        self._validate_port(port)
        # The image grants no `file exec` and netifd exposes no per-bridge-port
        # admin toggle over ubus — port admin control needs a confirmed uci
        # write shape against flashed hardware first (tracked with the
        # live-write confirmation in WARP-1674 / switch/docs/STATUS.md).
        raise SwitchAPIError(
            code=501,
            message=(
                "Port enable/disable is not yet supported by the openwrt "
                "switch driver — it lands with the post-flash live-write "
                "confirmation (WARP-1674)."
            ),
        )

    # ------------------------------------------------------------------
    # VLANs
    # ------------------------------------------------------------------
    async def _uci_values(self, config: str) -> dict:
        data = await self._ubus("uci", "get", {"config": config})
        values = data.get("values", {})
        return values if isinstance(values, dict) else {}

    async def _bridge_vlans(self) -> list[dict]:
        """bridge-vlan sections with internal keys (`_section` id, per-port
        `pvid`) that must never leak into the REST shape — the public readers
        below strip them."""
        values = await self._uci_values("network")
        out = []
        for section_id, section in values.items():
            if section.get(".type") != "bridge-vlan":
                continue
            try:
                vid = int(section.get("vlan"))
            except (TypeError, ValueError):
                continue
            out.append({
                "vlan_id": vid,
                "name": str(section.get("name", "") or ""),
                "ports": _parse_bridge_vlan_ports(section.get("ports")),
                "_section": section_id,
            })
        return sorted(out, key=lambda v: v["vlan_id"])

    @staticmethod
    def _public_ports(ports: list[dict]) -> list[dict]:
        return [{"port": p["port"], "tagged": p["tagged"], "member": p["member"]} for p in ports]

    async def get_vlans(self) -> list[dict]:
        return [
            {
                "vlan_id": v["vlan_id"],
                "name": v["name"],
                "ports": self._public_ports(v["ports"]),
            }
            for v in await self._bridge_vlans()
        ]

    async def _vlan_section(self, vlan_id: int) -> Optional[dict]:
        for vlan in await self._bridge_vlans():
            if vlan["vlan_id"] == vlan_id:
                return vlan
        return None

    async def get_vlan_membership(self, vlan_id: int) -> dict:
        vlan = await self._vlan_section(vlan_id)
        if vlan is None:
            raise SwitchAPIError(code=404, message=f"VLAN {vlan_id} not found")
        return {"vlan_id": vlan_id, "ports": self._public_ports(vlan["ports"])}

    @staticmethod
    def _membership_to_uci_ports(membership: list[dict]) -> list[str]:
        entries = []
        for m in sorted(membership, key=lambda m: int(m.get("port", 0))):
            if not m.get("member"):
                continue
            name = _port_name(int(m["port"]))
            entries.append(f"{name}:t" if m.get("tagged") else f"{name}:u*")
        return entries

    async def _apply_network_change(self) -> None:
        await self._ubus("uci", "commit", {"config": "network"})
        try:
            await self._ubus("network", "reload")
        except SwitchAPIError as exc:
            # Committed but not live — surfaced, not hidden: the operator sees
            # the change apply on the next reload/reboot.
            logger.warning("network reload denied/failed after uci commit: %s", exc)

    async def create_vlan(self, vlan_id: int, name: str = "") -> None:
        plan = {"op": "create_vlan", "vlan_id": vlan_id, "name": name}
        if self._plan_only:
            logger.info("Create VLAN %d (%s) PLANNED (plan_only) — not applied.", vlan_id, name)
            return
        values = {"device": "switch", "vlan": str(vlan_id)}
        if name:
            values["name"] = name
        await self._ubus("uci", "add", {
            "config": "network", "type": "bridge-vlan", "values": values,
        })
        await self._apply_network_change()
        logger.info("Create VLAN %d applied: %s", vlan_id, plan)

    async def delete_vlan(self, vlan_id: int) -> None:
        if self._plan_only:
            logger.info("Delete VLAN %d PLANNED (plan_only) — not applied.", vlan_id)
            return
        vlan = await self._vlan_section(vlan_id)
        if vlan is None:
            raise SwitchAPIError(code=404, message=f"VLAN {vlan_id} not found")
        await self._ubus("uci", "delete", {"config": "network", "section": vlan["_section"]})
        await self._apply_network_change()

    async def set_vlan_membership(self, vlan_id: int, membership: list[dict]) -> None:
        ports = self._membership_to_uci_ports(membership)
        if self._plan_only:
            logger.info(
                "VLAN %d membership PLANNED (plan_only) — not applied: %s", vlan_id, ports,
            )
            return
        vlan = await self._vlan_section(vlan_id)
        if vlan is None:
            raise SwitchAPIError(code=404, message=f"VLAN {vlan_id} not found")
        await self._ubus("uci", "set", {
            "config": "network", "section": vlan["_section"], "values": {"ports": ports},
        })
        await self._apply_network_change()

    # ------------------------------------------------------------------
    # PoE
    # ------------------------------------------------------------------
    async def _poe_uci_sections(self) -> dict[str, dict]:
        """uci poe sections by section id. realtek-poe's 30-poe uci-default
        creates ANONYMOUS `port` sections carrying a `name` option ("lanN") —
        resolve by that option, never by @port[N] positional refs."""
        try:
            return await self._uci_values("poe")
        except (SwitchAPIError, ConnectionLost):
            return {}

    async def get_poe_status(self) -> list[dict]:
        info = await self._poe_info()
        ports_raw = info.get("ports") or {}
        uci_enabled: dict[int, bool] = {}
        for section in (await self._poe_uci_sections()).values():
            if section.get(".type") != "port":
                continue
            port = _port_from_name(str(section.get("name", "")))
            if port is not None:
                uci_enabled[port] = str(section.get("enable", "1")) not in ("0", "false", "off")
        out = []
        for name, st in ports_raw.items():
            port = _port_from_name(name)
            if port is None or not (POE_PORT_MIN <= port <= POE_PORT_MAX):
                continue
            status = str(st.get("status", ""))
            mode = str(st.get("mode", "") or "")
            consumption_w = st.get("consumption") or 0.0
            out.append({
                "port": port,
                "enabled": uci_enabled.get(port, status.lower() != "disabled"),
                "delivering": status.lower().startswith("delivering"),
                "power_mw": float(consumption_w) * 1000,
                "class": mode,
                "max_power_mw": _POE_MODE_MAX_MW.get(mode, 30000),
            })
        return sorted(out, key=lambda p: p["port"])

    async def get_port_poe(self, port: int) -> dict:
        self._validate_poe_port(port)
        for entry in await self.get_poe_status():
            if entry["port"] == port:
                return entry
        raise SwitchAPIError(code=404, message=f"No PoE state reported for port {port}")

    async def set_port_poe(self, port: int, enabled: bool) -> dict | None:
        self._validate_poe_port(port)
        plan = {"port": port, "enabled": enabled}
        if self._plan_only:
            logger.info("Port %d PoE %s PLANNED (plan_only) — not applied.",
                        port, "enable" if enabled else "disable")
            return {**plan, "dry_run": True}
        section_id = None
        for sid, section in (await self._poe_uci_sections()).items():
            if section.get(".type") == "port" and _port_from_name(str(section.get("name", ""))) == port:
                section_id = sid
                break
        if section_id is None:
            raise SwitchAPIError(code=404, message=f"No uci poe section for port {port}")
        await self._ubus("uci", "set", {
            "config": "poe", "section": section_id,
            "values": {"enable": "1" if enabled else "0"},
        })
        await self._ubus("uci", "commit", {"config": "poe"})
        try:
            await self._ubus("poe", "reload")
        except SwitchAPIError as exc:
            logger.warning("poe reload denied/failed after uci commit: %s", exc)
        # Read-back: uci is the admin ground truth (the live `poe info` status
        # lags the reload by a negotiation cycle).
        for entry in await self.get_poe_status():
            if entry["port"] == port and entry["enabled"] != enabled:
                raise SwitchAPIError(
                    code=500, message=f"PoE write to port {port} did not take"
                )
        logger.info("Port %d PoE %s applied", port, "enabled" if enabled else "disabled")
        return plan

    # ------------------------------------------------------------------
    # Higher-level
    # ------------------------------------------------------------------
    async def detect_wan_port(self) -> dict:
        ports = await self.get_ports()
        linked = [p for p in ports if p["link_up"]]
        sfp_linked = [p for p in linked if p["is_sfp"]]
        if sfp_linked:
            return {
                "wan_port": sfp_linked[0]["port"],
                "confidence": "high",
                "reason": "SFP port with active link (uplink bank)",
            }
        if linked:
            return {
                "wan_port": linked[0]["port"],
                "confidence": "low",
                "reason": "first copper port with active link (no SFP link present)",
            }
        return {"wan_port": None, "confidence": "none", "reason": "no port has link"}

    async def backup_config(self) -> bytes:
        configs = (await self._ubus("uci", "configs")).get("configs", [])
        dump: dict[str, Any] = {}
        for config in configs:
            try:
                dump[config] = await self._uci_values(config)
            except (SwitchAPIError, ConnectionLost):
                dump[config] = {"_error": "unreadable"}
        return json.dumps(dump, indent=2, sort_keys=True).encode("utf-8")

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------
    @property
    def plan_only(self) -> bool:
        return self._plan_only

    @staticmethod
    def _validate_port(port: int) -> None:
        if not (PORT_MIN <= port <= PORT_MAX):
            raise InvalidPortError(f"Port {port} out of range {PORT_MIN}-{PORT_MAX}")

    @staticmethod
    def _validate_poe_port(port: int) -> None:
        if not (PORT_MIN <= port <= PORT_MAX):
            raise InvalidPortError(f"Port {port} out of range {PORT_MIN}-{PORT_MAX}")
        if not (POE_PORT_MIN <= port <= POE_PORT_MAX):
            raise InvalidPortError(
                f"Port {port} is an SFP port — PoE is only available on "
                f"ports {POE_PORT_MIN}-{POE_PORT_MAX}"
            )
