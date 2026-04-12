"""
Droplet OLED Display Service
==============================
FastAPI wrapper for the 128x128 SSD1351 OLED display.
Exposes REST endpoints for the orchestrator and AI gateway to control
what's shown on the physical display.
"""

import os
import io
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional
from PIL import Image

from display import OLEDDisplay, SIM_OUTPUT

logger = logging.getLogger("droplet.oled")
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# Service-to-service authentication
# ---------------------------------------------------------------------------
SERVICE_SECRET = os.environ.get("SERVICE_SECRET", "")
if not SERVICE_SECRET:
    logger.warning("SERVICE_SECRET not set — all endpoints are unauthenticated.")


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
                return JSONResponse(status_code=401, content={"error": "unauthorized"})
        return await call_next(request)


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
display: Optional[OLEDDisplay] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global display
    display = OLEDDisplay()
    display.start_cycle()
    logger.info("OLED display service started (simulated=%s)", display._simulated)
    yield
    display.stop_cycle()
    logger.info("OLED display service stopped")


app = FastAPI(title="Droplet OLED Display Service", lifespan=lifespan)
app.add_middleware(ServiceAuthMiddleware)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class MessageRequest(BaseModel):
    title: str = Field(..., max_length=20, description="Header text")
    lines: List[str] = Field(..., max_length=7, description="Body lines (max 7)")


class BrightnessRequest(BaseModel):
    value: int = Field(..., ge=0, le=255, description="Brightness 0-255")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"status": "ok", "service": "oled-display", "simulated": display._simulated if display else True}


@app.get("/display/status")
async def get_status():
    if not display:
        raise HTTPException(503, "Display not initialized")
    return display.get_status()


@app.post("/display/stats")
async def show_stats():
    """Switch to the device stats screen."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.resume_cycle()
    display.show_stats()
    return {"ok": True, "mode": "stats"}


@app.post("/display/logo")
async def show_logo():
    """Switch to the full-screen logo."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_logo()
    return {"ok": True, "mode": "logo"}


@app.post("/display/message")
async def show_message(req: MessageRequest):
    """Show a custom message (pauses auto-cycle for 30s)."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_message(req.title, req.lines)
    return {"ok": True, "mode": "message", "hold_seconds": 30}


@app.post("/display/custom")
async def show_custom(file: UploadFile = File(...)):
    """Upload a custom image to display (resized to 128x128)."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    try:
        data = await file.read()
        image = Image.open(io.BytesIO(data))
        display.show_custom_image(image)
        return {"ok": True, "mode": "custom"}
    except Exception as e:
        raise HTTPException(400, f"Invalid image: {e}")


@app.post("/display/brightness")
async def set_brightness(req: BrightnessRequest):
    """Set display brightness (0-255)."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.set_brightness(req.value)
    return {"ok": True, "brightness": req.value}


@app.post("/display/cycle/resume")
async def resume_cycle():
    """Resume auto-cycling immediately."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.resume_cycle()
    return {"ok": True, "cycling": True}


@app.post("/display/cycle/stop")
async def stop_cycle():
    """Stop auto-cycling (pin current screen)."""
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.stop_cycle()
    return {"ok": True, "cycling": False}


@app.get("/display/preview")
async def get_preview():
    """Return the current simulated frame as PNG (dev/debug only)."""
    if not display or not display._simulated:
        raise HTTPException(404, "Preview only available in simulated mode")
    if not SIM_OUTPUT.exists():
        raise HTTPException(404, "No frame rendered yet")
    return FileResponse(str(SIM_OUTPUT), media_type="image/png")
