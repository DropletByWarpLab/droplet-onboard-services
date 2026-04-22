"""
Droplet TFT Display Service
=============================
FastAPI wrapper for the 480x320 PyPortal Titano (ILI9341) TFT display.
Exposes REST endpoints for the orchestrator and AI gateway to control
what's shown on the physical display and to read / simulate touch input.

The visual system mirrors apps/web-dashboard (dark mode) so the on-device
screen is a compact version of the admin UI. Touch tiles on the home
screen route to Health, Network, Chat and Settings sub-screens.
"""

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
from PIL import Image

from display import TFTDisplay, SIM_OUTPUT, WIDTH, HEIGHT
from touch import TouchReader

logger = logging.getLogger("droplet.tft")
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# Service-to-service authentication
# ---------------------------------------------------------------------------
SERVICE_SECRET = os.environ.get("SERVICE_SECRET", "")
if not SERVICE_SECRET:
    logger.warning("SERVICE_SECRET not set - all endpoints are unauthenticated.")


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        if SERVICE_SECRET:
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


MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8 MB


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


@app.post("/display/custom")
async def show_custom(file: UploadFile = File(...)):
    if not display:
        raise HTTPException(503, "Display not initialized")
    try:
        data = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Image too large (max 8MB)")
        image = Image.open(io.BytesIO(data))
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
    # Also push to PyPortal so the on-screen list refreshes immediately
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
