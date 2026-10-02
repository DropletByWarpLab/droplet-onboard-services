"""
Droplet Device Gateway
======================
Commercial and industrial device control over BACnet/IP, Modbus TCP, SNMP
and KNX/IP, for the orchestrator to consume. Lives on the Vault's LAN side
(network_mode: host — BACnet Who-Is and KNX routing are broadcast/multicast)
and is never reachable from the WAN/Edge subsystem.

Three layers keep a write from moving equipment by accident:
  1. registry.py — only registered points exist; a point is writable only
     when explicitly marked, and a writable number carries min/max.
  2. guard.py — every write is re-validated here, at the layer that performs
     it, regardless of what the caller checked.
  3. DEVICE_GATEWAY_LIVE_WRITES — off by default: writes are planned and
     returned (`applied: false`) but never sent until an operator turns it on.
The orchestrator adds the fourth: Tier-2 human confirmation and an audit row
that must be written before the write is sent.
"""

import sys as _sys

# WARP-229: FIPS 140-3 boot self-test. Env-gated; see
# services/_shared/fips_selftest.py for the contract.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("device-gateway")
except ImportError:
    pass

import asyncio
import hmac
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal, Optional, Union

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.middleware.base import BaseHTTPMiddleware

import templates
from drivers import create_drivers
from drivers.base import DeviceUnreachable, DiscoveryUnsupported, ProtocolDriver, ProtocolError
from guard import PointNotFound, WriteRejected, plan_write
from registry import PROTOCOLS, Registry, public, validate_device

logger = logging.getLogger("droplet.device-gateway")
logging.basicConfig(level=logging.INFO)


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Service-to-service authentication — fails CLOSED (switch/routing contract).
# This service runs network_mode: host, so a failed secret injection must not
# leave device writes open to the LAN. DEVICE_GATEWAY_ALLOW_NO_AUTH=1 is for
# local dev only.
# ---------------------------------------------------------------------------
SERVICE_SECRET = os.environ.get("SERVICE_SECRET", "")
ALLOW_NO_AUTH = _flag("DEVICE_GATEWAY_ALLOW_NO_AUTH")
if not SERVICE_SECRET:
    if ALLOW_NO_AUTH:
        logger.warning("SERVICE_SECRET empty and DEVICE_GATEWAY_ALLOW_NO_AUTH set — auth disabled (dev only)")
    else:
        logger.error("SERVICE_SECRET empty — failing closed (403) on all non-/health routes")

# Explicit boolean, never derived: plan-only unless an operator opts in.
LIVE_WRITES = _flag("DEVICE_GATEWAY_LIVE_WRITES")
TIMEOUT_S = float(os.environ.get("DEVICE_GATEWAY_TIMEOUT_S", "3"))
REGISTRY_PATH = os.environ.get(
    "DEVICE_GATEWAY_REGISTRY_PATH", "/var/lib/droplet/device-gateway/registry.json"
)


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        if not SERVICE_SECRET:
            if ALLOW_NO_AUTH:
                return await call_next(request)
            return JSONResponse(
                status_code=403,
                content={"error": "Device gateway auth is not configured (SERVICE_SECRET unset)."},
            )
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(token, SERVICE_SECRET):
            return JSONResponse(status_code=403, content={"error": "Invalid or missing service token"})
        return await call_next(request)


class State:
    registry: Optional[Registry] = None
    drivers: dict[str, ProtocolDriver] = {}
    locks: dict[str, asyncio.Lock] = {}


state = State()


def _lock(device_id: str) -> asyncio.Lock:
    """One request at a time per device: many field devices take one client."""
    lock = state.locks.get(device_id)
    if lock is None:
        lock = state.locks[device_id] = asyncio.Lock()
    return lock


@asynccontextmanager
async def lifespan(app: FastAPI):
    if state.registry is None:
        state.registry = Registry(REGISTRY_PATH)
    if not state.drivers:
        state.drivers = create_drivers(TIMEOUT_S)
    for driver in state.drivers.values():
        await driver.start()
    logger.info(
        "device gateway up: %d devices, live writes %s",
        len(state.registry.all()), "ON" if LIVE_WRITES else "off (plan-only)",
    )
    try:
        yield
    finally:
        for driver in state.drivers.values():
            await driver.stop()


app = FastAPI(title="Droplet Device Gateway", lifespan=lifespan)
app.add_middleware(ServiceAuthMiddleware)


def _registry() -> Registry:
    if state.registry is None:
        raise HTTPException(503, "registry not loaded")
    return state.registry


def _device(device_id: str):
    device = _registry().get(device_id)
    if device is None:
        raise HTTPException(404, f"no device {device_id}")
    return device


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.get("/health")
async def health():
    reg = state.registry
    return {
        "status": "ok",
        "live_writes": LIVE_WRITES,
        "protocols": list(PROTOCOLS),
        "devices": len(reg.all()) if reg else 0,
    }


@app.get("/templates")
async def list_templates():
    return {"templates": templates.listing()}


@app.get("/devices")
async def list_devices():
    return {"devices": [public(d) for d in _registry().all()]}


@app.get("/devices/{device_id}")
async def get_device(device_id: str):
    return public(_device(device_id))


@app.put("/devices/{device_id}")
async def put_device(device_id: str, body: dict):
    if body.get("id", device_id) != device_id:
        raise HTTPException(400, "body id does not match the path")
    try:
        device = validate_device(templates.apply_template({**body, "id": device_id}))
    except ValidationError as e:
        raise HTTPException(422, e.errors(include_url=False, include_context=False, include_input=False))
    except ValueError as e:
        raise HTTPException(422, str(e))
    created = _registry().put(device)
    return JSONResponse(status_code=201 if created else 200, content=public(_registry().get(device_id)))


@app.delete("/devices/{device_id}", status_code=204)
async def delete_device(device_id: str):
    if not _registry().delete(device_id):
        raise HTTPException(404, f"no device {device_id}")
    state.locks.pop(device_id, None)


@app.get("/devices/{device_id}/values")
async def read_values(device_id: str):
    device = _device(device_id)
    driver = state.drivers[device.protocol]
    async with _lock(device_id):
        try:
            readings = await driver.read_points(device, list(device.points))
        except DeviceUnreachable as e:
            raise HTTPException(502, {"error": "unreachable", "detail": str(e)})
        except ProtocolError as e:
            raise HTTPException(502, {"error": "protocol_error", "detail": str(e)})
    return {
        "device_id": device_id,
        "read_at": _now(),
        "values": {pid: r.as_dict() for pid, r in readings.items()},
    }


class WriteBody(BaseModel):
    value: Union[bool, float, int, str]


@app.post("/devices/{device_id}/points/{point_id}/write")
async def write_value(device_id: str, point_id: str, body: WriteBody):
    device = _device(device_id)
    try:
        plan = plan_write(device, point_id, body.value)
    except PointNotFound as e:
        raise HTTPException(404, str(e))
    except WriteRejected as e:
        raise HTTPException(422, {"error": "write_rejected", "detail": str(e)})
    if not LIVE_WRITES:
        return {"applied": False, "live_writes": False, "plan": plan.as_dict()}
    driver = state.drivers[device.protocol]
    point = device.point(point_id)
    async with _lock(device_id):
        try:
            await driver.write_point(device, point, plan.value)
        except DeviceUnreachable as e:
            raise HTTPException(502, {"error": "unreachable", "detail": str(e)})
        except ProtocolError as e:
            raise HTTPException(502, {"error": "protocol_error", "detail": str(e)})
        logger.info("write %s/%s = %r", device_id, point_id, plan.value)
        # Read back so the caller reports what the device holds, not what we sent.
        try:
            readback = (await driver.read_points(device, [point])).get(point_id)
        except (DeviceUnreachable, ProtocolError) as e:
            readback = None
            logger.warning("readback %s/%s failed: %s", device_id, point_id, e)
    return {
        "applied": True,
        "live_writes": True,
        "plan": plan.as_dict(),
        "readback": readback.as_dict() if readback else None,
        "written_at": _now(),
    }


class DiscoverBody(BaseModel):
    protocol: Literal["bacnet", "modbus", "snmp", "knx"]
    timeout: float = Field(default=3.0, gt=0, le=15)


@app.post("/discover")
async def discover(body: DiscoverBody):
    try:
        found = await state.drivers[body.protocol].discover(body.timeout)
    except DiscoveryUnsupported as e:
        raise HTTPException(400, {"error": "discovery_unsupported", "detail": str(e)})
    known = {(d.protocol, d.address) for d in _registry().all()}
    for f in found:
        f["registered"] = (f["protocol"], f["address"]) in known
    return {"protocol": body.protocol, "found": found}
