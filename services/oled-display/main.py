"""
Droplet TFT Display Service
=============================
FastAPI wrapper for the 480x320 status display (ILI9341) TFT.
Exposes REST endpoints for the orchestrator and AI gateway to control
what's shown on the physical display and to read / simulate touch input.

The visual system mirrors apps/web-dashboard (dark mode) so the on-device
screen is a compact version of the admin UI. Touch tiles on the home
screen route to Health, Network, Chat and Settings sub-screens.
"""

import sys as _sys

# WARP-229: FIPS 140-3 boot self-test. Env-gated; see
# services/_shared/fips_selftest.py for the contract.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("oled-display")
except ImportError:
    pass

import os
import io
import hmac
import logging
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
from PIL import Image, UnidentifiedImageError

from display import TFTDisplay, SIM_OUTPUT, WIDTH, HEIGHT
from touch import TouchReader

logger = logging.getLogger("droplet.tft")
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# Service-to-service authentication
# ---------------------------------------------------------------------------
# Fail closed: refuse to start with an empty secret so a misprovisioned
# deployment (compose run without setup.sh having seeded DEVICE_SECRET_KEY)
# can't ship wide open on the LAN. Host-mode uvicorn binds 0.0.0.0:8082, so
# a silent empty secret would let any LAN host hit /display/*, /touch/*,
# /wifi/connect directly. Only /health is public.
SERVICE_SECRET = os.environ.get("SERVICE_SECRET", "")
if not SERVICE_SECRET:
    raise RuntimeError(
        "SERVICE_SECRET is required — refusing to start the display service "
        "without an auth secret. Set SERVICE_SECRET (or DEVICE_SECRET_KEY) in "
        "the environment; scripts/setup.sh provisions this automatically."
    )


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip()
        if not hmac.compare_digest(token, SERVICE_SECRET):
            return JSONResponse(status_code=401, content={"error": "unauthorized"})
        return await call_next(request)


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
display: Optional[TFTDisplay] = None
touch: Optional[TouchReader] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global display, touch
    display = TFTDisplay()
    touch = TouchReader(width=WIDTH, height=HEIGHT)
    touch.start()
    # Wire touch -> display so the cycle loop can consume events.
    display.bind_touch_source(touch)
    display.start_cycle()
    logger.info("TFT display service started (backend=%s, touch=%s)",
                display._backend, touch._backend)
    yield
    display.stop_cycle()
    touch.stop()
    logger.info("TFT display service stopped")


app = FastAPI(title="Droplet TFT Display Service", lifespan=lifespan)
app.add_middleware(ServiceAuthMiddleware)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class MessageRequest(BaseModel):
    title: str = Field(..., max_length=40, description="Header text")
    lines: List[str] = Field(..., max_length=10, description="Body lines (max 10)")


class BrightnessRequest(BaseModel):
    value: int = Field(..., ge=0, le=255, description="Brightness 0-255")


class TapRequest(BaseModel):
    x: int = Field(..., ge=0, le=WIDTH - 1)
    y: int = Field(..., ge=0, le=HEIGHT - 1)


class WifiConnectRequest(BaseModel):
    ssid: str = Field(..., min_length=1, max_length=64)
    password: str = Field("", max_length=128)


class BootRequest(BaseModel):
    stage: str = Field(..., max_length=48, description="Current boot stage caption")
    detail: str = Field("", max_length=54, description="Optional detail line")
    pct: Optional[int] = Field(
        None, ge=0, le=100,
        description="Progress 0-100; omit for an indeterminate band")


class ShutdownRequest(BaseModel):
    reason: str = Field("", max_length=54, description="Why we're shutting down")
    phase: str = Field(
        "stopping", max_length=16,
        description="'stopping' (in progress) or 'halted' (safe to power off)")


MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8 MB
# Cap decoded pixel count to prevent PIL decompression-bomb DoS — an 8 MB
# PNG/TIFF can balloon to multi-GB on decode and OOM the container. 24 MP
# covers any realistic upload (the panel itself is 480x320 = 0.15 MP).
MAX_IMAGE_PIXELS = 24_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
ALLOWED_IMAGE_FORMATS = {"PNG", "JPEG", "BMP", "GIF"}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "tft-display",
        "backend": display._backend if display else "uninitialized",
        "resolution": f"{WIDTH}x{HEIGHT}",
    }


@app.get("/display/status")
async def get_status():
    if not display:
        raise HTTPException(503, "Display not initialized")
    return display.get_status()


@app.post("/display/home")
async def show_home():
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_home()
    return {"ok": True, "mode": "home"}


@app.post("/display/stats")
async def show_stats():
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_stats()
    return {"ok": True, "mode": "stats"}


@app.post("/display/logo")
async def show_logo():
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_logo()
    return {"ok": True, "mode": "logo"}


@app.post("/display/message")
async def show_message(req: MessageRequest):
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_message(req.title, req.lines)
    return {"ok": True, "mode": "message", "hold_seconds": 30}


@app.post("/display/boot")
async def show_boot(req: BootRequest):
    """Show the boot/startup screen with a stage caption + optional progress.

    The boot screen is otherwise self-driven (the service opens on it and the
    readiness loop clears it); this endpoint lets the host's startup
    orchestration push finer-grained stage/progress updates while the stack
    comes up.
    """
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_boot(req.stage, req.detail, req.pct)
    return {"ok": True, "mode": "boot"}


@app.post("/display/shutdown")
async def show_shutdown(req: ShutdownRequest):
    """Show the shutdown screen and freeze the panel on it.

    Driven by the host's systemd ExecStop oneshot (droplet-shutdown-screen)
    at teardown so the last thing on the panel is "Shutting down" rather than
    a frozen live screen. `phase=halted` switches the copy to
    "Safe to power off".
    """
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_shutdown(req.reason, req.phase)
    return {"ok": True, "mode": "shutdown"}


@app.post("/display/custom")
async def show_custom(file: UploadFile = File(...)):
    if not display:
        raise HTTPException(503, "Display not initialized")
    try:
        data = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Image too large (max 8MB)")

        # Two-pass decode: verify() validates structure and raises on
        # malformed/truncated data before committing to a full decode.
        # Re-open afterwards because verify() leaves the image unusable.
        try:
            probe = Image.open(io.BytesIO(data))
            probe.verify()
            fmt = (probe.format or "").upper()
        except (UnidentifiedImageError, Image.DecompressionBombError) as e:
            raise HTTPException(400, f"Invalid image: {e}")

        if fmt not in ALLOWED_IMAGE_FORMATS:
            raise HTTPException(415, f"Unsupported image format: {fmt or 'unknown'}")

        try:
            image = Image.open(io.BytesIO(data))
            # image.size is available without decoding the full pixel buffer.
            w, h = image.size
            if w * h > MAX_IMAGE_PIXELS:
                raise HTTPException(413, "Image dimensions exceed limit")
        except Image.DecompressionBombError as e:
            raise HTTPException(413, f"Image dimensions exceed limit: {e}")

        display.show_custom_image(image)
        return {"ok": True, "mode": "custom"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Invalid image: {e}")


@app.post("/display/brightness")
async def set_brightness(req: BrightnessRequest):
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.set_brightness(req.value)
    return {"ok": True, "brightness": req.value}


@app.post("/display/cycle/resume")
async def resume_cycle():
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.resume_cycle()
    return {"ok": True, "cycling": True}


@app.post("/display/cycle/stop")
async def stop_cycle():
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.stop_cycle()
    return {"ok": True, "cycling": False}


@app.get("/display/preview")
async def get_preview():
    """Download the last rendered frame as PNG.

    Both `sim` and `pyportal` backends always write SIM_OUTPUT so the
    preview is available to the dashboard regardless of which is active.
    """
    if not display:
        raise HTTPException(503, "Display not initialized")
    if not SIM_OUTPUT.exists():
        raise HTTPException(404, "No frame rendered yet")
    return FileResponse(str(SIM_OUTPUT), media_type="image/png")


# ---------------------------------------------------------------------------
# Touch endpoints
# ---------------------------------------------------------------------------
@app.get("/touch/state")
async def touch_state():
    if not touch:
        raise HTTPException(503, "Touch not initialized")
    return touch.get_state()


@app.post("/touch/tap")
async def simulate_tap(req: TapRequest):
    """Simulate a tap at (x, y) — useful for the preview harness and
    end-to-end tests on hosts without a real panel connected."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    hit = display.handle_touch(req.x, req.y)
    return {"ok": True, "hit": hit, "x": req.x, "y": req.y}


@app.get("/wifi/scan")
async def wifi_scan():
    """Return the latest wifi scan snapshot from the host helper."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    snap = display.fetch_wifi()
    if snap is None:
        raise HTTPException(502, "Wi-Fi helper unreachable")
    # Also push to the status display so the on-screen list refreshes immediately
    display._pyportal_send("wifi", snap)
    return snap


@app.post("/wifi/connect")
async def wifi_connect(req: WifiConnectRequest):
    if not display:
        raise HTTPException(503, "Display not initialized")
    result = display.connect_wifi(req.ssid, req.password)
    return result


@app.get("/touch/regions")
async def touch_regions():
    """List the currently-active tap targets (name + bounding box).

    Handy for building HTML previews that overlay clickable hotspots on
    the rendered PNG frame."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    return {
        "regions": [
            {"name": r.name, "x": r.x, "y": r.y, "w": r.w, "h": r.h}
            for r in display._touch_regions
        ],
    }
