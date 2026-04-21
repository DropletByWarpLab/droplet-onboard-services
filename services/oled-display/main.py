"""
Droplet TFT Display Service
=============================
FastAPI wrapper for the 480x320 ILI9481 TFT display (with XPT2046 touch).
Exposes REST endpoints for the orchestrator and AI gateway to control what's
shown on the physical display and to read touch input.
"""

# GPIO shim must run BEFORE any import that might `import RPi.GPIO` (luma.core
# does this transitively via `display.py` -> `luma.core.interface.serial.spi`).
# On a Jetson it aliases Jetson.GPIO as RPi.GPIO and sets BOARD pin mode, so
# DC_PIN=18 / RST_PIN=22 etc. map to the physical pins of the 40-pin header —
# the same way they do on a real Pi.
import gpio_shim  # noqa: F401  -- import-for-side-effect (must come before luma.core)

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
    display.start_cycle()
    touch = TouchReader(width=WIDTH, height=HEIGHT)
    touch.start()
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


# Upload ceiling - bigger panel warrants a bigger ceiling, but still bounded.
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


@app.post("/display/stats")
async def show_stats():
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.resume_cycle()
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
    """Upload a custom image (resized to panel resolution, max 8 MB)."""
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
    if not display or display._backend != "sim":
        raise HTTPException(404, "Preview only available in simulated mode")
    if not SIM_OUTPUT.exists():
        raise HTTPException(404, "No frame rendered yet")
    return FileResponse(str(SIM_OUTPUT), media_type="image/png")


# ---------------------------------------------------------------------------
# Touch endpoints
# ---------------------------------------------------------------------------
@app.get("/touch/state")
async def touch_state():
    """Current touch state: pressed flag, last (x,y), press/release counters."""
    if not touch:
        raise HTTPException(503, "Touch not initialized")
    return touch.get_state()
