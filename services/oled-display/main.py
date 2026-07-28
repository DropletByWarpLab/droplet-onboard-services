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
from pydantic import BaseModel, Field, model_validator
from PIL import Image, UnidentifiedImageError

from display import TFTDisplay, SIM_OUTPUT, WIDTH, HEIGHT, BACKEND

# WARP-1640 — touch source depends on the panel. The PyPortal sent
# `TOUCH:x,y,pressure` back up the serial link (so touch.py is a no-op shim
# and display.py's cycle loop parses the events), whereas the rack panel's
# touchscreen is a separate USB HID device we read from /dev/input directly.
# Both expose the same start/stop/get_state contract, so nothing below cares.
if BACKEND == "fb":
    from touch_evdev import TouchReader
else:
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
    # M1 (WARP-624): render the shutdown frame from here as a best-effort
    # fallback. The systemd ExecStop oneshot only fires on a systemd-driven
    # halt; `docker compose down`, a container crash/OOM, or a host without
    # the unit would otherwise freeze the last live frame on the panel — the
    # exact "stale frame" this feature set out to fix. This runs inside the
    # container before teardown, so it covers every teardown path. It MUST be
    # best-effort: show_shutdown() bounds its own serial write, and we swallow
    # any error so a display fault can never wedge container shutdown.
    try:
        display.show_shutdown(reason="System stopping", phase="stopping")
    except Exception as e:  # noqa: BLE001
        logger.warning("shutdown-frame fallback failed (non-fatal): %s", e)
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


class ClaimRequest(BaseModel):
    # WARP-632 / ADR-017: the orchestrator mints the claim code and pushes it
    # here while the box is unclaimed. `code` is the DRPL-XXXX-XXXX plaintext
    # (already grouped for the lid); `setup_url` is where the customer points
    # their phone. Bounds are generous but cap obvious abuse on this LAN-only,
    # SERVICE_SECRET-guarded endpoint.
    code: str = Field(..., min_length=1, max_length=32, description="Claim code")
    setup_url: str = Field(..., max_length=200, description="Setup wizard URL")
    # WARP-819: optional Wi-Fi-connect creds so the claim screen ALSO shows how
    # to join the box's Wi-Fi with no prior config — the host-encoded QR
    # bit-matrix (the firmware never encodes on-device) plus the SSID and
    # plaintext PSK for the readable "type-it" text under the QR. All optional
    # and backward-compatible: an older orchestrator that omits them renders the
    # original claim-only layout. The matrix is capped (a v-large QR would OOM
    # the PyPortal); a Wi-Fi WPA2 join QR is small (≤ ~33x33), so 64 is headroom.
    wifi_qr_matrix: Optional[List[List[int]]] = Field(
        None, max_length=64, description="Host-encoded Wi-Fi QR bit-matrix (0/1 rows)")
    wifi_ssid: Optional[str] = Field(
        None, max_length=64, description="AP SSID for the readable creds line")
    wifi_psk: Optional[str] = Field(
        None, max_length=128, description="AP WPA2 passphrase for the readable creds line")

    @model_validator(mode="after")
    def _wifi_fields_all_or_nothing(self) -> "ClaimRequest":
        """Reject a PARTIAL Wi-Fi block (WARP-819).

        The three wifi_* fields are individually Optional only so a claim push
        can omit the whole block (graceful degradation to the claim-only
        layout). A partial block is a footgun: an ssid with no psk would render
        a blank-password QR (`WIFI:T:WPA;S:Droplet;P:;;`) — an unjoinable,
        named-but-open network, the same hazard the bridge boot-race guard
        prevents. So all three must be present TOGETHER or none at all. An empty
        string counts as absent: a present-but-empty psk is exactly the
        blank-password case we must refuse, and the matrix must be non-empty to
        paint anything.
        """
        present = (
            bool(self.wifi_qr_matrix),       # non-empty matrix
            bool(self.wifi_ssid),            # non-empty ssid
            bool(self.wifi_psk),             # non-empty psk
        )
        if any(present) and not all(present):
            raise ValueError(
                "wifi_qr_matrix, wifi_ssid and wifi_psk must all be provided "
                "together (and be non-empty) — a partial Wi-Fi block would "
                "render a blank-password QR")
        return self


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


@app.post("/display/system")
async def show_system():
    """Navigate the panel to the combined System + Wi-Fi screen (py-v3).

    Bare-nav endpoint the orchestrator's screen-qr poller calls once the box is
    claimed, so the panel leaves the modal claim screen and shows the live UI.
    """
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_system()
    return {"ok": True, "mode": "system"}


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


@app.post("/display/claim")
async def show_claim(req: ClaimRequest):
    """Show the onboarding claim screen (WARP-632 / ADR-017).

    Driven by the orchestrator's screen-qr service while the box is unclaimed:
    it mints the claim code and pushes it here. We render a dedicated `claim`
    mode on the PyPortal (large code + setup URL) — NOT the preview-only
    /display/custom image path. SERVICE_SECRET-guarded like the other display
    routes (the middleware enforces the bearer).
    """
    if not display:
        raise HTTPException(503, "Display not initialized")
    display.show_claim(
        req.code, req.setup_url,
        wifi_ssid=req.wifi_ssid,
        wifi_psk=req.wifi_psk,
        wifi_qr_matrix=req.wifi_qr_matrix,
    )
    return {"ok": True, "mode": "claim"}


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
