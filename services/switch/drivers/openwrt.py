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

Writes go through uci with a safe-apply arm (WARP-1730, parity with
services/routing's ``safe_apply``): stage (`uci set/add/delete`) →
`uci apply` with a device-side rollback timer → connectivity probe
(`system board`) → `uci confirm`. If the probe fails, confirm never fires
and the device reverts itself when the timer expires — a bridge/VLAN write
that strands the switch's static management address (192.168.9.2) can no
longer be permanent. If anything fails while changes are still staged, every
staged config is reverted (rpcd's staging area is SHARED — leftovers would
be silently committed by the next unrelated apply from any endpoint). The
GS1900 image has NO `file exec` grant at all, so nothing here shells out.
Writes are gated by ``plan_only`` (default ON): the uci write shapes are
built from the committed image config and have not yet been confirmed
against flashed hardware (the lab unit still runs stock firmware — see
droplet-edge-router/switch/docs/STATUS.md). Reads are exact.

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
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

import httpx

from .base import (
    SwitchDriver,
    ConnectionLost,
    AuthenticationError,
    SwitchAPIError,
    InvalidPortError,
    PoweredMemberError,
    ProtectedPortError,
)

logger = logging.getLogger("droplet.switch.openwrt")

# GS1900 family bounds. These are a SANITY RANGE for input validation across
# the variants we ship — they are NOT the port list of any given unit, and
# nothing user-visible may be derived from them (WARP-2165). The 8HP has
# lan1-8 and no SFP cage at all; the 10HP has lan1-10 with 9-10 optical. The
# real port set comes from the device via `_device_port_numbers()`, which is
# read off a `network.device status` call `get_ports` was already making.
PORT_MIN = 1
PORT_MAX = 10
POE_PORT_MIN = 1
POE_PORT_MAX = 8
# The optical bank on variants that HAVE one. Only ever applied to ports the
# device actually reports, so on an 8HP this range matches nothing.
SFP_PORT_MIN = 9
SFP_PORT_MAX = 10

# ubus wire constants (same values as services/routing's SDK).
NULL_SESSION = "0" * 32
UBUS_NO_DATA = 5
UBUS_PERMISSION_DENIED = 6

# Rollback window for `uci apply` (WARP-1730). Mirrors services/routing
# ``safe_apply``'s 60s, which matches the WARP-41 confirmation-token TTL —
# a Tier 2 confirmation token can never outlive the apply window. The switch
# service has no competing convention (SWITCH_PROVISION_TIMEOUT budgets the
# whole provisioning reconcile, not a single apply).
APPLY_ROLLBACK_TIMEOUT_S = 60

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


def _traffic_fields(statistics: Any) -> Optional[dict]:
    """netifd's per-device `statistics` block → the §7 traffic shape.

    Returns ``None`` when the driver reports no counters (an SFP cage with no
    module, a build without statistics) rather than zeros — "we don't know" and
    "nothing has crossed this port" are different claims, and the dashboard
    renders them differently.
    """
    if not isinstance(statistics, dict):
        return None
    try:
        rx = int(statistics["rx_bytes"])
        tx = int(statistics["tx_bytes"])
    except (KeyError, TypeError, ValueError):
        return None
    if rx < 0 or tx < 0:
        return None
    return {"rx_bytes": rx, "tx_bytes": tx}


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


def _raw_vlan_port_list(entries: Any) -> list[str]:
    """Normalise a uci bridge-vlan `ports` value to a list of raw entry strings.

    🔴 uci returns a MULTI-value option as a JSON list but a SINGLE-value (or
    whitespace-joined) option as a plain STRING. VLAN 1 as written by
    board.d/02_network comes back as the string "lan1 lan2 ... lan10"; iterating
    that string yields one CHARACTER at a time, so every entry failed to parse
    and VLAN 1 rendered with ZERO ports (audit 2026-08-06). Split a string on
    whitespace; pass a list through unchanged."""
    if isinstance(entries, str):
        return entries.split()
    if isinstance(entries, list):
        return [str(e) for e in entries]
    return []


def _parse_bridge_vlan_ports(entries: Any) -> list[dict]:
    """uci bridge-vlan `ports` entries ("lan1:u*", "lan9:t", bare "lan3") →
    the base-class membership shape. `u` = untagged, `*` = PVID; a bare entry
    is tagged (netifd's default)."""
    out: list[dict] = []
    for entry in _raw_vlan_port_list(entries):
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
        protected_port: int = 0,
    ) -> None:
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        # The uplink/trunk this appliance reaches the router through. 0 = none
        # configured, nothing protected. See `_refuse_if_protected`.
        self._protected_port = protected_port
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
        # Count the ports the unit HAS. `PORT_MAX` is the widest variant, so
        # reporting it told every 8HP owner they had 10 ports (WARP-2165).
        port_count = len(await self._device_port_numbers())
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
            "port_count": port_count,
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

    async def _device_status(self) -> dict:
        devices = await self._ubus("network.device", "status")
        return devices if isinstance(devices, dict) else {}

    @staticmethod
    def _port_numbers_from(devices: dict) -> list[int]:
        """The unit's REAL port numbers, off its own device list.

        `network.device status` names every netdev the switch has — on the
        live 8HP exactly `eth0 lan1..lan8 lo switch switch.1`. Only the `lanN`
        entries are ports, so the non-port devices must be filtered rather
        than counted, and the numbers must be taken as-is rather than
        re-derived as `range(1, len+1)`: a unit that names lan1/lan2/lan5 has
        a port 5, not a port 3.

        Returns [] when the unit answers but names no ports. That is the
        honest reading of a degraded response — falling back to the old
        10-port assumption is exactly what invented two ports on the 8HP.
        """
        found = set()
        for name in devices:
            num = _port_from_name(name)
            if num is not None:
                found.add(num)
        return sorted(found)

    async def _device_port_numbers(self) -> list[int]:
        ports = self._port_numbers_from(await self._device_status())
        if not ports:
            logger.warning(
                "Switch reported no lanN devices — port list is empty. Not "
                "assuming a %d-port unit (WARP-2165).", PORT_MAX,
            )
        return ports

    async def get_ports(self) -> list[dict]:
        devices = await self._device_status()
        try:
            pvids = await self._pvid_by_port()
        except (SwitchAPIError, ConnectionLost):
            pvids = {}
        poe_by_port = {p["port"]: p for p in await self.get_poe_status()}
        out = []
        for port in self._port_numbers_from(devices):
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
                # WARP-1716: netifd already hands us per-port counters on the
                # SAME `network.device status` read (no extra call, no new ACL
                # grant). They are the only evidence the dashboard has that a
                # port is carrying traffic rather than merely being plugged in.
                "traffic": _traffic_fields(st.get("statistics")),
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

    def _refuse_if_protected(self, port: int, enabled: bool, action: str) -> None:
        """Hard refusal on the appliance's uplink (WARP-2165).

        Only ever blocks the DISABLING direction — restoring a port can only
        help, and a guard that blocked it would make the uplink unrecoverable
        through the product. There is no `force` parameter on purpose: see
        :class:`ProtectedPortError`.
        """
        if enabled or not self._protected_port or port != self._protected_port:
            return
        raise ProtectedPortError(
            f"Refusing to {action} port {port}: it is this appliance's uplink "
            f"to the router (SWITCH_PROTECTED_PORT). Cutting it severs the box "
            f"from the fabric — including the connection carrying this request "
            f"— so nothing would remain that could undo it."
        )

    async def set_port_enabled(self, port: int, enabled: bool) -> None:
        self._validate_port(port)
        # BEFORE the unimplemented-write error below, so the refusal is already
        # correct on the day WARP-1674 lands the real write path rather than
        # that day silently shipping an unguarded cut.
        self._refuse_if_protected(port, enabled, "disable")
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

    # ------------------------------------------------------------------
    # Safe apply (WARP-1730)
    # ------------------------------------------------------------------
    async def _revert_staged_changes(self) -> None:
        """Best-effort sweep of rpcd's uci staging area (PYNET-005 parity with
        services/routing ``safe_apply``): the staging area is SHARED across
        endpoints, so a half-staged delta left behind by a failed write would
        be silently committed by the NEXT unrelated apply from any caller.
        Enumerate every config with pending deltas and revert each."""
        try:
            pending = await self._ubus("uci", "changes")
            changed = (
                pending.get("changes", pending) if isinstance(pending, dict) else {}
            )
            if not isinstance(changed, dict):
                changed = {}
            for config in list(changed):
                try:
                    await self._ubus("uci", "revert", {"config": config})
                except (SwitchAPIError, ConnectionLost):
                    logger.exception("Safe apply: revert failed for config %s", config)
        except (SwitchAPIError, ConnectionLost):
            logger.exception(
                "Safe apply: could not enumerate staged uci changes for revert"
            )

    async def _apply_with_rollback(self) -> None:
        """apply(rollback-armed) → connectivity probe → confirm.

        `uci apply` commits every pending change and reloads the affected
        services with a device-side rollback timer; if we cannot reach the
        switch afterwards (the write stranded 192.168.9.2), confirm never
        fires and the device restores itself when the timer expires.
        """
        try:
            await self._ubus("uci", "apply", {
                "rollback": True, "timeout": APPLY_ROLLBACK_TIMEOUT_S,
            })
        except SwitchAPIError as exc:
            if exc.code == UBUS_NO_DATA:
                # Nothing pending: rpcd skips unchanged values server-side
                # (WARP-987), so a re-post of the current config stages
                # nothing and apply reports NO_DATA — benign, never a fault.
                logger.info("Safe apply: no staged changes — nothing to apply.")
                return
            await self._revert_staged_changes()
            raise
        except BaseException:
            await self._revert_staged_changes()
            raise
        # Probe: the driver's cheapest read that proves the management plane
        # still answers (same call `is_connected` uses).
        try:
            await self._ubus("system", "board")
        except BaseException as exc:
            logger.warning(
                "Safe apply: connectivity probe failed after apply — device "
                "auto-rollback in %ds: %s", APPLY_ROLLBACK_TIMEOUT_S, exc,
            )
            raise
        try:
            await self._ubus("uci", "confirm")
        except BaseException as exc:
            logger.warning(
                "Safe apply: confirm failed — device auto-rollback in %ds: %s",
                APPLY_ROLLBACK_TIMEOUT_S, exc,
            )
            raise
        logger.info("Safe apply: changes applied and confirmed.")

    @asynccontextmanager
    async def _safe_apply(self) -> AsyncIterator[None]:
        """Stage uci writes inside this block. On clean exit they are applied
        with a rollback timer, probed, and confirmed; on ANY exception inside
        the block every staged config is reverted and the exception re-raised
        so a half-write cannot linger in rpcd's shared staging area."""
        try:
            yield
        except BaseException:
            await self._revert_staged_changes()
            raise
        await self._apply_with_rollback()

    async def create_vlan(self, vlan_id: int, name: str = "") -> None:
        plan = {"op": "create_vlan", "vlan_id": vlan_id, "name": name}
        if self._plan_only:
            logger.info("Create VLAN %d (%s) PLANNED (plan_only) — not applied.", vlan_id, name)
            return
        values = {"device": "switch", "vlan": str(vlan_id)}
        if name:
            values["name"] = name
        async with self._safe_apply():
            await self._ubus("uci", "add", {
                "config": "network", "type": "bridge-vlan", "values": values,
            })
        logger.info("Create VLAN %d applied: %s", vlan_id, plan)

    async def delete_vlan(self, vlan_id: int) -> None:
        if self._plan_only:
            logger.info("Delete VLAN %d PLANNED (plan_only) — not applied.", vlan_id)
            return
        vlan = await self._vlan_section(vlan_id)
        if vlan is None:
            raise SwitchAPIError(code=404, message=f"VLAN {vlan_id} not found")
        async with self._safe_apply():
            await self._ubus("uci", "delete", {"config": "network", "section": vlan["_section"]})

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
        async with self._safe_apply():
            await self._ubus("uci", "set", {
                "config": "network", "section": vlan["_section"], "values": {"ports": ports},
            })

    async def set_port_access_vlan(self, port: int, vlan_id: int) -> None:
        """Make `port` the untagged (access/PVID) member of `vlan_id` WITHOUT
        disturbing that VLAN's other members, and remove it from any OTHER VLAN
        where it is an untagged member (a port has exactly one access VLAN).

        🔴 Why this is not `set_vlan_membership([one port])`: that writes the
        VLAN's whole `ports` list, so a single-port call WIPED every other
        member — on the flat-lan default VLAN 1 that is the router uplink, the
        AP and the appliance, i.e. it strands the entire fabric on the first
        reconcile (audit 2026-08-06). This works on the RAW uci entries so it
        preserves each other port's exact suffix (bare / `:u*` / `:t`): a
        read→parse→re-serialise round-trip is lossy (a bare VLAN-1 entry would
        come back `:t`, silently re-tagging the LAN), so we never rebuild an
        entry we did not have to.

        Tagged (trunk) memberships — `lanN:t`, e.g. the guest VLAN 30 trunk —
        are left untouched: only untagged/access membership is exclusive.
        """
        if self._plan_only:
            # Same gate as every sibling write. This primitive is now reachable
            # from the interactive membership endpoint (not just the
            # provisioner), so without it SWITCH_LIVE_WRITES=0 would move a
            # port on real hardware while the API answered "planned".
            logger.info(
                "Port %d → access VLAN %d PLANNED (plan_only) — not applied.",
                port, vlan_id,
            )
            return
        name = _port_name(port)

        def _num(entry: str) -> Optional[int]:
            return _port_from_name(str(entry).partition(":")[0])

        def _is_tagged(entry: str) -> bool:
            return str(entry).endswith(":t")

        values = await self._uci_values("network")
        sections: dict[int, tuple[str, list[str]]] = {}
        for sid, section in values.items():
            if section.get(".type") != "bridge-vlan":
                continue
            try:
                vid = int(section.get("vlan"))
            except (TypeError, ValueError):
                continue
            sections[vid] = (sid, _raw_vlan_port_list(section.get("ports")))

        if vlan_id not in sections:
            raise SwitchAPIError(
                code=404,
                message=f"VLAN {vlan_id} not found — create it before assigning a port",
            )

        async with self._safe_apply():
            # Target VLAN: keep every other entry verbatim; (re)add this port
            # as explicit untagged + PVID.
            target_sid, target_ports = sections[vlan_id]
            kept = [e for e in target_ports if _num(e) != port]
            kept.append(f"{name}:u*")
            await self._ubus("uci", "set", {
                "config": "network", "section": target_sid,
                "values": {"ports": kept},
            })

            # Every other VLAN: drop this port ONLY from untagged membership;
            # never touch a tagged trunk entry.
            for vid, (sid, raw_ports) in sections.items():
                if vid == vlan_id:
                    continue
                pruned = [
                    e for e in raw_ports
                    if not (_num(e) == port and not _is_tagged(e))
                ]
                if len(pruned) != len(raw_ports):
                    await self._ubus("uci", "set", {
                        "config": "network", "section": sid,
                        "values": {"ports": pruned},
                    })

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

    async def get_fdb(self) -> list[dict]:
        """Learned MAC→port map from the `bridge.fdb` rpcd plugin (WARP-1734).

        The plugin ships in the switch overlay (droplet-edge-router
        switch/files/usr/share/rpcd/ucode/droplet-bridge.uc) and already
        filters the switch's own permanent addresses and the CPU-side port,
        so what comes back is "what is plugged into which port".

        Degrades to [] on ANY fault, so read-only consumers (topology display)
        keep working on an older image without the plugin. NOTE: [] here is
        AMBIGUOUS — it means both "FDB read failed" and "FDB is empty". The PoE
        guard must distinguish the two (unavailable ⇒ cannot prove safe ⇒ fail
        closed), so it does NOT use this method; it reads the FDB itself via
        `_powered_or_unknown`, which reports availability separately.
        """
        try:
            result = await self._ubus("bridge", "fdb")
        except (SwitchAPIError, ConnectionLost) as exc:
            logger.info(
                "FDB unavailable (%s) — switch image predates the bridge.fdb "
                "plugin or its ACL grant; topology degrades to unknown", exc,
            )
            return []
        entries = result.get("entries") if isinstance(result, dict) else None
        if not isinstance(entries, list):
            return []
        out: list[dict] = []
        for e in entries:
            if not isinstance(e, dict):
                continue
            mac, port = e.get("mac"), e.get("port")
            if not isinstance(mac, str) or not isinstance(port, str):
                continue
            out.append({"mac": mac.lower(), "port": port, "vlan": e.get("vlan")})
        return out

    async def port_powers(self, port: int) -> list[str]:
        """MACs the switch has learned on `port` — i.e. what this port feeds.

        The join that makes the ADR-035 §7 PoE guard possible: `poe info`
        knows a port draws power, the FDB knows which device is on it, and
        only together can the control plane say "port 2 powers the AP that is
        serving the household's Wi-Fi right now".
        """
        want = f"lan{port}"
        return [e["mac"] for e in await self.get_fdb() if e.get("port") == want]

    async def _powered_or_unknown(self, port: int) -> tuple[bool, list[str]]:
        """`(topology_known, macs_on_port)` for the PoE guard.

        `get_fdb()` deliberately degrades to `[]` on ANY fault, which conflates
        two very different states: "the FDB is readable and this port feeds
        nothing" (safe to cut) versus "we could not read the FDB at all" (we
        CANNOT prove the port is safe to cut). The guard must fail CLOSED on the
        latter, so read the FDB here directly and report availability, rather
        than going through the swallowing helper."""
        try:
            result = await self._ubus("bridge", "fdb")
        except (SwitchAPIError, ConnectionLost) as exc:
            logger.warning(
                "PoE guard: FDB unreadable (%s) — cannot verify what port %d "
                "feeds; failing closed", exc, port,
            )
            return (False, [])
        entries = result.get("entries") if isinstance(result, dict) else None
        if not isinstance(entries, list):
            # A malformed answer is not a trustworthy "empty" — treat as unknown.
            return (False, [])
        want = f"lan{port}"
        macs = [
            e["mac"].lower()
            for e in entries
            if isinstance(e, dict) and isinstance(e.get("mac"), str) and e.get("port") == want
        ]
        return (True, macs)

    async def set_port_poe(
        self, port: int, enabled: bool, force: bool = False,
    ) -> dict | None:
        self._validate_poe_port(port)
        # WARP-2165 runs BEFORE the ADR-035 §7 guard below because it is the
        # stricter of the two: that one yields to `force`, this one does not.
        # Ordering them the other way would let `force=true` reach the uplink.
        self._refuse_if_protected(port, enabled, "cut PoE on")
        # ADR-035 §7 hard refusal. De-powering a device is the one action in
        # this rack with NO remote recovery: the device cannot roll itself
        # back, cannot confirm, and cannot be reached to undo it. So a
        # disable that would darken something the switch can SEE on that port
        # is refused rather than warned about. `force` is the operator saying
        # they know. Enables are never guarded — restoring power is safe.
        if not enabled and not force:
            known, powered = await self._powered_or_unknown(port)
            if not known:
                # Fail CLOSED: de-powering a device has no remote recovery, so
                # if we cannot read the forwarding table we cannot prove the
                # port is safe to cut. (Older images without the bridge.fdb
                # plugin land here — the operator overrides with force=true.)
                raise PoweredMemberError(
                    f"Refusing to cut PoE on port {port}: the switch's "
                    f"forwarding table is unreadable, so I can't verify nothing "
                    f"critical is on it. Pass force=true to override."
                )
            if powered:
                raise PoweredMemberError(
                    f"Refusing to cut PoE on port {port}: it powers "
                    f"{', '.join(powered)}. A de-powered device cannot be "
                    f"reached to undo this. Pass force=true to override."
                )
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
        async with self._safe_apply():
            await self._ubus("uci", "set", {
                "config": "poe", "section": section_id,
                "values": {"enable": "1" if enabled else "0"},
            })
        # Belt-and-braces runtime reload: `uci apply` already fires
        # reload_config, but realtek-poe's reload-trigger coverage is not yet
        # confirmed against flashed hardware (WARP-1674). Safe after confirm —
        # the poe daemon cannot strand the management plane.
        try:
            await self._ubus("poe", "reload")
        except SwitchAPIError as exc:
            logger.warning("poe reload denied/failed after safe apply: %s", exc)
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
            # Say WHY there was no optical answer. "no SFP link present" reads
            # as "the cage is empty" on a unit that has no cage at all — on the
            # 8HP the honest statement is that the variant has none
            # (WARP-2165).
            has_sfp_bank = any(p["is_sfp"] for p in ports)
            reason = (
                "first copper port with active link (no SFP link present)"
                if has_sfp_bank
                else "first copper port with active link (this unit has no SFP ports)"
            )
            return {
                "wan_port": linked[0]["port"],
                "confidence": "low",
                "reason": reason,
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
