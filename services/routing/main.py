"""
Droplet Routing Service
=======================
FastAPI wrapper around the OpenWrt SDK, exposing router management
as a REST API for the orchestrator and AI gateway to consume.
"""

import sys as _sys

# WARP-229: FIPS 140-3 boot self-test. Env-gated; see
# services/_shared/fips_selftest.py for the contract.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("routing")
except ImportError:
    pass

import hmac
import os
import logging
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

import operations
from droplet_openwrt_sdk import (
    DropletRouter,
    ConnectionLost,
    LoginDenied,
    UbusError,
    ScanUnsupportedError,
    UBUS_STATUS_NOT_FOUND,
    UBUS_STATUS_NO_DATA,
    _ubus_object_absent,
    get_network_summary,
    describe_network_for_llm,
    detect_deployment_topology,
    parse_ai_acl_scopes,
)
import json
from schemas import (
    HealthResponse,
    SetSsidRequest,
    SetPasswordRequest,
    SetChannelRequest,
    CreateGuestNetworkRequest,
    SetUpnpRequest,
    StaticLeaseRequest,
    DhcpPoolRequest,
    HostnameRequest,
    NtpRequest,
    SysupgradeRequest,
    SetDnsRequest,
    DnsHostnameRequest,
    BlockDeviceRequest,
    UnblockDeviceRequest,
    PortForwardRequest,
    AddFirewallRuleRequest,
    SetZonePolicyRequest,
    PhoneHomeDeviceRequest,
    PhoneHomeCamerasRequest,
    ApplyConfigRequest,
    CreateVlanRequest,
    CameraSubnetSetupRequest,
    CreateInterfaceRequest,
    EditInterfaceRequest,
    FirewallZoneCollection,
    FirewallRuleCollection,
    FirewallRedirectCollection,
    VpnSetupRequest,
    VpnPeerCreateRequest,
    VpnOverlayPeerRequest,
    VpnPeerDeleteRequest,
    ApApproveRequest,
    ApTestSeedRequest,
    ApBandSteeringRequest,
    ApWirelessRequest,
)
import re

from request_context import configure_logging
from middleware import RequestIdMiddleware
from reconnect import ReconnectCoordinator

logger = logging.getLogger("droplet.routing")
configure_logging()

# ---------------------------------------------------------------------------
# Router singleton
# ---------------------------------------------------------------------------
OPENWRT_HOST = os.environ.get("OPENWRT_HOST", "192.168.50.1")
OPENWRT_PORT = int(os.environ.get("OPENWRT_PORT", "80"))
OPENWRT_USERNAME = os.environ.get("OPENWRT_USERNAME", "droplet-ai")

# WARP-44: `real` connects to OpenWrt; `mock` swaps in a fixture-returning
# stub so dev laptops without a router get a realistic UI; `disabled` is an
# orchestrator-side flag — routing still runs for consistency.
ROUTING_MODE = os.environ.get("ROUTING_MODE", "real").strip().lower()
if ROUTING_MODE not in ("real", "mock", "disabled"):
    logger.warning(
        "Unknown ROUTING_MODE=%r — falling back to 'real'. Valid values: real / mock / disabled.",
        ROUTING_MODE,
    )
    ROUTING_MODE = "real"


def _load_openwrt_password() -> str:
    """Load the rpcd password, preferring the Docker secret file (WARP-37).

    Resolution order:
      1. /run/secrets/openwrt_password — Docker Compose file-based secret (preferred).
      2. $OPENWRT_PASSWORD env var — deprecated, kept for dev / legacy bring-up.

    Returns an empty string when nothing is configured; the service still starts
    but logs a warning and every authenticated ubus call will fail at login —
    which is how the service has always behaved when the router is unreachable.
    """
    secret_path = os.environ.get("OPENWRT_PASSWORD_FILE", "/run/secrets/openwrt_password")
    try:
        with open(secret_path, "r", encoding="utf-8") as fh:
            value = fh.read().strip()
        if value:
            return value
        logger.warning(
            "OpenWrt password secret file %s is empty — set OPENWRT_PASSWORD in .env "
            "and re-run ./scripts/setup.sh --sync-secrets",
            secret_path,
        )
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("Could not read OpenWrt password from %s: %s", secret_path, exc)

    env_value = os.environ.get("OPENWRT_PASSWORD", "")
    if env_value:
        logger.warning(
            "OPENWRT_PASSWORD env var is deprecated — migrate to the Docker secret "
            "at /run/secrets/openwrt_password (WARP-37). Falling back to env for now."
        )
    return env_value


OPENWRT_PASSWORD = _load_openwrt_password()

# ---------------------------------------------------------------------------
# WARP-1675: external-AP credentials
# ---------------------------------------------------------------------------
# On the edge-router shape the approved coverage extender is an EXTERNAL
# OpenWrt AP (droplet-edge-router ap/ image) provisioning the same per-unit
# `droplet-ai` rpcd account model as the router. Approval configures the AP's
# OWN wireless over its rpcd at the mDNS-discovered address — the router-side
# wifi-iface staging is meaningless on a radio-less router. Same secret-file
# discipline as the router credential (WARP-37); when no AP credential is
# configured the service keeps the historical router-side-only behaviour.
AP_USERNAME = os.environ.get("AP_USERNAME", "droplet-ai")
AP_PORT = int(os.environ.get("AP_PORT", "80"))


def _load_ap_password() -> str:
    """Load the external AP's rpcd password, preferring the Docker secret file.

    Mirrors `_load_openwrt_password` (WARP-37): /run/secrets/ap_openwrt_password
    first, deprecated $AP_OPENWRT_PASSWORD env fallback. Empty string means "no
    external AP configured" — AP-direct configuration is skipped, never failed.
    """
    secret_path = os.environ.get("AP_OPENWRT_PASSWORD_FILE", "/run/secrets/ap_openwrt_password")
    try:
        with open(secret_path, "r", encoding="utf-8") as fh:
            value = fh.read().strip()
        if value:
            return value
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("Could not read AP password from %s: %s", secret_path, exc)

    env_value = os.environ.get("AP_OPENWRT_PASSWORD", "")
    if env_value:
        logger.warning(
            "AP_OPENWRT_PASSWORD env var is deprecated — migrate to the Docker "
            "secret at /run/secrets/ap_openwrt_password. Falling back to env for now."
        )
    return env_value


AP_PASSWORD = _load_ap_password()
if not OPENWRT_PASSWORD:
    logger.warning(
        "OpenWrt password is not configured — router control will be unavailable "
        "until /run/secrets/openwrt_password (or OPENWRT_PASSWORD) is set."
    )

# Shared bearer for orchestrator / camera-discovery → routing (WARP-36).
# Production bring-up via scripts/setup.sh always generates a token. When the
# token is unset the service FAILS CLOSED — every non-/health route returns 503
# — because routing binds 0.0.0.0:8080 under network_mode: host, so a missing or
# failed secret injection at deploy time would otherwise expose every mutation
# endpoint (VPN, firewall, SSID) to any host on the LAN. Set ROUTING_ALLOW_NO_AUTH=1
# to opt back into open mode for local dev only.
ROUTING_SERVICE_TOKEN = os.environ.get("ROUTING_SERVICE_TOKEN", "").strip()
ROUTING_ALLOW_NO_AUTH = os.environ.get("ROUTING_ALLOW_NO_AUTH", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
if not ROUTING_SERVICE_TOKEN:
    if ROUTING_ALLOW_NO_AUTH:
        logger.warning(
            "ROUTING_SERVICE_TOKEN is empty and ROUTING_ALLOW_NO_AUTH is set — "
            "auth disabled. Local dev only; NEVER set this in production."
        )
    else:
        logger.error(
            "ROUTING_SERVICE_TOKEN is empty — failing closed (503) on all "
            "non-/health routes. Set the token, or ROUTING_ALLOW_NO_AUTH=1 for "
            "local dev."
        )

# Paths exempt from bearer auth (used by Docker healthcheck / orchestrator health roll-up).
AUTH_EXEMPT_PATHS = frozenset({"/health"})


def require_bearer(request: Request) -> None:
    """Reject requests without a matching `Authorization: Bearer <token>` header.

    Fails CLOSED when no token is configured: an unset `ROUTING_SERVICE_TOKEN`
    (e.g. a failed secret injection at deploy) yields 503 on every non-/health
    route rather than silently opening the host-network service. Opt into the
    old open behaviour for local dev with `ROUTING_ALLOW_NO_AUTH=1`.
    """
    # /health stays reachable without a token (Docker healthcheck / health
    # roll-up) regardless of how auth is configured.
    if request.url.path in AUTH_EXEMPT_PATHS:
        return
    if not ROUTING_SERVICE_TOKEN:
        if ROUTING_ALLOW_NO_AUTH:
            return
        raise HTTPException(
            status_code=503,
            detail=(
                "Routing auth is not configured (ROUTING_SERVICE_TOKEN unset). "
                "Set the token, or ROUTING_ALLOW_NO_AUTH=1 for local dev."
            ),
        )
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip(), ROUTING_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


router_instance: Optional[DropletRouter] = None

# WARP-1673: WHY the last connect attempt failed — "auth" (router reachable but
# it rejected the droplet-ai credentials) or "unreachable" (everything else).
# Written by `_connect_to_openwrt` (whichever thread runs it — startup,
# on-demand, or background retry; plain assignment is atomic under the GIL,
# same discipline as the `router_instance` global itself) and read by
# `get_router()` / `/health` so a stale router secret renders as the actionable
# AUTH state instead of the generic "Router offline" one.
_last_connect_failure: Optional[str] = None


def _connect_to_openwrt() -> DropletRouter:
    """Construct a fresh, authenticated DropletRouter. Raises `ConnectionLost`
    / `UbusError` on failure — the caller (lifespan's startup attempt, or
    `reconnect_coordinator`'s on-demand / background retry, WARP-1510)
    decides what to do. Records the failure *kind* (WARP-1673) as it passes."""
    global _last_connect_failure
    try:
        router = DropletRouter(
            host=OPENWRT_HOST,
            port=OPENWRT_PORT,
            username=OPENWRT_USERNAME,
            password=OPENWRT_PASSWORD,
            auto_login=True,
        )
    except LoginDenied:
        _last_connect_failure = "auth"
        raise
    except (ConnectionLost, UbusError):
        _last_connect_failure = "unreachable"
        raise
    _last_connect_failure = None
    return router


#: Wire detail for the typed router-credential failure (WARP-1673). HTTP 502:
#: routing (the gateway) reached the router (the upstream) and the upstream
#: refused our credentials. Nothing sits between the orchestrator and this
#: service to mint a 502, so the status alone is an unambiguous classifier —
#: same status-only discipline as the 409 SCAN_UNSUPPORTED contract. The
#: orchestrator maps it to RouterError code AUTH (types/router-error.ts) and
#: the dashboard renders the existing "Credentials rejected" copy.
_ROUTER_AUTH_DETAIL = {
    "code": "ROUTER_AUTH",
    "message": (
        "The router rejected the routing service's credentials — the router's "
        "droplet-ai password has likely rotated (e.g. a reflash regenerated "
        "it). Re-sync docker/secrets/openwrt_password and restart the routing "
        "container."
    ),
}


def _set_router_instance(router: DropletRouter) -> None:
    global router_instance
    router_instance = router


def _router_is_connected() -> bool:
    return router_instance is not None


# WARP-1510: the startup connect above is a single attempt — if it loses
# the boot-order race (or a live connection is lost later), nothing retried
# it before this ticket, so `router_instance` stayed None forever. The
# coordinator is looked up as a module global (not captured by value) so
# tests can monkeypatch `main.reconnect_coordinator` per-test without
# leaking cooldown/backoff state across the suite — see conftest.py's
# autouse `_isolated_reconnect_coordinator` fixture.
reconnect_coordinator = ReconnectCoordinator(
    connect_fn=_connect_to_openwrt,
    on_connected=_set_router_instance,
    is_connected=_router_is_connected,
)


def get_router() -> DropletRouter:
    """Return the router singleton. If disconnected, first makes a
    cooldown-guarded on-demand reconnect attempt (WARP-1510) instead of
    503ing forever after a lost startup race — then 503s exactly as before
    if still disconnected."""
    if router_instance is None:
        reconnect_coordinator.maybe_reconnect_on_demand()
    if router_instance is None:
        # WARP-1673: a router that is UP but refusing our credentials is a
        # different operator problem than a router that is down — surface the
        # typed 502 so the dashboard shows "Credentials rejected", not
        # "Router offline".
        if _last_connect_failure == "auth":
            raise HTTPException(status_code=502, detail=_ROUTER_AUTH_DETAIL)
        raise HTTPException(status_code=503, detail="Router not connected")
    return router_instance


def handle_router_error(exc: Exception):
    """Convert SDK exceptions to HTTPException raises."""
    if isinstance(exc, LoginDenied):
        # WARP-1673: mid-session credential rejection (the password rotated
        # while we held a session and the re-login was refused) — same typed
        # 502 as the connect-time path in `get_router()`.
        raise HTTPException(status_code=502, detail=_ROUTER_AUTH_DETAIL)
    if isinstance(exc, ConnectionLost):
        raise HTTPException(status_code=503, detail=f"Router unreachable: {exc}")
    if isinstance(exc, UbusError):
        status = 400 if exc.code in (1, 2) else 500
        raise HTTPException(status_code=status, detail=f"ubus error: {exc.status}: {exc}")
    raise HTTPException(status_code=500, detail=f"Internal error: {exc}")


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global router_instance
    throughput_scheduler = None
    if ROUTING_MODE == "mock":
        # WARP-44: fixture-driven router — dev laptops, CI, demos.
        from mock_router import MockRouter

        router_instance = MockRouter()
        logger.info("Started in ROUTING_MODE=mock — serving fixtures, no real OpenWrt connection.")
        yield
        return

    try:
        router_instance = _connect_to_openwrt()
        logger.info("Connected to OpenWrt router at %s", OPENWRT_HOST)
    except (ConnectionLost, UbusError) as exc:
        logger.warning("Could not connect to OpenWrt router: %s", exc)
        router_instance = None

    # ADR-018: log the detected deployment-topology posture once on startup so
    # operators can see it without polling /network/topology. Re-evaluation is
    # event-driven — the /network/topology endpoint re-probes on every request
    # (the request IS the event); there is deliberately NO busy loop / periodic
    # tick here (rule 9), since the posture only needs a fresh read when the
    # dashboard/orchestrator asks. Non-fatal: a probe failure must not stop the
    # service from serving.
    if router_instance is not None:
        try:
            topology = detect_deployment_topology(router_instance)
            logger.info(
                "deployment topology detected: posture=%s wan_present=%s "
                "upstream_gateway=%s",
                topology["posture"].value,
                topology["evidence"]["wan_present"],
                topology["evidence"]["upstream_gateway"],
            )
        except ConnectionLost as exc:
            # Transient — the router dropped mid-probe. Benign at startup.
            logger.warning("deployment-topology probe failed at startup: %s", exc)
        except UbusError as exc:
            # Mirror the SDK's degrade-on-absence contract (ADR-011, same
            # discipline as get_all_interface_statuses / get_camera_subnet and
            # the /network/topology endpoint): a missing ubus object
            # (NOT_FOUND/NO_DATA, or the -1 "object not found" shape) just means
            # this deployment lacks it — benign. Any OTHER code
            # (PERMISSION_DENIED, INVALID_ARGUMENT, …) is a real misconfiguration
            # and must NOT be silently downgraded to a transient-looking warning.
            # This lifespan probe is deliberately non-fatal (a probe must not stop
            # the service from serving), so a genuine fault is surfaced at ERROR
            # rather than re-raised (which would crash startup).
            if _ubus_object_absent(exc):
                logger.warning("deployment-topology probe (object absent): %s", exc)
            else:
                logger.error(
                    "deployment-topology probe hit a real ubus fault "
                    "(code=%s) — check the OpenWrt ACL / config: %s",
                    exc.code,
                    exc,
                )

    # WARP-1510: the startup connect above lost the boot-order race — start
    # a background retry with capped exponential backoff instead of staying
    # wedged until a container restart. Non-fatal (same umbrella as the
    # samplers below): a failure to even start the retry scheduler must not
    # stop the service from serving the on-demand reconnect path in
    # get_router(). Stops itself (removes its own job) once connected —
    # see reconnect.py, rule 9 (no `while True` / `time.sleep` polling).
    reconnect_scheduler = None
    if router_instance is None:
        try:
            from reconnect import start_reconnect_scheduler

            reconnect_scheduler = start_reconnect_scheduler(reconnect_coordinator)
        except Exception as exc:  # noqa: BLE001 — non-fatal startup task
            logger.warning("reconnect scheduler failed to start: %s", exc)

    # WARP-470: start the 60 s WAN throughput sampler once we have a
    # real router connection. Skipped in mock mode (the mock doesn't
    # carry traffic counters worth sampling). Failure to start is
    # non-fatal — the routing service must keep serving even if the
    # sampler can't reach the orchestrator.
    if router_instance is not None:
        try:
            from scheduler import start_throughput_scheduler

            throughput_scheduler = start_throughput_scheduler(router_instance)
        except Exception as exc:  # noqa: BLE001 — non-fatal startup task
            logger.warning("throughput scheduler failed to start: %s", exc)

    # WARP-468: start the 60 s off-LAN egress counter. Non-fatal —
    # if the openwrt overlay hasn't dropped the nftables chains yet,
    # the meter logs once and emits zero samples until they appear.
    egress_meter_scheduler = None
    if router_instance is not None:
        try:
            from egress_meter import start_egress_meter

            egress_meter_scheduler = start_egress_meter(router_instance)
        except Exception as exc:  # noqa: BLE001 — non-fatal startup task
            logger.warning("off-LAN egress meter failed to start: %s", exc)

    # WARP-468: start the 60 s DNS-block meter. Non-fatal — until the
    # OpenWrt adblock/blocklist ubus method is pinned the meter logs
    # once and emits zero samples (read_counters_via_ubus fail-soft).
    dns_block_scheduler = None
    if router_instance is not None:
        try:
            from dns_block_meter import start_dns_block_meter

            dns_block_scheduler = start_dns_block_meter(router_instance)
        except Exception as exc:  # noqa: BLE001 — non-fatal startup task
            logger.warning("dns-block meter failed to start: %s", exc)

    yield

    if reconnect_scheduler is not None:
        try:
            reconnect_scheduler.shutdown(wait=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("reconnect scheduler shutdown failed: %s", exc)

    if throughput_scheduler is not None:
        try:
            throughput_scheduler.shutdown(wait=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("throughput scheduler shutdown failed: %s", exc)

    if egress_meter_scheduler is not None:
        try:
            egress_meter_scheduler.shutdown(wait=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("off-LAN egress meter shutdown failed: %s", exc)

    if dns_block_scheduler is not None:
        try:
            dns_block_scheduler.shutdown(wait=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("dns-block meter shutdown failed: %s", exc)

    if router_instance:
        router_instance.disconnect()
        logger.info("Disconnected from OpenWrt router")


class OperationTrackingMiddleware(BaseHTTPMiddleware):
    """Assign an operation id to every write (POST/PUT/DELETE) and surface it
    via `X-Operation-Id`. The dashboard polls `GET /operations/{id}` to track
    apply vs. rollback. See WARP-40.

    Skipped for:
      - GETs (reads don't change router state)
      - /operations/* (polling the tracker itself shouldn't create new records)
      - /health (exempt from auth + tracking for Docker healthchecks)
    """

    _TRACKED_METHODS = frozenset({"POST", "PUT", "DELETE"})
    _SKIP_PATH_PREFIXES = ("/operations", "/health")

    async def dispatch(self, request: Request, call_next):
        if request.method not in self._TRACKED_METHODS or any(
            request.url.path.startswith(p) for p in self._SKIP_PATH_PREFIXES
        ):
            return await call_next(request)

        op_id = operations.register()
        request.state.operation_id = op_id
        try:
            response = await call_next(request)
        except Exception as exc:
            operations.mark_rolled_back(op_id, f"handler raised: {exc.__class__.__name__}")
            raise

        # 2xx/3xx = router accepted the change.
        # 5xx     = upstream failure, conservatively mark as rolled back so the
        #           dashboard warns the user.
        # 4xx     = caller error (bad input, auth, etc.) — the request was
        #           refused before any router state change. Mark as `rejected`,
        #           NOT `applied`: recording a 401/422 as an applied router
        #           change masked auth/validation failures from operators.
        if 200 <= response.status_code < 400:
            operations.mark_applied(op_id)
        elif response.status_code >= 500:
            operations.mark_rolled_back(op_id, f"HTTP {response.status_code}")
        else:
            operations.mark_rejected(op_id, f"HTTP {response.status_code}")

        response.headers["X-Operation-Id"] = op_id
        return response


app = FastAPI(
    title="Droplet Routing Service",
    version="1.0.0",
    lifespan=lifespan,
    dependencies=[Depends(require_bearer)],
)
app.add_middleware(OperationTrackingMiddleware)
app.add_middleware(RequestIdMiddleware)


@app.exception_handler(Exception)
async def generic_exception_handler(request, exc):
    """Catch unhandled exceptions and return a clean 500 without leaking internals."""
    logger.error("Unhandled exception: %s", exc)
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
def _best_effort_topology() -> Optional[str]:
    """Return the explicit deployment-topology posture string, or None on any
    failure. WARP-826: `/health` carries the posture so the orchestrator can
    derive `routerConnected` from real reachability and distinguish a LAN-only
    single-box (WAN handled by the host → UNKNOWN) from an unreachable router.

    Strictly best-effort: the topology probe must NEVER turn a reachable router
    (board_info() already succeeded) into a failed /health. Any exception — a
    transient ubus fault, a genuine error, anything — degrades to None, leaving
    `connected` as the single source of truth for reachability.
    """
    if router_instance is None:
        return None
    try:
        # `posture` is a DeploymentTopology(str, Enum); use `.value` so the wire
        # value is the bare name ("UNKNOWN"), not "DeploymentTopology.UNKNOWN".
        return detect_deployment_topology(router_instance)["posture"].value
    except Exception:  # noqa: BLE001 — health must not 500 on a posture hiccup
        return None


@app.get("/health", response_model=HealthResponse)
def health():
    if router_instance is None:
        # WARP-1673: name the reason when we know it — an operator reading
        # /health should see "bad credentials" (fix the secret), not go
        # checking cables for a router that is answering fine.
        error = (
            _ROUTER_AUTH_DETAIL["message"]
            if _last_connect_failure == "auth"
            else "Router not connected at startup"
        )
        return HealthResponse(
            status="disconnected",
            connected=False,
            router_host=OPENWRT_HOST,
            error=error,
        )
    try:
        board = router_instance.system.board_info()
        return HealthResponse(
            status="ok",
            connected=True,
            router_host=OPENWRT_HOST,
            board=board,
            topology=_best_effort_topology(),
        )
    except (ConnectionLost, UbusError) as exc:
        return HealthResponse(
            status="error",
            connected=False,
            router_host=OPENWRT_HOST,
            error=str(exc),
        )


# ---------------------------------------------------------------------------
# Operations (WARP-40)
# ---------------------------------------------------------------------------
@app.get("/operations/{op_id}")
def get_operation(op_id: str):
    """Look up an in-flight or recently-finished operation.

    Records live for 5 minutes. After the TTL, returns 404 — the dashboard
    interprets this as "operation is too old to track" and falls back to
    polling the target resource directly.
    """
    op = operations.get(op_id)
    if op is None:
        raise HTTPException(status_code=404, detail="Operation not found or expired")
    return {
        "id": op.id,
        "state": op.state,
        "startedAt": op.started_at,
        "finishedAt": op.finished_at,
        "reason": op.reason,
    }


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
@app.get("/network/summary")
def network_summary():
    try:
        return get_network_summary(get_router())
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/network/summary/text")
def network_summary_text():
    try:
        return {"text": describe_network_for_llm(get_router())}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/network/topology")
def network_topology():
    """Report the explicit deployment-topology posture + the evidence behind it
    (ADR-018 Decision 2).

    Read-only: probes the WAN-facing interface for an upstream gateway by
    reusing the SDK's `get_all_interface_statuses()` shape-detection — it never
    mutates the router or the upstream network. Returns:

        {"posture": "PRIMARY_ROUTER" | "DOWNSTREAM_ROUTER" | "UNKNOWN",
         "evidence": {wan_interface, wan_present, wan_up, wan_device,
                      upstream_gateway_present, upstream_gateway}}

    The posture is an explicit enum value, never inferred from a null field
    (rule 10). A genuine ubus fault while probing propagates as an error (so the
    dashboard can tell "router unreachable / misconfigured" apart from a real
    posture) rather than being flattened to UNKNOWN.
    """
    try:
        return detect_deployment_topology(get_router())
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# Interfaces the dashboard / orchestrator are reached on. A create/edit that
# rewrites one of these can sever the management path (the single-box is reached
# on `lan`/`br-lan`; a multi-box adds `mgmt`), so the interface-write routes
# refuse it unless the caller passes `force` (the explicit extra-confirm). The
# set is env-configurable for non-default shapes (no host-specific hardcoding —
# NET-02), defaulting to the shipped `lan`,`mgmt`. Compared case-insensitively.
_MANAGEMENT_INTERFACES = frozenset(
    iface.strip().lower()
    for iface in os.environ.get("DROPLET_MGMT_INTERFACES", "lan,mgmt").split(",")
    if iface.strip()
)


def _is_management_interface(name: str) -> bool:
    return name.strip().lower() in _MANAGEMENT_INTERFACES


@app.get("/network/interfaces")
def network_interfaces():
    try:
        return get_router().network.get_all_interface_statuses()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# MUST precede /network/interfaces/{name} — otherwise "all" matches {name} and
# hits interface_status("all").
@app.get("/network/interfaces/all")
def network_interfaces_all():
    try:
        return {"interfaces": get_router().network.list_all_interfaces()}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/network/interfaces/{name}")
def network_interface_status(name: str):
    try:
        return get_router().network.interface_status(name)
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/network/interfaces/{name}/up")
def network_interface_up(name: str):
    try:
        get_router().network.interface_up(name)
        return {"status": "ok", "interface": name, "action": "up"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/network/interfaces/{name}/down")
def network_interface_down(name: str):
    try:
        get_router().network.interface_down(name)
        return {"status": "ok", "interface": name, "action": "down"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# Interface Add / Edit / Restart write path (KAN-10)
# ---------------------------------------------------------------------------
# Editing an interface is high blast radius — a wrong proto/address/zone can
# cut the dashboard's own connectivity. Every write here rides the same
# blast-radius-safety patterns the VPN/wireless writes use:
#
#   * the SDK create/edit stage uci changes inside `safe_apply(timeout=60)`, so a
#     change that severs the link auto-rolls-back after 60s;
#   * a write targeting the management interface is REFUSED with 409 unless the
#     caller passes `force` (the connectivity-self-cut guard);
#   * a `ConnectionLost` from safe_apply's rollback path surfaces as a 503 with
#     `rollback_pending`, exactly like `/aps/{mac}/approve`.
#
# RBAC (owner-only) + the Tier-2/3 confirm dispatch live one layer up in the
# orchestrator's `/api/network/*` routes; this service trusts a valid bearer.
_MANAGEMENT_REFUSAL = {
    "error": (
        "This is the interface this dashboard is reached on. Changing it can cut "
        "your own connection — confirm again to proceed."
    ),
    "code": "MANAGEMENT_INTERFACE",
}


@app.post("/network/interfaces")
def create_network_interface(req: CreateInterfaceRequest, request: Request):
    """Create (or overwrite) a `config interface` section under `safe_apply`."""
    if _is_management_interface(req.name) and not req.force:
        return JSONResponse(status_code=409, content=_MANAGEMENT_REFUSAL)
    try:
        r = get_router()
        r.network.create_interface(
            req.name,
            proto=req.proto,
            device=req.device,
            ipaddr=req.ipaddr,
            netmask=req.netmask,
            gateway=req.gateway,
        )
        return {
            "status": "ok",
            "name": req.name,
            "proto": req.proto,
            "operation_id": getattr(request.state, "operation_id", None),
        }
    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost creating the interface — rolling back",
                "detail": str(exc),
                "rollback_pending": True,
            },
        )
    except UbusError as exc:
        handle_router_error(exc)


@app.put("/network/interfaces/{name}")
def edit_network_interface(name: str, req: EditInterfaceRequest, request: Request):
    """Update only the supplied options on an existing interface, under `safe_apply`."""
    if _is_management_interface(name) and not req.force:
        return JSONResponse(status_code=409, content=_MANAGEMENT_REFUSAL)
    try:
        r = get_router()
        r.network.edit_interface(
            name,
            proto=req.proto,
            device=req.device,
            ipaddr=req.ipaddr,
            netmask=req.netmask,
            gateway=req.gateway,
        )
        return {
            "status": "ok",
            "name": name,
            "operation_id": getattr(request.state, "operation_id", None),
        }
    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost editing the interface — rolling back",
                "detail": str(exc),
                "rollback_pending": True,
            },
        )
    except UbusError as exc:
        handle_router_error(exc)


@app.post("/network/restart")
def restart_network(request: Request):
    """Restart the whole networking stack (ifdown/ifup of every interface).

    A blunt instrument — it briefly drops every interface — so the orchestrator
    gates it Tier-3 (web-UI-only, owner-only, confirm). The router-side `network
    restart` ubus call is fire-and-forget; the operation tracker records the
    apply outcome via the middleware.
    """
    try:
        get_router().network.restart()
        return {
            "status": "ok",
            "action": "network_restart",
            "operation_id": getattr(request.state, "operation_id", None),
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# Wireless
# ---------------------------------------------------------------------------
@app.get("/wireless/status")
def wireless_status():
    try:
        return get_router().wireless.status()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/wireless/scan")
def wireless_scan(device: Optional[str] = None):
    # device=None → SDK resolves DROPLET_WIFI_SCAN_DEVICE (last-resort wlan0).
    try:
        return {"results": get_router().wireless.scan(device)}
    except ScanUnsupportedError as exc:
        # WARP-816: the radio is in an AP/Master role and can't station-scan
        # (single-box `wlp14s0`). This is NOT a 200 `[]` (which the dashboard
        # reads as "no networks") and NOT a retryable 5xx — it's a stable,
        # terminal capability fact. Return 409 with a machine-readable `code`
        # so the orchestrator maps it to a typed RouterError and the dashboard
        # renders calm "scanning unavailable while broadcasting" copy.
        return JSONResponse(
            status_code=409,
            content={"code": exc.code, "message": str(exc), "device": exc.device},
        )
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/wireless/clients")
def wireless_clients(device: Optional[str] = None):
    # device=None → SDK resolves DROPLET_WIFI_SCAN_DEVICE (last-resort wlan0).
    try:
        return {"clients": get_router().wireless.connected_clients(device)}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/wireless/radio")
def wireless_radio_default():
    # No device segment → let the SDK resolve DROPLET_WIFI_SCAN_DEVICE so the
    # orchestrator can read the host AP radio without knowing its name. An absent
    # radio degrades to {} (radio_info contract), not a 500.
    try:
        return get_router().wireless.radio_info(None)
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/wireless/radio/{device}")
def wireless_radio_info(device: str = "wlan0"):
    try:
        return get_router().wireless.radio_info(device)
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/wireless/ssid")
def set_ssid(req: SetSsidRequest):
    try:
        r = get_router()
        r.wireless.set_ssid(req.radio, req.iface_section, req.ssid)
        r.apply_changes("wireless")
        return {"status": "ok", "ssid": req.ssid}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/wireless/password")
def set_password(req: SetPasswordRequest):
    try:
        r = get_router()
        r.wireless.set_password(req.iface_section, req.password, req.encryption)
        r.apply_changes("wireless")
        return {"status": "ok"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/wireless/channel")
def set_channel(req: SetChannelRequest):
    try:
        r = get_router()
        r.wireless.set_channel(req.radio_section, req.channel)
        r.apply_changes("wireless")
        return {"status": "ok", "channel": req.channel}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/wireless/guest")
def guest_status():
    try:
        return get_router().wireless.guest_status()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/wireless/guest")
def create_guest_network(req: CreateGuestNetworkRequest):
    try:
        r = get_router()
        r.wireless.create_guest_network(req.radio, req.ssid, req.password, req.network)
        r.apply_changes("wireless")
        return {"status": "ok", "ssid": req.ssid, "network": req.network}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.delete("/wireless/guest")
def remove_guest_network():
    try:
        r = get_router()
        r.wireless.remove_guest_network()
        r.apply_changes("wireless")
        return {"status": "ok"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# UPnP / NAT-PMP (miniupnpd)
# ---------------------------------------------------------------------------
@app.get("/upnp")
def upnp_status():
    # Reflective read of automatic port-opening state. Degrades to
    # {available: false, enabled: false} when miniupnpd isn't installed — the
    # secure default for a privacy appliance.
    try:
        return get_router().firewall.upnp_status()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/upnp")
def set_upnp(req: SetUpnpRequest):
    try:
        r = get_router()
        if not r.firewall.upnp_status().get("available"):
            # Never pretend to toggle a service that isn't on the box.
            return JSONResponse(
                status_code=422,
                content={
                    "code": "UPNP_UNAVAILABLE",
                    "message": "UPnP/NAT-PMP isn't installed on this Droplet — it never opens ports automatically.",
                },
            )
        r.firewall.set_upnp(req.enabled)
        return {"status": "ok", "enabled": req.enabled}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# DHCP
# ---------------------------------------------------------------------------
@app.get("/dhcp/leases")
def dhcp_leases():
    try:
        return {"leases": get_router().dhcp.active_leases()}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/dhcp/leases/v6")
def dhcp_leases_v6():
    try:
        return {"leases": get_router().dhcp.active_leases_v6()}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/dhcp/static-lease")
def add_static_lease(req: StaticLeaseRequest):
    try:
        r = get_router()
        r.dhcp.add_static_lease(req.name, req.mac, req.ip, req.leasetime)
        _commit_and_reload_dhcp(r)
        return {"status": "ok", "name": req.name, "mac": req.mac, "ip": req.ip}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/dhcp/pool")
def get_dhcp_pool():
    try:
        return get_router().dhcp.get_lan_pool()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/dhcp/pool")
def set_dhcp_pool(req: DhcpPoolRequest):
    try:
        r = get_router()
        r.dhcp.set_lan_pool(req.start, req.limit, req.leasetime)
        # Use uci.apply (via _commit_and_reload_dhcp) — the droplet-ai ACL
        # denies file.exec so exec_service("dnsmasq", "restart") raises
        # PERMISSION_DENIED, commits the UCI change but leaves dnsmasq
        # unsignaled. uci.apply is permitted and triggers the correct reload.
        _commit_and_reload_dhcp(r)
        return {
            "status": "ok",
            "start": req.start,
            "limit": req.limit,
            "leasetime": req.leasetime,
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/dhcp/dns")
def set_dns(req: SetDnsRequest):
    try:
        r = get_router()
        r.dhcp.set_dns_servers(req.servers)
        r.apply_changes("network")
        return {"status": "ok", "servers": req.servers}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# DNS hostname entries (dnsmasq static name → IP)
# ---------------------------------------------------------------------------
# Same grammar as schemas._HOSTNAME_PATTERN, compiled once for path validation.
_HOSTNAME_PATH_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"
)


@app.get("/dhcp/hostnames")
def list_dns_hostnames():
    try:
        return {"entries": get_router().dhcp.list_hostrecords()}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# Why this specific commit + reload path (WARP-987, root-caused live on the
# box 2026-07-01 and verified against rpcd source):
#   1. `uci.apply` commits the staged hostrecord delta and emits the procd
#      `config.change` event — but that trigger does NOT regenerate
#      /var/etc/dnsmasq.conf.* on the appliance container: records stayed
#      committed-but-unserved until a manual `/etc/init.d/dnsmasq restart`.
#      apply alone is commit, not reload.
#   2. `service.signal` with SIGHUP — permitted, but dnsmasq reads its config
#      from /var/etc/dnsmasq.conf.cfg*, which is *generated* from /etc/config/
#      dhcp by the init script at start/reload time. SIGHUP reloads hostnames
#      from /etc/hosts but NOT the UCI-derived host-records, so the change
#      would persist in UCI but never reach live DNS.
#   3. So after committing we explicitly rerun the init script via
#      `DHCPApi.reload()` (`file.exec` on `/etc/init.d/dnsmasq restart`).
#      The droplet-ai rpcd ACL pins exactly that command line — rpcd matches
#      the full path+args string, so this is NOT a blanket exec grant (see
#      openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json).
# Idempotency: a re-post of an already-committed record stages NOTHING —
# rpcd's `uci set` skips unchanged values server-side, and `uci apply` with
# zero pending deltas reports NO_DATA. That is "nothing to commit", not a
# fault: swallow it and still restart dnsmasq, which self-heals any earlier
# committed-but-unserved record. 500-ing on that NO_DATA is what broke
# existing-record re-posts on the box (WARP-987).
# rollback=False so apply doesn't start a rollback timer (there's nothing to
# rollback against — a bad DNS entry can't partition the router). timeout=5
# is well under the 30s default and keeps the HTTP response snappy.
def _commit_and_reload_dhcp(router) -> None:
    try:
        router.uci.apply(timeout=5, rollback=False)
    except UbusError as exc:
        if exc.code != UBUS_STATUS_NO_DATA:
            raise
    router.dhcp.reload()


@app.post("/dhcp/hostnames")
def upsert_dns_hostname(req: DnsHostnameRequest):
    try:
        r = get_router()
        result = r.dhcp.set_hostrecord(req.hostname, req.ip)
        _commit_and_reload_dhcp(r)
        return {"status": "ok", **result}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.delete("/dhcp/hostnames/{hostname}")
def delete_dns_hostname(hostname: str):
    if not _HOSTNAME_PATH_RE.fullmatch(hostname):
        raise HTTPException(status_code=400, detail="Invalid hostname")
    try:
        r = get_router()
        removed = r.dhcp.delete_hostrecord(hostname)
        if removed == 0:
            raise HTTPException(status_code=404, detail="Hostname not found")
        _commit_and_reload_dhcp(r)
        return {"status": "ok", "hostname": hostname, "removed": removed}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
@app.get("/firewall/zones", response_model=FirewallZoneCollection)
def firewall_zones() -> FirewallZoneCollection:
    # WARP-42: typed through the response model so schema drift becomes a
    # Pydantic validation error at the boundary instead of a silent break
    # in the dashboard.
    try:
        return FirewallZoneCollection.model_validate(get_router().firewall.get_zones())
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/firewall/rules", response_model=FirewallRuleCollection)
def firewall_rules() -> FirewallRuleCollection:
    try:
        return FirewallRuleCollection.model_validate(get_router().firewall.get_rules())
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/firewall/redirects", response_model=FirewallRedirectCollection)
def firewall_redirects() -> FirewallRedirectCollection:
    try:
        return FirewallRedirectCollection.model_validate(get_router().firewall.get_redirects())
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/firewall/block-device")
def block_device(req: BlockDeviceRequest):
    try:
        get_router().firewall.block_device(req.mac, req.name)
        return {"status": "ok", "mac": req.mac, "action": "blocked"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/firewall/unblock-device")
def unblock_device(req: UnblockDeviceRequest):
    try:
        get_router().firewall.unblock_device(req.mac)
        return {"status": "ok", "mac": req.mac, "action": "unblocked"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/firewall/port-forward")
def add_port_forward(req: PortForwardRequest):
    try:
        get_router().firewall.add_port_forward(
            req.name, req.src_port, req.dest_ip, req.dest_port, req.proto,
        )
        return {"status": "ok", "name": req.name}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/firewall/rule")
def add_firewall_rule(req: AddFirewallRuleRequest):
    try:
        get_router().firewall.add_rule(
            req.name, req.src, req.dest, req.proto, req.dest_port,
            req.target, req.src_port, req.enabled,
        )
        return {"status": "ok", "name": req.name}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/firewall/zone-policy")
def set_zone_policy(req: SetZonePolicyRequest):
    try:
        get_router().firewall.set_zone_policy(
            req.zone, req.input, req.output, req.forward,
        )
        return {"status": "ok", "zone": req.zone}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# WARP-613: phone-home egress control (see ADR-012).
@app.post("/firewall/phone-home/device")
def set_device_phone_home(req: PhoneHomeDeviceRequest):
    try:
        fw = get_router().firewall
        if req.blocked:
            fw.block_phone_home(req.mac)
        else:
            fw.unblock_phone_home(req.mac)
        return {"status": "ok", "mac": req.mac, "blocked": req.blocked}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/firewall/phone-home/cameras")
def set_cameras_phone_home(req: PhoneHomeCamerasRequest):
    # The camera zone toggle only affects the camera VLAN's WAN egress — it
    # cannot sever the orchestrator's (LAN/mgmt-side) management path, so it
    # commits+reloads directly like block_device rather than wrapping in
    # safe_apply (which would conflict with the SDK method's own commit/reload).
    try:
        get_router().firewall.set_camera_phone_home(req.blocked)
        return {"status": "ok", "scope": "cameras", "blocked": req.blocked}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# VLANs / Camera Subnet
# ---------------------------------------------------------------------------
@app.get("/network/vlans")
def list_vlans():
    """List all configured VLANs by scanning UCI network config for VLAN interfaces."""
    try:
        r = get_router()
        # Get all network interfaces and filter for VLAN devices (contain '.')
        config = r.uci.get("network")
        vlans = []
        if isinstance(config, dict):
            for name, section in config.items():
                if isinstance(section, dict):
                    device = section.get("device", "")
                    if "." in str(device) and section.get("proto") == "static":
                        vlans.append({
                            "name": name,
                            "device": device,
                            "ipaddr": section.get("ipaddr"),
                            "netmask": section.get("netmask"),
                            "proto": section.get("proto"),
                        })
        return {"vlans": vlans}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/network/vlans")
def create_vlan(req: CreateVlanRequest):
    """Create a new VLAN interface."""
    try:
        r = get_router()
        r.network.add_vlan(
            name=req.name,
            vid=req.vid,
            parent_device=req.parent_device,
            ipaddr=req.ipaddr,
            netmask=req.netmask,
        )
        r.apply_changes("network")
        return {"status": "ok", "name": req.name, "vid": req.vid, "ipaddr": req.ipaddr}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/network/subnets/cameras")
def get_camera_subnet():
    """Get camera subnet configuration status.

    NET-13: distinguish "camera subnet legitimately not configured" from a
    genuine router fault. Only a ubus NOT_FOUND/NO_DATA on the `cameras`
    section means "not configured" → `{"enabled": False}`. Any other
    UbusError (e.g. PERMISSION_DENIED, METHOD_NOT_FOUND) and every
    ConnectionLost propagate to `handle_router_error`, so the dashboard
    can tell "no camera subnet" apart from "router unreachable / token
    wrong" instead of mis-rendering both as not-configured. Mirrors the
    `interface_exists` discipline.
    """
    try:
        r = get_router()
        # Check if the cameras interface exists. A NOT_FOUND/NO_DATA here is
        # the only signal that means "not configured"; let anything else
        # bubble to the outer (ConnectionLost, UbusError) handler.
        try:
            iface = r.uci.get("network", "cameras")
        except UbusError as exc:
            if exc.code in (UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA):
                return {"enabled": False}
            raise
        # An empty/non-dict section also means the interface isn't set up.
        if not isinstance(iface, dict) or not iface:
            return {"enabled": False}

        zone = None
        # Find the cameras firewall zone
        fw_config = r.uci.get("firewall")
        if isinstance(fw_config, dict):
            for name, section in fw_config.items():
                if isinstance(section, dict) and section.get("name") == "cameras":
                    zone = section
                    break
        # Check DHCP pool. A missing pool (NOT_FOUND/NO_DATA) is benign —
        # the subnet can exist without a DHCP section — so swallow only
        # that class; a real fault still propagates.
        dhcp_pool = None
        try:
            dhcp_pool = r.uci.get("dhcp", "cameras")
        except UbusError as exc:
            if exc.code not in (UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA):
                raise

        return {
            "enabled": True,
            "interface": iface,
            "firewall_zone": zone,
            "dhcp_pool": dhcp_pool if isinstance(dhcp_pool, dict) else None,
            "subnet": iface.get("ipaddr", "192.168.100.1"),
            "netmask": iface.get("netmask", "255.255.255.0"),
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/network/subnets/cameras/setup")
def setup_camera_subnet(req: CameraSubnetSetupRequest):
    """One-click camera subnet setup: VLAN + firewall zone + DHCP + isolation rules.

    Uses safe-apply with automatic rollback on connectivity loss.
    Future: This endpoint abstracts the implementation so it can switch
    from software VLANs to ASIC hardware VLANs without API changes.
    """
    try:
        r = get_router()

        with r.safe_apply(timeout=60):
            # 1. Create VLAN interface
            device_name = f"br-lan.{req.vlan_id}"
            r.uci.set("network", "cameras", {
                "proto": "static",
                "device": device_name,
                "ipaddr": req.subnet,
                "netmask": req.netmask,
            })

            # 2. Create bridge-vlan entry
            r.uci.add("network", "bridge-vlan", {
                "device": "br-lan",
                "vlan": str(req.vlan_id),
                "ports": "eth1:t",
            })
            r.uci.commit("network")

            # 3. Create firewall zone (isolated: REJECT input, REJECT forward)
            r.uci.add("firewall", "zone", {
                "name": "cameras",
                "network": "cameras",
                "input": "REJECT",
                "output": "ACCEPT",
                "forward": "REJECT",
            })

            # 4. Allow LAN (Droplet) → cameras (for RTSP/ONVIF access)
            r.uci.add("firewall", "forwarding", {
                "src": "lan",
                "dest": "cameras",
            })

            # 5. Allow cameras → WAN (NTP, DNS, firmware updates)
            r.uci.add("firewall", "forwarding", {
                "src": "cameras",
                "dest": "wan",
            })

            # 6. Allow camera DHCP and DNS to router
            r.uci.add("firewall", "rule", {
                "name": "Allow-Camera-DHCP",
                "src": "cameras",
                "proto": "udp",
                "dest_port": "67-68",
                "target": "ACCEPT",
            })
            r.uci.add("firewall", "rule", {
                "name": "Allow-Camera-DNS",
                "src": "cameras",
                "proto": "tcpudp",
                "dest_port": "53",
                "target": "ACCEPT",
            })
            r.uci.commit("firewall")

            # 7. Create DHCP pool for camera subnet
            r.uci.set("dhcp", "cameras", {
                "interface": "cameras",
                "start": str(req.dhcp_start),
                "limit": str(req.dhcp_limit),
                "leasetime": req.leasetime,
            })
            r.uci.commit("dhcp")

        return {
            "status": "ok",
            "vlan_id": req.vlan_id,
            "subnet": req.subnet,
            "netmask": req.netmask,
            "dhcp_range": f"{req.subnet.rsplit('.', 1)[0]}.{req.dhcp_start} - .{req.dhcp_start + req.dhcp_limit - 1}",
            "firewall": "cameras zone created with LAN→cameras and cameras→WAN forwarding",
        }

    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost during camera subnet setup — rolling back",
                "detail": str(exc),
                "rollback_pending": True,
            },
        )
    except (UbusError) as exc:
        handle_router_error(exc)


@app.delete("/network/subnets/cameras")
def teardown_camera_subnet():
    """Remove the camera subnet (VLAN, firewall zone, DHCP pool)."""
    try:
        r = get_router()

        with r.safe_apply(timeout=60):
            # Remove network interface
            try:
                r.uci.delete("network", "cameras")
                r.uci.commit("network")
            except Exception:
                pass

            # Remove firewall zone and rules related to cameras
            fw_config = r.uci.get("firewall")
            if isinstance(fw_config, dict):
                to_delete = []
                for name, section in fw_config.items():
                    if not isinstance(section, dict):
                        continue
                    # Delete cameras zone
                    if section.get("name") == "cameras" and section.get(".type") == "zone":
                        to_delete.append(name)
                    # Delete forwarding rules involving cameras
                    if section.get(".type") == "forwarding":
                        if section.get("src") == "cameras" or section.get("dest") == "cameras":
                            to_delete.append(name)
                    # Delete camera-specific rules
                    if section.get(".type") == "rule":
                        rule_name = section.get("name", "")
                        if "Camera" in rule_name and section.get("src") == "cameras":
                            to_delete.append(name)

                for name in to_delete:
                    try:
                        r.uci.delete("firewall", name)
                    except Exception:
                        pass
                r.uci.commit("firewall")

            # Remove DHCP pool
            try:
                r.uci.delete("dhcp", "cameras")
                r.uci.commit("dhcp")
            except Exception:
                pass

        return {"status": "ok", "action": "camera_subnet_removed"}

    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={"error": "Connectivity lost during teardown", "detail": str(exc)},
        )
    except (UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# VPN (WireGuard)
# ---------------------------------------------------------------------------
#
# Phase 1 of the Remote Access feature. These endpoints wrap VPNApi from the
# OpenWrt SDK and are consumed by the orchestrator (`/api/vpn/peers`), which
# layers user identity + IP allocation + QR rendering on top. Nothing here
# knows about Nextcloud users — peers are anonymous from the router's POV.
#
# Setup is idempotent: calling /vpn/setup twice is fine and just returns the
# existing interface info on the second call. This means the orchestrator can
# treat "ensure VPN is configured" as a single request without coordination.
#
# Server priv keys live in /etc/config/network (uci) — that's how OpenWrt's
# native luci-proto-wireguard stores them. Client priv keys are returned ONCE
# in the /vpn/peers POST response and never persisted server-side.


@app.post("/vpn/setup")
def vpn_setup(req: VpnSetupRequest):
    """Idempotently bring up the WireGuard server interface + firewall.

    First call: generates a fresh server keypair, creates the wg interface,
    opens the listen port on WAN, allows VPN→LAN forwarding.
    Subsequent calls: returns the existing interface info untouched.
    """
    try:
        r = get_router()

        if r.vpn.interface_exists(req.interface):
            info = r.vpn.get_interface_info(req.interface)
            return {"status": "ok", "created": False, **info}

        # Wrap in safe_apply so a misconfigured firewall change can't lock
        # the orchestrator out of the router. 60s timeout matches /config/apply.
        with r.safe_apply(timeout=60):
            private_key, _public_key = r.vpn.generate_keypair()
            r.vpn.create_interface(
                req.interface,
                private_key=private_key,
                listen_port=req.listen_port,
                address=req.address,
            )
            r.vpn.setup_firewall(req.interface, listen_port=req.listen_port)

        # OpenWrt 24.10 has an ordering quirk: when both `network` and
        # `firewall` are committed by the same `uci.apply`, the iface ifup
        # hotplug fires `firewall reload` *during* network reload, before
        # the new firewall config has fully landed for fw4. ucitrack does
        # not always re-fire firewall reload afterward. The narrow fix is
        # to send a `config.change` service event ourselves once apply has
        # settled, which is exactly what `/sbin/reload_config` does.
        try:
            r._call("service", "event", {
                "type": "config.change",
                "data": {"package": "firewall"},
            })
        except (ConnectionLost, UbusError) as exc:
            logger.warning("vpn: firewall reload nudge failed (rule may need manual reload): %s", exc)

        info = r.vpn.get_interface_info(req.interface)
        return {"status": "ok", "created": True, **info}

    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost during VPN setup — rolling back",
                "detail": str(exc),
                "rollback_pending": True,
            },
        )
    except UbusError as exc:
        handle_router_error(exc)


@app.get("/vpn/status")
def vpn_status(interface: str = "wg0"):
    """Return server-side info for a WireGuard interface.

    404 when the interface hasn't been bootstrapped yet — the dashboard uses
    that as the cue to show the "Set up Remote Access" prompt.
    """
    try:
        r = get_router()
        if not r.vpn.interface_exists(interface):
            raise HTTPException(status_code=404, detail=f"VPN interface '{interface}' not configured")
        info = r.vpn.get_interface_info(interface)
        peers = r.vpn.list_peers(interface)
        return {**info, "peer_count": len(peers)}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/vpn/peers")
def vpn_list_peers(interface: str = "wg0"):
    """List peers configured on the interface. Empty list if none.

    WARP-1389: when runtime handshake data is AVAILABLE, each peer gets
    `latest_handshake` (epoch secs; a real 0 = the peer exists but never
    handshook). When it is UNAVAILABLE (ubus read failed / no peer data), the
    field is OMITTED entirely — UNKNOWN must stay distinct from an observed 0, or
    the orchestrator sweep would score every torn-down peer as a failed punch and
    report a false 0% success rate. Never fails the list.
    """
    try:
        r = get_router()
        if not r.vpn.interface_exists(interface):
            raise HTTPException(status_code=404, detail=f"VPN interface '{interface}' not configured")
        peers = r.vpn.list_peers(interface)
        try:
            hs = r.vpn.peer_handshakes(interface)  # dict = available, None = UNKNOWN
        except Exception:  # noqa: BLE001 — telemetry enrichment never fails the list
            hs = None
        if isinstance(hs, dict):
            # Read succeeded: every peer gets a value (0 = observed never-handshook).
            for p in peers:
                p["latest_handshake"] = int(hs.get(p.get("public_key", ""), 0) or 0)
        # else UNKNOWN: leave `latest_handshake` ABSENT on every peer.
        return {"interface": interface, "peers": peers}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/vpn/peers")
def vpn_create_peer(req: VpnPeerCreateRequest):
    """Mint a peer: generate a keypair, install the pubkey on the router,
    return the priv key + pubkey to the caller.

    The returned `private_key` is one-shot: it's never stored server-side and
    cannot be re-fetched. If the user loses their config they revoke + re-mint.
    """
    try:
        r = get_router()
        if not r.vpn.interface_exists(req.interface):
            raise HTTPException(
                status_code=409,
                detail=f"VPN interface '{req.interface}' not configured — POST /vpn/setup first",
            )

        private_key, public_key = r.vpn.generate_keypair()
        # uci stores allowed_ips as a single comma-joined string.
        allowed_ips_uci = ",".join(req.allowed_ips)
        r.vpn.add_peer(
            interface=req.interface,
            public_key=public_key,
            allowed_ips=allowed_ips_uci,
            description=req.description,
            persistent_keepalive=req.persistent_keepalive,
        )

        # Bring the new peer online without a full network restart by reloading
        # the wg interface. apply (without rollback timer) is the same path used
        # by the DNS hostnames endpoint — it triggers ucitrack -> wg reload.
        try:
            r.uci.apply(timeout=5, rollback=False)
        except Exception as exc:  # noqa: BLE001 — apply failure shouldn't fail the request
            logger.warning("vpn: uci.apply after add_peer failed (peer is staged): %s", exc)

        return {
            "status": "ok",
            "interface": req.interface,
            "public_key": public_key,
            "private_key": private_key,
            "allowed_ips": list(req.allowed_ips),
            "description": req.description,
            "persistent_keepalive": req.persistent_keepalive,
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/vpn/peers/overlay")
def vpn_install_overlay_peer(req: VpnOverlayPeerRequest):
    """WARP-1385 (ADR-030) — install/refresh a direct-punch overlay peer.

    The phone brings its OWN key (enrolled via HQ), so unlike POST /vpn/peers
    this installs the caller-supplied `public_key` with the phone's observed
    `endpoint` + a keepalive — WireGuard's own initiations from that endpoint
    are the box side of the NAT hole-punch. Idempotent: any prior section for
    the same public_key is removed first, so a re-connect just refreshes the
    endpoint. Never generates or returns a private key.
    """
    try:
        r = get_router()
        if not r.vpn.interface_exists(req.interface):
            raise HTTPException(
                status_code=409,
                detail=f"VPN interface '{req.interface}' not configured — POST /vpn/setup first",
            )
        # Refresh semantics: drop any existing section for this key before adding
        # so the endpoint/allowed-ips update cleanly (add_peer would otherwise
        # append a duplicate section).
        r.vpn.delete_peer(req.interface, req.public_key)
        allowed_ips_uci = ",".join(req.allowed_ips)
        r.vpn.add_peer(
            interface=req.interface,
            public_key=req.public_key,
            allowed_ips=allowed_ips_uci,
            description=req.description,
            endpoint=req.endpoint,
            persistent_keepalive=req.persistent_keepalive,
        )
        try:
            r.uci.apply(timeout=5, rollback=False)
        except Exception as exc:  # noqa: BLE001 — apply failure shouldn't fail the request
            logger.warning("vpn: uci.apply after overlay add_peer failed (peer is staged): %s", exc)

        return {
            "status": "ok",
            "interface": req.interface,
            "public_key": req.public_key,
            "endpoint": req.endpoint,
            "allowed_ips": list(req.allowed_ips),
            "persistent_keepalive": req.persistent_keepalive,
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.delete("/vpn/peers")
def vpn_delete_peer(req: VpnPeerDeleteRequest):
    """Remove every peer matching `public_key` from `interface`.

    404 when there's nothing to remove — the orchestrator treats that as a
    success-equivalent (peer already gone). Multiple matches are deleted in
    one shot; the response carries the count.
    """
    try:
        r = get_router()
        if not r.vpn.interface_exists(req.interface):
            raise HTTPException(status_code=404, detail=f"VPN interface '{req.interface}' not configured")
        removed = r.vpn.delete_peer(req.interface, req.public_key)
        if removed == 0:
            raise HTTPException(status_code=404, detail="Peer not found")
        try:
            r.uci.apply(timeout=5, rollback=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("vpn: uci.apply after delete_peer failed: %s", exc)
        return {"status": "ok", "interface": req.interface, "removed": removed}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------
@app.get("/system/info")
def system_info():
    try:
        r = get_router()
        return {
            "board": r.system.board_info(),
            "resources": r.system.resource_info(),
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/system/reboot")
def system_reboot():
    try:
        get_router().system.reboot()
        return {"status": "ok", "action": "reboot"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# Deployment-shape discriminator (single-box = hostapd). The orchestrator
# applies the AUTHORITATIVE honest gate at its service layer (mirroring the
# guest-wifi/UPnP gate); routing's controls() default just keeps the read
# honest if the orchestrator ever calls it directly.
_AP_MODE = os.environ.get("DROPLET_AP_MODE", "uci").strip().lower()


@app.get("/system/controls")
def system_controls():
    try:
        return get_router().system.controls(ap_mode=_AP_MODE)
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/system/hostname")
def set_system_hostname(req: HostnameRequest):
    try:
        r = get_router()
        r.system.set_hostname(req.hostname)
        # system uci changes are picked up by hostname/dnsmasq services on
        # commit; no reboot needed. The hostname write already commits.
        return {"status": "ok", "hostname": req.hostname}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/system/ntp")
def set_system_ntp(req: NtpRequest):
    try:
        r = get_router()
        r.system.set_ntp_enabled(req.enabled)
        return {"status": "ok", "enabled": req.enabled}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# KAN-8 — router firmware upgrade + factory-reset (multi-box / PRIMARY_ROUTER)
# ---------------------------------------------------------------------------
# These are the SDK's HTTP face for the BRICK-RISK upgrade-router.sh semantics.
# The AUTHORITATIVE gates — owner-only, Tier-3 confirm, AND refusal on any
# non-PRIMARY_ROUTER deployment shape (the shipping single-box, where a wipe
# destroys the host hostapd bridge's UCI with no remote recovery) — live in the
# orchestrator ABOVE this layer. The routing service never enforces RBAC and is
# bound to the LAN behind the orchestrator; the firmware-check read is safe on
# any shape, the two writes must only ever be reached through the gated
# orchestrator route.


@app.get("/system/firmware-check")
def system_firmware_check(
    pinned_image: str = Query(
        ..., min_length=1, max_length=512,
        description="Pinned sysupgrade image name to compare the running release against",
    ),
):
    """Read-only firmware version compare (KAN-8 AC 4). No flash, safe anywhere."""
    try:
        return get_router().system.firmware_version_check(pinned_image)
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/system/sysupgrade")
def system_sysupgrade(req: SysupgradeRequest):
    """Flash a staged OpenWrt sysupgrade image. ⚠️ BRICK RISK — gated upstream."""
    try:
        return get_router().system.sysupgrade(req.image_path, req.preserve_config)
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/system/factory-reset")
def system_factory_reset():
    """Wipe the OpenWrt overlay + reboot to defaults. ⚠️ BRICK RISK — gated upstream."""
    try:
        return get_router().system.factory_reset()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# droplet-ai ubus RPC scopes (read-only)
# ---------------------------------------------------------------------------
# The canonical ACL lives at this path on the box; the routing service reads it
# via file.read (the droplet-ai ACL grants file.read) so the surfaced scopes
# reflect on-box truth. The bundled fallback below mirrors
# openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json so the card still renders
# read-only truth if the file read is denied or the box is briefly unreachable.
_AI_ACL_PATH = "/usr/share/rpcd/acl.d/droplet-ai.json"
_AI_ACL_FALLBACK = {
    "droplet-ai": {
        "read": {
            "ubus": {
                "system": ["board", "info"],
                "network.interface.*": ["status", "dump"],
                "network.device": ["status"],
                "network.wireless": ["status"],
                "iwinfo": ["info", "scan", "assoclist", "freqlist", "countrylist", "phyname"],
                "dhcp": ["ipv4leases", "ipv6leases"],
                "uci": ["get", "state", "configs"],
                "file": ["read", "list", "stat"],
                "service": ["list"],
                "session": ["access", "list"],
                "hostapd.*": ["get_clients", "get_status"],
                "luci-rpc": [
                    "getBoardJSON", "getNetworkDevices", "getWirelessDevices",
                    "getDHCPLeases", "getHostHints",
                ],
                "umdns": ["browse", "update"],
            },
            # The `ubus` grant above only opens the `file` OBJECT. rpcd applies
            # a SECOND, path-level check for file.read/list/stat, so without
            # this scope `/ai-access` silently falls back to the bundled ACL
            # instead of reflecting on-box truth. Pinned to the ACL itself —
            # the only path the routing service ever reads. Verified on the Pi
            # edge router: without it, file.read returns ubus status 6.
            "file": {
                _AI_ACL_PATH: ["read"],
            },
        },
        "write": {
            "ubus": {
                "network": ["restart"],
                "network.interface.*": ["up", "down"],
                "network.wireless": ["up", "down", "reconf", "notify"],
                "uci": [
                    "set", "add", "delete", "rename", "reorder", "commit",
                    "apply", "confirm", "rollback", "changes", "revert",
                ],
                "system": ["reboot"],
                "service": ["set", "delete", "signal", "event"],
                "session": ["login", "destroy"],
                "hostapd.*": ["del_client"],
                "wireguard": ["*"],
                "file": ["exec"],
            },
            # WARP-987: exec is PINNED to the dnsmasq restart command line —
            # rpcd matches the full path+args string against this `file`
            # scope, so nothing else is executable. Keep in lockstep with the
            # canonical ACL (test_ai_access.py enforces ubus-scope parity).
            "file": {
                "/etc/init.d/dnsmasq restart": ["exec"],
            },
        },
    }
}


@app.get("/ai-access")
def ai_access():
    try:
        r = get_router()
        # Read the live on-box ACL so the chips reflect on-box truth; fall back
        # to the bundled canonical ACL on any read failure (denied grant, parse
        # error, brief unreachability) so the card still renders read-only truth.
        acl = _AI_ACL_FALLBACK
        try:
            raw = r.file.read(_AI_ACL_PATH)
            parsed = json.loads(raw)
            if isinstance(parsed, dict) and parsed.get("droplet-ai"):
                acl = parsed
        except (UbusError, ConnectionLost, ValueError, json.JSONDecodeError):
            pass

        scopes = parse_ai_acl_scopes(acl)
        # Touch session_token to trigger ensure_valid() so the active flag in
        # session_info() reflects reality even when file.read above failed
        # before the session was established (e.g. cold-start PERMISSION_DENIED).
        try:
            _ = r.session_token
        except (ConnectionLost, UbusError):
            pass
        session = r.session_info()
        # The endpoint reflects the live connection target (the in-container
        # OpenWrt's /ubus), NOT the legacy multi-box 192.168.50.1.
        endpoint = f"http://{OPENWRT_HOST}:{OPENWRT_PORT}/ubus"
        return {
            "user": session.get("username", OPENWRT_USERNAME),
            "endpoint": endpoint,
            "read_scopes": scopes["read"],
            "write_scopes": scopes["write"],
            "session": {
                "active": session.get("active", False),
                "expires_at": session.get("expires_at"),
                "rotates": "hourly",
            },
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# Config apply (safe-apply with rollback)
# ---------------------------------------------------------------------------
@app.post("/config/apply")
def apply_config(req: ApplyConfigRequest):
    try:
        r = get_router()
        with r.safe_apply(timeout=req.timeout):
            for config in req.configs:
                r.uci.commit(config)
        return {"status": "ok", "configs": req.configs, "confirmed": True}
    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost after apply",
                "detail": str(exc),
                "rollback_pending": True,
                "timeout": req.timeout,
            },
        )
    except UbusError as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# Coverage extender APs (WARP-446)
# ---------------------------------------------------------------------------
#
# Per ADR-005. The discovery list itself is owned by the orchestrator's
# mDNS poller; the routing service only sees an already-discovered MAC
# and pushes a wireless config to it. In mock mode the in-memory
# `_MockAp` mirrors the contract — production wires the same shape
# against the real router.
#
# Auth: same Bearer-token + safe_apply discipline as the rest of the
# service. RBAC (which session is allowed to call) lives one layer up
# in the orchestrator's `/api/aps/*` routes.


# Canonical MAC for path-param validation. Lowercase + uppercase
# hex are both accepted; the SDK normalises to uppercase at the boundary.
_MAC_PATH_RE = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")


def _validate_mac(mac: str) -> str:
    if not _MAC_PATH_RE.fullmatch(mac):
        raise HTTPException(status_code=404, detail="Invalid MAC")
    return mac.upper()


def _get_ap_namespace(router):
    """Return the AP namespace from a router, supporting both real and mock.

    The real `DropletRouter.ap` is an `ApApi` instance whose contract is
    "push/remove wireless config + iface_section helpers". The mock's
    `_MockAp` adds the in-memory discovery list on top. Endpoints below
    branch on `hasattr(.., "discovered")` because the real production
    discovery story is orchestrator-side (mDNS poller), not router-side.
    """
    return router.ap


def _router_has_ap_radios(router) -> bool:
    """False only when the router POSITIVELY reports zero wireless radios
    (`network.wireless status` → {} — the radio-less Pi edge router). Any
    probe failure fails OPEN to True so the historical router-side staging
    path is never skipped on a transient read error."""
    try:
        wireless = getattr(router, "wireless", None)
        if wireless is None or not hasattr(wireless, "status"):
            return True
        return bool(wireless.status())
    except (ConnectionLost, UbusError):
        return True


def _mac_key(mac: str) -> str:
    return mac.replace(":", "").replace("-", "").strip().lower()


def _discovered_ap_ip(ap, canonical: str) -> Optional[str]:
    """The AP's last-seen address from the discovery layer (mock `get`, real
    umdns browse). None when the AP isn't currently visible."""
    if hasattr(ap, "get"):
        info = ap.get(canonical)
        if isinstance(info, dict) and info.get("last_ip"):
            return info["last_ip"]
    if hasattr(ap, "browse_discovered"):
        try:
            records = ap.browse_discovered()
        except (ConnectionLost, UbusError):
            return None
        for rec in records:
            if _mac_key(str(rec.get("mac", ""))) == _mac_key(canonical) and rec.get("last_ip"):
                return rec["last_ip"]
    return None


def _connect_ap(host: str):
    """Dial the EXTERNAL AP's rpcd as `droplet-ai` (AP_* config above).

    Single construction point for every AP-direct call (`_push_ap_wireless`,
    band steering) so the credential/port wiring can't drift between them.
    Raises ConnectionLost / UbusError for the caller to classify.
    """
    return DropletRouter(
        host=host,
        port=AP_PORT,
        username=AP_USERNAME,
        password=AP_PASSWORD,
        auto_login=True,
    )


def _push_ap_wireless(
    host: str,
    *,
    enable: bool,
    ssid: Optional[str] = None,
    encryption: Optional[str] = None,
    key: Optional[str] = None,
) -> None:
    """Configure the EXTERNAL AP's own wifi-iface sections over ITS rpcd.

    WARP-1675 — this is the layer schema.prisma's `ApDevice.lastIp` comment
    always promised. Connects to the AP as `droplet-ai` (AP_* config above),
    sets ssid/encryption/key (when supplied) + the disabled flag on every
    `wifi-iface` section the AP carries, and applies under the AP's own
    safe_apply so a push that breaks the AP's management path auto-rolls back.
    Raises ConnectionLost / UbusError for the caller to classify.
    """
    dev = _connect_ap(host)
    envelope = dev.uci.get("wireless", type="wifi-iface") or {}
    sections = envelope.get("values", {}) if isinstance(envelope, dict) else {}
    values: dict[str, str] = {"disabled": "0" if enable else "1"}
    if ssid is not None:
        values["ssid"] = ssid
    if encryption is not None:
        values["encryption"] = encryption
    if key is not None:
        values["key"] = key
    if not sections:
        raise UbusError(-1, f"AP at {host} reports no wifi-iface sections to configure")
    with dev.safe_apply(timeout=60):
        for section_id in sections:
            dev.uci.set("wireless", section_id, values)


def _classify_ap_push_error(exc: Exception, host: str) -> HTTPException:
    """Typed 502s for an AP-direct push failure — mirrors the WARP-1673
    status-only discipline. Credential rejections are recognised both as
    UbusError(6) at login (current SDK) and by the LoginDenied marker
    (`code == "ROUTER_AUTH"`, WARP-1673) so either merge order behaves."""
    is_auth = (isinstance(exc, UbusError) and exc.code == 6) or (
        getattr(exc, "code", None) == "ROUTER_AUTH"
    )
    if is_auth:
        return HTTPException(status_code=502, detail={
            "code": "AP_AUTH",
            "message": (
                f"The AP at {host} rejected the droplet-ai credentials — its "
                "per-unit password has likely rotated (reflash). Re-sync "
                "docker/secrets/ap_openwrt_password and retry the approval."
            ),
        })
    return HTTPException(status_code=502, detail={
        "code": "AP_UNREACHABLE",
        "message": (
            f"Could not configure the AP at {host} over rpcd: {exc}. The "
            "approval is retryable once the AP is reachable."
        ),
    })


# WARP-1703 — the AP image's band-steering master switch (droplet-edge-router
# PR #5): uci `droplet.wifi.band_steering` ('1'/'0', default '1'). Committing
# the option fires the AP's own procd reload trigger, which unifies/splits the
# SSIDs and starts/stops dawn — the routing service never touches the AP's
# wireless sections on this path. The droplet-ai ACL grants uci read/write on
# the 'droplet' config, so no extra privileges are needed.
_AP_BAND_STEERING_CONFIG = "droplet"
_AP_BAND_STEERING_SECTION = "wifi"
_AP_BAND_STEERING_OPTION = "band_steering"


def _get_band_steering_value(dev) -> Optional[bool]:
    """Read `droplet.wifi.band_steering` off an already-connected AP device.

    None = the AP image doesn't carry the droplet.wifi substrate (an image
    that predates droplet-edge-router PR #5) — honest "unsupported", never an
    error. ubus code 4 (NOT_FOUND) / 5 (NO_DATA) mean the config or section is
    missing; any other UbusError propagates for the caller to classify.
    """
    try:
        envelope = dev.uci.get(
            _AP_BAND_STEERING_CONFIG, section=_AP_BAND_STEERING_SECTION
        )
    except UbusError as exc:
        if exc.code in (4, 5):
            return None
        raise
    values = envelope.get("values", {}) if isinstance(envelope, dict) else {}
    if not isinstance(values, dict) or not values:
        return None
    # The substrate default is ON — an unset option means steering is active.
    return str(values.get(_AP_BAND_STEERING_OPTION, "1")) == "1"


def _read_ap_band_steering(host: str) -> Optional[bool]:
    """Dial the AP and read its band-steering state. None = unsupported."""
    return _get_band_steering_value(_connect_ap(host))


def _write_ap_band_steering(host: str, enabled: bool) -> bool:
    """Dial the AP and set `droplet.wifi.band_steering`.

    Returns False (without writing) when the AP image doesn't carry the
    substrate — the caller surfaces the honest 422. The write runs under the
    AP's own safe_apply: set + apply(rollback) + connectivity probe + confirm,
    so a commit that somehow breaks the AP's management path auto-rolls back.
    The apply also commits the staged option, which is what fires the AP's
    procd reload trigger (set+commit is the substrate contract; apply's
    rollback arm is belt-and-braces on top).
    """
    dev = _connect_ap(host)
    if _get_band_steering_value(dev) is None:
        return False
    with dev.safe_apply(timeout=60):
        dev.uci.set(
            _AP_BAND_STEERING_CONFIG,
            _AP_BAND_STEERING_SECTION,
            {_AP_BAND_STEERING_OPTION: "1" if enabled else "0"},
        )
    return True


# ---------------------------------------------------------------------------
# WARP-1712 — the AP's OWN network name + passphrase, read and written live.
# ---------------------------------------------------------------------------
#
# THE SOURCE-OF-TRUTH CONTRACT (read this before touching anything below).
#
# The AP is authoritative for its own radios. This service NEVER caches an
# SSID: every read dials the AP and reports what its uci actually says, and
# every write goes to the AP's uci. There is no orchestrator-side copy of the
# network name that could drift (`ApDevice.approvedSsid` is an APPROVAL-TIME
# audit column and is deliberately not used for display).
#
# THE BAND-STEERING INTERACTION. The Droplet AP image ships an applier,
# `/etc/init.d/droplet-band-steer` (droplet-edge-router PR #5), with a procd
# reload trigger. On every reload it DERIVES the 5 GHz interface from the
# 2.4 GHz one:
#
#     droplet.wifi.band_steering = '1'  →  default_radio1.ssid = <ssid>
#     droplet.wifi.band_steering = '0'  →  default_radio1.ssid = <ssid>-5g
#
# (the key is copied verbatim either way). So `default_radio0` — resolved by
# `_ap_primary_iface` — is the ONE section this service may author. Writing
# `default_radio1` ourselves would be authoring a value the applier
# recomputes on the next reload: a race whose winner depends on ordering, and
# a second place for the household's network name to live. We refuse to do
# it. `uci apply` (inside `safe_apply`) fires the AP's reload triggers, which
# is what re-derives radio1 and brings the radios back up — the routing
# service issues no `wifi up` of its own.
#
# The one exception is a PRE-SUBSTRATE image (no `droplet.wifi` section, so
# `_get_band_steering_value` returns None): nothing on that AP derives
# anything, so every wifi-iface has to be written directly — which is exactly
# what the WARP-1675 approval push (`_push_ap_wireless`) already does.
#
# `_derived_five_ghz_ssid` mirrors the applier's rule for DISPLAY ONLY, so the
# dashboard can tell an operator what their 5 GHz network will be called
# without a second round trip. It is never used to author a uci value.

_AP_PRIMARY_RADIO = "radio0"
_AP_PRIMARY_IFACE_FALLBACK = "default_radio0"
_AP_FIVE_GHZ_SSID_SUFFIX = "-5g"

# WPA2-PSK limits, same as ApApproveRequest / SetSsidRequest. SSID is capped in
# BYTES (802.11 SSID element is 32 octets) — a 32-CHARACTER name with any
# non-ASCII in it overflows the element and hostapd refuses the config, which
# on a commit would down the radios. Refuse it here instead.
_AP_SSID_MAX_BYTES = 32
_AP_KEY_MIN_LEN = 8
_AP_KEY_MAX_LEN = 63

_AP_WIRELESS_UNAVAILABLE = {
    "code": "AP_WIRELESS_UNAVAILABLE",
    "message": (
        "The network name can't be changed on this access point — it needs an "
        "approved Droplet AP that reports its own wireless configuration."
    ),
}


def _ap_wireless_sections(dev) -> tuple[dict, dict]:
    """Split a connected AP's `wireless` config into (radios, interfaces).

    One `uci get wireless` round trip rather than two type-filtered reads —
    the per-radio band/channel/htmode live on the `wifi-device` sections and
    the ssid/key/encryption on the `wifi-iface` sections, and the card needs
    both joined.
    """
    envelope = dev.uci.get("wireless") or {}
    values = envelope.get("values", {}) if isinstance(envelope, dict) else {}
    radios: dict[str, dict] = {}
    ifaces: dict[str, dict] = {}
    if isinstance(values, dict):
        for name, section in values.items():
            if not isinstance(section, dict):
                continue
            if section.get(".type") == "wifi-device":
                radios[name] = section
            elif section.get(".type") == "wifi-iface":
                ifaces[name] = section
    return radios, ifaces


def _ap_primary_iface(ifaces: dict) -> Optional[str]:
    """The wifi-iface section that owns the household's network name.

    Must stay in lock-step with the AP-side applier, which reads
    `wireless.default_radio0`. Resolved by the radio it is attached to
    (`device == 'radio0'`) so a renamed section still lands correctly, then by
    the applier's literal section name, then — last resort, an image whose
    sections we don't recognise at all — the first interface uci reports.
    """
    for name, section in ifaces.items():
        if section.get("device") == _AP_PRIMARY_RADIO:
            return name
    if _AP_PRIMARY_IFACE_FALLBACK in ifaces:
        return _AP_PRIMARY_IFACE_FALLBACK
    return next(iter(ifaces), None)


def _derived_five_ghz_ssid(ssid: str, band_steering: Optional[bool]) -> Optional[str]:
    """What the AP's applier will name the 5 GHz network. DISPLAY ONLY.

    Mirrors `/etc/init.d/droplet-band-steer`. None when the AP carries no
    applier (pre-substrate image) — there is nothing to derive, because every
    interface is written directly on that shape.
    """
    if band_steering is None:
        return None
    return ssid if band_steering else f"{ssid}{_AP_FIVE_GHZ_SSID_SUFFIX}"


def _validate_ap_wireless(req: ApWirelessRequest) -> tuple[Optional[str], Optional[str]]:
    """Refuse a payload the AP's hostapd would reject, BEFORE dialing out.

    A commit that hostapd refuses leaves the radios down until someone
    physically recovers the AP, so an out-of-range name/passphrase is a 400
    here and no connection is ever opened. Raises HTTPException(400); returns
    the (ssid, key) to write otherwise.
    """
    ssid = req.ssid
    key = req.key
    if ssid is None and key is None:
        raise HTTPException(
            status_code=400,
            detail="Provide 'ssid' and/or 'key' — nothing to change.",
        )
    if ssid is not None:
        # Bytes, not characters — see _AP_SSID_MAX_BYTES.
        length = len(ssid.encode("utf-8"))
        if length < 1 or length > _AP_SSID_MAX_BYTES:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Network name (SSID) must be 1-{_AP_SSID_MAX_BYTES} bytes; "
                    f"got {length}."
                ),
            )
    if key is not None and not (_AP_KEY_MIN_LEN <= len(key) <= _AP_KEY_MAX_LEN):
        # Never echo the passphrase back — only its length.
        raise HTTPException(
            status_code=400,
            detail=(
                f"Wi-Fi password must be {_AP_KEY_MIN_LEN}-{_AP_KEY_MAX_LEN} "
                f"characters; got {len(key)}."
            ),
        )
    return ssid, key


def _ap_live_overlay(dev, ifaces: dict) -> tuple[dict, dict]:
    """Best-effort live state off an already-connected AP: (per-iface, device).

    Reuses the ubus surfaces the droplet-ai ACL already grants — no new
    AP-side endpoint. `network.wireless status` for link state + the kernel
    ifname, `iwinfo info`/`assoclist` for the real channel/width/client count,
    `system board`/`info` for model/firmware/uptime.

    UbusError is swallowed per-surface: an AP whose ACL is narrower than ours
    still gets an honest config read with the live fields reported as None,
    which is strictly better than 502-ing a page that could have rendered.
    ConnectionLost deliberately propagates — a connection that dropped
    mid-read makes the WHOLE answer untrustworthy, so the caller classifies it
    as AP_UNREACHABLE.
    """
    per_iface: dict[str, dict] = {}
    device: dict[str, Any] = {
        "model": None,
        "firmware": None,
        "hostname": None,
        "uptime_seconds": None,
    }

    status: dict = {}
    try:
        status = dev.wireless.status() or {}
    except UbusError:
        logger.debug("AP live overlay: wireless status unavailable", exc_info=True)

    # netifd's status is keyed by radio; each radio carries the wifi-iface
    # sections it brought up, with the kernel ifname iwinfo needs.
    ifname_by_section: dict[str, str] = {}
    up_by_section: dict[str, bool] = {}
    if isinstance(status, dict):
        for radio_state in status.values():
            if not isinstance(radio_state, dict):
                continue
            radio_up = bool(radio_state.get("up"))
            for entry in radio_state.get("interfaces", []) or []:
                if not isinstance(entry, dict):
                    continue
                section = entry.get("section")
                if not section:
                    continue
                if entry.get("ifname"):
                    ifname_by_section[section] = entry["ifname"]
                up_by_section[section] = radio_up

    for section in ifaces:
        ifname = ifname_by_section.get(section)
        info: dict = {}
        clients: Optional[int] = None
        if ifname:
            try:
                info = dev.wireless.radio_info(device=ifname) or {}
            except UbusError:
                logger.debug("AP live overlay: iwinfo info failed", exc_info=True)
            try:
                clients = len(dev.wireless.connected_clients(device=ifname) or [])
            except UbusError:
                logger.debug("AP live overlay: iwinfo assoclist failed", exc_info=True)
        per_iface[section] = {
            "ifname": ifname,
            "up": up_by_section.get(section),
            "live_channel": info.get("channel"),
            "live_htmode": info.get("htmode"),
            "clients": clients,
        }

    try:
        board = dev.system.board_info() or {}
        device["model"] = board.get("model")
        device["hostname"] = board.get("hostname")
        release = board.get("release")
        if isinstance(release, dict):
            device["firmware"] = release.get("description") or release.get("version")
    except UbusError:
        logger.debug("AP live overlay: system board failed", exc_info=True)
    try:
        device["uptime_seconds"] = dev.system.uptime_seconds()
    except UbusError:
        logger.debug("AP live overlay: system info failed", exc_info=True)

    return per_iface, device


def _shape_ap_wireless(dev) -> Optional[dict]:
    """Build the live wireless snapshot off an already-connected AP.

    None = honest "unsupported": the AP reports no wifi-iface sections at all,
    so there is no network name to show or change on it.
    """
    radios, ifaces = _ap_wireless_sections(dev)
    if not ifaces:
        return None
    band_steering = _get_band_steering_value(dev)
    primary = _ap_primary_iface(ifaces)
    live, device = _ap_live_overlay(dev, ifaces)

    shaped = []
    for section in sorted(ifaces):
        iface = ifaces[section]
        radio_name = iface.get("device")
        radio = radios.get(radio_name, {}) if isinstance(radio_name, str) else {}
        overlay = live.get(section, {})
        shaped.append({
            "section": section,
            "radio": radio_name,
            "band": radio.get("band"),
            "ssid": iface.get("ssid"),
            "encryption": iface.get("encryption"),
            # Configured channel ('auto' is a legal uci value); the live
            # channel iwinfo reports is separate and may differ.
            "channel": radio.get("channel"),
            "htmode": radio.get("htmode"),
            # uci omits `disabled` when the radio is enabled — absence means
            # "not disabled", which is a documented uci default, not a guess.
            "disabled": str(iface.get("disabled", "0")) == "1",
            "primary": section == primary,
            "ifname": overlay.get("ifname"),
            "up": overlay.get("up"),
            "live_channel": overlay.get("live_channel"),
            "live_htmode": overlay.get("live_htmode"),
            "clients": overlay.get("clients"),
        })

    primary_iface = ifaces.get(primary, {}) if primary else {}
    ssid = primary_iface.get("ssid")
    return {
        "supported": True,
        "band_steering": band_steering,
        "primary_section": primary,
        "ssid": ssid,
        # The live passphrase, so an operator can read it off the dashboard
        # instead of ssh-ing to the AP. The AP mints a per-unit one at first
        # boot (/etc/droplet/wifi-psk). Gated owner/admin one layer up, same
        # posture as the guest-network PSK.
        "key": primary_iface.get("key"),
        "encryption": primary_iface.get("encryption"),
        "five_ghz_ssid": _derived_five_ghz_ssid(ssid, band_steering) if ssid else None,
        "radios": shaped,
        "device": device,
    }


def _ap_mode_ifnames(dev) -> list[str]:
    """Every AP-mode radio interface name the AP is currently running.

    `connected_clients` needs a concrete iwinfo device, and an external AP's
    interface names aren't knowable up front (phy0-ap0, wlan0, ...) — so read
    them off the AP's own wireless status rather than guessing. Interfaces
    with no `ifname` are not up and have no clients to report.
    """
    names: list[str] = []
    status = dev.wireless.status()
    if not isinstance(status, dict):
        return names
    for radio in status.values():
        if not isinstance(radio, dict):
            continue
        for iface in radio.get("interfaces") or []:
            if not isinstance(iface, dict):
                continue
            cfg = iface.get("config") or {}
            if isinstance(cfg, dict) and str(cfg.get("mode", "")).lower() != "ap":
                continue
            ifname = iface.get("ifname")
            if isinstance(ifname, str) and ifname and ifname not in names:
                names.append(ifname)
    return names


def _read_ap_wireless(host: str) -> Optional[dict]:
    """The AP's own broadcast Wi-Fi config — ssid/key/encryption (WARP-1714).

    On the edge-router shape the router runs NO AP-mode interface (the Pi's
    radio0 reports ``interfaces: []`` and its uci carries only a disabled
    ``ssid='OpenWrt'`` placeholder), so the household's real Wi-Fi name and
    password live on the standalone AP. Reading the router alone can only
    answer "nothing configured", which is why the dashboard's Wi-Fi card came
    up blank on this shape.

    Returns ``None`` when the AP exposes no AP-mode interface with an SSID —
    an honest "nothing to report", never a fabricated default. Raises
    ConnectionLost / UbusError for the caller to classify.
    """
    dev = _connect_ap(host)
    status = dev.wireless.status()
    if not isinstance(status, dict):
        return None
    for radio in status.values():
        if not isinstance(radio, dict):
            continue
        for iface in radio.get("interfaces") or []:
            if not isinstance(iface, dict):
                continue
            cfg = iface.get("config") or {}
            if not isinstance(cfg, dict):
                continue
            if str(cfg.get("mode", "")).lower() != "ap":
                continue
            # Guest Wi-Fi has its own card; surfacing its PSK as the household
            # password would be actively misleading.
            network = cfg.get("network")
            names = network if isinstance(network, list) else str(network or "").split()
            if "guest" in names:
                continue
            ssid = cfg.get("ssid")
            if not ssid:
                continue
            return {
                "ssid": str(ssid),
                "key": str(cfg.get("key", "") or ""),
                "encryption": str(cfg.get("encryption", "") or ""),
                "section": str(iface.get("section", "") or ""),
            }
    return None


def _read_ap_clients(host: str) -> list[dict]:
    """Stations currently associated to the EXTERNAL AP's own radios.

    WARP-1715 — the router's assoclist only covers the ROUTER's radios, so
    every device joined through a standalone AP looked wired (no signal, no
    AP attribution) in the dashboard. This reads the AP's own iwinfo assoclist
    over its rpcd, the same credential path as the approval push.

    Distinct from WARP-1712's `/aps/{mac}/wireless`, whose per-radio `clients`
    is a COUNT — device attribution needs each station's MAC and signal.

    Each returned client carries the `ifname` it associated on so the caller
    can attribute a station to the right radio. Raises ConnectionLost /
    UbusError for the caller to classify.
    """
    dev = _connect_ap(host)
    out: list[dict] = []
    seen: set[str] = set()
    for ifname in _ap_mode_ifnames(dev):
        for client in dev.wireless.connected_clients(ifname):
            if not isinstance(client, dict):
                continue
            mac = str(client.get("mac", "")).strip()
            # A station roaming between the AP's own bands can appear on two
            # radios at once; first sighting wins so it stays one device.
            key = _mac_key(mac)
            if not mac or key in seen:
                continue
            seen.add(key)
            out.append({**client, "ifname": ifname})
    return out


def _read_ap_wireless(host: str) -> Optional[dict]:
    """Dial the AP and snapshot its wireless state. None = unsupported."""
    return _shape_ap_wireless(_connect_ap(host))


def _write_ap_wireless(host: str, ssid: Optional[str], key: Optional[str]) -> Optional[dict]:
    """Dial the AP and set the household network name / passphrase.

    Writes ONLY the primary (2.4 GHz) wifi-iface when the AP carries the
    band-steering applier — see the contract at the top of this block; the
    applier derives the 5 GHz interface on the reload `uci apply` triggers.
    A pre-substrate image has no applier, so every interface is written
    directly (the WARP-1675 approval-push shape).

    Returns the post-write snapshot, or None (having written nothing) when the
    AP exposes no wireless sections — the caller surfaces the honest 422.
    """
    dev = _connect_ap(host)
    _radios, ifaces = _ap_wireless_sections(dev)
    if not ifaces:
        return None
    band_steering = _get_band_steering_value(dev)
    primary = _ap_primary_iface(ifaces)

    values: dict[str, str] = {}
    if ssid is not None:
        values["ssid"] = ssid
    if key is not None:
        values["key"] = key

    if band_steering is None:
        # No applier on this image — nothing derives the other interfaces.
        targets = sorted(ifaces)
    else:
        targets = [primary] if primary else []
    if not targets:
        return None

    with dev.safe_apply(timeout=60):
        for section in targets:
            dev.uci.set("wireless", section, values)

    # Report the intent, not a re-read: the AP's radios are mid-reload right
    # after apply, and a read raced against that would show pre-reload values.
    # The dashboard revalidates once the operation lands.
    effective_ssid = ssid if ssid is not None else ifaces.get(primary, {}).get("ssid")
    return {
        "sections_written": targets,
        "band_steering": band_steering,
        "ssid": effective_ssid,
        "five_ghz_ssid": (
            _derived_five_ghz_ssid(effective_ssid, band_steering)
            if effective_ssid
            else None
        ),
    }


@app.get("/aps/discovered")
def aps_discovered():
    """Return the live mDNS discovery snapshot.

    Two layers:
      - Mock mode (`ROUTING_MODE=mock`): the in-memory `_MockAp`
        exposes a `discovered()` method seeded by `/aps/_test_seed`
        so dev + integration tests can drive the full state machine
        without a real OpenWrt box.
      - Real mode: the SDK's `ApApi.browse_discovered()` issues a
        `ubus call umdns browse` and parses `_droplet-ap._tcp` TXT
        records (mac/model/serial/version) into the orchestrator-
        friendly shape. The droplet-ai rpcd ACL already grants
        `umdns: ["browse", "update"]`
        (openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json), so the
        orchestrator's poller can drive this on a 10s cadence
        without extra privileges (ADR-005 §1).
    """
    try:
        r = get_router()
        ap = _get_ap_namespace(r)
        # Prefer the mock's seeded list when present — `_test_seed`
        # populates it deterministically and we don't want a real umdns
        # call leaking into mock-mode tests.
        if hasattr(ap, "discovered"):
            return {"discovered": ap.discovered()}
        if hasattr(ap, "browse_discovered"):
            return {"discovered": ap.browse_discovered()}
        return {"discovered": []}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/aps/{mac}")
def aps_get(mac: str):
    """Return the current state of a discovered AP.

    States: `discovered` (mDNS seen, no approval), `online` (config
    pushed), `decommissioned` (config removed). Returns 404 when the
    MAC was never announced.
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)
        if not hasattr(ap, "get"):
            raise HTTPException(status_code=404, detail="AP not found")
        info = ap.get(canonical)
        if info is None:
            raise HTTPException(status_code=404, detail="AP not found")
        return info
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/aps/_test_seed", include_in_schema=False)
def aps_test_seed(req: ApTestSeedRequest):
    """Inject a discovered AP into the mock router. Test-only.

    Production discovery is mDNS-driven from the orchestrator; this
    endpoint is the test seam that lets pytest + dev exercise the
    state machine without simulating multicast. Returns 404 when the
    router isn't a MockRouter — there's nothing to seed in real mode.
    """
    try:
        r = get_router()
        ap = _get_ap_namespace(r)
        if not hasattr(ap, "seed"):
            raise HTTPException(
                status_code=404,
                detail="_test_seed only available in ROUTING_MODE=mock",
            )
        ap.seed(
            req.mac,
            model=req.model,
            serial=req.serial,
            version=req.version,
            last_ip=req.last_ip,
            hostname=req.hostname,
            clients=req.clients,
        )
        return {"status": "ok", "mac": req.mac.upper()}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


_AP_BAND_STEERING_UNAVAILABLE = {
    "code": "AP_BAND_STEERING_UNAVAILABLE",
    "message": (
        "Band steering isn't available on this access point — it needs an "
        "approved Droplet AP running an image with the droplet.wifi substrate."
    ),
}


@app.get("/aps/{mac}/band-steering")
def aps_band_steering_get(mac: str):
    """Read the AP's band-steering master switch (WARP-1703).

    Honesty contract (the UPnP pattern): `supported` is False — never an
    error — when no AP credential is provisioned (single-box / legacy shapes)
    or when the AP's image predates the droplet.wifi substrate. Reachability
    problems on a *configured* AP are typed 502s (AP_AUTH / AP_UNREACHABLE),
    same classification as the approval push.
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        # Mock surface first (ROUTING_MODE=mock) — the in-memory _MockAp keeps
        # a per-MAC band-steering flag so dashboard dev can drive the toggle
        # without a real AP.
        if hasattr(ap, "get_band_steering"):
            if not hasattr(ap, "get") or ap.get(canonical) is None:
                raise HTTPException(status_code=404, detail="AP not found")
            return {
                "supported": True,
                "enabled": ap.get_band_steering(canonical),
                "ap_detail": "mock AP",
            }

        if not AP_PASSWORD:
            return {
                "supported": False,
                "enabled": False,
                "ap_detail": "no AP credential configured",
            }

        ap_ip = _discovered_ap_ip(ap, canonical)
        if not ap_ip:
            raise HTTPException(status_code=502, detail={
                "code": "AP_UNREACHABLE",
                "message": (
                    f"AP {canonical} has no discovered address to read — is "
                    "it online? The read is retryable."
                ),
            })
        try:
            state = _read_ap_band_steering(ap_ip)
        except (ConnectionLost, UbusError) as exc:
            raise _classify_ap_push_error(exc, ap_ip)
        if state is None:
            return {
                "supported": False,
                "enabled": False,
                "ap_detail": (
                    f"AP at {ap_ip} doesn't expose band steering — its image "
                    "predates the droplet.wifi substrate"
                ),
            }
        return {
            "supported": True,
            "enabled": state,
            "ap_detail": f"AP at {ap_ip}",
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.put("/aps/{mac}/band-steering")
def aps_band_steering_put(mac: str, req: ApBandSteeringRequest, request: Request):
    """Toggle the AP's band-steering master switch (WARP-1703).

    Sets `droplet.wifi.band_steering` over the AP's rpcd; the commit fires
    the AP's own procd reload trigger which unifies/splits the SSIDs and
    starts/stops dawn. Mirrors POST /upnp's honesty: a shape that can't do
    this answers 422 AP_BAND_STEERING_UNAVAILABLE, never a pretend-success.
    The Operation-Id is mirrored into the body like aps_approve — some
    proxies strip non-standard response headers.
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        # Mock surface first (ROUTING_MODE=mock).
        if hasattr(ap, "set_band_steering"):
            if not hasattr(ap, "get") or ap.get(canonical) is None:
                raise HTTPException(status_code=404, detail="AP not found")
            ap.set_band_steering(canonical, req.enabled)
            return {
                "status": "ok",
                "mac": canonical,
                "enabled": req.enabled,
                "ap_detail": "mock AP",
                "operation_id": getattr(request.state, "operation_id", None),
            }

        if not AP_PASSWORD:
            # Never pretend to toggle steering on an AP we can't configure.
            return JSONResponse(status_code=422, content=_AP_BAND_STEERING_UNAVAILABLE)

        ap_ip = _discovered_ap_ip(ap, canonical)
        if not ap_ip:
            raise HTTPException(status_code=502, detail={
                "code": "AP_UNREACHABLE",
                "message": (
                    f"AP {canonical} has no discovered address to configure — "
                    "is it online? The change is retryable."
                ),
            })
        try:
            written = _write_ap_band_steering(ap_ip, req.enabled)
        except (ConnectionLost, UbusError) as exc:
            raise _classify_ap_push_error(exc, ap_ip)
        if not written:
            return JSONResponse(status_code=422, content=_AP_BAND_STEERING_UNAVAILABLE)
        return {
            "status": "ok",
            "mac": canonical,
            "enabled": req.enabled,
            "ap_detail": f"AP at {ap_ip} band steering {'on' if req.enabled else 'off'}",
            "operation_id": getattr(request.state, "operation_id", None),
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/aps/{mac}/wireless")
def aps_wireless(mac: str):
    """The AP's broadcast SSID + key (WARP-1714).

    Same honesty contract as band-steering. `supported: false` when no AP
    credential is provisioned — which is the state the lab box is in today
    (`docker/secrets/ap_openwrt_password` is empty), so the caller can say WHY
    it can't show the Wi-Fi instead of rendering blank fields that read as
    "no Wi-Fi configured".
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        # Mock surface (ROUTING_MODE=mock): approve pushes into `_pushed`.
        if hasattr(ap, "pushed_config"):
            if not hasattr(ap, "get") or ap.get(canonical) is None:
                raise HTTPException(status_code=404, detail="AP not found")
            cfg = ap.pushed_config(canonical)
            return {
                "supported": True,
                "wireless": cfg,
                "ap_detail": "mock AP",
            }

        if not AP_PASSWORD:
            return {
                "supported": False,
                "wireless": None,
                "ap_detail": "no AP credential configured",
            }

        ap_ip = _discovered_ap_ip(ap, canonical)
        if not ap_ip:
            raise HTTPException(status_code=502, detail={
                "code": "AP_UNREACHABLE",
                "message": (
                    f"AP {canonical} has no discovered address to read — is "
                    "it online? The read is retryable."
                ),
            })
        try:
            cfg = _read_ap_wireless(ap_ip)
        except (ConnectionLost, UbusError) as exc:
            raise _classify_ap_push_error(exc, ap_ip)
        return {
            "supported": True,
            "wireless": cfg,
            "ap_detail": f"AP at {ap_ip}",
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/aps/{mac}/clients")
def aps_clients(mac: str):
    """Stations associated to this AP's own radios (WARP-1715).

    Distinct from `/aps/{mac}/wireless` (WARP-1712), which reports per-radio
    STATE and a client COUNT. Device attribution in the orchestrator needs the
    per-station MAC + signal, which only the assoclist carries.

    Same honesty contract: `supported` is False — never an error — when no AP
    credential is provisioned (single-box / legacy shapes), because on those
    shapes the router's own assoclist already covers every wireless client. A
    *configured* AP that can't be reached is a typed 502 (AP_AUTH /
    AP_UNREACHABLE), so "no clients" never masks "couldn't ask".
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        # Mock surface first (ROUTING_MODE=mock) so dashboard dev can drive the
        # via-AP attribution without a real AP on the bench.
        if hasattr(ap, "get_clients"):
            if not hasattr(ap, "get") or ap.get(canonical) is None:
                raise HTTPException(status_code=404, detail="AP not found")
            return {
                "supported": True,
                "clients": ap.get_clients(canonical),
                "ap_detail": "mock AP",
            }

        if not AP_PASSWORD:
            return {
                "supported": False,
                "clients": [],
                "ap_detail": "no AP credential configured",
            }

        ap_ip = _discovered_ap_ip(ap, canonical)
        if not ap_ip:
            raise HTTPException(status_code=502, detail={
                "code": "AP_UNREACHABLE",
                "message": (
                    f"AP {canonical} has no discovered address to read — is "
                    "it online? The read is retryable."
                ),
            })
        try:
            clients = _read_ap_clients(ap_ip)
        except (ConnectionLost, UbusError) as exc:
            raise _classify_ap_push_error(exc, ap_ip)
        return {
            "supported": True,
            "clients": clients,
            "ap_detail": f"AP at {ap_ip}",
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/aps/{mac}/wireless")
def aps_wireless_get(mac: str):
    """Read the AP's LIVE wireless state (WARP-1712).

    The AP is authoritative for its own radios — this dials it and reports
    what its uci actually says, so nothing upstream can serve a stale network
    name. Returns the per-radio detail an operator needs (band, channel,
    width, link state, associated clients) plus the model/firmware/uptime, all
    off ubus surfaces the droplet-ai ACL already grants.

    Honesty contract (the band-steering / UPnP pattern): `supported` is False —
    never an error — when no AP credential is provisioned or the AP reports no
    wireless sections. Reachability problems on a *configured* AP are typed
    502s (AP_AUTH / AP_UNREACHABLE).

    The response carries the live passphrase. That is deliberate (an operator
    should not need ssh to read their own Wi-Fi password) and is why the
    orchestrator gates this read to owner/admin, same posture as the
    guest-network PSK read.
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        # Mock surface first (ROUTING_MODE=mock).
        if hasattr(ap, "get_ap_wireless"):
            if not hasattr(ap, "get") or ap.get(canonical) is None:
                raise HTTPException(status_code=404, detail="AP not found")
            return {**ap.get_ap_wireless(canonical), "ap_detail": "mock AP"}

        if not AP_PASSWORD:
            return {
                "supported": False,
                "ap_detail": "no AP credential configured",
                "radios": [],
            }

        ap_ip = _discovered_ap_ip(ap, canonical)
        if not ap_ip:
            raise HTTPException(status_code=502, detail={
                "code": "AP_UNREACHABLE",
                "message": (
                    f"AP {canonical} has no discovered address to read — is "
                    "it online? The read is retryable."
                ),
            })
        try:
            state = _read_ap_wireless(ap_ip)
        except (ConnectionLost, UbusError) as exc:
            raise _classify_ap_push_error(exc, ap_ip)
        if state is None:
            return {
                "supported": False,
                "ap_detail": f"AP at {ap_ip} reports no wireless interfaces",
                "radios": [],
            }
        return {**state, "ap_detail": f"AP at {ap_ip}"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.put("/aps/{mac}/wireless")
def aps_wireless_put(mac: str, req: ApWirelessRequest, request: Request):
    """Set the AP's network name / passphrase (WARP-1712).

    Validation runs BEFORE any dial-out: an SSID or passphrase hostapd would
    reject is a 400 that pushes nothing, because a rejected commit leaves the
    AP's radios down. Beyond that the write targets ONLY the primary
    (2.4 GHz) interface when the AP carries the band-steering applier — the
    applier derives the 5 GHz interface on the reload that `uci apply` fires.
    See the contract block above `_ap_primary_iface`.

    Mirrors the band-steering PUT's honesty: a shape that can't do this
    answers 422 AP_WIRELESS_UNAVAILABLE, never a pretend-success.
    """
    canonical = _validate_mac(mac)
    # Raises 400 before anything is connected to or written.
    ssid, key = _validate_ap_wireless(req)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        # Mock surface first (ROUTING_MODE=mock).
        if hasattr(ap, "set_ap_wireless"):
            if not hasattr(ap, "get") or ap.get(canonical) is None:
                raise HTTPException(status_code=404, detail="AP not found")
            result = ap.set_ap_wireless(canonical, ssid, key)
            return {
                "status": "ok",
                "mac": canonical,
                **result,
                "ap_detail": "mock AP",
                "operation_id": getattr(request.state, "operation_id", None),
            }

        if not AP_PASSWORD:
            # Never pretend to rename a network on an AP we can't configure.
            return JSONResponse(status_code=422, content=_AP_WIRELESS_UNAVAILABLE)

        ap_ip = _discovered_ap_ip(ap, canonical)
        if not ap_ip:
            raise HTTPException(status_code=502, detail={
                "code": "AP_UNREACHABLE",
                "message": (
                    f"AP {canonical} has no discovered address to configure — "
                    "is it online? The change is retryable."
                ),
            })
        try:
            written = _write_ap_wireless(ap_ip, ssid, key)
        except (ConnectionLost, UbusError) as exc:
            raise _classify_ap_push_error(exc, ap_ip)
        if written is None:
            return JSONResponse(status_code=422, content=_AP_WIRELESS_UNAVAILABLE)
        return {
            "status": "ok",
            "mac": canonical,
            **written,
            "ap_detail": f"AP at {ap_ip} wireless updated",
            "operation_id": getattr(request.state, "operation_id", None),
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/aps/{mac}/approve")
def aps_approve(mac: str, req: ApApproveRequest, request: Request):
    """Approve a discovered AP and push wireless config.

    The push is wrapped in `safe_apply` so a misconfigured wireless
    change can't lock the orchestrator out of the main router — same
    discipline `/vpn/setup` and `/network/subnets/cameras/setup` use.
    The Operation-Id surfaces via the middleware-attached
    `X-Operation-Id` header AND in the response body so the
    dashboard's wizard can poll the operation tracker until the
    transition is terminal. The body-mirrored value matters when the
    dashboard reaches us through the orchestrator's HTTP proxy — some
    proxies strip non-standard response headers.
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        # Mock mode tracks discovered state; real mode trusts the
        # orchestrator to only call this with an MAC the orchestrator
        # itself surfaced as discovered.
        if hasattr(ap, "get"):
            existing = ap.get(canonical)
            if existing is None:
                raise HTTPException(status_code=404, detail="AP not found in discovery list")

        from droplet_openwrt_sdk import ApApi
        iface_section = ApApi.iface_section_for_mac(canonical)

        # WARP-1675: staging a wifi-iface on a router that HAS no AP radios
        # (the Pi edge router) would leave a dead uci section that configures
        # nothing — skip it and rely on the AP-direct push below.
        router_staged = _router_has_ap_radios(r)
        if router_staged:
            with r.safe_apply(timeout=60):
                # Mock router's `push_wireless_config` takes the MAC so it
                # can track per-AP state; the real SDK's signature doesn't
                # take MAC because the iface_section already encodes it.
                # Detect via the mock's `discovered` attribute.
                if hasattr(ap, "discovered"):
                    ap.push_wireless_config(
                        mac=canonical,
                        iface_section=iface_section,
                        radio=req.radio,
                        ssid=req.ssid,
                        encryption=req.encryption,
                        key=req.encryption_key,
                        network=req.network,
                    )
                else:
                    ap.push_wireless_config(
                        iface_section=iface_section,
                        radio=req.radio,
                        ssid=req.ssid,
                        encryption=req.encryption,
                        key=req.encryption_key,
                        network=req.network,
                    )
        else:
            logger.info(
                "router reports no AP radios (edge-router shape) — skipping "
                "router-side wifi-iface staging for %s", canonical,
            )

        # WARP-1675: configure the AP ITSELF when an AP credential is
        # provisioned. Without one (single-box / legacy shapes) the
        # router-side staging above remains the whole story.
        ap_configured = False
        ap_detail = "no AP credential configured — router-side approval only"
        if AP_PASSWORD:
            ap_ip = _discovered_ap_ip(ap, canonical)
            if not ap_ip:
                raise HTTPException(status_code=502, detail={
                    "code": "AP_UNREACHABLE",
                    "message": (
                        f"AP {canonical} has no discovered address to "
                        "configure — is it online? The approval is retryable."
                    ),
                })
            try:
                _push_ap_wireless(
                    ap_ip,
                    enable=True,
                    ssid=req.ssid,
                    encryption=req.encryption,
                    key=req.encryption_key,
                )
            except (ConnectionLost, UbusError) as exc:
                raise _classify_ap_push_error(exc, ap_ip)
            ap_configured = True
            ap_detail = f"AP at {ap_ip} configured directly over rpcd"

        return {
            "status": "ok",
            "mac": canonical,
            "iface_section": iface_section,
            "ssid": req.ssid,
            "router_staged": router_staged,
            "ap_configured": ap_configured,
            "ap_detail": ap_detail,
            "operation_id": getattr(request.state, "operation_id", None),
        }
    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost during AP approval — rolling back",
                "detail": str(exc),
                "rollback_pending": True,
            },
        )
    except UbusError as exc:
        handle_router_error(exc)


@app.delete("/aps/{mac}")
def aps_decommission(mac: str, request: Request):
    """Remove the wireless config off the AP and transition state.

    Idempotent on previously-decommissioned MACs (re-DELETE is a
    success no-op). Returns 404 only when the MAC was never announced
    at all (matches discovery's contract — can't decommission what
    we've never seen).
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        if hasattr(ap, "get"):
            existing = ap.get(canonical)
            if existing is None:
                raise HTTPException(status_code=404, detail="AP not found")

        from droplet_openwrt_sdk import ApApi
        iface_section = ApApi.iface_section_for_mac(canonical)

        # WARP-1675: mirror approve's radio gating — there is nothing staged
        # on a radio-less router to remove, and safe_apply with zero pending
        # changes returns NO_DATA.
        if _router_has_ap_radios(r):
            with r.safe_apply(timeout=60):
                if hasattr(ap, "discovered"):
                    ap.remove_wireless_config(canonical)
                else:
                    ap.remove_wireless_config(iface_section=iface_section)

        # WARP-1675: best-effort disable of the AP's own radios. A
        # decommissioned AP may already be unplugged/off — an unreachable AP
        # must NEVER fail the decommission, only annotate it.
        ap_disabled = False
        ap_detail = "no AP credential configured — router-side decommission only"
        if AP_PASSWORD:
            ap_ip = _discovered_ap_ip(ap, canonical)
            if not ap_ip:
                ap_detail = "AP not currently discovered — nothing to disable"
            else:
                try:
                    _push_ap_wireless(ap_ip, enable=False)
                    ap_disabled = True
                    ap_detail = f"AP at {ap_ip} wireless disabled over rpcd"
                except (ConnectionLost, UbusError) as exc:
                    ap_detail = f"AP at {ap_ip} unreachable during decommission ({exc}) — proceeding"
                    logger.warning("AP decommission: %s", ap_detail)

        return {
            "status": "ok",
            "mac": canonical,
            "ap_disabled": ap_disabled,
            "ap_detail": ap_detail,
            "operation_id": getattr(request.state, "operation_id", None),
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)
