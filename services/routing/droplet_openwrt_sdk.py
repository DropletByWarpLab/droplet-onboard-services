"""
Droplet OpenWrt SDK
===================
Python client for the appliance AI module to control all aspects of the
OpenWrt routing layer via the ubus JSON-RPC API.

Usage:
    from droplet_openwrt_sdk import DropletRouter

    router = DropletRouter("192.168.50.1", username="droplet-ai", password="SECRET")

    # Get network status
    status = router.network.interface_status("lan")

    # Change WiFi SSID (radio / iface-section names are deployment-specific;
    # the shipped router host uses radio3 / default_radio3 — see schemas.py)
    router.wireless.set_ssid("radio3", "default_radio3", "My-New-SSID")
    router.apply_changes("wireless")

    # Block a device
    router.firewall.block_device("AA:BB:CC:DD:EE:FF", name="Kids-iPad")

    # Safe apply with auto-rollback
    with router.safe_apply(timeout=60):
        router.uci.set("network", "lan", {"ipaddr": "192.168.2.1"})
        router.uci.commit("network")
"""

import json
import os
import re
import time
import logging
from contextlib import contextmanager
from enum import Enum
from http.client import HTTPException
from typing import Any, Optional
from urllib.request import Request, urlopen

from request_context import get_request_id

logger = logging.getLogger("droplet.openwrt")


# ---------------------------------------------------------------------------
# Deployment topology (ADR-018 Decision 2)
# ---------------------------------------------------------------------------
class DeploymentTopology(str, Enum):
    """How this Droplet box sits on the network — an EXPLICIT, indexable state,
    never derived from the absence of a field (rule 10; mirrors the
    ``ApDeviceStatus`` / ``BrainMemoryItemStatus`` enum pattern, and the
    ``interface_stub(present=…)`` presence signal).

    * ``PRIMARY_ROUTER`` — the box owns the WAN uplink (ISP): the WAN-facing
      interface is present and up, with no upstream router handing it a default
      gateway. It IS the edge.
    * ``DOWNSTREAM_ROUTER`` — the box is plugged into an existing upstream
      network; its WAN-facing interface has an upstream default-route gateway
      (it is a DHCP client of the home/ISP router). It keeps its own LAN for
      devices and NATs them out the WAN. The upstream network is NEVER mutated —
      detection is read-only probing only.
    * ``UNKNOWN`` — the WAN-facing interface is not present on this deployment
      shape (the LAN-only single-box that motivated ADR-018), so the posture
      cannot be determined. We refuse to GUESS one of the two real postures from
      that absence; this is the explicit "undetermined" member, with the
      evidence dict carrying ``wan_present=False`` so the caller knows why.

    ``str``-valued so it round-trips cleanly through JSON on the endpoint and is
    indexable by name (``DeploymentTopology["PRIMARY_ROUTER"]``).
    """

    PRIMARY_ROUTER = "PRIMARY_ROUTER"
    DOWNSTREAM_ROUTER = "DOWNSTREAM_ROUTER"
    UNKNOWN = "UNKNOWN"


# The logical interface the SDK treats as the WAN uplink across every shape —
# the same one `get_all_interface_statuses()`, `_resolve_wan_device`, and the
# WireGuard interface probe already interrogate. Named so the probe never
# invents a second "which interface is the WAN" path.
WAN_INTERFACE_NAME = "wan"

# Default-route targets that mean "upstream gateway" on the WAN interface's
# ubus `route` list. OpenWrt reports a default route as target 0.0.0.0/0 (IPv4)
# or ::/0 (IPv6) with a `nexthop` pointing at the upstream router.
_DEFAULT_ROUTE_TARGETS = frozenset({"0.0.0.0", "::"})


# ---------------------------------------------------------------------------
# Wireless scan/info device default is deployment-shape-specific.
#
# `wlan0` is the wrong NIC name on every current shape (the router host's
# MT7922 enumerates via its `radio3` sections; a single-box's radio is
# `wlp14s0`/similar). Resolve from `DROPLET_WIFI_SCAN_DEVICE` so the shipped
# compose can name the real interface; the literal is only a last-resort
# fallback when the env is unset (NET-02). A future follow-up can derive the
# active device from `wireless.status()` / `iwinfo` and drop the literal.
# ---------------------------------------------------------------------------
def _default_wifi_scan_device() -> str:
    # The single-box compose passes `DROPLET_WIFI_SCAN_DEVICE=${...:-}`, so on a
    # blank `.env` the var arrives set-but-empty (""). A bare
    # `os.environ.get(key, "wlan0")` only fires its default when the key is
    # ABSENT, so an empty/whitespace value would slip through and
    # `iwinfo scan {"device": ""}` raises ubus INVALID_ARGUMENT. Coalesce
    # unset OR empty/whitespace → the last-resort literal.
    return (os.environ.get("DROPLET_WIFI_SCAN_DEVICE") or "").strip() or "wlan0"


# ---------------------------------------------------------------------------
# ubus return codes
# ---------------------------------------------------------------------------
UBUS_STATUS = {
    0: "OK",
    1: "INVALID_COMMAND",
    2: "INVALID_ARGUMENT",
    3: "METHOD_NOT_FOUND",
    4: "NOT_FOUND",
    5: "NO_DATA",
    6: "PERMISSION_DENIED",
    7: "TIMEOUT",
}

# Named ubus status codes (subset) used for shape-agnostic error handling —
# a deployment may legitimately lack an interface/device the SDK asks about
# (e.g. a single-box with no `wan`); see ADR-011.
UBUS_STATUS_INVALID_ARGUMENT = 2
UBUS_STATUS_NOT_FOUND = 4
UBUS_STATUS_NO_DATA = 5
UBUS_STATUS_TIMEOUT = 7

NULL_SESSION = "00000000000000000000000000000000"

# Fresh placeholder status for an interface the SDK can't read live. Mirrors the
# `InterfaceStatus` wire shape (orchestrator `types/network.ts`) so the Network
# overview renders instead of 500-ing. `present` is the canonical presence
# signal (CLAUDE.md coding-standard #2 — never derive state from the absence of
# a field): `present=False` means the interface isn't configured on this box,
# distinct from a configured-but-down interface (`present=True, up=False`).
# Returns a NEW dict each call so callers never share the nested `data`/lists.
def interface_stub(present: bool) -> dict:
    return {
        "up": False,
        "pending": False,
        "available": False,
        "autostart": False,
        "device": "",
        "proto": "",
        "uptime": 0,
        "l3_device": "",
        "ipv4-address": [],
        "ipv6-address": [],
        "route": [],
        "dns-server": [],
        "present": present,
        "data": {},
    }


def parse_ai_acl_scopes(acl: dict) -> dict:
    """Flatten the droplet-ai rpcd ACL into read/write scope chip strings.

    The ACL (openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json) groups grants
    under ``droplet-ai.{read,write}.ubus`` as ``{object: [methods]}``. The
    dashboard's scope chips are ``object.method`` strings (e.g. ``system.board``,
    ``network.interface.*.status``), so flatten each object's methods into one
    string per grant. Returns ``{"read": [...], "write": [...]}`` — empty lists on
    a missing/empty ACL (so the card renders a calm empty state, never crashes).
    """
    out: dict[str, list[str]] = {"read": [], "write": []}
    user = acl.get("droplet-ai", {}) if isinstance(acl, dict) else {}
    for kind in ("read", "write"):
        ubus = (user.get(kind, {}) or {}).get("ubus", {})
        if not isinstance(ubus, dict):
            continue
        chips: list[str] = []
        for obj, methods in ubus.items():
            if isinstance(methods, list):
                for method in methods:
                    chips.append(f"{obj}.{method}")
            else:
                chips.append(str(obj))
        out[kind] = chips
    return out


class UbusError(Exception):
    """Raised when a ubus call returns a non-zero status code."""

    def __init__(self, code: int, message: str = ""):
        self.code = code
        self.status = UBUS_STATUS.get(code, f"UNKNOWN({code})")
        super().__init__(message or f"ubus error: {self.status}")


class ConnectionLost(Exception):
    """Raised when the appliance can no longer reach the OpenWrt device."""
    pass


class LoginDenied(ConnectionLost):
    """Raised when the OpenWrt device is REACHABLE but rejects our rpcd
    credentials (`session login` → PERMISSION_DENIED).

    Subclasses :class:`ConnectionLost` so every existing "couldn't establish a
    session" catch (lifespan startup, ReconnectCoordinator, best-effort
    logout) keeps working unchanged — callers that care about the *reason*
    check for this subclass first.

    WARP-1673: on the edge-router shape a router reflash regenerates the
    per-unit `droplet-ai` password, stranding the copy in
    `docker/secrets/openwrt_password`. Before this class, that surfaced as the
    same 503 as a powered-off router and the dashboard said "Router offline"
    instead of the actionable "Credentials rejected" copy. `session login` is
    the ONLY call site where PERMISSION_DENIED unambiguously means bad
    credentials — on any other object it can equally mean an ACL gap, so this
    classification never happens in the generic call path.
    """

    #: Stable, wire-facing classification — mirrored by the routing service's
    #: HTTP 502 detail and the orchestrator's RouterError AUTH mapping.
    code = "ROUTER_AUTH"


# WARP-816: radio operating modes (from `iwinfo info` → `mode`) in which a
# single-radio card is broadcasting an AP and therefore CANNOT station-scan.
# On the single-box `wlp14s0` is `mode == "Master"` (hostapd AP for the Droplet
# network); `iw dev wlp14s0 scan` returns "Not supported (-95)", but ubus
# `iwinfo scan` swallows that to `{"results": []}` with no error — so the radio
# mode is the only reliable discriminator between "can't scan here" and
# "scanned, found nothing". Matched case-insensitively; "AP" is included for
# builds/drivers that label the role that way instead of "Master".
_AP_SCAN_BLOCKING_MODES = frozenset({"master", "ap"})


class ScanUnsupportedError(Exception):
    """Raised when a Wi-Fi scan can't run on this radio in its current mode.

    Distinct from a successful scan that finds zero networks (which returns
    `[]`): this means the radio is in an AP/Master role and physically cannot
    station-scan. The `/wireless/scan` route maps it to a typed HTTP 409 +
    stable ``code`` so the orchestrator can surface a RouterError and the
    dashboard can explain "scanning isn't available while broadcasting" instead
    of rendering an empty results list.
    """

    #: Stable, wire-facing classification — mirrored verbatim by the
    #: orchestrator RouterError and the dashboard copy map. Never renumber.
    code = "SCAN_UNSUPPORTED"

    def __init__(self, device: str, mode: Optional[str] = None):
        self.device = device
        self.mode = mode
        detail = f" (radio mode: {mode})" if mode else ""
        super().__init__(
            f"Wi-Fi scan is not available on {device}{detail} — the radio is "
            "broadcasting its own network and can't scan while it does."
        )


def _ubus_object_absent(exc: UbusError) -> bool:
    """True when a UbusError means "this object isn't present on this deployment".

    Two shapes map to the same "not on this build" meaning (ADR-011):

    * A **per-object** miss reports a numeric ``NOT_FOUND``/``NO_DATA`` code —
      same class `get_all_interface_statuses()` already degrades on.
    * A **whole missing ubus object** (no ``network.wireless`` / ``dhcp`` /
      ``firewall`` registered at all) surfaces as a top-level JSON-RPC error,
      which the low-level client raises as ``UbusError(-1, "Object not found")``
      (code -1, status ``UNKNOWN(-1)``). This is the exact 500 root-caused on the
      single-box. Matched by message so an unrelated -1 (e.g. "Empty result")
      stays a real fault.

    Everything else — ``PERMISSION_DENIED`` (auth), ``INVALID_ARGUMENT`` (caller
    bug), any other code — is NOT absence and must propagate.
    """
    if exc.code in (UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA):
        return True
    return exc.code == -1 and "not found" in str(exc).lower()


def _section_or(call, fallback):
    """Run an optional network-summary section, degrading a missing ubus object
    to ``fallback`` instead of 500-ing the whole summary (ADR-011 — a missing
    optional surface is data, not a crash). Mirrors `interface_stub(present=False)`.

    Only the "object not present on this deployment" class (see
    :func:`_ubus_object_absent`) degrades; genuine ubus faults and a total
    transport loss (`ConnectionLost`) propagate so real problems still surface.
    The ``fallback`` is passed by the caller (never shared/mutated here).
    """
    try:
        return call()
    except UbusError as exc:
        if _ubus_object_absent(exc):
            logger.warning(
                "ubus object absent on this deployment (%s); degrading section "
                "to empty for shape-agnostic summary", exc,
            )
            return fallback
        raise


# ---------------------------------------------------------------------------
# Core JSON-RPC client
# ---------------------------------------------------------------------------
class UbusClient:
    """Low-level JSON-RPC 2.0 client for OpenWrt ubus over HTTP."""

    def __init__(self, host: str, port: int = 80, scheme: str = "http", timeout: int = 10):
        self.base_url = f"{scheme}://{host}:{port}/ubus"
        self.timeout = timeout
        self._request_id = 0

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _post(self, data: bytes, label: str) -> dict | list:
        """One HTTP POST to the ubus endpoint, with WARP-868 transport rigor.

        uhttpd resets connections under concurrent load (stock
        `max_requests=3` vs the orchestrator's network-summary fan-out), and
        a reset during the response read surfaces as a NAKED
        `ConnectionResetError` — an `OSError` that is NOT a `URLError`, so
        the old `except URLError` let it escape the SDK entirely and the
        FastAPI route answered an untyped 500 (observed live on the .87 box,
        2026-06-11: 10× `ConnectionResetError: [Errno 104]`). Every transport
        failure now maps to `ConnectionLost` — which `handle_router_error`
        turns into the typed 503 the dashboard knows how to soften — after
        ONE bounded retry on a fresh connection (each call already opens its
        own socket; a single retry rides out the transient reset without
        hammering a genuinely-down router).
        """
        _hdrs = {"Content-Type": "application/json"}
        _rid = get_request_id()
        if _rid:
            _hdrs["x-request-id"] = _rid
        req = Request(self.base_url, data=data, headers=_hdrs)
        last_exc: Exception | None = None
        for attempt in (1, 2):
            try:
                with urlopen(req, timeout=self.timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except (OSError, HTTPException, ValueError) as exc:
                # OSError covers URLError, ConnectionResetError, timeouts;
                # http.client.HTTPException covers IncompleteRead /
                # RemoteDisconnected variants; ValueError covers a JSON body
                # truncated by a mid-read reset. All are transport-integrity
                # failures, never ubus-level answers.
                last_exc = exc
                if attempt == 1:
                    time.sleep(0.1)
        raise ConnectionLost(
            f"{label} failed against OpenWrt at {self.base_url}: {last_exc}"
        ) from last_exc

    def raw_call(self, method: str, params: list) -> dict:
        """Send a single JSON-RPC request and return the parsed response."""
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": method,
            "params": params,
        }
        data = json.dumps(payload).encode("utf-8")
        result = self._post(data, "Request")
        if not isinstance(result, dict):
            raise ConnectionLost(
                f"Malformed JSON-RPC response from {self.base_url}: expected object"
            )
        return result

    def call(self, session: str, obj: str, method: str, args: Optional[dict] = None) -> Any:
        """
        Call a ubus method and return the response data.

        Raises UbusError on non-zero return codes.
        """
        args = args or {}
        resp = self.raw_call("call", [session, obj, method, args])

        if "error" in resp:
            raise UbusError(-1, resp["error"].get("message", str(resp["error"])))

        result = resp.get("result", [])
        if not result:
            raise UbusError(-1, "Empty result")

        code = result[0]
        if code != 0:
            raise UbusError(code)

        return result[1] if len(result) > 1 else {}

    def batch_call(self, session: str, calls: list[tuple[str, str, dict]]) -> list[Any]:
        """
        Send multiple ubus calls in a single HTTP request.

        calls: list of (object, method, args) tuples
        Returns: list of response data dicts (same order)
        """
        payloads = []
        request_ids = []
        for obj, method, args in calls:
            req_id = self._next_id()
            request_ids.append(req_id)
            payloads.append({
                "jsonrpc": "2.0",
                "id": req_id,
                "method": "call",
                "params": [session, obj, method, args or {}],
            })

        data = json.dumps(payloads).encode("utf-8")
        # Same WARP-868 transport rigor as raw_call (reset → retry once →
        # typed ConnectionLost), via the shared _post helper.
        responses = self._post(data, "Batch call")
        if not isinstance(responses, list):
            raise ConnectionLost(
                f"Malformed JSON-RPC batch response from {self.base_url}: expected array"
            )

        # Match responses by ID (JSON-RPC batch responses may arrive in any
        # order). rpcd can emit bare error objects WITHOUT an "id" key for
        # malformed batch members — .get() keys them under None instead of
        # raising KeyError; the per-request lookup below then reports any
        # missing match as a typed UbusError.
        response_by_id = {r.get("id"): r for r in responses}
        results = []
        for req_id in request_ids:
            r = response_by_id.get(req_id)
            if r is None:
                raise UbusError(-1, f"Missing response for request {req_id}")
            res = r.get("result", [])
            code = res[0] if res else -1
            if code != 0:
                raise UbusError(code)
            results.append(res[1] if len(res) > 1 else {})
        return results

    def list_objects(self, session: str, pattern: str = "*") -> dict:
        """List available ubus objects matching a pattern."""
        resp = self.raw_call("list", [session, pattern])
        return resp.get("result", {})


# ---------------------------------------------------------------------------
# Session manager
# ---------------------------------------------------------------------------
class SessionManager:
    """Handles authentication, session refresh, and logout."""

    def __init__(self, client: UbusClient, username: str, password: str):
        self.client = client
        self.username = username
        self.password = password
        self.token: Optional[str] = None
        self.expires_at: float = 0

    def login(self) -> str:
        """Authenticate and store the session token.

        Raises :class:`LoginDenied` when the device answers but refuses the
        credentials (PERMISSION_DENIED) — distinct from :class:`ConnectionLost`
        (device unreachable) and from every other :class:`UbusError`.
        """
        try:
            result = self.client.call(NULL_SESSION, "session", "login", {
                "username": self.username,
                "password": self.password,
            })
        except UbusError as exc:
            # ubus status 6 = PERMISSION_DENIED. On `session login` that means
            # exactly one thing: the router rejected this username/password.
            if exc.code == 6:
                raise LoginDenied(
                    f"OpenWrt rejected the rpcd credentials for user "
                    f"'{self.username}' — the router password has likely "
                    f"rotated (e.g. a reflash regenerated it)."
                ) from exc
            raise
        self.token = result["ubus_rpc_session"]
        timeout = result.get("timeout", 300)
        self.expires_at = time.time() + timeout
        logger.info("Authenticated as %s (expires in %ds)", self.username, timeout)
        return self.token

    def ensure_valid(self) -> str:
        """Return a valid session token, re-authenticating if needed."""
        if self.token is None or time.time() > (self.expires_at - 30):
            self.login()
        return self.token

    def logout(self):
        """Destroy the current session."""
        if self.token:
            try:
                self.client.call(self.token, "session", "destroy", {
                    "ubus_rpc_session": self.token,
                })
            except (UbusError, ConnectionLost):
                pass
            self.token = None


# ---------------------------------------------------------------------------
# High-level API: UCI
# ---------------------------------------------------------------------------
class UCIApi:
    """Read/write OpenWrt configuration via the UCI ubus interface."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def configs(self) -> list[str]:
        """List all available config files."""
        result = self._r._call("uci", "configs")
        return result.get("configs", [])

    def get(self, config: str, section: Optional[str] = None,
            option: Optional[str] = None, type: Optional[str] = None) -> Any:
        """Read a config file, section, or individual option."""
        args = {"config": config}
        if section:
            args["section"] = section
        if option:
            args["option"] = option
        if type:
            args["type"] = type
        return self._r._call("uci", "get", args)

    def set(self, config: str, section: str, values: dict) -> Any:
        """Set one or more values on a config section."""
        return self._r._call("uci", "set", {
            "config": config, "section": section, "values": values,
        })

    def add(self, config: str, type: str, values: Optional[dict] = None, name: Optional[str] = None) -> Any:
        """Add a new anonymous or named section."""
        args: dict[str, Any] = {"config": config, "type": type}
        if values:
            args["values"] = values
        if name:
            args["name"] = name
        return self._r._call("uci", "add", args)

    def delete(self, config: str, section: str, option: Optional[str] = None) -> Any:
        """Delete a section or a single option."""
        args: dict[str, Any] = {"config": config, "section": section}
        if option:
            args["option"] = option
        return self._r._call("uci", "delete", args)

    def commit(self, config: str) -> Any:
        """Write staged changes to disk."""
        return self._r._call("uci", "commit", {"config": config})

    def apply(self, timeout: int = 30, rollback: bool = True) -> Any:
        """Apply committed changes with optional rollback safety."""
        return self._r._call("uci", "apply", {"timeout": timeout, "rollback": rollback})

    def confirm(self) -> Any:
        """Confirm applied changes (cancels auto-rollback timer)."""
        return self._r._call("uci", "confirm")

    def rollback(self) -> Any:
        """Manually rollback unapplied changes."""
        return self._r._call("uci", "rollback")

    def changes(self, config: Optional[str] = None) -> Any:
        """List staged (uncommitted) UCI changes, grouped by config."""
        args: dict[str, Any] = {}
        if config:
            args["config"] = config
        return self._r._call("uci", "changes", args)

    def revert(self, config: str) -> Any:
        """Discard staged (uncommitted) changes for a config (rpcd staging area)."""
        return self._r._call("uci", "revert", {"config": config})


# ---------------------------------------------------------------------------
# High-level API: Network
# ---------------------------------------------------------------------------
class NetworkApi:
    """Network interface management."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def interface_status(self, name: str) -> dict:
        """Get full status of an interface (lan, wan, etc.)."""
        return self._r._call(f"network.interface.{name}", "status")

    def interface_up(self, name: str) -> dict:
        """Bring an interface up."""
        return self._r._call(f"network.interface.{name}", "up")

    def interface_down(self, name: str) -> dict:
        """Bring an interface down."""
        return self._r._call(f"network.interface.{name}", "down")

    def device_status(self) -> dict:
        """Get status of all network devices (physical and virtual)."""
        return self._r._call("network.device", "status")

    def restart(self) -> dict:
        """Restart the entire networking stack."""
        return self._r._call("network", "restart")

    def get_all_interface_statuses(self) -> dict[str, dict]:
        """Status of the standard `lan`/`wan` interfaces, deployment-shape-agnostic.

        Queries each interface independently with an explicit degradation
        contract so a single interface never 500s the whole Network overview
        (ADR-011):

        * **Not present on this box** — e.g. a single-box where WAN is handled by
          the host, not the containerised OpenWrt — reported as an explicit
          ``present: False`` stub. Covers BOTH shapes of "absent" via
          :func:`_ubus_object_absent`: a configured-but-missing interface (numeric
          ubus ``NOT_FOUND``/``NO_DATA``) AND a whole missing ubus object, which
          the low-level client surfaces as ``UbusError(-1, "Object not found")``
          (the live single-box case — `network.interface.wan` simply isn't
          registered, so `ubus call` returns a top-level JSON-RPC error, not a
          numeric code).
        * **Transient read failure** of a configured interface (ubus
          ``TIMEOUT``) — reported as ``present: True, up: False`` and a warning
          logged, so a blip on one interface degrades to "down" and self-heals
          on the next poll rather than taking the page down.
        * **Any other ubus error** (e.g. ``PERMISSION_DENIED``,
          ``INVALID_ARGUMENT``) is a real fault and propagates — it is not
          masked as "down".
        * A **total transport loss** (``ConnectionLost`` — the router is
          unreachable at all) also propagates, so a genuinely offline router
          surfaces as offline upstream instead of as fake all-interfaces-down.

        Consumers read ``present`` to warn on a configured-but-down interface
        distinctly from one that simply isn't on this hardware shape.
        """
        out: dict[str, dict] = {}
        for name in ("lan", "wan"):
            try:
                status = self.interface_status(name)
                status["present"] = True
                out[name] = status
            except UbusError as exc:
                if _ubus_object_absent(exc):
                    out[name] = interface_stub(present=False)
                elif exc.code == UBUS_STATUS_TIMEOUT:
                    logger.warning(
                        "interface_status(%s) timed out; degrading to down for "
                        "this poll", name,
                    )
                    out[name] = interface_stub(present=True)
                else:
                    raise
        return out

    def list_all_interfaces(self) -> list[dict]:
        """Enumerate ALL configured interfaces with live state + zone membership.

        Unlike :meth:`get_all_interface_statuses` (a hardcoded lan/wan tuple),
        this scans ``uci.get("network")`` for every interface section — the same
        proven enumeration primitive `/network/vlans` uses — and joins:

        * live status (``interface_status``) per section, degraded to an explicit
          ``present: False`` stub when the section has no live ubus object (e.g.
          a VLAN/wan that's configured but not registered on the single-box), so
          the table renders an honest "not on this box" row rather than a fake
          "down" one. ``TIMEOUT`` degrades to ``present: True, up: False``.
        * the IPv4 ``address`` flattened to ``ip/mask`` (first address) from the
          live status, or ``None``.
        * ``zone`` membership read from the firewall zones' ``network`` lists, so
          the Zone column is real (``None`` when no zone references the section)
          rather than fabricated.

        Read-only — it cannot cut connectivity.
        """
        config = self._r.uci.get("network")
        rows: list[dict] = []
        if not isinstance(config, dict):
            return rows

        # Build a section-name → zone-name index from the firewall zones once.
        zone_by_network: dict[str, str] = {}
        try:
            zones = self._r.firewall.get_zones()
            values = zones.get("values", {}) if isinstance(zones, dict) else {}
            for zone in values.values():
                if not isinstance(zone, dict):
                    continue
                zname = zone.get("name")
                nets = zone.get("network")
                if isinstance(nets, str):
                    nets = nets.split()
                if isinstance(nets, list) and zname:
                    for n in nets:
                        zone_by_network[n] = zname
        except (UbusError, ConnectionLost):
            # Zone join is best-effort; without it the Zone column is None, not
            # fabricated.
            zone_by_network = {}

        for name, section in config.items():
            if not isinstance(section, dict):
                continue
            # Only explicit `config interface` sections. Sections without a
            # `.type` key (absent rather than "interface") could be bare device
            # entries that happen to carry a `proto` field on some builds —
            # including them causes spurious dashboard rows. Requiring `.type
            # == "interface"` is the correct filter: every `config interface`
            # block in UCI output carries that key.
            if section.get(".type") != "interface":
                continue
            if name.startswith("@"):
                continue

            try:
                status = self.interface_status(name)
                present = True
                up = bool(status.get("up", False))
                addresses = status.get("ipv4-address") or []
            except UbusError as exc:
                if _ubus_object_absent(exc):
                    status = {}
                    present = False
                    up = False
                    addresses = []
                elif exc.code == UBUS_STATUS_TIMEOUT:
                    status = {}
                    present = True
                    up = False
                    addresses = []
                else:
                    raise

            address = None
            if isinstance(addresses, list) and addresses:
                first = addresses[0]
                if isinstance(first, dict) and first.get("address") is not None:
                    mask = first.get("mask")
                    address = (
                        f"{first['address']}/{mask}" if mask is not None else str(first["address"])
                    )

            rows.append({
                "name": name,
                "device": status.get("device") or section.get("device"),
                "proto": status.get("proto") or section.get("proto"),
                "address": address,
                "zone": zone_by_network.get(name),
                "up": up,
                "present": present,
            })
        return rows

    def set_lan_ip(self, ipaddr: str, netmask: str = "255.255.255.0"):
        """Change the LAN IP address via UCI."""
        self._r.uci.set("network", "lan", {"ipaddr": ipaddr, "netmask": netmask})
        self._r.uci.commit("network")

    def set_wan_protocol(self, proto: str, **kwargs):
        """
        Set WAN protocol.

        proto: "dhcp", "static", "pppoe", etc.
        kwargs: additional options (ipaddr, netmask, username, password, etc.)
        """
        values = {"proto": proto, **kwargs}
        self._r.uci.set("network", "wan", values)
        self._r.uci.commit("network")

    def add_vlan(self, name: str, vid: int, parent_device: str = "br-lan",
                 ipaddr: str = None, netmask: str = "255.255.255.0"):
        """Create a new VLAN interface."""
        device_name = f"{parent_device}.{vid}"
        self._r.uci.set("network", name, {
            "proto": "static",
            "device": device_name,
            "ipaddr": ipaddr or f"192.168.{vid}.1",
            "netmask": netmask,
        })
        self._r.uci.commit("network")

    def create_interface(
        self,
        name: str,
        proto: str,
        device: Optional[str] = None,
        ipaddr: Optional[str] = None,
        netmask: Optional[str] = None,
        gateway: Optional[str] = None,
    ) -> None:
        """Create (or overwrite) a `config interface` section under `network` (KAN-10).

        Wrapped in ``safe_apply``: writing /etc/config/network can cut the AP/LAN
        the dashboard rides on, so the change applies with the 60s auto-rollback
        timer that reverts on lost connectivity — the same blast-radius posture as
        ``FirewallApi.set_zone_policy`` and the VPN/wireless writes. Only the
        supplied fields are written; ``proto`` is always required.
        """
        values: dict[str, Any] = {"proto": proto}
        if device is not None:
            values["device"] = device
        if ipaddr is not None:
            values["ipaddr"] = ipaddr
        if netmask is not None:
            values["netmask"] = netmask
        if gateway is not None:
            values["gateway"] = gateway
        with self._r.safe_apply(timeout=60):
            self._r.uci.set("network", name, values)
            self._r.uci.commit("network")

    def edit_interface(
        self,
        name: str,
        proto: Optional[str] = None,
        device: Optional[str] = None,
        ipaddr: Optional[str] = None,
        netmask: Optional[str] = None,
        gateway: Optional[str] = None,
    ) -> None:
        """Update only the supplied options on an existing `config interface` (KAN-10).

        Same ``safe_apply`` auto-rollback posture as :meth:`create_interface`:
        flipping an interface's proto/address/zone is exactly how an edit can
        sever the management path, so a misapply self-reverts after 60s. Raises
        :class:`ValueError` if no field is supplied (an empty edit is a no-op the
        route should reject before minting a confirm token).
        """
        values: dict[str, Any] = {}
        if proto is not None:
            values["proto"] = proto
        if device is not None:
            values["device"] = device
        if ipaddr is not None:
            values["ipaddr"] = ipaddr
        if netmask is not None:
            values["netmask"] = netmask
        if gateway is not None:
            values["gateway"] = gateway
        if not values:
            raise ValueError("edit_interface requires at least one field to change")
        with self._r.safe_apply(timeout=60):
            self._r.uci.set("network", name, values)
            self._r.uci.commit("network")


# ---------------------------------------------------------------------------
# High-level API: Wireless
# ---------------------------------------------------------------------------
class WirelessApi:
    """WiFi radio and interface management."""

    def __init__(self, router: "DropletRouter"):
        self._r = router
        # WARP-1681: warn-once latch for the strict-netifd fallback below.
        # Monotonic boolean — a threadpool race here costs at most a duplicate
        # log line, never a wrong value (contrast the WARP-816 side-channel).
        self._strict_netifd_warned = False

    def status(self) -> dict:
        """Get status of all wireless radios and interfaces.

        Returns an empty dict when this box has no ``network.wireless`` ubus
        object at all (the single-box shape: the containerised OpenWrt exposes
        only ``network.interface.lan`` + ``loopback``). A whole missing object
        surfaces as ``UbusError(-1, "Object not found")``; degrading it to ``{}``
        instead of 500-ing mirrors how ``get_network_summary`` already treats the
        same wireless section (ADR-011, shape-agnostic — a missing optional
        surface is data, not a crash). Genuine faults (PERMISSION_DENIED,
        transport ``ConnectionLost``, unrelated ubus errors) still propagate.

        WARP-1681 (edge-router): OpenWrt 25.12's netifd strict-validates
        message attributes, and the uhttpd ``/ubus`` session bridge injects
        ``ubus_rpc_session`` into every authenticated call — so a sessioned
        ``network.wireless status`` fails ``INVALID_ARGUMENT`` even though the
        object exists and the ACL grants it (verified live on ``droplet-edge``:
        the same call succeeds over the local socket, and even a valid
        ``{"device": "radio0"}`` fails remotely). ``status()`` sends no caller
        arguments, so ``INVALID_ARGUMENT`` here can only be that strict-reject
        — fall back to rpcd's ``luci-rpc getWirelessDevices``, which rpcd
        serves session-natively and which returns the identical netifd status
        shape (plus an ``iwinfo`` block that is stripped for shape parity).
        """
        try:
            return self._r._call("network.wireless", "status")
        except UbusError as exc:
            if _ubus_object_absent(exc):
                return {}
            if exc.code == UBUS_STATUS_INVALID_ARGUMENT:
                return self._status_via_luci_rpc()
            raise

    def _status_via_luci_rpc(self) -> dict:
        """Wireless status via ``luci-rpc getWirelessDevices`` (WARP-1681).

        Same payload netifd's ``network.wireless status`` returns, enriched by
        rpcd with a per-radio ``iwinfo`` block — stripped here so both paths
        hand callers one shape. When ``luci-rpc`` itself isn't on this build
        (no rpcd-mod-luci), a radio-less report is the honest answer (ADR-011)
        — with ``status()`` argless, no genuine caller bug can be masked by
        degrading. Any other ``luci-rpc`` fault (auth, unrelated codes) still
        propagates.
        """
        if not self._strict_netifd_warned:
            self._strict_netifd_warned = True
            logger.warning(
                "network.wireless rejects sessioned calls on this build "
                "(strict netifd + injected ubus_rpc_session, WARP-1681); "
                "serving wireless status via luci-rpc getWirelessDevices"
            )
        try:
            devices = self._r._call("luci-rpc", "getWirelessDevices")
        except UbusError as exc:
            if _ubus_object_absent(exc):
                return {}
            raise
        if not isinstance(devices, dict):
            return {}
        return {
            name: (
                {k: v for k, v in radio.items() if k != "iwinfo"}
                if isinstance(radio, dict)
                else radio
            )
            for name, radio in devices.items()
        }

    def up(self) -> dict:
        """Enable all wireless interfaces."""
        return self._r._call("network.wireless", "up")

    def down(self) -> dict:
        """Disable all wireless interfaces."""
        return self._r._call("network.wireless", "down")

    def scan(self, device: Optional[str] = None) -> list[dict]:
        """Scan for nearby WiFi networks.

        Returns an empty list when `device` isn't present on this box (ubus
        ``NOT_FOUND`` / ``NO_DATA`` — e.g. the default ``wlan0`` on a box whose
        radio is named differently): a radio that isn't there can't scan and
        shouldn't 500 the page (ADR-011, shape-agnostic). Mirrors
        :meth:`connected_clients`.

        ``INVALID_ARGUMENT`` (a malformed `device` — a caller bug) and every
        other code propagate, so a real fault is never masked as "no networks".

        WARP-816: an *empty* result on a radio that's in an AP/Master role is
        NOT "found nothing" — the card is broadcasting its own network and
        physically can't station-scan (``iw … scan`` → "Not supported (-95)",
        which ubus ``iwinfo scan`` silently degrades to ``{"results": []}``).
        Since the empty list is indistinguishable from a genuine zero-network
        scan at the scan call, classify by the radio's operating mode
        (``iwinfo info`` → ``mode``): an AP-role mode raises
        :class:`ScanUnsupportedError` (→ typed 409 at the route), while any
        scannable mode that finds nothing keeps returning ``[]``. The mode is
        probed ONLY on an empty result — the happy path stays a single call.

        ``device`` defaults to ``DROPLET_WIFI_SCAN_DEVICE`` (last-resort
        ``wlan0``) when not supplied — see ``_default_wifi_scan_device``.
        """
        device = device or _default_wifi_scan_device()
        try:
            result = self._r._call("iwinfo", "scan", {"device": device})
        except UbusError as exc:
            if exc.code in (UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA):
                return []
            raise
        # `{"results": null}` (key present, value null) is a valid reply shape;
        # `dict.get` only falls back to the default when the key is ABSENT, so
        # coalesce the null to `[]` to preserve the `list[dict]` contract (and
        # so a null result still triggers the AP-mode probe, like `[]`).
        results = result.get("results", []) or []
        if not results:
            blocked, mode = self._scan_blocked_by_ap_mode(device)
            if blocked:
                raise ScanUnsupportedError(device, mode=mode)
        return results

    def _scan_blocked_by_ap_mode(self, device: str) -> tuple[bool, Optional[str]]:
        """Return ``(blocked, mode)`` for `device`'s current operating mode.

        ``blocked`` is True when the mode means the radio can't station-scan
        (mode ∈ :data:`_AP_SCAN_BLOCKING_MODES`, case-insensitive); ``mode`` is
        the raw mode string read (or ``None`` if it couldn't be read / wasn't a
        string). The mode is RETURNED as a local — never stashed on ``self`` —
        because ``WirelessApi`` is a module-level singleton (``get_router().
        wireless``) and FastAPI runs the sync ``/wireless/scan`` route in a
        threadpool: a shared ``self._last_probed_mode`` would race across
        concurrent scans (WARP-816 review, Romain). The caller unpacks the tuple
        and raises ``ScanUnsupportedError(device, mode=mode)`` from its own
        local.

        Defensive: if the follow-up info call can't be read (device vanished
        between calls, a transient ubus fault), return ``(False, None)`` —
        "couldn't prove it's AP-mode" falls back to the historical empty-``[]``
        behavior rather than inventing an unsupported signal or crashing. Only
        called on an empty scan result.
        """
        try:
            info = self._r._call("iwinfo", "info", {"device": device})
        except (UbusError, ConnectionLost):
            return False, None
        mode = info.get("mode") if isinstance(info, dict) else None
        if not isinstance(mode, str):
            return False, None
        return mode.strip().lower() in _AP_SCAN_BLOCKING_MODES, mode

    def connected_clients(self, device: Optional[str] = None) -> list[dict]:
        """Get list of connected wireless clients for `device`.

        Returns an empty list when `device` isn't present on this box (ubus
        ``NOT_FOUND`` / ``NO_DATA`` — e.g. the default `wlan0` on a box whose
        radio is named `wlp14s0`): a missing radio has no clients and shouldn't
        500 the page (ADR-011, shape-agnostic).

        ``INVALID_ARGUMENT`` is deliberately NOT swallowed — it signals a
        malformed `device` argument (a caller bug), so converting it to "zero
        clients" would silently mask the error. It propagates instead.

        ``device`` defaults to ``DROPLET_WIFI_SCAN_DEVICE`` (last-resort
        ``wlan0``) when not supplied — see ``_default_wifi_scan_device``.
        """
        device = device or _default_wifi_scan_device()
        try:
            result = self._r._call("iwinfo", "assoclist", {"device": device})
        except UbusError as exc:
            if exc.code in (UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA):
                return []
            raise
        return result.get("results", [])

    def radio_info(self, device: Optional[str] = None) -> dict:
        """Get radio information (frequency, txpower, channel, etc.).

        Returns an empty dict when `device` isn't present on this box (ubus
        ``NOT_FOUND`` / ``NO_DATA`` — e.g. the default ``wlan0`` on a box whose
        radio is named differently): an absent radio has no info and shouldn't
        500 the page (ADR-011, shape-agnostic). Mirrors :meth:`connected_clients`.

        ``INVALID_ARGUMENT`` (a malformed `device` — a caller bug) and every
        other code propagate, so a real fault is never masked as "no radio".

        ``device`` defaults to ``DROPLET_WIFI_SCAN_DEVICE`` (last-resort
        ``wlan0``) when not supplied — see ``_default_wifi_scan_device``.
        """
        device = device or _default_wifi_scan_device()
        try:
            result = self._r._call("iwinfo", "info", {"device": device})
        except UbusError as exc:
            if exc.code in (UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA):
                return {}
            raise
        return result

    def set_ssid(self, radio: str, iface_section: str, ssid: str):
        """Change the SSID of a wireless interface."""
        self._r.uci.set("wireless", iface_section, {"ssid": ssid})
        self._r.uci.commit("wireless")

    def set_password(self, iface_section: str, password: str,
                     encryption: str = "sae-mixed"):
        """Change WiFi password and encryption method."""
        self._r.uci.set("wireless", iface_section, {
            "key": password,
            "encryption": encryption,
        })
        self._r.uci.commit("wireless")

    def set_channel(self, radio_section: str, channel: int | str):
        """Set the WiFi channel (or 'auto')."""
        self._r.uci.set("wireless", radio_section, {"channel": str(channel)})
        self._r.uci.commit("wireless")

    def create_guest_network(self, radio: str, ssid: str, password: str,
                             network: str = "guest"):
        """Create (or update) the isolated guest WiFi network.

        Idempotent: when a guest iface already exists, update it in place and
        clear ``disabled`` — re-running setup must not stack a SECOND SSID on
        the same network (which would orphan an iface that remove only half
        deletes), and it doubles as the re-enable path for a disabled guest.
        """
        section_id, _ = self._find_guest_iface(network)
        values = {
            "device": radio,
            "mode": "ap",
            "ssid": ssid,
            "encryption": "sae-mixed",
            "key": password,
            "network": network,
            "isolate": "1",
            "disabled": "0",
        }
        if section_id is None:
            self._r.uci.add("wireless", "wifi-iface", values)
        else:
            self._r.uci.set("wireless", section_id, values)
        self._r.uci.commit("wireless")

    def _find_guest_iface(self, network: str = "guest") -> tuple[Optional[str], dict]:
        """Locate the wifi-iface bound to the guest network.

        Returns ``(section_id, values)`` or ``(None, {})`` when no guest iface
        exists (or there's no wireless config at all on this shape).
        """
        try:
            res = self._r.uci.get("wireless", type="wifi-iface")
        except UbusError:
            return None, {}
        values = res.get("values", res) if isinstance(res, dict) else {}
        for section_id, cfg in (values or {}).items():
            if isinstance(cfg, dict) and cfg.get("network") == network:
                return section_id, cfg
        return None, {}

    def guest_status(self, network: str = "guest") -> dict:
        """Read the guest network's current state.

        ``configured`` false → no guest iface (the common single-box default).
        Returns the SSID + key so the owner-facing dashboard can render the join
        QR; gated to owner/admin at the orchestrator boundary.
        """
        section_id, cfg = self._find_guest_iface(network)
        if section_id is None:
            return {"configured": False, "enabled": False, "ssid": None, "password": None}
        # OpenWrt convention: a section is enabled unless `disabled '1'`.
        enabled = str(cfg.get("disabled", "0")) not in ("1", "true", "True")
        return {
            "configured": True,
            "enabled": enabled,
            "ssid": cfg.get("ssid"),
            "password": cfg.get("key"),
        }

    def remove_guest_network(self, network: str = "guest") -> None:
        """Tear down the guest network. Idempotent — a no-op when none exists."""
        section_id, _ = self._find_guest_iface(network)
        if section_id is None:
            return
        self._r.uci.delete("wireless", section_id)
        self._r.uci.commit("wireless")

    def reload(self):
        """Reload wireless (down then up) to apply config changes."""
        self.down()
        time.sleep(1)
        self.up()


# ---------------------------------------------------------------------------
# High-level API: DHCP
# ---------------------------------------------------------------------------
class DHCPApi:
    """DHCP server and DNS management."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def active_leases(self) -> list[dict]:
        """Get all active IPv4 DHCP leases.

        ``ubus call dhcp ipv4leases`` is the documented object on mainline
        OpenWrt, but on 24.10.x it consistently returns an empty object
        even when odhcpd/dnsmasq have live entries in /tmp/dhcp.leases.
        The ``luci-rpc`` object reads the same files and DOES return the
        populated list, so we try it first and fall back to the native
        call only when luci-rpc isn't installed (build without luci).
        """
        try:
            result = self._r._call("luci-rpc", "getDHCPLeases")
            leases = result.get("dhcp_leases") or []
            if leases:
                return leases
        except UbusError as exc:
            # luci-rpc missing or permission denied — fall through. Any
            # other ubus error from luci-rpc is treated as non-fatal so
            # the native path still has a chance.
            logger.debug("luci-rpc getDHCPLeases unavailable: %s", exc)
        try:
            result = self._r._call("dhcp", "ipv4leases")
        except UbusError as exc:
            # The `dhcp` object is provided by odhcpd. A router that serves
            # DHCPv4 from dnsmasq alone — the Pi edge router does — has no
            # `ipv4leases` method at all, so this raises METHOD_NOT_FOUND.
            # Reaching here means luci-rpc already answered with an empty
            # list, which is the correct answer: no leases. Raising instead
            # would 500 the whole device list the moment it went quiet.
            logger.debug("dhcp ipv4leases unavailable: %s", exc)
            return []
        return result.get("dhcp_leases", [])

    def active_leases_v6(self) -> list[dict]:
        """Get all active IPv6 DHCP leases.

        Same fallback logic as :meth:`active_leases` — ``luci-rpc
        getDHCPLeases`` returns both v4 and v6 under ``dhcp6_leases``.
        """
        try:
            result = self._r._call("luci-rpc", "getDHCPLeases")
            leases = result.get("dhcp6_leases") or []
            if leases:
                return leases
        except UbusError as exc:
            logger.debug("luci-rpc getDHCPLeases unavailable: %s", exc)
        try:
            result = self._r._call("dhcp", "ipv6leases")
        except UbusError as exc:
            # See active_leases: no odhcpd means no `dhcp` methods at all.
            logger.debug("dhcp ipv6leases unavailable: %s", exc)
            return []
        return result.get("dhcp_leases", [])

    def find_device_by_hostname(self, hostname_fragment: str) -> Optional[dict]:
        """Find a DHCP lease by partial hostname match (case-insensitive)."""
        fragment = hostname_fragment.lower()
        for lease in self.active_leases():
            if fragment in lease.get("hostname", "").lower():
                return lease
        return None

    def get_lan_pool(self) -> dict:
        """Read the LAN DHCP pool range + lease time from the `dhcp lan` section.

        Returns ``{start, limit, leasetime}`` (each a string or ``None`` when the
        section omits it — OpenWrt drops keys when a default applies, so an
        absent value means "dnsmasq default", not "broken"). The `dhcp lan`
        section is the LAN-pool config the camera-subnet route already proves the
        write side of (`uci.set("dhcp", ...)`).
        """
        res = self._r.uci.get("dhcp", "lan")
        # `uci get` returns the section wrapped in a `values` envelope. Reading
        # the top level instead yields None for every field, so the dashboard's
        # DHCP pool card rendered blank even on a router with an explicit pool.
        # Same unwrap idiom as the wifi-iface / firewall-rule readers below;
        # falls back to `res` so a pre-unwrapped dict (mock router) still works.
        section = res.get("values", res) if isinstance(res, dict) else {}
        if not isinstance(section, dict):
            section = {}
        return {
            "start": section.get("start"),
            "limit": section.get("limit"),
            "leasetime": section.get("leasetime"),
        }

    def set_lan_pool(self, start: int, limit: int, leasetime: str):
        """Reshape the LAN DHCP pool range + lease time.

        Writes start/limit/leasetime onto the `dhcp lan` section and commits.
        dnsmasq re-reads the pool on the dnsmasq restart the route issues (same
        reload the static-lease route uses), so no reboot is needed. Tier 2 at
        the orchestrator boundary — shrinking the pool can strand live clients.
        """
        self._r.uci.set("dhcp", "lan", {
            "start": str(start),
            "limit": str(limit),
            "leasetime": leasetime,
        })
        self._r.uci.commit("dhcp")

    def add_static_lease(self, name: str, mac: str, ip: str, leasetime: str = "infinite"):
        """Add a static DHCP reservation."""
        self._r.uci.add("dhcp", "host", {
            "name": name,
            "mac": mac,
            "ip": ip,
            "leasetime": leasetime,
        })
        self._r.uci.commit("dhcp")

    def set_dns_servers(self, servers: list[str]):
        """Set custom upstream DNS servers on WAN."""
        self._r.uci.set("network", "wan", {
            "peerdns": "0",
            "dns": " ".join(servers),
        })
        self._r.uci.commit("network")

    def list_hostrecords(self) -> list[dict]:
        """Return dnsmasq static hostname → IP entries (UCI `config hostrecord`).

        Must be `hostrecord` (NOT `domain`). OpenWrt 24.10's /etc/init.d/dnsmasq
        only processes `config hostrecord` sections into dnsmasq `--host-record=`
        flags (see `config_foreach filter_dnsmasq hostrecord dhcp_hostrecord_add`);
        `config domain` sections exist in the UCI schema but are silently ignored
        by the init script, so entries written there never reach the live
        dnsmasq config file and no DNS answers are served.

        A lookup that finds nothing is ABSENCE, not a fault (WARP-987):
        depending on the rpcd build / box state the type-filtered get comes
        back as `{"values": {}}` or as a NOT_FOUND/NO_DATA error (same
        convention `VPNApi.interface_exists` handles for missing sections).
        Both mean "no entries" — return [] so the first-ever add and the
        list endpoint never 500 on an empty box.
        """
        try:
            result = self._r.uci.get("dhcp", type="hostrecord")
        except UbusError as exc:
            if _ubus_object_absent(exc):
                return []
            raise
        values = result.get("values", {}) if isinstance(result, dict) else {}
        entries = []
        for section_name, section in values.items():
            if not isinstance(section, dict):
                continue
            name = section.get("name")
            ip = section.get("ip")
            if name and ip:
                entries.append({"section": section_name, "hostname": name, "ip": ip})
        return entries

    def set_hostrecord(self, hostname: str, ip: str) -> dict:
        """Idempotently register a static hostname → IP in dnsmasq.

        Creates a `config hostrecord` section if none exists for this hostname,
        otherwise updates the first match and prunes any duplicates so the
        result is exactly one section per hostname. Returns the resulting
        entry with an `action` field of `created` or `updated`.

        IMPORTANT: does NOT commit. The caller must call `uci.apply` after
        (commits to disk) and then `DHCPApi.reload()` — see the long comment
        on `_commit_and_reload_dhcp` in services/routing/main.py for why the
        explicit dnsmasq restart is required for the record to be SERVED.
        Two apply gotchas (WARP-987, verified against rpcd source):
          * apply only picks up *pending* (uncommitted) changes — a
            `uci.commit` here would leave apply nothing to do (NO_DATA);
          * a re-post of values already committed stages NOTHING, because
            rpcd's `uci set` skips unchanged options server-side — so apply
            reports NO_DATA then too. Callers must treat that as a benign
            "nothing to commit", never a fault.
        """
        existing = [e for e in self.list_hostrecords()
                    if e["hostname"].lower() == hostname.lower()]
        if existing:
            first = existing[0]
            self._r.uci.set("dhcp", first["section"], {"name": hostname, "ip": ip})
            for dup in existing[1:]:
                self._r.uci.delete("dhcp", dup["section"])
            return {"section": first["section"], "hostname": hostname, "ip": ip, "action": "updated"}

        added = self._r.uci.add("dhcp", "hostrecord", {"name": hostname, "ip": ip})
        section = added.get("section") if isinstance(added, dict) else None
        return {"section": section, "hostname": hostname, "ip": ip, "action": "created"}

    def delete_hostrecord(self, hostname: str) -> int:
        """Stage deletion of all static entries for hostname; return count.

        Stages only — caller must `uci.apply` to commit + reload dnsmasq.
        """
        removed = 0
        for entry in self.list_hostrecords():
            if entry["hostname"].lower() == hostname.lower():
                self._r.uci.delete("dhcp", entry["section"])
                removed += 1
        return removed

    def reload(self):
        """Restart dnsmasq so committed UCI DHCP/DNS changes are actually SERVED.

        Dispatches `/etc/init.d/dnsmasq restart` via `file.exec`. The
        droplet-ai rpcd ACL pins exactly this command line (rpcd checks the
        full path+args string against the `file` scope, so this is NOT a
        blanket exec grant) — see openwrt/files/usr/share/rpcd/acl.d/
        droplet-ai.json. Required because the procd `config.change` trigger
        that `uci.apply` emits does not regenerate /var/etc/dnsmasq.conf.*
        on the appliance container (WARP-987): committed host-records stayed
        unserved until the init script reran.
        """
        self._r.exec_service("dnsmasq", "restart")


# ---------------------------------------------------------------------------
# High-level API: Firewall
# ---------------------------------------------------------------------------
class FirewallApi:
    """Firewall zones, rules, and port forwards."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def get_zones(self) -> dict:
        """Read all firewall zones."""
        return self._r.uci.get("firewall", type="zone")

    def get_rules(self) -> dict:
        """Read all firewall rules."""
        return self._r.uci.get("firewall", type="rule")

    def get_redirects(self) -> dict:
        """Read all port forward / NAT redirect rules."""
        return self._r.uci.get("firewall", type="redirect")

    def upnp_status(self) -> dict:
        """Read UPnP / NAT-PMP (miniupnpd) state → ``{available, enabled}``.

        miniupnpd ships ``/etc/config/upnpd`` only when the package is
        installed; a privacy appliance that never auto-opens ports usually
        won't have it. A missing config surfaces as a UbusError ("uci entry not
        found"), which we degrade to ``available=False`` — the honest, secure
        default — rather than 500-ing. Mirrors how ``WirelessApi.status``
        degrades a missing optional surface to data, not a crash (ADR-011).
        """
        try:
            res = self._r.uci.get("upnpd", "config", "enable_upnp")
            val = res.get("value") if isinstance(res, dict) else res
            return {"available": True, "enabled": str(val) in ("1", "true", "True")}
        except UbusError:
            return {"available": False, "enabled": False}

    def set_upnp(self, enabled: bool) -> None:
        """Enable/disable UPnP + NAT-PMP automatic port opening.

        Callers must check ``upnp_status().available`` first — setting on a box
        without miniupnpd raises (no ``upnpd`` config to write).
        """
        flag = "1" if enabled else "0"
        # Also manage the procd `enabled` gate: the uci-defaults seed now ships
        # enabled='0' (avoids crash-loop on fresh containers without interfaces),
        # so set_upnp(True) must flip it to '1' to start the daemon.
        self._r.uci.set("upnpd", "config", {"enabled": flag, "enable_upnp": flag, "enable_natpmp": flag})
        # uci.apply commits the pending change and triggers ucitrack to reload
        # miniupnpd — exec_service("miniupnpd","restart") maps to file.exec which
        # the droplet-ai ACL does not grant.
        self._r.uci.apply(timeout=5, rollback=False)

    def block_device(self, mac: str, name: Optional[str] = None):
        """Block a device (by MAC address) from accessing the internet."""
        rule_name = name or f"block-{mac.replace(':', '')}"
        self._r.uci.add("firewall", "rule", {
            "name": rule_name,
            "src": "lan",
            "dest": "wan",
            "src_mac": mac,
            "target": "REJECT",
            "enabled": "1",
        })
        self._r.uci.commit("firewall")
        self.reload()

    def unblock_device(self, mac: str):
        """Remove all firewall rules blocking a specific MAC address.

        Idempotent: when no matching REJECT rule exists — e.g. the schedule
        ticker re-asserting the desired "unblocked" state for a device that was
        never blocked — we skip the commit/reload entirely and return cleanly.
        Previously this committed + reloaded even on zero matches, which the
        safe-apply path rejected and surfaced as a recurring "Unblock device:
        500" (code ROLLED_BACK) every tick.
        """
        config = self._r.uci.get("firewall", type="rule")
        removed = False
        for section_name, section_data in config.get("values", {}).items():
            if section_data.get("src_mac", "").upper() == mac.upper():
                if section_data.get("target") == "REJECT":
                    self._r.uci.delete("firewall", section_name)
                    removed = True
        # Nothing matched → no-op (idempotent). Don't commit/reload an empty
        # changeset; that's what was 500-ing on every schedule tick.
        if not removed:
            return
        self._r.uci.commit("firewall")
        self.reload()

    # WARP-613: phone-home egress control. Softer than block_device — denies a
    # device's WAN egress but keeps NTP (time) working; LAN DNS is already
    # permitted by the shipped Allow-DNS-LAN rule. Rules are named
    # `phonehome-<mac>` / `phonehome-ntp-<mac>` so they never collide with the
    # schedule ticker's `block-<mac>` full-block rules.
    def _remove_phone_home_rules(self, mac: str) -> None:
        """Delete this MAC's phone-home rules. Does NOT commit (callers do)."""
        suffix = mac.replace(":", "")
        names = {f"phonehome-{suffix}", f"phonehome-ntp-{suffix}"}
        config = self._r.uci.get("firewall", type="rule")
        for section_name, section_data in config.get("values", {}).items():
            if section_data.get("name") in names:
                self._r.uci.delete("firewall", section_name)

    def block_phone_home(self, mac: str):
        """Block a device (by MAC) from phoning home: REJECT WAN egress while
        allowing NTP. The NTP ACCEPT is added BEFORE the REJECT so fw4 matches
        it first. Idempotent — clears any prior phone-home rules first."""
        suffix = mac.replace(":", "")
        self._remove_phone_home_rules(mac)
        self._r.uci.add("firewall", "rule", {
            "name": f"phonehome-ntp-{suffix}",
            "src": "lan",
            "src_mac": mac,
            "dest": "wan",
            "proto": "udp",
            "dest_port": "123",
            "target": "ACCEPT",
            "enabled": "1",
        })
        self._r.uci.add("firewall", "rule", {
            "name": f"phonehome-{suffix}",
            "src": "lan",
            "src_mac": mac,
            "dest": "wan",
            "target": "REJECT",
            "enabled": "1",
        })
        self._r.uci.commit("firewall")
        self.reload()

    def unblock_phone_home(self, mac: str):
        """Remove a device's phone-home rules (REJECT + NTP allow)."""
        self._remove_phone_home_rules(mac)
        self._r.uci.commit("firewall")
        self.reload()

    def set_camera_phone_home(self, blocked: bool):
        """Toggle the whole camera VLAN's ability to phone home. When blocked,
        drop the broad `cameras → wan` forwarding and add an NTP allow so camera
        clocks/timestamps stay correct (camera DNS to the router is already
        permitted by Allow-Camera-DNS). When unblocked, restore the forwarding
        and drop the NTP allow. Idempotent."""
        fw = self._r.uci.get("firewall")
        fwd_sections: list[str] = []
        ntp_sections: list[str] = []
        if isinstance(fw, dict):
            for section_name, section in fw.items():
                if not isinstance(section, dict):
                    continue
                if (section.get(".type") == "forwarding"
                        and section.get("src") == "cameras"
                        and section.get("dest") == "wan"):
                    fwd_sections.append(section_name)
                if (section.get(".type") == "rule"
                        and section.get("name") == "Allow-Camera-NTP"):
                    ntp_sections.append(section_name)
        if blocked:
            for s in fwd_sections:
                self._r.uci.delete("firewall", s)
            if not ntp_sections:
                self._r.uci.add("firewall", "rule", {
                    "name": "Allow-Camera-NTP",
                    "src": "cameras",
                    "dest": "wan",
                    "proto": "udp",
                    "dest_port": "123",
                    "target": "ACCEPT",
                    "enabled": "1",
                })
        else:
            if not fwd_sections:
                self._r.uci.add("firewall", "forwarding", {
                    "src": "cameras",
                    "dest": "wan",
                })
            for s in ntp_sections:
                self._r.uci.delete("firewall", s)
        self._r.uci.commit("firewall")
        self.reload()

    def add_port_forward(self, name: str, src_port: str, dest_ip: str,
                         dest_port: str, proto: str = "tcp"):
        """Add a port forwarding rule (WAN -> LAN device)."""
        self._r.uci.add("firewall", "redirect", {
            "name": name,
            "src": "wan",
            "dest": "lan",
            "proto": proto,
            "src_dport": src_port,
            "dest_ip": dest_ip,
            "dest_port": dest_port,
            "target": "DNAT",
            "enabled": "1",
        })
        self._r.uci.commit("firewall")
        self.reload()

    def create_zone(self, name: str, input: str = "REJECT",
                    output: str = "ACCEPT", forward: str = "REJECT",
                    network: Optional[str] = None, masq: bool = False):
        """Create a new firewall zone."""
        values = {
            "name": name,
            "input": input,
            "output": output,
            "forward": forward,
        }
        if network:
            values["network"] = network
        if masq:
            values["masq"] = "1"
        self._r.uci.add("firewall", "zone", values)
        self._r.uci.commit("firewall")

    def add_forwarding(self, src: str, dest: str):
        """Allow traffic forwarding between two zones."""
        self._r.uci.add("firewall", "forwarding", {"src": src, "dest": dest})
        self._r.uci.commit("firewall")

    def add_rule(self, name: str, src: str, dest: str, proto: str = "tcp",
                 dest_port: Optional[str] = None, target: str = "REJECT",
                 src_port: Optional[str] = None, enabled: str = "1"):
        """Add a generic firewall traffic rule (modeled on block_device)."""
        values = {
            "name": name,
            "src": src,
            "dest": dest,
            "proto": proto,
            "target": target,
            "enabled": enabled,
        }
        if dest_port is not None:
            values["dest_port"] = str(dest_port)
        if src_port is not None:
            values["src_port"] = str(src_port)
        self._r.uci.add("firewall", "rule", values)
        self._r.uci.commit("firewall")
        self.reload()

    def set_zone_policy(self, zone: str, input: Optional[str] = None,
                        output: Optional[str] = None, forward: Optional[str] = None):
        """Set a zone's default input/output/forward policy.

        Wrapped in safe_apply: flipping a zone (esp. lan/mgmt) input or forward
        to REJECT/DROP can sever the dashboard's own management path, so the
        change applies with the 60s auto-rollback timer that reverts on lost
        connectivity (same posture as the VPN/wireless writes).
        """
        res = self._r.uci.get("firewall", type="zone")
        values = res.get("values", res) if isinstance(res, dict) else {}
        section_id = next(
            (sid for sid, cfg in (values or {}).items()
             if isinstance(cfg, dict) and cfg.get("name") == zone),
            None,
        )
        if section_id is None:
            raise UbusError(-1, f"firewall zone '{zone}' not found")
        policy = {}
        if input is not None:
            policy["input"] = input
        if output is not None:
            policy["output"] = output
        if forward is not None:
            policy["forward"] = forward
        with self._r.safe_apply(timeout=60):
            self._r.uci.set("firewall", section_id, policy)
            self._r.uci.commit("firewall")

    def reload(self):
        """Reload the firewall to apply changes."""
        self._r.exec_service("firewall", "reload")


# ---------------------------------------------------------------------------
# High-level API: System
# ---------------------------------------------------------------------------
# KAN-8: an OpenWrt sysupgrade image name embeds the release it carries, e.g.
# `openwrt-24.10.0-droplet-squashfs-sysupgrade.img.gz`. We extract that pinned
# version to compare against the running one — read-only, no flash. A name that
# carries no parseable version yields an EXPLICIT `None` (undetermined), never a
# guessed match (rule 10).
_FIRMWARE_IMAGE_VERSION_RE = re.compile(r"(\d+\.\d+(?:\.\d+)?)")


def compare_firmware_version(board: dict, pinned_image: str) -> dict:
    """Compare the running OpenWrt release against the pinned sysupgrade image.

    KAN-8 AC 4. Pure read: takes a `board_info()`-shaped dict and the pinned
    image name, returns the compare result the dashboard renders on the
    Maintenance card BEFORE any owner ever arms a flash.

    Returns ``{current_version, pinned_version, up_to_date, upgrade_available}``.
    ``up_to_date`` / ``upgrade_available`` are EXPLICIT booleans when both
    versions are known, and explicit ``None`` (undetermined) when the pinned
    image name carries no parseable version — we never guess "up to date" from a
    failed parse (rule 10).
    """
    release = board.get("release") if isinstance(board, dict) else None
    current_version = release.get("version") if isinstance(release, dict) else None

    pinned_match = _FIRMWARE_IMAGE_VERSION_RE.search(pinned_image or "")
    pinned_version = pinned_match.group(1) if pinned_match else None

    if not current_version or pinned_version is None:
        # Undetermined — surface explicitly rather than asserting equality.
        return {
            "current_version": current_version,
            "pinned_version": pinned_version,
            "up_to_date": None,
            "upgrade_available": None,
        }

    up_to_date = current_version == pinned_version
    return {
        "current_version": current_version,
        "pinned_version": pinned_version,
        "up_to_date": up_to_date,
        "upgrade_available": not up_to_date,
    }


class SystemApi:
    """System-level operations."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def board_info(self) -> dict:
        """Get hardware and OS info (kernel, hostname, model, release)."""
        return self._r._call("system", "board")

    def firmware_version_check(self, pinned_image: str) -> dict:
        """Read the running firmware version and compare it to the pinned image.

        KAN-8 AC 4. Pure read — issues NO flash and NO exec. Reads the version
        from the SAME `board_info()` release block that `/system/info` exposes,
        then delegates to :func:`compare_firmware_version`.
        """
        return compare_firmware_version(self.board_info(), pinned_image)

    def sysupgrade(self, image_path: str, preserve_config: bool = True) -> dict:
        """Flash an OpenWrt sysupgrade image already staged on the router.

        ⚠️ BRICK RISK. Wraps the `openwrt/scripts/upgrade-router.sh` flash step:
        ``sysupgrade -v [-n] <image>``. ``preserve_config`` keeps ``/etc/config``
        (the default, ``-v``); ``preserve_config=False`` adds ``-n`` for a clean
        flash. Dispatch goes through the SAME ``file.exec`` ubus surface the rest
        of the SDK uses — never a parallel box script.

        The router reboots as it flashes, dropping the ubus/SSH connection; that
        ``ConnectionLost`` is the EXPECTED success path of a flash, so it is
        swallowed and reported as ``{"status": "flashing"}``. A genuine fault
        BEFORE the reboot (e.g. PERMISSION_DENIED) propagates.

        GATING to the PRIMARY_ROUTER deployment shape and the owner-only Tier-3
        confirm are enforced ABOVE this layer (routing route + orchestrator);
        this method is the raw mechanism and must never be reached otherwise.
        """
        if not image_path or not image_path.strip():
            raise ValueError("sysupgrade requires a staged image path")
        params = ["-v"]
        if not preserve_config:
            params.append("-n")  # clean flash — do not preserve /etc/config
        params.append(image_path)
        try:
            self._r.exec_command("sysupgrade", params)
        except ConnectionLost:
            # Router rebooting into the new image — the connection drop IS success.
            logger.info("sysupgrade dispatched; router rebooting into new image")
            return {"status": "flashing", "image": image_path}
        return {"status": "flashing", "image": image_path}

    def factory_reset(self) -> dict:
        """Wipe the OpenWrt overlay (UCI config) and reboot — factory defaults.

        ⚠️ THE MOST DANGEROUS SURFACE. Runs ``jffs2reset`` to clear the overlay
        then ``reboot -f`` to make it take effect, via ``file.exec``. On the
        shipping single-box this would wipe the named-volume UCI the host hostapd
        bridge depends on with no remote recovery — which is exactly why the
        gating ABOVE this layer refuses it on any non-PRIMARY_ROUTER shape.

        Like :meth:`sysupgrade`, the reboot drops the connection; that
        ``ConnectionLost`` is the expected success path and is swallowed
        (``{"status": "resetting"}``). A genuine fault before the reboot
        propagates.
        """
        # jffs2reset must complete cleanly — a transport error here means the
        # overlay may not have been wiped, so propagate rather than declaring success.
        self._r.exec_command("jffs2reset", ["-y"])
        try:
            self._r.exec_command("reboot", ["-f"])
        except ConnectionLost:
            # Connection drop on the reboot call is the expected success path.
            pass
        logger.info("factory_reset dispatched; router rebooting to defaults")
        return {"status": "resetting"}

    def resource_info(self) -> dict:
        """Get CPU load, memory usage, and uptime."""
        return self._r._call("system", "info")

    def reboot(self):
        """Reboot the OpenWrt device."""
        return self._r._call("system", "reboot")

    def set_hostname(self, hostname: str):
        """Change the system hostname."""
        self._r.uci.set("system", "@system[0]", {"hostname": hostname})
        self._r.uci.commit("system")

    def set_ntp_enabled(self, enabled: bool):
        """Enable/disable the in-container OpenWrt time daemon (sysntpd).

        Governs the appliance's OpenWrt sysntpd (`system.ntp.enabled` /
        `.enable_server`), NOT the host SBC hardware clock — callers/UI must say
        so. Reversible, low-risk → Tier 1 at the orchestrator boundary.
        """
        flag = "1" if enabled else "0"
        # Use the anonymous section key so the write targets the same section
        # the sysntpd daemon reads. On builds that store NTP config as a named
        # 'ntp' section this also works (anonymous-index and named-section
        # both resolve when the section exists). Writing to a named 'ntp' key
        # on an anonymous-section build creates a new, isolated section that
        # the daemon never reads, making the toggle a silent no-op.
        self._r.uci.set("system", "@timeserver[0]", {"enabled": flag, "enable_server": flag})
        self._r.uci.commit("system")

    def controls(self, ap_mode: str = "uci") -> dict:
        """Read the editable system controls + honest gates for the box shape.

        Returns ``{hostname, ntp_enabled, status_led, country}`` where:
          * ``hostname`` — from board_info (live);
          * ``ntp_enabled`` — the sysntpd `enabled` flag;
          * ``status_led`` — ``{supported, enabled}``. The front-panel LEDs are
            physical on the host SBC; the in-container OpenWrt has no
            ``system.led`` ubus surface, so on the hostapd single-box shape there
            is nothing to toggle → ``supported: False`` (honest gate, same shape
            as the guest-wifi gate). A real OpenWrt radio host can light it up.
          * ``country`` — ``{value, editable}``. On the single-box the AP is host
            hostapd with a hardcoded country, and the in-container `wireless`
            config has no live radio, so the country is read-only here
            (``editable: False``) — the value still reflects what we can read.

        ``ap_mode`` is the deployment discriminator (``"hostapd"`` = single-box).
        """
        gated = ap_mode == "hostapd"

        try:
            hostname = self.board_info().get("hostname")
        except (UbusError, ConnectionLost):
            hostname = None

        ntp_enabled = False
        # Try @timeserver[0] first (anonymous section, matches what set_ntp_enabled
        # writes); fall back to the named 'ntp' key for legacy configs.
        for _ntp_key in ("@timeserver[0]", "ntp"):
            try:
                res = self._r.uci.get("system", _ntp_key, "enabled")
                val = res.get("value") if isinstance(res, dict) else res
                ntp_enabled = str(val) in ("1", "true", "True")
                break
            except UbusError:
                continue

        country = None
        try:
            wireless = self._r.uci.get("wireless")
            if isinstance(wireless, dict):
                for section in wireless.values():
                    if isinstance(section, dict) and section.get("country") is not None:
                        country = section.get("country")
                        break
        except UbusError:
            country = None

        return {
            "hostname": hostname,
            "ntp_enabled": ntp_enabled,
            # On a non-gated (real OpenWrt radio) host these could be live; the
            # service layer flips supported/editable per deployment shape. Here
            # we report the honest container-shape default.
            "status_led": {"supported": not gated, "enabled": False},
            "country": {"value": country, "editable": not gated},
        }

    def set_timezone(self, zonename: str, timezone_string: str):
        """
        Set the timezone.

        zonename: e.g. "America/New_York"
        timezone_string: POSIX TZ string, e.g. "EST5EDT,M3.2.0,M11.1.0"
        """
        self._r.uci.set("system", "@system[0]", {
            "zonename": zonename,
            "timezone": timezone_string,
        })
        self._r.uci.commit("system")

    def uptime_seconds(self) -> int:
        """Return system uptime in seconds."""
        info = self.resource_info()
        return info.get("uptime", 0)


# ---------------------------------------------------------------------------
# High-level API: VPN (WireGuard)
# ---------------------------------------------------------------------------
class VPNApi:
    """WireGuard VPN management.

    All keypair generation happens in Python (Curve25519 via `cryptography`)
    rather than shelling out to `wg` on the router. The droplet-ai rpcd ACL
    deliberately does NOT grant `file.exec` (see openwrt/files/usr/share/rpcd/
    acl.d/droplet-ai.json), so the older shell-based path was unreachable on
    production. Doing it in Python also keeps client private keys out of any
    on-router temp file — they live only in the response body and are dropped
    after the caller renders the QR.
    """

    def __init__(self, router: "DropletRouter"):
        self._r = router

    @staticmethod
    def generate_keypair() -> tuple[str, str]:
        """Generate a fresh WireGuard X25519 keypair.

        Returns `(private_key_b64, public_key_b64)`. Callers MUST treat the
        private key as one-shot output: hand it to the user (e.g. inside a
        QR) and discard. We never persist client private keys in uci or in
        the orchestrator DB.

        WARP-229 / FIPS 140-3: WireGuard mandates X25519 for the Noise IK
        handshake; the algorithm is registered in
        docs/security/fips-exceptions.md → wireguard-x25519. Risk acceptance
        is documented there (WAN-edge tunnels only, no PHI/PII transits).
        """
        from base64 import b64encode
        from cryptography.hazmat.primitives import serialization
        # fips:allowed: wireguard-x25519
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

        # fips:allowed: wireguard-x25519
        priv = X25519PrivateKey.generate()
        priv_bytes = priv.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        pub_bytes = priv.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        return b64encode(priv_bytes).decode("ascii"), b64encode(pub_bytes).decode("ascii")

    @staticmethod
    def derive_public_key(private_key_b64: str) -> str:
        """Re-derive the public key from a base64-encoded private key.

        Used by `get_interface_info` so we can surface the server pubkey
        without storing it separately in uci — the priv on disk is the
        single source of truth and the pub is recomputed on read.
        """
        from base64 import b64decode, b64encode
        from cryptography.hazmat.primitives import serialization
        # fips:allowed: wireguard-x25519
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

        # fips:allowed: wireguard-x25519
        priv = X25519PrivateKey.from_private_bytes(b64decode(private_key_b64))
        pub_bytes = priv.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        return b64encode(pub_bytes).decode("ascii")

    def interface_exists(self, name: str) -> bool:
        """Return True iff a uci network section with this name already exists.

        Lets the routing-service `/vpn/setup` endpoint be idempotent — calling
        it twice doesn't try to recreate the interface or stack a second
        firewall zone.
        """
        try:
            result = self._r.uci.get("network", name)
        except UbusError as exc:
            # NOT_FOUND / NO_DATA — section doesn't exist.
            if exc.code in (4, 5):
                return False
            raise
        if not isinstance(result, dict):
            return False
        # `uci.get` on a missing section can also return an empty dict.
        return bool(result.get("values") or result.get(".type"))

    def get_interface_info(self, interface: str = "wg0") -> dict:
        """Return server-side info for a WireGuard interface.

        The private key is intentionally redacted from the return value — the
        REST layer never has a reason to send it back to a caller. Public key
        is re-derived from the priv on disk so we don't store it twice.
        """
        result = self._r.uci.get("network", interface)
        if not isinstance(result, dict):
            return {}
        # Real ubus wraps the section in {"values": {...}}; some shapes return
        # the section directly. Accept both.
        section = result.get("values", result) if isinstance(result, dict) else {}
        if not isinstance(section, dict):
            return {}
        priv = section.get("private_key", "")
        pub = self.derive_public_key(priv) if priv else ""
        addresses = section.get("addresses", "")
        if isinstance(addresses, list):
            addresses_list = list(addresses)
        elif addresses:
            addresses_list = [addresses]
        else:
            addresses_list = []
        return {
            "interface": interface,
            "public_key": pub,
            "listen_port": int(section.get("listen_port") or 0) or None,
            "addresses": addresses_list,
        }

    def create_interface(self, name: str, private_key: str,
                         listen_port: int = 51820, address: str = "10.0.100.1/24"):
        """Create a WireGuard network interface.

        Goes through `uci.add` (not `uci.set`) because the OpenWrt ubus uci
        backend's `set` method requires the section to already exist —
        creating one returns NOT_FOUND. `add` with `name=...` creates the
        named `interface` section in one shot, then we set `proto=wireguard`
        et al as section options.

        DOES NOT commit. Caller wraps this in `safe_apply` (or follows up with
        `uci.apply`) so commit + reload happen in one ucitrack pass. Pre-
        committing here would leave nothing pending for `apply`, which then
        returns NO_DATA. Same convention `set_hostrecord` uses — see the long
        comment on `_commit_and_reload_dhcp` in `services/routing/main.py`.
        """
        self._r.uci.add("network", "interface", values={
            "proto": "wireguard",
            "private_key": private_key,
            "listen_port": str(listen_port),
            "addresses": address,
        }, name=name)

    def add_peer(self, interface: str, public_key: str, allowed_ips: str,
                 description: str = "", endpoint: str = "",
                 persistent_keepalive: int = 25):
        """Add a WireGuard peer to an interface.

        DOES NOT commit; caller follows up with `uci.apply` (rollback=False is
        fine — adding a peer can't partition the orchestrator from the
        router). Pre-committing here would leave apply with nothing to do
        and the wg interface would not pick up the new peer until the next
        ucitrack pass.
        """
        values = {
            "public_key": public_key,
            "allowed_ips": allowed_ips,
            "persistent_keepalive": str(persistent_keepalive),
        }
        if description:
            values["description"] = description
        if endpoint:
            values["endpoint_host"] = endpoint
        self._r.uci.add("network", f"wireguard_{interface}", values)

    def list_peers(self, interface: str = "wg0") -> list[dict]:
        """Return peers attached to an interface as plain dicts.

        Filters on the OpenWrt-native section type `wireguard_<interface>`,
        same shape `add_peer` writes. Each entry carries the section name so
        callers can match it to a delete.
        """
        section_type = f"wireguard_{interface}"
        result = self._r.uci.get("network", type=section_type)
        values = result.get("values", {}) if isinstance(result, dict) else {}
        peers: list[dict] = []
        for section_name, section in values.items():
            if not isinstance(section, dict):
                continue
            allowed = section.get("allowed_ips", "")
            if isinstance(allowed, list):
                allowed_list = list(allowed)
            elif allowed:
                allowed_list = [allowed]
            else:
                allowed_list = []
            peers.append({
                "section": section_name,
                "public_key": section.get("public_key", ""),
                "allowed_ips": allowed_list,
                "description": section.get("description", ""),
                "endpoint_host": section.get("endpoint_host", ""),
                "persistent_keepalive": section.get("persistent_keepalive", ""),
            })
        return peers

    def peer_handshakes(self, interface: str = "wg0") -> Optional[dict[str, int]]:
        """WARP-1389 — best-effort per-peer runtime `latest handshake` epoch
        (seconds), keyed by public_key, for the overlay punch-success telemetry.

        Sourced from the PERMITTED ubus read ``network.interface.<iface> status``
        (luci-proto-wireguard populates ``data.peers[].latest_handshake`` on many
        builds). This deliberately AVOIDS ``file.exec`` / ``wg show`` — the
        droplet-ai rpcd ACL denies file.exec on purpose (see the acl.d note), and
        telemetry must never motivate widening that grant.

        Returns ``None`` = UNKNOWN (the ubus read failed, or the status carried
        no peer data at all) — the caller must NOT treat that as "nobody
        handshook", or every torn-down peer reads as a false failure and the
        fleet punch-success rate collapses to 0%. Returns a dict = AVAILABLE: an
        entry per peer that DID handshake (epoch > 0); a peer that exists but
        never handshook is simply absent from the dict, which — since the read
        succeeded — the caller reads as an observed 0 (a real failure). Read-only.
        """
        try:
            status = self._r._call(f"network.interface.{interface}", "status")
        except Exception:  # noqa: BLE001 — telemetry read, never fatal
            return None
        data = status.get("data") if isinstance(status, dict) else None
        peers = data.get("peers") if isinstance(data, dict) else None
        if not isinstance(peers, list):
            return None  # no peer data in the status → UNKNOWN, never a fake 0
        out: dict[str, int] = {}
        for p in peers:
            if not isinstance(p, dict):
                continue
            pk = p.get("public_key")
            hs = p.get("latest_handshake")
            if isinstance(pk, str) and isinstance(hs, (int, float)) and hs > 0:
                out[pk] = int(hs)
        return out

    def delete_peer(self, interface: str, public_key: str) -> int:
        """Delete every peer section matching `public_key`. Returns the count.

        Walks all `wireguard_<interface>` sections and deletes the ones whose
        public_key matches. Multiple matches are a misconfiguration but we
        clean them all up rather than silently leaving duplicates.

        DOES NOT commit; caller follows up with `uci.apply`. See `add_peer`.
        """
        section_type = f"wireguard_{interface}"
        result = self._r.uci.get("network", type=section_type)
        values = result.get("values", {}) if isinstance(result, dict) else {}
        removed = 0
        for section_name, section in values.items():
            if not isinstance(section, dict):
                continue
            if section.get("public_key", "") == public_key:
                self._r.uci.delete("network", section_name)
                removed += 1
        return removed

    def setup_firewall(self, interface: str = "wg0", listen_port: int = 51820):
        """Stage firewall zone, forwardings, and WAN allow rule for WireGuard.

        `listen_port` plumbs through to the WAN allow rule so a non-default
        port (e.g. when the upstream home router can only forward 51821) is
        reflected in the rule we install.

        Bypasses `firewall.create_zone` / `firewall.add_forwarding` because
        those helpers commit per-call, which would split this work across
        four separate firewall reloads — and on the third reload the new wg
        zone might be referenced by a forwarding before the zone itself is
        committed, leaving the reload partial. Doing it as one staged batch
        + a single `uci.apply` (in the caller's `safe_apply`) keeps it atomic.

        Note: we don't call `firewall.reload()` here either — that helper
        shells out via `file.exec` which the droplet-ai rpcd ACL deliberately
        denies; safe_apply's apply triggers ucitrack -> firewall reload anyway.
        """
        # 1. wg zone — permissive in/out/fwd within the VPN, masquerade so
        #    peers can reach upstream services that don't route the VPN subnet.
        self._r.uci.add("firewall", "zone", {
            "name": "wg",
            "input": "ACCEPT",
            "output": "ACCEPT",
            "forward": "ACCEPT",
            "network": interface,
            "masq": "1",
        })

        # 2. Forwardings: wg -> lan (reach NAS, services), wg -> wan (internet).
        self._r.uci.add("firewall", "forwarding", {"src": "wg", "dest": "lan"})
        self._r.uci.add("firewall", "forwarding", {"src": "wg", "dest": "wan"})

        # 3. Allow WireGuard listen_port through WAN ingress.
        self._r.uci.add("firewall", "rule", {
            "name": "Allow-WireGuard",
            "src": "wan",
            "proto": "udp",
            "dest_port": str(listen_port),
            "target": "ACCEPT",
            "enabled": "1",
        })
        # No commit here — safe_apply's uci.apply commits + reloads atomically.


# ---------------------------------------------------------------------------
# High-level API: AP onboarding (WARP-446)
# ---------------------------------------------------------------------------
class ApApi:
    """Coverage-extender AP wireless config management.

    Each approved extender gets one `wifi-iface` UCI section keyed on
    its MAC. The section is the standard hostapd-compatible shape with
    802.11k/v/r flags baked in so band-steering (dawn) works without
    per-AP tuning. See `docs/ADR-005-ap-auto-onboarding.md` for the
    decision record.

    Following the WireGuard / camera-subnet pattern: callers wrap these
    helpers in `safe_apply` so a bad push that partitions connectivity
    is auto-rolled back. The helpers themselves don't commit — they
    stage uci changes and the caller's `safe_apply` does the
    commit + reload atomically.
    """

    # Standard 802.11r FT flags. Same shape used by OpenWrt's wiki
    # examples for cross-AP fast handoff over WPA2-PSK. ft_over_ds=0
    # means the handoff goes through the AIR (over-the-air) rather
    # than over the wired backhaul — the latter requires a working
    # IP routing between APs that we don't reliably have at install
    # time (a fresh extender may not have a static lease yet).
    _FT_FLAGS = {
        "ieee80211r": "1",
        "ft_over_ds": "0",
        "ft_psk_generate_local": "1",
    }

    # 802.11k (neighbor reports) + 802.11v (BSS Transition Management).
    # Dawn needs these set on every AP to negotiate roaming — without
    # them dawn falls back to deauth-based steering which is what
    # caused the usteer/Apple problems documented in ADR-005.
    _KV_FLAGS = {
        "ieee80211k": "1",
        "bss_transition": "1",
    }

    def __init__(self, router: "DropletRouter"):
        self._r = router

    @staticmethod
    def iface_section_for_mac(mac: str) -> str:
        """Deterministic uci section name from a MAC.

        `B8:27:EB:12:34:56` → `ap_extender_b827eb123456`. Lowercase,
        no separators — matches the OpenWrt section-name grammar
        (`^[a-z][a-z0-9_]*$`). Idempotent re-push relies on this
        being stable across input variants ("AA:BB", "aa-bb", "AABB").

        Raises ValueError when the input doesn't look like a MAC.
        """
        if not isinstance(mac, str):
            raise ValueError(f"mac must be a string, got {type(mac).__name__}")
        cleaned = mac.replace(":", "").replace("-", "").replace(".", "").strip().lower()
        if len(cleaned) != 12 or not all(c in "0123456789abcdef" for c in cleaned):
            raise ValueError(
                f"invalid MAC: {mac!r} (expected 6 hex bytes separated by : or -)"
            )
        return f"ap_extender_{cleaned}"

    def push_wireless_config(
        self,
        iface_section: str,
        radio: str,
        ssid: str,
        encryption: str,
        key: str,
        network: str = "lan",
    ) -> None:
        """Stage a `wifi-iface` section for the extender's wireless config.

        DOES NOT commit. Caller wraps this in `safe_apply` so commit +
        reload happen as a single ucitrack pass — same convention
        `create_interface` / `add_peer` in VPNApi use. Pre-committing
        here would leave nothing pending for `apply`, which then
        returns NO_DATA.

        802.11k/v/r flags are baked in unconditionally (see ADR-005);
        the dashboard does NOT expose toggles for them because the
        whole point of automatic onboarding is consistent steering
        across every AP.
        """
        values = {
            "device": radio,
            "mode": "ap",
            "network": network,
            "ssid": ssid,
            "encryption": encryption,
            "key": key,
            **self._FT_FLAGS,
            **self._KV_FLAGS,
        }
        # uci.set requires the section to exist; uci.add(name=...) is
        # the create-or-set idiom. We always use `add` because re-runs
        # need to be safe — if the section already exists, uci.add
        # with the same name will fail on real OpenWrt; the caller's
        # idempotency layer (remove + push) handles that.
        try:
            self._r.uci.set("wireless", iface_section, values)
        except UbusError as exc:
            # NOT_FOUND / NO_DATA — section doesn't exist yet; create.
            if exc.code in (4, 5):
                self._r.uci.add("wireless", "wifi-iface", values=values, name=iface_section)
            else:
                raise

    def remove_wireless_config(self, iface_section: str) -> None:
        """Stage deletion of the wifi-iface section.

        DOES NOT commit. Caller wraps this in `safe_apply`. No-op when
        the section doesn't exist — matches the orchestrator's
        decommission contract (idempotent).
        """
        try:
            self._r.uci.delete("wireless", iface_section)
        except UbusError as exc:
            if exc.code in (4, 5):
                # Already gone — caller's decommission flow treats this
                # as success-equivalent.
                return
            raise

    def browse_discovered(self) -> list[dict[str, Any]]:
        """Query umdns for `_droplet-ap._tcp` announcements on br-lan.

        Returns one dict per extender currently visible on the LAN,
        shaped like:
            {
                "mac": "B8:27:EB:12:34:56",
                "model": "raspberrypi,5-model-b",
                "serial": "AP-00000000a1b2c3d4",
                "version": "1.0",
                "last_ip": "192.168.50.42",
                "hostname": "droplet-extender-b827eb123456",
            }

        Per ADR-005 §1, the extender's `99-droplet-setup` script writes
        `/etc/umdns/droplet-ap.json` advertising `_droplet-ap._tcp` with
        TXT records `mac=…`, `model=…`, `serial=…`, `version=…`,
        `role=…`. The orchestrator's poller calls this every
        DROPLET_AP_DISCOVERY_INTERVAL seconds; the droplet-ai rpcd ACL
        already grants `umdns: ["browse", "update"]`
        (openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json) so no extra
        privileges are needed.

        Returns [] when umdns isn't installed, has no peers, or the
        ubus call shape changes. This is read-only — never raises on
        empty data; only network / auth failures bubble.
        """
        try:
            raw = self._r._call("umdns", "browse")
        except UbusError as exc:
            # NOT_FOUND on the umdns object = service isn't running.
            # Treat as "nothing to discover this tick"; the orchestrator
            # poller swallows empty results silently.
            if exc.code in (4, 5):
                return []
            raise

        # umdns returns either {service-name: {host-name: {...}}} or a
        # flat dict of records depending on the build. Tolerate both.
        records: list[dict[str, Any]] = []
        services = raw if isinstance(raw, dict) else {}
        droplet_services = services.get("_droplet-ap._tcp", {})
        if not isinstance(droplet_services, dict):
            return []
        for host_key, entry in droplet_services.items():
            if not isinstance(entry, dict):
                continue
            parsed = self._parse_droplet_ap_txt(entry)
            if parsed is None:
                continue
            # `ipv4` shape on umdns is just the address string; older
            # builds sometimes nest it under `ipv4` -> "address". Tolerate.
            ipv4 = entry.get("ipv4")
            if isinstance(ipv4, dict):
                ipv4 = ipv4.get("address") or ipv4.get("ip")
            if isinstance(ipv4, str) and "last_ip" not in parsed:
                parsed["last_ip"] = ipv4
            # Use the host key as hostname when the TXT didn't carry one.
            parsed.setdefault("hostname", host_key)
            records.append(parsed)
        return records

    @staticmethod
    def _parse_droplet_ap_txt(entry: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Pull TXT records out of a single umdns entry into our shape.

        TXT records arrive as a list of "key=value" strings (umdns) or
        sometimes as a dict (build-dependent). Tolerate both; drop any
        entry that doesn't carry the mandatory `mac=` key, since that's
        the orchestrator's primary key.
        """
        txt = entry.get("txt")
        kv: dict[str, str] = {}
        if isinstance(txt, list):
            for item in txt:
                if not isinstance(item, str) or "=" not in item:
                    continue
                key, _, value = item.partition("=")
                if key:
                    kv[key.strip()] = value.strip()
        elif isinstance(txt, dict):
            kv = {str(k): str(v) for k, v in txt.items()}
        else:
            return None

        mac = kv.get("mac")
        if not mac:
            return None
        record: dict[str, Any] = {"mac": mac}
        for k in ("model", "serial", "version"):
            if v := kv.get(k):
                record[k] = v
        return record


# ---------------------------------------------------------------------------
# High-level API: File operations
# ---------------------------------------------------------------------------
class FileApi:
    """File system operations on the OpenWrt device."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def read(self, path: str) -> str:
        """Read a file and return its contents."""
        result = self._r._call("file", "read", {"path": path})
        return result.get("data", "")

    def write(self, path: str, data: str) -> dict:
        """Write data to a file."""
        return self._r._call("file", "write", {"path": path, "data": data})

    def list_dir(self, path: str) -> list[dict]:
        """List directory contents."""
        result = self._r._call("file", "list", {"path": path})
        return result.get("entries", [])

    def stat(self, path: str) -> dict:
        """Get file metadata (size, permissions, timestamps)."""
        return self._r._call("file", "stat", {"path": path})

    def exec(self, command: str, params: Optional[list[str]] = None) -> dict:
        """Execute a command and return stdout, stderr, and exit code."""
        args: dict[str, Any] = {"command": command}
        if params:
            args["params"] = params
        return self._r._call("file", "exec", args)


# ---------------------------------------------------------------------------
# Main router class
# ---------------------------------------------------------------------------
class DropletRouter:
    """
    Top-level client for controlling the Droplet's OpenWrt routing layer.

    Provides authenticated access to all network configuration APIs via
    the ubus JSON-RPC interface.
    """

    def __init__(self, host: str = "192.168.50.1", port: int = 80,
                 username: str = "droplet-ai", password: str = "",
                 scheme: str = "http", timeout: int = 10,
                 auto_login: bool = True):
        self._client = UbusClient(host, port, scheme, timeout)
        self._session = SessionManager(self._client, username, password)

        # Initialize sub-APIs
        self.uci = UCIApi(self)
        self.network = NetworkApi(self)
        self.wireless = WirelessApi(self)
        self.dhcp = DHCPApi(self)
        self.firewall = FirewallApi(self)
        self.system = SystemApi(self)
        self.vpn = VPNApi(self)
        self.ap = ApApi(self)  # WARP-446: coverage extender onboarding
        self.file = FileApi(self)

        if auto_login:
            self._session.login()

    @property
    def session_token(self) -> str:
        return self._session.ensure_valid()

    def session_info(self) -> dict:
        """Current ubus session state (pure read of held SessionManager state).

        Surfaces ``{active, expires_at, username}`` for the AI-access scopes card.
        ubus sessions are short-lived tokens minted ~hourly by SessionManager and
        auto-refreshed — they already rotate themselves, which is why the
        dashboard's 'Rotate token' action is honest-gated rather than wired.
        """
        return {
            "active": self._session.token is not None,
            "expires_at": self._session.expires_at,
            "username": self._session.username,
        }

    def _call(self, obj: str, method: str, args: Optional[dict] = None) -> Any:
        """Make an authenticated ubus call."""
        return self._client.call(self.session_token, obj, method, args)

    def _batch_call(self, calls: list[tuple[str, str, dict]]) -> list[Any]:
        """Make multiple authenticated ubus calls in a single request."""
        return self._client.batch_call(self.session_token, calls)

    def exec_command(self, command: str, params: Optional[list[str]] = None) -> dict:
        """Execute a shell command on the OpenWrt device."""
        return self.file.exec(command, params)

    def exec_service(self, service: str, action: str) -> dict:
        """Run a service init script action (start, stop, restart, reload)."""
        return self.exec_command(f"/etc/init.d/{service}", [action])

    def list_objects(self, pattern: str = "*") -> dict:
        """List all available ubus objects."""
        return self._client.list_objects(self.session_token, pattern)

    def apply_changes(self, config: str, timeout: int = 30):
        """Commit and safely apply config changes with auto-rollback."""
        self.uci.commit(config)
        self.uci.apply(timeout=timeout, rollback=True)

        # Verify we still have connectivity
        try:
            self.system.board_info()
            self.uci.confirm()
            logger.info("Changes to '%s' applied and confirmed.", config)
        except ConnectionLost:
            logger.warning(
                "Lost connectivity after applying '%s'. "
                "Changes will auto-rollback in %ds.", config, timeout
            )
            raise

    @contextmanager
    def safe_apply(self, timeout: int = 60):
        """
        Context manager for safe configuration changes.

        Usage:
            with router.safe_apply(timeout=60):
                router.uci.set("network", "lan", {"ipaddr": "192.168.2.1"})
                router.uci.commit("network")

        Changes are applied with a rollback timer. If connectivity is lost,
        OpenWrt will automatically revert after `timeout` seconds.

        Default is 60s to match the orchestrator's confirmation-token TTL
        (WARP-41) — a Tier 2 token can never outlive the apply window.
        """
        try:
            yield self
        except BaseException:
            # PYNET-005: the with-block body raised (e.g. a UbusError partway
            # through a uci.set/add sequence). The already-staged deltas must not
            # linger in rpcd's SHARED staging area — a later, unrelated uci.apply
            # from any endpoint would silently commit our half-configuration to
            # the live router. Revert every config with pending changes, then
            # re-raise. The droplet-ai ACL already grants uci "changes"+"revert".
            try:
                pending = self.uci.changes() or {}
                changed = (
                    pending.get("changes", pending)
                    if isinstance(pending, dict)
                    else {}
                )
                for cfg in list(changed.keys()) if isinstance(changed, dict) else []:
                    try:
                        self.uci.revert(cfg)
                    except Exception:
                        logger.exception("Safe apply: revert failed for config %s", cfg)
            except Exception:
                logger.exception("Safe apply: failed to enumerate staged UCI changes for revert")
            raise

        # Apply all pending changes
        self.uci.apply(timeout=timeout, rollback=True)

        # Verify connectivity
        connected = False
        try:
            self.system.board_info()
            connected = True
            self.uci.confirm()
            logger.info("Safe apply: changes confirmed.")
        except ConnectionLost:
            logger.warning(
                "Safe apply: connectivity lost. Auto-rollback in %ds.", timeout
            )
            raise
        except UbusError as exc:
            # A UbusError during the probe or confirm leaves the rollback timer
            # running; log it and re-raise so the caller receives a 5xx.
            logger.warning(
                "Safe apply: ubus error during %s — auto-rollback in %ds: %s",
                "confirm" if connected else "connectivity probe",
                timeout,
                exc,
            )
            raise

    def disconnect(self):
        """Logout and clean up."""
        self._session.logout()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.disconnect()


# ---------------------------------------------------------------------------
# Convenience: AI agent integration helpers
# ---------------------------------------------------------------------------
def get_network_summary(router: DropletRouter) -> dict:
    """
    Get a complete network summary for the AI model's context.

    Returns a dict with interfaces, wireless, DHCP leases, and system info
    that can be fed into the LLM's context window.
    """
    # Shape-agnostic (ADR-011): a minimal deployment may not expose every
    # optional ubus object. The interface path already degrades a missing `wan`
    # to a present:False stub; each independent optional section below degrades
    # the same way (a missing object is data, not a crash) so the whole summary
    # never 500s and the dashboard doesn't read the router as offline. `system`
    # (board_info) is intentionally NOT degraded — it's a core object on every
    # build, so its absence is a genuinely broken router, which should surface.
    interfaces = router.network.get_all_interface_statuses()
    return {
        "system": router.system.board_info(),
        "resources": _section_or(router.system.resource_info, {}),
        "lan": interfaces.get("lan", interface_stub(present=False)),
        "wan": interfaces.get("wan", interface_stub(present=False)),
        "wireless": _section_or(router.wireless.status, {}),
        "dhcp_leases": _section_or(router.dhcp.active_leases, []),
        "firewall_zones": _section_or(router.firewall.get_zones, {}),
    }


def _find_upstream_gateway(wan_status: dict) -> Optional[str]:
    """Return the upstream default-route gateway on the WAN interface, or None.

    Reads the interface's ubus ``route`` list (same status shape
    `get_all_interface_statuses()` returns; `interface_stub` declares
    ``route: []``). An upstream gateway is a default route — target 0.0.0.0/0
    (IPv4) or ::/0 (IPv6) — carrying a non-empty ``nexthop``. The presence of
    such a route is the evidence that *something upstream* is routing for us,
    i.e. the box is plugged into an existing network rather than owning the edge.

    Read-only: this only inspects status the SDK already fetched; it never
    issues a write or touches the upstream.
    """
    routes = wan_status.get("route")
    if not isinstance(routes, list):
        return None
    for route in routes:
        if not isinstance(route, dict):
            continue
        target = route.get("target")
        # A default route has mask 0; tolerate the field being absent on odd
        # builds by keying primarily on the 0.0.0.0 / :: target.
        mask = route.get("mask", 0)
        nexthop = route.get("nexthop")
        if (
            target in _DEFAULT_ROUTE_TARGETS
            and (mask in (0, "0") or mask == 0)
            and isinstance(nexthop, str)
            and nexthop
        ):
            return nexthop
    return None


def detect_deployment_topology(router: DropletRouter) -> dict:
    """Determine this box's :class:`DeploymentTopology` by probing the WAN-facing
    interface for an upstream gateway — ADR-018 Decision 2.

    Reuses ``NetworkApi.get_all_interface_statuses()`` (the SAME shape-detection
    mechanism `get_network_summary` and the WireGuard interface probe use, per
    ADR-011) so there is exactly one "which interfaces are present" path. The
    posture is an EXPLICIT enum, never inferred from a null/absent field
    (rule 10):

    * WAN present + up + an upstream default-route gateway → ``DOWNSTREAM_ROUTER``.
    * WAN present + no upstream gateway → ``PRIMARY_ROUTER`` (the box owns the edge).
    * WAN not present on this shape → ``UNKNOWN`` (we do not guess a posture from
      absence; the LAN-only single-box case).

    Returns ``{"posture": DeploymentTopology, "evidence": {...}}``. The evidence
    surfaces *why* the posture was chosen: which interface is the WAN, whether it
    is present/up, and whether an upstream gateway was found. This is detection
    only — it issues no writes and never mutates the upstream network. Genuine
    ubus faults (e.g. PERMISSION_DENIED) and transport loss propagate to the
    caller rather than being masked as a posture.
    """
    statuses = router.network.get_all_interface_statuses()
    wan = statuses.get(WAN_INTERFACE_NAME)

    # Absent WAN — either no entry at all, or the explicit present:False stub a
    # LAN-only shape returns. Either way the posture is undetermined, NOT guessed.
    wan_present = isinstance(wan, dict) and wan.get("present") is True
    if not wan_present:
        return {
            "posture": DeploymentTopology.UNKNOWN,
            "evidence": {
                "wan_interface": WAN_INTERFACE_NAME,
                "wan_present": False,
                "wan_up": False,
                "wan_device": "",
                "upstream_gateway_present": False,
                "upstream_gateway": None,
            },
        }

    gateway = _find_upstream_gateway(wan)
    posture = (
        DeploymentTopology.DOWNSTREAM_ROUTER
        if gateway is not None
        else DeploymentTopology.PRIMARY_ROUTER
    )
    return {
        "posture": posture,
        "evidence": {
            "wan_interface": WAN_INTERFACE_NAME,
            "wan_present": True,
            "wan_up": bool(wan.get("up")),
            "wan_device": wan.get("l3_device") or wan.get("device") or "",
            "upstream_gateway_present": gateway is not None,
            "upstream_gateway": gateway,
        },
    }


def describe_network_for_llm(router: DropletRouter) -> str:
    """
    Generate a natural-language summary of the network state
    that can be injected into an LLM system prompt.
    """
    summary = get_network_summary(router)

    lan = summary["lan"]
    wan = summary["wan"]
    resources = summary["resources"]
    leases = summary["dhcp_leases"]

    lan_ip = "unknown"
    if lan.get("ipv4-address"):
        lan_ip = lan["ipv4-address"][0]["address"]

    wan_ip = "unknown"
    if wan.get("ipv4-address"):
        wan_ip = wan["ipv4-address"][0]["address"]
    elif wan.get("present") is False:
        # WAN not configured on this box (e.g. single-box: WAN handled by the
        # host, not the containerised OpenWrt) — distinct from a down WAN.
        wan_ip = "n/a (WAN handled by host)"

    uptime_hours = resources.get("uptime", 0) // 3600
    mem_total = resources.get("memory", {}).get("total", 0) // (1024 * 1024)
    mem_free = resources.get("memory", {}).get("free", 0) // (1024 * 1024)

    lines = [
        f"Network Status: LAN IP {lan_ip}, WAN IP {wan_ip}",
        f"Uptime: {uptime_hours} hours",
        f"Memory: {mem_free}MB free / {mem_total}MB total",
        f"Connected devices (DHCP): {len(leases)}",
    ]

    for lease in leases:
        lines.append(f"  - {lease.get('hostname', 'Unknown')} ({lease.get('ipaddr')}, MAC: {lease.get('macaddr')})")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI quick-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)

    host = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.1"
    password = sys.argv[2] if len(sys.argv) > 2 else ""

    with DropletRouter(host=host, password=password) as router:
        print("=== System Board Info ===")
        print(json.dumps(router.system.board_info(), indent=2))

        print("\n=== LAN Status ===")
        print(json.dumps(router.network.interface_status("lan"), indent=2))

        print("\n=== DHCP Leases ===")
        for lease in router.dhcp.active_leases():
            print(f"  {lease['hostname']:30s} {lease['ipaddr']:15s} {lease['macaddr']}")

        print("\n=== Network Summary for AI ===")
        print(describe_network_for_llm(router))
