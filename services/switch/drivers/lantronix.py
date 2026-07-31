"""Lantronix SM8TAT2SA managed switch driver.

Controls the switch via its WebStaX HTTPS JSON API. Authentication uses
client-generated session cookies plus a userip handshake against
POST /config/login (the firmware issues no Set-Cookie).

Verified API (read-only discovery against firmware v1.04.0079, 2026-06-03 —
ADR-018 item 10):
- Auth:  GET  /config/login   → JSON carrying `userip`
         POST /config/login   → {"users_login_auth": {agent, username, password, userip}}
- Reads (confirmed HTTP 200, JSON):
         GET /stat/sysinfo               model / firmware / MAC
         GET /stat/vlan_membership_stat  [[vid, name, members[], untagged[]], ...]
         GET /stat/vlan_port_stat        per-port PVID + tagging (trunk via txtag)
         GET /stat/poe_status            per-port PoE
- Writes (pattern-inferred, NOT hardware-confirmed — gated by `plan_only`):
         POST /config/<name> with a body shaped like the matching /stat/<name>.

The legacy prototype VLAN endpoints (/stat/vlan, /stat/port,
/stat/vlan_membership, /config/vlan_membership) return 404 on v1.04.0079 and
have been removed — they were never reachable on shipping firmware.

Port layout: 8x GbE copper PoE (1-8) + 2x SFP (9-10)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

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

# Default untagged VLAN a port falls back to when its PVID can't be read.
LAN_VLAN = 1

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

# A trunk port on WebStaX carries `txtag` = "All except-native" (it tags every
# VLAN except its native/untagged PVID). Access ports carry "None".
_TRUNK_TXTAG = "All except-native"


def _format_speed_mbps(speed_mbps: int) -> str:
    """Render a link speed (Mbps from /stat/port_status) as the §7 label.

    0 (or anything falsy) -> "" so the dashboard shows "—" for a down link.
    Clean 1000-multiples render as "N Gb" (1000 -> "1 Gb", 10000 -> "10 Gb");
    anything else renders as "N Mb" rather than fabricating a fractional Gb
    label the firmware never reported.
    """
    try:
        mbps = int(speed_mbps)
    except (TypeError, ValueError):
        return ""
    if mbps <= 0:
        return ""
    if mbps % 1000 == 0:
        return f"{mbps // 1000} Gb"
    return f"{mbps} Mb"


def _parse_vlan_membership_stat(data: dict) -> dict[int, dict]:
    """Parse a GET /stat/vlan_membership_stat payload into a per-VLAN map.

    Input rows are ``[vlan_id:int, name:str, members:int[], untagged:int[]]``.
    Tagged ports are ``members - untagged``. Returns::

        {vid: {"name": str,
               "ports": [{"port": int, "tagged": bool, "member": True}, ...]}}

    Shared by ``get_vlans`` (all VLANs) and ``get_vlan_membership`` (one VLAN)
    so both expose the identical base-class membership shape from one parser.
    """
    out: dict[int, dict] = {}
    rows = data.get("data", []) if isinstance(data, dict) else []
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) < 4:
            continue
        vid, name, members, untagged = row[0], row[1], row[2], row[3]
        try:
            vid = int(vid)
        except (TypeError, ValueError):
            continue
        members = [int(p) for p in (members or [])]
        untagged_set = {int(p) for p in (untagged or [])}
        ports = [
            {"port": p, "tagged": p not in untagged_set, "member": True}
            for p in sorted(members)
        ]
        out[vid] = {"name": str(name or ""), "ports": ports}
    return out


class LantronixDriver(SwitchDriver):
    """SM8TAT2SA driver using HTTPS JSON API with session cookie auth.

    Concurrency model:
    * `_auth_lock` serializes login POSTs so parallel callers can't stomp on
      each other's session cookie. All re-auths go through `_authenticate()`,
      which takes the lock and refreshes `_last_ok_at` on success so a
      second concurrent caller short-circuits on the lock's 1s de-dup check
      instead of firing a redundant login POST.
    * `_last_ok_at` is treated as liveness ground truth and is written on
      three success paths: `connect()` (initial auth), `_authenticate()`
      (every successful re-auth), and `_request()` (every successful
      application call). `is_connected()` / the orchestrator health probe
      read from this cache rather than hitting the switch.
    * A background apscheduler job (`_keepalive_tick`) pings /stat/sysinfo on
      a cadence below the switch idle timeout. It doesn't reset `_last_ok_at`
      directly — it calls `_ping()` → `_request()`, which does. (WARP-221:
      replaced the old `while True` keepalive loop with AsyncIOScheduler, the
      canonical pattern in services/file-indexer/scheduler_service.py.)
    """

    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        ca_cert: str | None = None,
        plan_only: bool = True,
    ):
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        # Optional CA bundle / cert path for TLS verification of the switch
        # (SWITCH_CA_CERT). When None, verification stays disabled with a
        # warning (self-signed embedded cert) — NET-07.
        self._ca_cert = ca_cert
        # Write-safety gate (ADR-018 item 10 "Driver caveat"). The WebStaX
        # WRITE shape (`POST /config/<name>` mirroring the `/stat/<name>` read)
        # is pattern-inferred from the confirmed reads but NOT yet verified on
        # firmware v1.04.0079 — writes are not GET-verifiable, so they could not
        # be confirmed in the read-only discovery session. While `plan_only` is
        # True (the default) every write method COMPUTES and returns the
        # intended change without issuing the POST. Flipping it to False
        # requires a one-time supervised confirmation per firmware; only then
        # does a write actually hit the wire (and it is read-back-verified).
        self._plan_only = plan_only
        self._client: httpx.AsyncClient | None = None
        self._auth_lock = asyncio.Lock()
        self._keepalive_scheduler: AsyncIOScheduler | None = None
        # Held for the duration of a single `_keepalive_tick` so `disconnect()`
        # can drain an in-flight ping before closing the client (WARP-221).
        # `shutdown(wait=False)` stops *new* ticks firing but does not await a
        # tick already suspended inside `_ping()`; without this lock that tick
        # would resume against a closed httpx client and raise.
        self._keepalive_lock = asyncio.Lock()
        self._last_ok_at: float = 0.0
        self._last_auth_failure_at: float = 0.0

    # --- Lifecycle ---

    async def connect(self) -> None:
        # Must be awaited from inside a running asyncio event loop (it is —
        # the FastAPI lifespan awaits it on uvicorn's loop). AsyncIOScheduler
        # binds to the running loop when .start() is called below.
        #
        # NET-07: honour SWITCH_CA_CERT. When the operator points it at a CA
        # bundle / cert, pass that path to httpx `verify=` so the TLS session
        # to the switch is actually verified. Without it, fall back to the
        # historical insecure behaviour (self-signed embedded cert) with a
        # warning. A configured-but-unreadable cert fails closed rather than
        # silently downgrading to verify=False — silent downgrade is the very
        # false-assurance trap this fix removes.
        if self._ca_cert:
            if not os.path.isfile(self._ca_cert):
                raise ValueError(
                    f"SWITCH_CA_CERT is set to '{self._ca_cert}' but no such file "
                    f"exists; refusing to fall back to unverified TLS. Fix the path "
                    f"or unset SWITCH_CA_CERT to use the (insecure) self-signed default."
                )
            verify: bool | str = self._ca_cert
            logger.info(
                "TLS certificate verification ENABLED for switch at %s:%d "
                "(CA cert: %s).",
                self._host, self._port, self._ca_cert,
            )
        else:
            verify = False  # Self-signed cert on embedded switch
            logger.warning(
                "TLS certificate verification disabled for switch at %s:%d "
                "(self-signed cert expected). Set SWITCH_CA_CERT to enable verification.",
                self._host, self._port,
            )
        self._client = httpx.AsyncClient(
            base_url=f"https://{self._host}:{self._port}",
            verify=verify,
            timeout=15.0,
            follow_redirects=False,
        )
        # Install client-assigned session cookies BEFORE the first login. The
        # SM8TAT2SA web UI generates random values for cid, seid, sesslid in
        # JavaScript (see login.html) and uses them as the session key — the
        # firmware never issues a Set-Cookie, so these are the only thing
        # identifying our session to the switch. Values just need to be
        # reasonably unique integers.
        for name in ("cid", "seid", "sesslid"):
            self._client.cookies.set(
                name, str(secrets.randbelow(10**9) + 1), domain=self._host
            )
        await self._authenticate()
        # Mark the startup auth as a fresh ok so is_connected() reports true
        # before the first keepalive tick has landed.
        self._last_ok_at = time.monotonic()
        # A direct re-connect() without an intervening disconnect() must not
        # orphan the previous scheduler — otherwise two interval jobs would
        # ping the switch concurrently. Tear the old one down first.
        if self._keepalive_scheduler is not None:
            self._keepalive_scheduler.shutdown(wait=False)
            self._keepalive_scheduler = None
        # WARP-221: keepalive runs on apscheduler, not a while-True loop.
        # coalesce=True + max_instances=1 stop a slow ping from overlapping
        # or stampeding the next tick.
        self._keepalive_scheduler = AsyncIOScheduler()
        self._keepalive_scheduler.add_job(
            self._keepalive_tick,
            trigger=IntervalTrigger(seconds=_KEEPALIVE_INTERVAL_S),
            id="lantronix_keepalive",
            name="Lantronix switch session keepalive",
            replace_existing=True,
            coalesce=True,
            max_instances=1,
        )
        self._keepalive_scheduler.start()
        logger.info(
            "Keepalive scheduled (interval=%.1fs, liveness window=%.1fs)",
            _KEEPALIVE_INTERVAL_S, _LIVENESS_WINDOW_S,
        )
        logger.info("Connected to managed switch at %s:%d", self._host, self._port)

    async def disconnect(self) -> None:
        # Stop the scheduler first so no *new* keepalive tick can fire, then
        # drain any tick already in flight before tearing down the client.
        # `shutdown(wait=False)` returns immediately and does NOT await a tick
        # suspended inside `_ping()`'s `await self._client.get(...)`; closing
        # the client out from under that coroutine raises
        # "Cannot send a request, as the client has been closed" (WARP-221
        # HIGH). Acquiring `_keepalive_lock` — held for the whole tick body —
        # blocks here until the in-flight ping has fully returned.
        if self._keepalive_scheduler:
            self._keepalive_scheduler.shutdown(wait=False)
            self._keepalive_scheduler = None
        async with self._keepalive_lock:
            if self._client:
                await self._client.aclose()
                self._client = None
            self._last_ok_at = 0.0
        logger.info("Disconnected from switch")

    async def is_connected(self) -> bool:
        # Trust the keepalive loop's last result — never hits the switch.
        # If the loop has been unable to refresh `_last_ok_at` for longer
        # than the liveness window, the switch is effectively offline from
        # our perspective.
        if not self._client:
            return False
        return (time.monotonic() - self._last_ok_at) < _LIVENESS_WINDOW_S

    # --- Authentication ---

    async def _authenticate(self) -> None:
        """Authenticate against the SM8TAT2SA JSON login API.

        Two-step flow (matches what the switch's own login.html does):

          1. GET /config/login
             Returns {"status":"none","userip":"<our-ip>","System Name":...}.
             We need userip because the POST body carries it — the firmware
             treats the userip declared by the caller as part of the session
             key. Skipping this step and guessing userip works intermittently
             but breaks once the switch has seen traffic from a different IP
             recently.

          2. POST /config/login
             Body: JSON envelope
                 {"users_login_auth": {
                     "agent": 4,            # 4 = HTTPS, 3 = HTTP
                     "username": ...,
                     "password": ...,
                     "userip": <from step 1>
                 }}
             Success:  {"status":"success","privilege":15,"agent_id":N,"user":...}
             Failure:  {"status":"error","msg":"Wrong username or password!"}

        The switch never issues a Set-Cookie — the only thing holding the
        session together is the client-picked cid/seid/sesslid cookies we
        install in `connect()`. The HTTP 200 on /config/login says nothing
        about success; only the JSON status field does. The previous
        driver sent `data=` (form-encoded), which the switch rejected with
        {"error":"Invalid JSON format"} — so auth had never actually worked
        and every /stat/sysinfo was returning a login redirect forever.

        Serialized by `_auth_lock` so concurrent callers share a single
        login attempt rather than racing on the switch side.
        """
        if not self._client:
            raise ConnectionLost("Client not initialized")

        async with self._auth_lock:
            # If another coroutine just succeeded, skip the second login.
            if (time.monotonic() - self._last_ok_at) < 1.0:
                return

            # Short-circuit if we just failed — avoids a thundering herd on
            # a rebooting switch where the port is open but auth is failing.
            # Also important because SM8TAT2SA rate-limits failed logins —
            # hammering it locks out the admin account for a few minutes.
            if (time.monotonic() - self._last_auth_failure_at) < _REAUTH_BACKOFF_S:
                raise AuthenticationError(
                    f"Skipping re-auth ({_REAUTH_BACKOFF_S:.0f}s back-off after recent failure)"
                )

            # Use HTTPS agent code (4) when the base_url scheme is https, else
            # the plaintext agent code (3). Matches the client= ternary in the
            # firmware's login.html.
            agent = 4 if str(self._client.base_url).startswith("https") else 3

            try:
                pre = await self._client.get("/config/login")
                pre_data: dict = {}
                with contextlib.suppress(Exception):
                    pre_data = pre.json()
                userip = pre_data.get("userip", "")
                if not userip:
                    # Firmware usually returns this; if not, fall back to the
                    # switch's configured host IP so the payload shape is still
                    # valid (the firmware doesn't verify userip matches the
                    # TCP source, just that it's present).
                    userip = self._host

                body = {
                    "users_login_auth": {
                        "agent": agent,
                        "username": self._username,
                        "password": self._password,
                        "userip": userip,
                    }
                }
                resp = await self._client.post("/config/login", json=body)

                # Switch always returns 200 — success lives in the body.
                try:
                    result = resp.json()
                except Exception as exc:  # noqa: BLE001
                    self._last_auth_failure_at = time.monotonic()
                    raise AuthenticationError(
                        f"Non-JSON login response (status {resp.status_code}): "
                        f"{resp.text[:200]}"
                    ) from exc

                status = result.get("status") if isinstance(result, dict) else None
                if status == "success":
                    # Refresh liveness *inside* the lock-held success branch
                    # so the 1s de-dup check at the top of the critical
                    # section stops the next concurrent caller from firing
                    # a second login POST. Without this the check only saves
                    # work when some other path (connect, _request) updated
                    # `_last_ok_at` first — exactly the thundering-herd case
                    # the lock was meant to prevent.
                    self._last_ok_at = time.monotonic()
                    logger.info(
                        "Authenticated with switch as %s (privilege %s)",
                        result.get("user", self._username),
                        result.get("privilege"),
                    )
                    return

                self._last_auth_failure_at = time.monotonic()
                msg = result.get("msg") if isinstance(result, dict) else str(result)
                raise AuthenticationError(
                    f"Login rejected by switch: {msg or result}"
                )
            except httpx.ConnectError as exc:
                self._last_auth_failure_at = time.monotonic()
                raise ConnectionLost(
                    f"Cannot reach switch at {self._host}:{self._port}: {exc}"
                )
            except httpx.TimeoutException as exc:
                self._last_auth_failure_at = time.monotonic()
                raise ConnectionLost(f"Timeout connecting to switch: {exc}")

    async def _keepalive_tick(self) -> None:
        """One scheduler-fired keepalive: ping /stat/sysinfo, swallow errors.

        Fired every `_KEEPALIVE_INTERVAL_S` by the AsyncIOScheduler set up in
        `connect()` (WARP-221 — replaced the old `while True` loop). The
        IntervalTrigger waits one full interval before its first fire, which
        matches the old loop's "sleep first, then ping" cadence. Exceptions
        are logged but never propagate — losing the switch for a while is
        surfaced via `is_connected()` going False, not by crashing.

        The whole body holds `_keepalive_lock` so `disconnect()` can wait for
        an in-flight ping to finish before closing the httpx client (WARP-221
        HIGH — avoids a use-after-close race on graceful shutdown/reconnect).
        """
        async with self._keepalive_lock:
            try:
                await self._ping()
            except Exception as exc:  # noqa: BLE001 — any failure is interesting
                logger.warning("Keepalive ping failed: %s", exc)

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

    @property
    def plan_only(self) -> bool:
        """True when writes are computed but NOT applied (SWITCH_LIVE_WRITES off).
        The REST layer reflects this as dry_run/planned so callers — and the
        LLM switch tools — never report a hardware change that didn't happen
        (PYNET-001)."""
        return self._plan_only

    async def _gated_write(
        self,
        config_path: str,
        body: dict,
        plan: dict,
        verify: "Callable[[], Awaitable[bool]] | None" = None,
    ) -> dict | None:
        """Apply a write, or return its plan when ``plan_only`` is set.

        The WebStaX write shape (``POST /config/<name>`` mirroring the matching
        ``/stat/<name>`` read) is pattern-inferred from the confirmed reads and
        has NOT been verified on firmware v1.04.0079 — writes are not
        GET-verifiable, so the read-only discovery session could not confirm
        them. This is the ADR-018 item 10 "Driver caveat": flipping the driver
        out of plan-only requires a one-time supervised confirmation per
        firmware.

        * ``plan_only`` True  → return ``{**plan, "dry_run": True}``; no POST.
        * ``plan_only`` False → POST the body, then run ``verify`` (a read-back)
          and raise ``SwitchAPIError`` if the change didn't take. Returns
          ``{**plan, "dry_run": False}`` on success.
        """
        if self._plan_only:
            logger.info(
                "switch write PLANNED (plan_only) — not applied: POST %s %s",
                config_path, plan,
            )
            return {**plan, "dry_run": True}

        await self._request("POST", config_path, json=body)
        if verify is not None and not await verify():
            raise SwitchAPIError(
                500,
                f"write to {config_path} did not verify on read-back "
                f"(plan: {plan}). The v1.04 write shape is unconfirmed — "
                f"see the LantronixDriver ADR-018 item 10 caveat.",
            )
        logger.info("switch write APPLIED + verified: POST %s %s", config_path, plan)
        return {**plan, "dry_run": False}

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
        # Verified: GET /stat/sysinfo → {"data": {"Model Name": ...,
        # "Firmware Version": ..., "MAC Address": ..., "System Name": ...}}.
        data = await self._request("GET", "/stat/sysinfo")
        raw = data.get("data", data)
        # WARP-1674: the driver owns vendor branding (the dashboard renders
        # `model` verbatim now that "Lantronix" is no longer hardcoded there).
        model = str(raw.get("Model Name", raw.get("Model", "SM8TAT2SA")))
        if not model.lower().startswith("lantronix"):
            model = f"Lantronix {model}"
        return {
            "model": model,
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
        # Verified: GET /stat/vlan_port_stat → {"data": [{"port": N,
        # "element": [{"pvid": int, "txtag": "None"|"All except-native", ...}]}]}.
        # `pvid` is the port's untagged (access) VLAN; a trunk port carries
        # txtag "All except-native". (The legacy `/stat/port` 404s on v1.04.0079;
        # link/speed/duplex are not exposed here and surface as empty/false —
        # the provisioner only consumes `port`, `vlan`, and `is_sfp`.)
        data = await self._request("GET", "/stat/vlan_port_stat")
        raw_ports = data.get("data", []) if isinstance(data, dict) else []

        ports: list[dict] = []
        if isinstance(raw_ports, list):
            for entry in raw_ports:
                if not isinstance(entry, dict):
                    continue
                port_num = entry.get("port")
                try:
                    port_num = int(port_num)
                except (TypeError, ValueError):
                    continue

                element = entry.get("element") or [{}]
                el = element[0] if isinstance(element, list) and element else {}
                pvid = el.get("pvid", el.get("PVID", LAN_VLAN))
                try:
                    pvid = int(pvid)
                except (TypeError, ValueError):
                    pvid = LAN_VLAN
                txtag = str(el.get("txtag", "")).strip()

                ports.append({
                    "port": port_num,
                    "name": f"Port {port_num}",
                    # vlan_port_stat carries PVID/tagging, not link state.
                    "enabled": True,
                    "link_up": False,
                    "speed": "",
                    "duplex": "",
                    "is_sfp": port_num >= SFP_PORT_MIN,
                    "is_trunk": txtag == _TRUNK_TXTAG,
                    "vlan": pvid,
                })

        # Ensure all ports are represented even if the firmware omits one.
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
                    "is_trunk": False,
                    "vlan": LAN_VLAN,
                })

        return sorted(ports, key=lambda p: p["port"])

    async def get_port(self, port: int) -> dict:
        self._validate_port(port)
        all_ports = await self.get_ports()
        for p in all_ports:
            if p["port"] == port:
                return p
        raise SwitchAPIError(404, f"Port {port} not found")

    async def get_port_status(self) -> list[dict]:
        """Read live link state + speed from GET /stat/port_status.

        Newly confirmed on v1.04.0079 (ADR-018 item 12) — this is the REAL
        link/speed source. `/stat/vlan_port_stat` (consumed by ``get_ports``)
        carries only PVID/tagging, so ``get_ports`` cannot report link state;
        the orchestrator aggregation joins this read in to fill it.

        Firmware row shape::

            {"port": int, "link": "up"|"down", "media": "copper"|"fiber",
             "speed": int (Mbps; 0 = down), "olink": 0|1}

        Returns one dict per physical port (1-10), sorted by port::

            {"port": int, "link_up": bool, "speed": str, "is_sfp": bool}

        ``speed`` is the §7 label ("1 Gb"/"10 Gb"/"" when down). All ports are
        represented even if the firmware omits a row (omitted -> down).
        """
        data = await self._request("GET", "/stat/port_status")
        raw_rows = data.get("data", []) if isinstance(data, dict) else []

        by_port: dict[int, dict] = {}
        if isinstance(raw_rows, list):
            for entry in raw_rows:
                if not isinstance(entry, dict):
                    continue
                port_num = entry.get("port")
                try:
                    port_num = int(port_num)
                except (TypeError, ValueError):
                    continue
                link_up = str(entry.get("link", "")).strip().lower() == "up"
                speed = _format_speed_mbps(entry.get("speed", 0)) if link_up else ""
                by_port[port_num] = {
                    "port": port_num,
                    "link_up": link_up,
                    "speed": speed,
                    "is_sfp": port_num >= SFP_PORT_MIN,
                }

        # Represent every physical port even when the firmware omits a row;
        # an omitted port is reported down (never inferred as up from absence).
        for i in range(PORT_MIN, PORT_MAX + 1):
            by_port.setdefault(i, {
                "port": i,
                "link_up": False,
                "speed": "",
                "is_sfp": i >= SFP_PORT_MIN,
            })

        return [by_port[i] for i in range(PORT_MIN, PORT_MAX + 1)]

    async def set_port_enabled(self, port: int, enabled: bool) -> None:
        self._validate_port(port)
        if self._plan_only:
            logger.info(
                "Port %d enable=%s PLANNED (plan_only) — not applied.",
                port, enabled,
            )
            return
        await self._request(
            "POST",
            "/config/ports",
            json={"port": port, "enabled": enabled},
        )
        logger.info("Port %d %s", port, "enabled" if enabled else "disabled")

    # --- VLAN Management ---

    async def get_vlans(self) -> list[dict]:
        # Verified: GET /stat/vlan_membership_stat →
        # {"data": [[vid, name, members[], untagged[]], ...]}. The shared parser
        # turns each row into the base-class membership shape (tagged = members
        # − untagged). (The legacy `/stat/vlan` 404s on v1.04.0079.)
        data = await self._request("GET", "/stat/vlan_membership_stat")
        parsed = _parse_vlan_membership_stat(data)
        return [
            {"vlan_id": vid, "name": info["name"], "ports": info["ports"]}
            for vid, info in sorted(parsed.items())
        ]

    async def create_vlan(self, vlan_id: int, name: str = "") -> None:
        # On WebStaX a VLAN is created implicitly by writing membership for a
        # new vid; this explicit call posts the VLAN row first. Gated by
        # `plan_only` so plan mode stays fully write-free (the membership write
        # that follows is the change that's read-back-verified).
        if not 2 <= vlan_id <= 4094:
            raise SwitchAPIError(400, f"VLAN ID {vlan_id} out of range (2-4094)")
        if self._plan_only:
            logger.info(
                "Create VLAN %d (%s) PLANNED (plan_only) — not applied.",
                vlan_id, name,
            )
            return
        await self._request(
            "POST",
            "/config/vlan",
            json={"vid": vlan_id, "name": name or f"VLAN{vlan_id}"},
        )
        logger.info("Created VLAN %d (%s)", vlan_id, name)

    async def delete_vlan(self, vlan_id: int) -> None:
        if vlan_id == 1:
            raise SwitchAPIError(400, "Cannot delete default VLAN 1")
        if self._plan_only:
            logger.info("Delete VLAN %d PLANNED (plan_only) — not applied.", vlan_id)
            return
        await self._request(
            "POST",
            "/config/vlan_delete",
            json={"vid": vlan_id},
        )
        logger.info("Deleted VLAN %d", vlan_id)

    async def get_vlan_membership(self, vlan_id: int) -> dict:
        # Verified: GET /stat/vlan_membership_stat carries every VLAN's
        # membership; we parse all rows and pick the requested vid. A VLAN that
        # doesn't exist returns an empty port list (not an error) so the
        # provisioner's read-back-verify can distinguish "absent" from
        # "unreadable". (The legacy `/stat/vlan_membership` 404s on v1.04.0079.)
        data = await self._request("GET", "/stat/vlan_membership_stat")
        parsed = _parse_vlan_membership_stat(data)
        info = parsed.get(vlan_id)
        return {
            "vlan_id": vlan_id,
            "ports": info["ports"] if info else [],
        }

    async def set_vlan_membership(
        self, vlan_id: int, membership: list[dict]
    ) -> dict | None:
        # Write counterpart of GET /stat/vlan_membership_stat. WebStaX
        # convention: POST /config/<name> with a body shaped like the matching
        # /stat/<name> read. Gated by `plan_only` (see _gated_write) — the write
        # shape is pattern-inferred, NOT confirmed on v1.04.0079. In apply mode
        # we read /stat/vlan_membership_stat back and confirm every requested
        # untagged member actually landed as an untagged member of the VLAN.
        body = {
            "data": [
                {"vid": vlan_id, "ports": membership},
            ]
        }
        plan = {"vlan_id": vlan_id, "membership": membership}

        async def _verify() -> bool:
            current = await self.get_vlan_membership(vlan_id)
            present = {
                (e["port"], bool(e.get("tagged")))
                for e in current.get("ports", [])
                if e.get("member")
            }
            for entry in membership:
                if not entry.get("member"):
                    continue
                want = (entry["port"], bool(entry.get("tagged")))
                if want not in present:
                    return False
            return True

        result = await self._gated_write(
            "/config/vlan_membership_stat", body, plan, verify=_verify
        )
        logger.info(
            "VLAN %d membership %s: %d ports",
            vlan_id,
            "planned" if self._plan_only else "updated",
            len(membership),
        )
        return result

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

    async def set_port_poe(self, port: int, enabled: bool) -> dict | None:
        # Write counterpart of GET /stat/poe_status. WebStaX convention:
        # POST /config/poe_config. Gated by `plan_only` (pattern-inferred write
        # shape, unconfirmed on v1.04.0079). In apply mode the read-back
        # confirms the port's admin-enabled state matches the request.
        self._validate_poe_port(port)
        body = {"data": [{"port": port, "enabled": enabled}]}
        plan = {"port": port, "enabled": enabled}

        async def _verify() -> bool:
            for entry in await self.get_poe_status():
                if entry.get("port") == port:
                    return bool(entry.get("enabled")) == enabled
            # No PoE row for the port after the write — can't confirm it took.
            return False

        result = await self._gated_write(
            "/config/poe_config", body, plan, verify=_verify
        )
        logger.info(
            "Port %d PoE %s",
            port,
            ("planned " if self._plan_only else "")
            + ("enable" if enabled else "disable"),
        )
        return result

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
        # PYNET-004: an idle-expired session answers 200 with a login-redirect
        # body ({"redirect_url": "/login"}), not a config. Accepting that as a
        # "backup" silently defeats the provisioner's refuse-to-write-blind
        # restore-point gate — detect it and fail closed.
        content = resp.content
        if b"redirect_url" in content[:256]:
            try:
                data = resp.json()
            except Exception:
                data = None
            if isinstance(data, dict) and "redirect_url" in data:
                raise SwitchAPIError(
                    resp.status_code,
                    "Config backup returned a login redirect (session expired) — refusing to treat it as a valid backup",
                )
        return content
