"""ADR-071 slice B (WARP-3739) - box <-> edge-router pairing, routing half.

Two pieces live here, kept out of main.py so the wire-level client and the
process-wide pairing state can be unit-tested without the FastAPI app:

  * `PairingApi` - the NULL-SESSION client for the router's `droplet.pair`
    ubus object (`status`, `claim`). The caller holds no credential yet, so
    every call is made with the all-zero session id (ADR-071 section 2.1). A
    router image without the plugin answers "Object not found" / "Access
    denied"; that is `PairingUnsupported` (state `unknown`), never a crash.
  * `PairingState` - the explicit, thread-safe state routing keeps about the
    pairing: the last `status` probe (cached, served by /health), the box
    fingerprint supplied by the orchestrator, whether a claim succeeded in
    this process, and the freshly-minted password held in memory until the
    orchestrator confirms it was persisted (`pending_persist`).

The password is NEVER logged or echoed anywhere except the 200 body of
`POST /pairing/claim` (and the service-token-gated `GET /pairing/pending`).
"""
from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from droplet_openwrt_sdk import NULL_SESSION, UbusClient, UbusError

logger = logging.getLogger("droplet.routing.pairing")

PAIR_OBJECT = "droplet.pair"

# Router-side pairing states (ADR-071 section 2.1) plus `unknown` for "could
# not tell".
STATE_OPEN = "open"
STATE_CLOSED = "closed"
STATE_PAIRED = "paired"
STATE_UNKNOWN = "unknown"
_ROUTER_STATES = frozenset({STATE_OPEN, STATE_CLOSED, STATE_PAIRED})

# JSON-RPC error codes rpcd/uhttpd-mod-ubus returns for a missing object
# (plugin not installed) and for a method the null session may not call.
_RPC_OBJECT_NOT_FOUND = -32000
_RPC_ACCESS_DENIED = -32002
# ubus status codes carrying the same meaning inside `result[0]`.
_UBUS_NOT_FOUND = 4
_UBUS_PERMISSION_DENIED = 6

FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")


class PairingUnsupported(Exception):
    """The router has no `droplet.pair` object (or refuses the null session)."""


class PairingClaimError(Exception):
    """`droplet.pair claim` was answered with an error. The message is the
    router's reason - it never contains the password (the router never echoes
    it)."""


@dataclass(frozen=True)
class PairStatus:
    state: str = STATE_UNKNOWN
    window_ends_at: Optional[str] = None
    paired_box: Optional[str] = None


def _iso(value: Any) -> Optional[str]:
    """Normalise the router's window end to ISO-8601 UTC. The plugin may report
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
    """Null-session client for the router's `droplet.pair` ubus object."""

    def __init__(self, host: str, port: int = 80, timeout: int = 5,
                 client: Optional[UbusClient] = None):
        self._client = client or UbusClient(host, port, "http", timeout)

    def _call(self, method: str, args: Optional[dict] = None) -> dict:
        resp = self._client.raw_call(
            "call", [NULL_SESSION, PAIR_OBJECT, method, args or {}]
        )
        err = resp.get("error")
        if err:
            code = err.get("code") if isinstance(err, dict) else None
            if code in (_RPC_OBJECT_NOT_FOUND, _RPC_ACCESS_DENIED):
                raise PairingUnsupported(
                    f"{PAIR_OBJECT}.{method} unavailable on router "
                    f"(rpc error {code})"
                )
            message = err.get("message") if isinstance(err, dict) else str(err)
            raise UbusError(-1, str(message))
        result = resp.get("result") or []
        if not result:
            raise UbusError(-1, "Empty result")
        code = result[0]
        if code in (_UBUS_NOT_FOUND, _UBUS_PERMISSION_DENIED):
            raise PairingUnsupported(
                f"{PAIR_OBJECT}.{method} unavailable on router (ubus status {code})"
            )
        if code != 0:
            raise UbusError(code)
        data = result[1] if len(result) > 1 else {}
        return data if isinstance(data, dict) else {}

    def status(self) -> PairStatus:
        """Read the pairing window state. Raises `PairingUnsupported` for a
        router without the plugin; `ConnectionLost` / `UbusError` pass through."""
        data = self._call("status")
        state = data.get("pairing")
        if state not in _ROUTER_STATES:
            state = STATE_UNKNOWN
        paired_box = data.get("paired_box")
        if not (isinstance(paired_box, str) and FINGERPRINT_RE.match(paired_box)):
            paired_box = None
        return PairStatus(
            state=state,
            window_ends_at=_iso(data.get("window_ends_at")),
            paired_box=paired_box,
        )

    def claim(self, password: str, box_fingerprint: str) -> None:
        """Claim the router. Raises `PairingClaimError` when the router answers
        with an error, `PairingUnsupported` when the plugin is absent."""
        try:
            data = self._call(
                "claim", {"password": password, "box_fingerprint": box_fingerprint}
            )
        except UbusError as exc:
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
                "ROUTER_PAIRED_ELSEWHERE: router is paired to a different box "
                "(fingerprint %s...) - a router button press is needed to re-pair",
                foreign[:16],
            )

    def foreign_paired_box(self) -> Optional[str]:
        """The foreign fingerprint when the cached probe says the router is
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
