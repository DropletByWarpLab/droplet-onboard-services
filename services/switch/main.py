"""
Droplet Switch Service
======================
FastAPI wrapper around the abstract SwitchDriver, exposing managed switch
control as a REST API for the orchestrator and AI gateway to consume.

The driver implementation is selected at startup via SWITCH_DRIVER env var.
The managed switch driver is selected at startup via SWITCH_DRIVER env var.
Lantronix SM8TAT2SA is the prototype backend. When the custom PCB ASIC is
ready, set SWITCH_DRIVER=asic and nothing else changes.
"""

import sys as _sys

# WARP-229: FIPS 140-3 boot self-test. Env-gated; see
# services/_shared/fips_selftest.py for the contract.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("switch")
except ImportError:
    pass

import os
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from drivers import create_driver
from drivers.base import (
    SwitchDriver,
    SwitchError,
    ConnectionLost,
    AuthenticationError,
    SwitchAPIError,
    InvalidPortError,
)
from provisioner import ProvisionConfig, reconcile_switch
import provision_state
from schemas import (
    HealthResponse,
    CreateVlanRequest,
    SetVlanMembershipRequest,
    CameraSetupRequest,
    CameraSetupResult,
    ProvisionRequest,
    ProvisionResult,
    ProvisionConfigResponse,
)

# ---------------------------------------------------------------------------
# Model constants (no firmware read exposes these)
# ---------------------------------------------------------------------------
# The SM8TAT2SA's PoE power budget. The firmware's poe_status read reports
# per-port draw but no total budget, so it is a documented model constant
# (130 W for the 8-port PoE+ SM8TAT2SA). Surfaced in watts on the §7 status
# contract as poe_budget_w.
POE_BUDGET_W = 130

logger = logging.getLogger("droplet.switch")
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Service-to-service authentication
# ---------------------------------------------------------------------------
SERVICE_SECRET = os.environ.get("SERVICE_SECRET", "")
if not SERVICE_SECRET:
    logger.warning("SERVICE_SECRET not set — all endpoints are unauthenticated. "
                    "Set SERVICE_SECRET to enable service-to-service auth.")


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Reject requests without a valid SERVICE_SECRET Bearer token."""

    async def dispatch(self, request: Request, call_next):
        import hmac
        if request.url.path == "/health":
            return await call_next(request)
        if SERVICE_SECRET:
            auth = request.headers.get("Authorization", "")
            token = auth.removeprefix("Bearer ").strip()
            if not hmac.compare_digest(token, SERVICE_SECRET):
                return JSONResponse(
                    status_code=403,
                    content={"error": "Invalid or missing service token"},
                )
        return await call_next(request)


SWITCH_HOST = os.environ.get("SWITCH_HOST", "192.168.1.77")
SWITCH_PORT = int(os.environ.get("SWITCH_PORT", "443"))
SWITCH_DRIVER = os.environ.get("SWITCH_DRIVER", "lantronix")

# ---------------------------------------------------------------------------
# Bring-up provisioning config (ADR-018 item 9)
# ---------------------------------------------------------------------------
# This is the SYSTEM provisioning path (runs once on bring-up + on POST
# /provision). It is distinct from the orchestrator's Tier-2 human-confirmation
# switch path (apps/orchestrator/src/routes/switch.ts). All desired state is
# read from EXPLICIT env (never inferred from absence — rule 10):
#   SWITCH_AUTOPROVISION   "0"/off (default) — gates the on-boot reconcile.
#   SWITCH_VLAN_PROFILE    flat-lan (default) | segmented.
#   SWITCH_PROTECTED_PORT  uplink/trunk port — NEVER moved off LAN/trunk. No
#                          host-specific value is baked (rule 12); 0 = none.
#   SWITCH_{CAMERA,AP,CLIENT}_PORTS  comma-separated; empty = safe default.
#   SWITCH_PROVISION_TIMEOUT  hard timeout (s) for one reconcile (default 30).
# The segmented profile additionally cross-checks ROUTING_SERVICE_URL for
# `cameras.present === true` before isolating (item 9 depends on item 3).
SWITCH_PROVISION_TIMEOUT = float(os.environ.get("SWITCH_PROVISION_TIMEOUT", "30"))
# The switch service runs network_mode: host, so reach routing on loopback.
ROUTING_SERVICE_URL = os.environ.get("ROUTING_SERVICE_URL", "http://localhost:8080")
# Bearer the routing service validates on its non-/health routes. This is the
# routing service's own ROUTING_SERVICE_TOKEN (see services/routing/main.py),
# NOT this service's SERVICE_SECRET — the two are distinct secrets. The camera
# cross-check below MUST present this token or routing answers 401 and the
# segmented profile is wrongly refused. (camera-discovery presents the same
# ROUTING_SERVICE_TOKEN on its routing calls.)
ROUTING_SERVICE_TOKEN = os.environ.get("ROUTING_SERVICE_TOKEN", "").strip()
if not ROUTING_SERVICE_TOKEN:
    logger.warning(
        "ROUTING_SERVICE_TOKEN not set — cross-check calls to the routing "
        "service will send no Authorization header; routing will 401 and the "
        "segmented VLAN profile will be permanently refused."
    )


def autoprovision_enabled() -> bool:
    """True when SWITCH_AUTOPROVISION is explicitly truthy. Default off."""
    return os.environ.get("SWITCH_AUTOPROVISION", "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _parse_ports(env_value: str) -> list[int]:
    """Parse a comma-separated port list; blank/whitespace -> empty list."""
    ports: list[int] = []
    for tok in env_value.split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            ports.append(int(tok))
        except ValueError:
            logger.warning("provisioner: ignoring non-integer port %r", tok)
    return ports


def build_provision_config() -> ProvisionConfig:
    """Build the desired-state config from env. Safe defaults throughout."""
    return ProvisionConfig(
        profile=os.environ.get("SWITCH_VLAN_PROFILE", "flat-lan").strip() or "flat-lan",
        protected_port=int(os.environ.get("SWITCH_PROTECTED_PORT", "0") or "0"),
        camera_ports=_parse_ports(os.environ.get("SWITCH_CAMERA_PORTS", "")),
        ap_ports=_parse_ports(os.environ.get("SWITCH_AP_PORTS", "")),
        client_ports=_parse_ports(os.environ.get("SWITCH_CLIENT_PORTS", "")),
    )


class RoutingCamerasCrossCheck:
    """Reads the explicit camera-interface presence flag from the routing
    service (ADR-018 Decision 2/4). Used only by the segmented profile to
    double-gate isolation. Read-only; never mutates the router."""

    def __init__(self, base_url: str):
        self._base_url = base_url.rstrip("/")

    async def cameras_present(self) -> Optional[bool]:
        """Return cameras.present from /network/interfaces, or None if it can't
        be determined. Presence is the explicit `present` flag — never inferred
        from a missing key."""
        # Authenticate with the routing service's OWN token, not this
        # service's SERVICE_SECRET. routing validates ROUTING_SERVICE_TOKEN;
        # presenting SERVICE_SECRET here 401s and the segmented profile is
        # permanently refused.
        headers = {}
        if ROUTING_SERVICE_TOKEN:
            headers["Authorization"] = f"Bearer {ROUTING_SERVICE_TOKEN}"
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{self._base_url}/network/interfaces", headers=headers
            )
            if not resp.is_success:
                logger.warning(
                    "routing /network/interfaces returned %s: %s",
                    resp.status_code, resp.text,
                )
                resp.raise_for_status()
            data = resp.json()
        cameras = data.get("cameras") if isinstance(data, dict) else None
        if isinstance(cameras, dict) and "present" in cameras:
            return bool(cameras["present"])
        return None


async def run_provisioner_safe(profile_override: Optional[str] = None) -> ProvisionResult:
    """Run one reconcile against the current driver, swallowing ALL failures.

    This is the single entry both the lifespan background task and POST
    /provision call. No exception escapes (logged WARNING/ERROR) and the whole
    run is bounded by SWITCH_PROVISION_TIMEOUT so a hung switch can never block
    boot or wedge a request. Switch-absent and any error resolve to a
    ProvisionResult, never a raise.
    """
    cfg = build_provision_config()
    if profile_override:
        cfg.profile = profile_override
    routing = (
        RoutingCamerasCrossCheck(ROUTING_SERVICE_URL)
        if cfg.profile == "segmented"
        else None
    )
    try:
        result = await asyncio.wait_for(
            reconcile_switch(driver_instance, cfg, routing_client=routing),
            timeout=SWITCH_PROVISION_TIMEOUT,
        )
        # Stamp last_provisioned_at only when the switch was actually confirmed
        # at the managed layout: `applied` (ports moved) or `noop` (already
        # correct). `refused`/`skipped`/`error` did not leave the switch in a
        # known-good provisioned state, so we don't fabricate a stamp (rule 10).
        if result.get("status") in ("applied", "noop"):
            provision_state.stamp_provisioned_now()
        return ProvisionResult(**result)
    except asyncio.TimeoutError:
        logger.error(
            "provisioner: reconcile exceeded the %.0fs hard timeout — aborting "
            "(boot not blocked).",
            SWITCH_PROVISION_TIMEOUT,
        )
        return ProvisionResult(
            status="error",
            profile_applied=cfg.profile,
            skipped_reason=f"reconcile exceeded {SWITCH_PROVISION_TIMEOUT:.0f}s timeout",
        )
    except Exception as exc:  # never let provisioning escape into boot
        logger.error("provisioner: unexpected failure (%s) — no-op.", exc)
        return ProvisionResult(
            status="error",
            profile_applied=cfg.profile,
            skipped_reason=f"unexpected provisioner failure: {exc}",
        )


# ---------------------------------------------------------------------------
# Driver singleton
# ---------------------------------------------------------------------------
driver_instance: Optional[SwitchDriver] = None
# Background bring-up provisioning task — created in lifespan when
# SWITCH_AUTOPROVISION is on and the driver connected; cancelled on shutdown.
_provision_task: Optional["asyncio.Task[ProvisionResult]"] = None


def get_driver() -> SwitchDriver:
    """Return the driver singleton. Raises 503 if not connected."""
    if driver_instance is None:
        raise HTTPException(
            status_code=503,
            detail="Switch not connected. Check SWITCH_HOST and credentials.",
        )
    return driver_instance


def handle_switch_error(exc: SwitchError):
    """Convert driver exceptions to HTTP responses."""
    if isinstance(exc, ConnectionLost):
        raise HTTPException(status_code=503, detail=f"Switch unreachable: {exc}")
    if isinstance(exc, AuthenticationError):
        raise HTTPException(status_code=401, detail=f"Switch auth failed: {exc}")
    if isinstance(exc, InvalidPortError):
        raise HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, SwitchAPIError):
        status = 400 if exc.is_client_error else 500
        raise HTTPException(status_code=status, detail=str(exc))
    raise HTTPException(status_code=500, detail=f"Switch error: {exc}")


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global driver_instance, _provision_task
    try:
        driver_instance = create_driver()
        await driver_instance.connect()
        logger.info("Switch service ready (driver: %s, host: %s)", SWITCH_DRIVER, SWITCH_HOST)
    except Exception as exc:
        logger.warning("Could not connect to switch at %s: %s", SWITCH_HOST, exc)
        driver_instance = None

    # ADR-018 item 9: bring-up provisioning. Gated by SWITCH_AUTOPROVISION
    # (default off) AND only when the driver connected (switch-absent = no-op).
    # Runs as a NON-BLOCKING background task — the service finishes boot and
    # serves /health immediately; the reconcile is bounded by a hard timeout in
    # run_provisioner_safe and never raises. This is an event-driven one-shot
    # (boot), not a polling loop (rule 9).
    if autoprovision_enabled() and driver_instance is not None:
        logger.info(
            "provisioner: SWITCH_AUTOPROVISION on — scheduling bring-up reconcile "
            "(profile=%s) as a background task.",
            os.environ.get("SWITCH_VLAN_PROFILE", "flat-lan"),
        )
        _provision_task = asyncio.create_task(run_provisioner_safe())
    elif autoprovision_enabled():
        logger.info(
            "provisioner: SWITCH_AUTOPROVISION on but switch not connected — "
            "no-op (will run on POST /provision once reachable)."
        )

    yield

    # Cancel an in-flight provisioning task so shutdown isn't blocked by a
    # reconcile that's still waiting on the switch.
    if _provision_task is not None and not _provision_task.done():
        _provision_task.cancel()
        try:
            await _provision_task
        except (asyncio.CancelledError, Exception):
            pass

    if driver_instance:
        await driver_instance.disconnect()
        logger.info("Switch service stopped")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Droplet Switch Service",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(ServiceAuthMiddleware)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health", response_model=HealthResponse)
async def health():
    if driver_instance is None:
        return HealthResponse(
            status="disconnected",
            connected=False,
            switch_host=SWITCH_HOST,
            driver=SWITCH_DRIVER,
            error="Switch not connected at startup",
        )
    try:
        info = await driver_instance.get_system_info()
        return HealthResponse(
            status="ok",
            connected=True,
            switch_host=SWITCH_HOST,
            driver=SWITCH_DRIVER,
            system_info=info,
        )
    except SwitchError as exc:
        return HealthResponse(
            status="error",
            connected=False,
            switch_host=SWITCH_HOST,
            driver=SWITCH_DRIVER,
            error=str(exc),
        )


# ---------------------------------------------------------------------------
# Port Management
# ---------------------------------------------------------------------------
@app.get("/ports")
async def list_ports():
    try:
        ports = await get_driver().get_ports()
        return {"ports": ports}
    except SwitchError as exc:
        handle_switch_error(exc)


# NOTE: this static route MUST be declared before `/ports/{port}` so the
# integer path param doesn't capture the literal "status".
@app.get("/ports/status")
async def list_port_status():
    """Live link/speed per port (the real link source the §7 aggregation joins
    in — `/ports` carries only PVID/tagging on the Lantronix WebStaX firmware).
    """
    try:
        rows = await get_driver().get_port_status()
        return {"ports": rows}
    except SwitchError as exc:
        handle_switch_error(exc)


@app.get("/ports/{port}")
async def get_port(port: int):
    try:
        return await get_driver().get_port(port)
    except SwitchError as exc:
        handle_switch_error(exc)


@app.post("/ports/{port}/enable")
async def enable_port(port: int):
    try:
        await get_driver().set_port_enabled(port, True)
        return {"status": "ok", "port": port, "enabled": True}
    except SwitchError as exc:
        handle_switch_error(exc)


@app.post("/ports/{port}/disable")
async def disable_port(port: int):
    try:
        await get_driver().set_port_enabled(port, False)
        return {"status": "ok", "port": port, "enabled": False}
    except SwitchError as exc:
        handle_switch_error(exc)


# ---------------------------------------------------------------------------
# VLAN Management
# ---------------------------------------------------------------------------
@app.get("/vlans")
async def list_vlans():
    try:
        vlans = await get_driver().get_vlans()
        return {"vlans": vlans}
    except SwitchError as exc:
        handle_switch_error(exc)


@app.post("/vlans")
async def create_vlan(req: CreateVlanRequest):
    try:
        await get_driver().create_vlan(req.vlan_id, req.name)
        return {"status": "ok", "vlan_id": req.vlan_id, "name": req.name}
    except SwitchError as exc:
        handle_switch_error(exc)


@app.delete("/vlans/{vlan_id}")
async def delete_vlan(vlan_id: int):
    try:
        await get_driver().delete_vlan(vlan_id)
        return {"status": "ok", "vlan_id": vlan_id, "deleted": True}
    except SwitchError as exc:
        handle_switch_error(exc)


@app.get("/vlans/{vlan_id}/membership")
async def get_vlan_membership(vlan_id: int):
    try:
        return await get_driver().get_vlan_membership(vlan_id)
    except SwitchError as exc:
        handle_switch_error(exc)


@app.post("/vlans/{vlan_id}/membership")
async def set_vlan_membership(vlan_id: int, req: SetVlanMembershipRequest):
    try:
        membership = [
            {"port": p.port, "tagged": p.tagged, "member": p.member}
            for p in req.ports
        ]
        await get_driver().set_vlan_membership(vlan_id, membership)
        return {"status": "ok", "vlan_id": vlan_id, "ports_updated": len(membership)}
    except SwitchError as exc:
        handle_switch_error(exc)


# ---------------------------------------------------------------------------
# PoE Control
# ---------------------------------------------------------------------------
@app.get("/poe")
async def poe_status():
    try:
        status = await get_driver().get_poe_status()
        return {"ports": status}
    except SwitchError as exc:
        handle_switch_error(exc)


@app.get("/poe/{port}")
async def get_port_poe(port: int):
    try:
        return await get_driver().get_port_poe(port)
    except SwitchError as exc:
        handle_switch_error(exc)


@app.post("/poe/{port}/enable")
async def enable_port_poe(port: int):
    try:
        await get_driver().set_port_poe(port, True)
        return {"status": "ok", "port": port, "poe_enabled": True}
    except SwitchError as exc:
        handle_switch_error(exc)


@app.post("/poe/{port}/disable")
async def disable_port_poe(port: int):
    try:
        await get_driver().set_port_poe(port, False)
        return {"status": "ok", "port": port, "poe_enabled": False}
    except SwitchError as exc:
        handle_switch_error(exc)


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------
@app.get("/system/info")
async def system_info():
    try:
        return await get_driver().get_system_info()
    except SwitchError as exc:
        handle_switch_error(exc)


# ---------------------------------------------------------------------------
# WAN Detection
# ---------------------------------------------------------------------------
@app.post("/wan/detect")
async def detect_wan():
    try:
        return await get_driver().detect_wan_port()
    except SwitchError as exc:
        handle_switch_error(exc)


# ---------------------------------------------------------------------------
# Camera Setup (one-click: create VLAN + assign ports)
# ---------------------------------------------------------------------------
@app.post("/setup/cameras", response_model=CameraSetupResult)
async def setup_cameras(req: CameraSetupRequest):
    """One-click camera VLAN setup on the managed switch.

    1. Create camera VLAN (default: 100)
    2. Assign camera ports as untagged members
    3. Assign uplink ports as tagged members (trunk)
    """
    driver = get_driver()
    try:
        # Step 1: Create VLAN
        try:
            await driver.create_vlan(req.vlan_id, "cameras")
            logger.info("Created VLAN %d for cameras", req.vlan_id)
        except SwitchAPIError as e:
            if "exist" in str(e).lower():
                logger.info("VLAN %d already exists", req.vlan_id)
            else:
                raise

        # Step 2: Set port membership
        membership = []
        for port in req.camera_ports:
            membership.append({"port": port, "tagged": False, "member": True})
        for port in req.uplink_ports:
            membership.append({"port": port, "tagged": True, "member": True})

        await driver.set_vlan_membership(req.vlan_id, membership)
        logger.info(
            "Camera VLAN %d: %d camera ports + %d uplink ports",
            req.vlan_id,
            len(req.camera_ports),
            len(req.uplink_ports),
        )

        return CameraSetupResult(
            status="ok",
            vlan_id=req.vlan_id,
            camera_ports=req.camera_ports,
            uplink_ports=req.uplink_ports,
            message=f"VLAN {req.vlan_id} configured: ports {req.camera_ports} (untagged) + {req.uplink_ports} (tagged trunk)",
        )

    except SwitchError as exc:
        handle_switch_error(exc)
        # handle_switch_error always raises, but type checker needs this
        raise  # unreachable


# ---------------------------------------------------------------------------
# Provision config echo (ADR-018 item 12) — read-only, feeds §7 /api/switch/status
# ---------------------------------------------------------------------------
@app.get("/provision/config", response_model=ProvisionConfigResponse)
async def provision_config():
    """Echo the parsed bring-up provisioning config + persisted state.

    Pure config/state read — answers even when the switch is disconnected, so
    the orchestrator can render the panel header (model/profile/budget/auto)
    without a live switch. All desired-state values come from EXPLICIT env
    (build_provision_config); auto_managed mirrors SWITCH_AUTOPROVISION;
    last_provisioned_at is the persisted reconcile stamp (None if never run).
    """
    cfg = build_provision_config()
    return ProvisionConfigResponse(
        vlan_profile=cfg.profile,
        auto_managed=autoprovision_enabled(),
        protected_port=cfg.protected_port,
        camera_ports=cfg.camera_ports,
        ap_ports=cfg.ap_ports,
        client_ports=cfg.client_ports,
        poe_budget_w=POE_BUDGET_W,
        last_provisioned_at=provision_state.read_last_provisioned_at(),
    )


# ---------------------------------------------------------------------------
# Bring-up Provisioning (ADR-018 item 9) — event-driven re-run
# ---------------------------------------------------------------------------
@app.post("/provision", response_model=ProvisionResult)
async def provision(req: Optional[ProvisionRequest] = None):
    """Re-run the bring-up provisioner on demand (event-driven, no busy loop).

    Reconciles the switch to the explicit desired VLAN state. This is the same
    routine the lifespan runs on boot; exposing it lets an event (e.g. a switch
    coming online after the service started, or an AP being plugged in) trigger
    a fresh reconcile without polling. Best-effort: a missing/unreadable switch
    returns a `skipped` result with HTTP 200, never a 503 — provisioning is not
    a request the caller needs to succeed synchronously.
    """
    profile_override = req.profile if req else None
    return await run_provisioner_safe(profile_override=profile_override)
