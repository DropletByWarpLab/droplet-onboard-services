"""ADR-071 slice C (WARP-3739) - box <-> managed-switch pairing, switch half.

Mirrors services/routing/pairing.py (slice B) for the switch. The two services
ship as separate images with no shared Python package path on either side (the
switch image COPYs only services/switch/ and four named services/_shared files),
so this module is a deliberate sibling copy rather than an import. What differs:

  * `PairingApi` is ASYNC (httpx) - the switch driver and every route here are
    async, and the switch has no SDK to borrow a sync `UbusClient` from. The
    wire contract is identical: the NULL session id and the `droplet.pair`
    object's `status` / `claim` methods.
  * Errors are the switch driver's own (`ConnectionLost` for transport,
    `PairingProtocolError` where the router's client raises `UbusError`).

`PairingState` and the typed-state helpers are kept line-for-line the same as
the routing copy so a fix to one is a mechanical fix to the other.

The password is NEVER logged or echoed anywhere except the 200 body of
`POST /pairing/claim` (and the service-token-gated `GET /pairing/pending`).
"""
from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

import httpx

from drivers.base import ConnectionLost

logger = logging.getLogger("droplet.switch.pairing")

PAIR_OBJECT = "droplet.pair"
NULL_SESSION = "0" * 32

# Device-side pairing states (ADR-071 section 2.1) plus `unknown` for "could
# not tell".
STATE_OPEN = "open"
STATE_CLOSED = "closed"
STATE_PAIRED = "paired"
STATE_UNKNOWN = "unknown"
_DEVICE_STATES = frozenset({STATE_OPEN, STATE_CLOSED, STATE_PAIRED})

# JSON-RPC error codes rpcd/uhttpd-mod-ubus returns for a missing object
# (plugin not installed) and for a method the null session may not call.
_RPC_OBJECT_NOT_FOUND = -32000
_RPC_ACCESS_DENIED = -32002
# ubus status codes carrying the same meaning inside `result[0]`.
_UBUS_NOT_FOUND = 4
_UBUS_PERMISSION_DENIED = 6

FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")

#: Injectable transport for tests: takes the JSON-RPC payload dict, returns the
#: parsed response dict. Production uses httpx against http://host:port/ubus.
Transport = Callable[[dict], Awaitable[dict]]


class PairingUnsupported(Exception):
    """The switch has no `droplet.pair` object (or refuses the null session)."""


class PairingProtocolError(Exception):
    """A ubus-level failure that is not "plugin absent" (the router client's
    `UbusError`). Carries the ubus status code when there is one."""

    def __init__(self, status: int = -1, message: str = ""):
        self.status = status
        super().__init__(message or f"ubus status {status}")


class PairingClaimError(Exception):
    """`droplet.pair claim` was answered with an error. The message is the
    device's reason - it never contains the password (the device never echoes
    it)."""


@dataclass(frozen=True)
class PairStatus:
    state: str = STATE_UNKNOWN
    window_ends_at: Optional[str] = None
    paired_box: Optional[str] = None


def _iso(value: Any) -> Optional[str]:
    """Normalise the device's window end to ISO-8601 UTC. The plugin may report
    epoch seconds or an already-formatted string; anything else is dropped."""
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
    if isinstance(value, str):
        return value
    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class PairingApi:
    """Null-session client for the switch's `droplet.pair` ubus object."""

    def __init__(self, host: str, port: int = 80, timeout: float = 5.0,
                 transport: Optional[Transport] = None):
        self._base_url = f"http://{host}:{port}/ubus"
        self._timeout = timeout
        self._transport = transport
        self._rpc_id = 0

    async def _post(self, payload: dict) -> dict:
        try:
            if self._transport is not None:
                return await self._transport(payload)
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                res = await client.post(self._base_url, json=payload)
            if res.status_code != 200:
                raise ConnectionLost(
                    f"Switch ubus endpoint returned HTTP {res.status_code} at {self._base_url}"
                )
            return res.json()
        except httpx.HTTPError as exc:
            raise ConnectionLost(f"Cannot reach switch at {self._base_url}: {exc}") from exc
        except ValueError as exc:  # json.JSONDecodeError
            raise ConnectionLost(f"Malformed ubus response from {self._base_url}") from exc

    async def _call(self, method: str, args: Optional[dict] = None) -> dict:
        self._rpc_id += 1
        resp = await self._post({
            "jsonrpc": "2.0",
            "id": self._rpc_id,
            "method": "call",
            "params": [NULL_SESSION, PAIR_OBJECT, method, args or {}],
        })
        err = resp.get("error")
        if err:
            code = err.get("code") if isinstance(err, dict) else None
            if code in (_RPC_OBJECT_NOT_FOUND, _RPC_ACCESS_DENIED):
                raise PairingUnsupported(
                    f"{PAIR_OBJECT}.{method} unavailable on switch (rpc error {code})"
                )
            message = err.get("message") if isinstance(err, dict) else str(err)
            raise PairingProtocolError(-1, str(message))
        result = resp.get("result") or []
        if not result:
            raise PairingProtocolError(-1, "Empty result")
        code = result[0]
        if code in (_UBUS_NOT_FOUND, _UBUS_PERMISSION_DENIED):
            raise PairingUnsupported(
                f"{PAIR_OBJECT}.{method} unavailable on switch (ubus status {code})"
            )
        if code != 0:
            raise PairingProtocolError(code)
        data = result[1] if len(result) > 1 else {}
        return data if isinstance(data, dict) else {}

    async def status(self) -> PairStatus:
        """Read the pairing window state. Raises `PairingUnsupported` for a
        switch without the plugin; `ConnectionLost` / `PairingProtocolError`
        pass through."""
        data = await self._call("status")
        state = data.get("pairing")
        if state not in _DEVICE_STATES:
            state = STATE_UNKNOWN
        paired_box = data.get("paired_box")
        if not (isinstance(paired_box, str) and FINGERPRINT_RE.match(paired_box)):
            paired_box = None
        return PairStatus(
            state=state,
            window_ends_at=_iso(data.get("window_ends_at")),
            paired_box=paired_box,
        )

    async def claim(self, password: str, box_fingerprint: str) -> None:
        """Claim the switch. Raises `PairingClaimError` when it answers with an
        error, `PairingUnsupported` when the plugin is absent."""
        try:
            data = await self._call(
                "claim", {"password": password, "box_fingerprint": box_fingerprint}
            )
        except PairingProtocolError as exc:
            raise PairingClaimError(f"claim refused: {exc.status}") from exc
        if data.get("error") or data.get("ok") is False:
            raise PairingClaimError(str(data.get("error") or "claim refused"))


class PairingState:
    """Process-wide pairing state. Plain, explicit fields guarded by one lock."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._status = PairStatus()
        self._box_fingerprint: Optional[str] = None
        self._paired_in_process = False
        self._live_password: Optional[str] = None
        self._pending_persist = False
        self._paired_at: Optional[str] = None
        self._foreign_logged: set[str] = set()

    # -- box fingerprint (supplied by the orchestrator) -----------------------
    def set_box_fingerprint(self, fingerprint: str) -> None:
        with self._lock:
            self._box_fingerprint = fingerprint
            self._log_foreign_once()

    def box_fingerprint(self) -> Optional[str]:
        with self._lock:
            return self._box_fingerprint

    # -- probe cache ----------------------------------------------------------
    def record_probe(self, status: PairStatus) -> None:
        with self._lock:
            self._status = status
            self._log_foreign_once()

    def record_probe_unknown(self) -> None:
        self.record_probe(PairStatus())

    def _foreign_box_locked(self) -> Optional[str]:
        st = self._status
        if (
            st.state == STATE_PAIRED
            and st.paired_box
            and self._box_fingerprint
            and st.paired_box != self._box_fingerprint
        ):
            return st.paired_box
        return None

    def _log_foreign_once(self) -> None:
        foreign = self._foreign_box_locked()
        if foreign and foreign not in self._foreign_logged:
            self._foreign_logged.add(foreign)
            logger.warning(
                "SWITCH_PAIRED_ELSEWHERE: switch is paired to a different box "
                "(fingerprint %s...) - a switch button press is needed to re-pair",
                foreign[:16],
            )

    def foreign_paired_box(self) -> Optional[str]:
        """The foreign fingerprint when the cached probe says the switch is
        paired to another box, else None. None whenever our own fingerprint is
        not yet known - the state is never guessed."""
        with self._lock:
            return self._foreign_box_locked()

    # -- successful claim -----------------------------------------------------
    def record_claim(self, password: str, fingerprint: str) -> str:
        with self._lock:
            self._box_fingerprint = fingerprint
            self._live_password = password
            self._pending_persist = True
            self._paired_in_process = True
            self._paired_at = _now_iso()
            self._status = PairStatus(state=STATE_PAIRED, paired_box=fingerprint)
            return self._paired_at

    def live_password(self) -> Optional[str]:
        """Password minted by a claim in this process, used for every login in
        preference to the secret file (which still holds the old value until the
        orchestrator persists the new one and the container is recreated)."""
        with self._lock:
            return self._live_password

    def pending(self) -> dict:
        with self._lock:
            if not self._pending_persist:
                return {"pending": False, "password": None, "paired_at": None}
            return {
                "pending": True,
                "password": self._live_password,
                "paired_at": self._paired_at,
            }

    def mark_persisted(self, secret_file_value: str) -> None:
        """The orchestrator confirmed the secret file holds the new password:
        clear the pending flag. The in-memory live password is dropped too once
        the file demonstrably agrees; otherwise it is kept so this process never
        regresses to a stale password."""
        with self._lock:
            self._pending_persist = False
            if self._live_password and secret_file_value == self._live_password:
                self._live_password = None

    # -- /health --------------------------------------------------------------
    def snapshot(self, *, connected: bool, auth_failed: bool) -> dict:
        """The `/health.pairing` block, served from cache - never touches the
        network. Connected: `paired` after a claim here or a paired probe, else
        `unknown` (no probing while connected). Disconnected: the AUTH-state
        probe cache, only while the last failure was an auth rejection."""
        with self._lock:
            st = self._status
            if connected:
                if self._paired_in_process or st.state == STATE_PAIRED:
                    box = self._box_fingerprint if self._paired_in_process else st.paired_box
                    return self._block(STATE_PAIRED, None, box, False)
                return self._block(STATE_UNKNOWN, None, None, False)
            if not auth_failed:
                return self._block(STATE_UNKNOWN, None, None, False)
            foreign = self._foreign_box_locked()
            return self._block(
                st.state, st.window_ends_at, st.paired_box, foreign is not None
            )

    def _block(self, state: str, window_ends_at: Optional[str],
               paired_box: Optional[str], elsewhere: bool) -> dict:
        return {
            "state": state,
            "window_ends_at": window_ends_at,
            "paired_box": paired_box,
            "paired_elsewhere": elsewhere,
            "pending_persist": self._pending_persist,
        }
