"""
Droplet Switch Service
======================
FastAPI wrapper around the abstract SwitchDriver, exposing managed switch
control as a REST API for the orchestrator and AI gateway to consume.

The driver implementation is selected at startup via SWITCH_DRIVER env var.
Lantronix SM8TAT2SA is the prototype driver. When the custom PCB ASIC is
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
import logging
from contextlib import asynccontextmanager
from typing import Optional

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
from schemas import (
    HealthResponse,
    CreateVlanRequest,
    SetVlanMembershipRequest,
    CameraSetupRequest,
    CameraSetupResult,
)

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

# Smart-port watcher: opt-in via env so the existing single-VLAN POC keeps
# booting cleanly even without an MQTT broker in scope. The watcher itself
# also tolerates broker-down (logs once, does not crash the switch service).
SMART_PORT_WATCHER_ENABLED = (
    os.environ.get("SMART_PORT_WATCHER_ENABLED", "0") == "1"
)
MQTT_BROKER = os.environ.get("MQTT_BROKER_LOCAL") or os.environ.get(
    "MQTT_BROKER", "mqtt://mosquitto:1883"
)

# ---------------------------------------------------------------------------
# Driver singleton
# ---------------------------------------------------------------------------
driver_instance: Optional[SwitchDriver] = None
watcher_instance: Optional["SmartPortWatcher"] = None  # noqa: F821 — forward ref


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
    global driver_instance, watcher_instance
    try:
        driver_instance = create_driver()
        await driver_instance.connect()
        logger.info("Switch service ready (driver: %s, host: %s)", SWITCH_DRIVER, SWITCH_HOST)
    except Exception as exc:
        logger.warning("Could not connect to switch at %s: %s", SWITCH_HOST, exc)
        driver_instance = None

    if SMART_PORT_WATCHER_ENABLED and driver_instance is not None:
        # Import lazily so a broken paho-mqtt install can't crash the whole
        # service — we'd rather lose the watcher than the REST surface.
        try:
            from watcher import SmartPortWatcher

            watcher_instance = SmartPortWatcher(driver_instance, MQTT_BROKER)
            await watcher_instance.start()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Smart-port watcher failed to start: %s", exc)
            watcher_instance = None

    yield

    if watcher_instance is not None:
        await watcher_instance.stop()
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
