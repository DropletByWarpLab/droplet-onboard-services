"""
Droplet TFT Display Driver
===========================
Drives the front-panel 480x320 TFT via an Adafruit PyPortal Titano connected
over USB-serial. The PyPortal's own SAMD51 + ILI9341 handles rendering; this
module streams JSON commands over /dev/ttyACM* and mirrors every frame to a
preview PNG so the dashboard can show what's on the panel.

Backends:
  1. pyportal   - USB-serial to an Adafruit PyPortal Titano (primary)
  2. simulated  - writes a PNG to SIM_OUTPUT (dev/CI fallback, auto-used
                  when no PyPortal is present)

The direct-SPI / luma.lcd / fbtft-framebuffer paths were removed after the
pivot to PyPortal (Tegra's GPIO/SPI driver stack is incompatible with the
Pi-shield TFTs we originally targeted; see WARP-127). gpio_shim,
Jetson.GPIO, RPi.GPIO, luma, spidev, and the XPT2046 touch code are gone.

The visual system mirrors the web dashboard (`apps/web-dashboard/`) so the
on-device screen looks like a compact version of the admin UI: same Droplet
brand mark (faceted indigo drop, geometry from `DropletMark.tsx` /
`public/logo.svg`), same color tokens (dark mode surface + `#818cf8` accent),
same tile / status-chip layout.
"""

import os
import time
import json
import socket
import logging
import threading
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Any, Callable, Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError:  # py<3.9
    ZoneInfo = None  # type: ignore

# Timezone for the wall-clock we push to the PyPortal. The container
# itself runs UTC (standard for Docker images), so we compute local
# time explicitly here. Override via DISPLAY_TIMEZONE if needed.
_TZ_NAME = os.environ.get("DISPLAY_TIMEZONE", "America/Los_Angeles")
_TZ = ZoneInfo(_TZ_NAME) if ZoneInfo else None

import psutil
from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger("droplet.tft")

# ---------------------------------------------------------------------------
# Display geometry
# ---------------------------------------------------------------------------
WIDTH = int(os.environ.get("LCD_WIDTH", "480"))
HEIGHT = int(os.environ.get("LCD_HEIGHT", "320"))

# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------
# "auto" (default) probes the PyPortal on USB-serial and falls back to "sim".
# "pyportal" / "sim" force a specific backend (primarily for CI / dev).
BACKEND = os.environ.get("DISPLAY_BACKEND", "auto").lower()

# PyPortal backend (USB-serial-connected Adafruit PyPortal Titano).
PYPORTAL_TTY = os.environ.get("PYPORTAL_TTY", "/dev/ttyACM1")
PYPORTAL_BAUD = int(os.environ.get("PYPORTAL_BAUD", "115200"))

# Host-side device-bridge URL (see services/oled-display/device-bridge.py).
# The bridge runs on the Jetson host and exposes /wifi, /files, /cameras,
# /drives, /openwrt/qr so the container gets live data without mounting
# NetworkManager/DBus/etc. inside. Default 127.0.0.1 because the bridge
# binds to loopback by default (see BRIDGE_BIND in device-bridge.py).
WIFI_HELPER_URL = os.environ.get(
    "WIFI_HELPER_URL", "http://127.0.0.1:9090")
WIFI_REFRESH_SECONDS = int(os.environ.get("WIFI_REFRESH_SECONDS", "20"))
FILES_REFRESH_SECONDS = int(os.environ.get("FILES_REFRESH_SECONDS", "30"))
CAMERAS_REFRESH_SECONDS = int(os.environ.get("CAMERAS_REFRESH_SECONDS", "15"))

# ---------------------------------------------------------------------------
# Design tokens — mirror apps/web-dashboard/src/app/globals.css (dark mode).
# On-device we use dark mode exclusively: the panel is OLED-adjacent and
# dark surfaces read well in both ambient light and the LAN-closet
# deployments the device is built for.
# ---------------------------------------------------------------------------
# Surfaces
BG_COLOR         = (18, 18, 20)      # surface-primary (near-black)
SURFACE_SECONDARY = (28, 28, 30)     # #1c1c1e
SURFACE_RAISED   = (24, 24, 27)      # #18181b, slight warmth
SEPARATOR        = (70, 70, 76)

# Labels
TEXT_COLOR       = (255, 255, 255)
LABEL_SECONDARY  = (190, 190, 200)
LABEL_TERTIARY   = (145, 145, 160)
LABEL_QUATERNARY = (100, 100, 115)

# Accent (indigo)
ACCENT_COLOR     = (129, 140, 248)   # #818cf8 dashboard dark-mode accent
ACCENT_PRIMARY   = (99, 102, 241)    # #6366f1 brand logo primary
ACCENT_LIGHT     = (165, 180, 252)   # #a5b4fc
ACCENT_SUBTLE    = (45, 47, 85)      # rendered opacity-15 of accent on dark

# System status
STATUS_RED       = (255, 69, 58)     # system-red
STATUS_ORANGE    = (255, 159, 10)    # system-orange
STATUS_GREEN     = (48, 209, 88)     # system-green

# Legacy aliases kept so older code paths keep working
CARD_COLOR       = SURFACE_RAISED
DIM_COLOR        = LABEL_TERTIARY
BAR_BG           = SURFACE_SECONDARY
TEMP_WARN        = STATUS_ORANGE
TEMP_CRIT        = STATUS_RED
GOOD_COLOR       = STATUS_GREEN

# ---------------------------------------------------------------------------
# Assets + cycle timing
# ---------------------------------------------------------------------------
ASSETS_DIR = Path(__file__).parent / "assets"
SIM_OUTPUT = Path(os.environ.get("SIM_OUTPUT", "/tmp/tft_preview.png"))

# Auto-cycle disabled by default on the touch build: a touch display is
# for interaction, not a billboard. Setting AUTO_CYCLE=1 restores the
# old logo -> stats carousel for headless demos.
AUTO_CYCLE = os.environ.get("AUTO_CYCLE", "0") == "1"
LOGO_DURATION = 5
STATS_DURATION = 10
MESSAGE_HOLD = 30
# How long an LLM message pins the screen. After that we return to home.
MESSAGE_RETURN_HOME_AFTER = MESSAGE_HOLD


def _get_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    try:
        variant = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
        for search in ["/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/"]:
            path = Path(search) / variant
            if path.exists():
                return ImageFont.truetype(str(path), size)
    except Exception:
        pass
    return ImageFont.load_default()


# ---------------------------------------------------------------------------
# Canonical Droplet brand mark
# ---------------------------------------------------------------------------
# Geometry copied verbatim from apps/web-dashboard/src/components/DropletMark.tsx
# (52x60 viewBox). Rendering it here rather than bundling a PNG keeps the
# device logo pixel-perfect across panel sizes and rotations.
_MARK_VIEWBOX = (52, 60)
_MARK_LEFT = [(26, 0), (44, 28), (36, 48), (16, 48), (8, 28)]
_MARK_RIGHT = [(26, 0), (44, 28), (26, 36)]


def draw_droplet_mark(
    draw: ImageDraw.ImageDraw,
    x: int, y: int, size: int,
    primary: Tuple[int, int, int] = ACCENT_PRIMARY,
    highlight: Tuple[int, int, int] = ACCENT_LIGHT,
):
    """Draw the Droplet brand mark at (x, y) sized to `size` pixels tall.

    (x, y) is the top-left of the bounding box; the mark is drawn
    proportionally so the full 52x60 geometry fits inside `size x size`.
    """
    vw, vh = _MARK_VIEWBOX
    scale = size / vh  # scale by height so the mark looks like its web twin
    # Horizontal centering offset inside the size-box
    x_off = x + (size - int(vw * scale)) // 2
    y_off = y

    def proj(pt):
        return (int(x_off + pt[0] * scale), int(y_off + pt[1] * scale))

    draw.polygon([proj(p) for p in _MARK_LEFT], fill=primary)
    draw.polygon([proj(p) for p in _MARK_RIGHT], fill=highlight)


# ---------------------------------------------------------------------------
# Touch regions
# ---------------------------------------------------------------------------
class TouchRegion:
    """A rectangular tap target tied to a screen-state callback.

    The display's render routines register these while building a frame;
    the cycle loop polls the touch reader and invokes `action(reader)` on
    press-then-release inside the region.
    """
    __slots__ = ("name", "x", "y", "w", "h", "action")

    def __init__(self, name: str, x: int, y: int, w: int, h: int,
                 action: Callable[[], None]):
        self.name = name
        self.x, self.y, self.w, self.h = x, y, w, h
        self.action = action

    def contains(self, px: int, py: int) -> bool:
        return self.x <= px <= self.x + self.w and self.y <= py <= self.y + self.h


class TFTDisplay:
    """ILI9481 480x320 TFT controller with touch-driven screens."""

    # Screen ids — mirror the dashboard's top-level routes where it makes
    # sense: home tile grid, chat-prep, stats/health, device summary,
    # settings. `logo` and `message` are ephemeral overlays.
    HOME = "home"
    STATS = "stats"
    CHAT = "chat"
    DEVICES = "devices"
    SETTINGS = "settings"
    LOGO = "logo"
    MESSAGE = "message"

    def __init__(self):
        self._pyportal = None
        self._pyportal_lock = threading.Lock()
        self._backend = "sim"
        self._current_mode = self.HOME
        self._current_image: Optional[Image.Image] = None
        self._custom_title: Optional[str] = None
        self._custom_lines: Optional[List[str]] = None
        self._cycle_thread: Optional[threading.Thread] = None
        self._cycle_running = False
        self._cycle_paused_until = 0.0
        self._message_clear_at = 0.0
        self._lock = threading.Lock()
        self._brightness = 255
        self._logo_image: Optional[Image.Image] = None
        # Touch regions for the current frame
        self._touch_regions: List[TouchRegion] = []
        self._touch_regions_lock = threading.Lock()
        # Live touch feedback: momentary highlight after a tap
        self._last_tap_region: Optional[str] = None
        self._last_tap_at: float = 0.0

        self._init_device()
        self._load_logo()
        # First frame — render home so the screen isn't blank on boot.
        self._render_current()

    # ----- Backend init -------------------------------------------------

    def _init_device(self):
        # PyPortal takes several seconds to finish USB enumeration after a
        # Jetson reboot, so retry a few times before falling through to sim.
        # Otherwise a cold boot leaves the user with a blank screen until
        # the container is restarted.
        if BACKEND in ("auto", "pyportal"):
            attempts = 6 if BACKEND == "auto" else 1
            for attempt in range(attempts):
                if self._try_pyportal():
                    return
                if attempt < attempts - 1:
                    time.sleep(2)
        self._backend = "sim"
        logger.warning("Using simulated display (no PyPortal detected on USB)")

    def _try_pyportal(self) -> bool:
        try:
            import serial
        except ImportError:
            return False
        # PyPortal can re-enumerate as ttyACM0/1/2 depending on which
        # USB interface ends up as "data" vs "console" at boot. Try each
        # candidate and pick the first that responds.
        candidates = []
        if Path(PYPORTAL_TTY).exists():
            candidates.append(PYPORTAL_TTY)
        for i in range(0, 5):
            p = f"/dev/ttyACM{i}"
            if Path(p).exists() and p not in candidates:
                candidates.append(p)
        if not candidates:
            return False
        for path in candidates:
            if self._probe_pyportal(path):
                return True
        return False

    def _probe_pyportal(self, path: str) -> bool:
        try:
            import serial
        except ImportError:
            return False
        try:
            s = serial.Serial(path, PYPORTAL_BAUD, timeout=2)
            # Give the USB-serial endpoint a moment to stabilise after
            # open() — CircuitPython sometimes needs a few ms before it
            # is ready to read/write reliably.
            time.sleep(0.3)
            s.reset_input_buffer()
            s.write(b'{"mode":"ping"}\n')
            s.flush()
            # Expect an OK or READY within 800ms; otherwise treat as a
            # different serial device (e.g. PyPortal's REPL console).
            deadline = time.time() + 0.8
            saw_ok = False
            while time.time() < deadline:
                line = s.readline()
                if not line:
                    break
                if b"OK" in line or b"READY" in line:
                    saw_ok = True
                    break
            if not saw_ok:
                s.close()
                return False
            self._pyportal = s
            self._backend = "pyportal"
            logger.info("TFT initialised via PyPortal on %s @ %d baud",
                        path, PYPORTAL_BAUD)
            return True
        except Exception as e:
            logger.debug("PyPortal probe %s failed: %s", path, e)
            return False

    def _pyportal_send(self, mode: str, data: Optional[dict] = None):
        if self._pyportal is None:
            return
        payload: dict[str, Any] = {"mode": mode}
        if data is not None:
            payload["data"] = data
        try:
            with self._pyportal_lock:
                self._pyportal.write(json.dumps(payload).encode("utf-8") + b"\n")
                self._pyportal.flush()
        except Exception as e:
            # I/O error usually means the PyPortal re-enumerated on USB
            # (e.g. firmware reloaded) and our file handle is stale.
            # Drop the handle, try to re-probe; subsequent calls will
            # either reconnect or stay quiet until the PyPortal is back.
            logger.warning("PyPortal write failed (mode=%s): %s — reconnecting", mode, e)
            try:
                with self._pyportal_lock:
                    try:
                        self._pyportal.close()
                    except Exception:
                        pass
                    self._pyportal = None
                    self._backend = "sim"  # temporary until re-probe succeeds
            except Exception:
                pass
            if self._try_pyportal():
                # Re-probe worked — re-send the payload once.
                try:
                    with self._pyportal_lock:
                        self._pyportal.write(
                            json.dumps(payload).encode("utf-8") + b"\n")
                        self._pyportal.flush()
                except Exception as e2:
                    logger.debug("resend after reconnect failed: %s", e2)

    # ----- Assets -------------------------------------------------------

    def _load_logo(self):
        """Prefer the canonical vector logo, but allow override via PNG.

        If a PNG exists in `assets/logo_480.png` or `assets/logo_128.png`
        it's used as-is (lets product swap in a rendered marketing asset
        later). Otherwise we draw the DropletMark-derived vector ourselves.
        """
        for candidate in (ASSETS_DIR / "logo_480.png", ASSETS_DIR / "logo_128.png"):
            if candidate.exists():
                try:
                    self._logo_image = (
                        Image.open(candidate).convert("RGB").resize((WIDTH, HEIGHT))
                    )
                    return
                except Exception as e:
                    logger.warning("Failed to load %s: %s", candidate, e)
        self._logo_image = self._render_logo_fallback()

    def _render_logo_fallback(self) -> Image.Image:
        """Full-screen splash using the canonical brand mark + wordmark.

        Matches apps/web-dashboard/public/logo.svg composition: mark on
        top, "Droplet" wordmark below, subtle tagline.
        """
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)

        mark_size = 140
        mark_x = (WIDTH - mark_size) // 2
        mark_y = HEIGHT // 2 - mark_size // 2 - 30
        draw.rounded_rectangle(
            [(mark_x - 28, mark_y - 22),
             (mark_x + mark_size + 28, mark_y + mark_size + 22)],
            radius=28, fill=SURFACE_RAISED,
        )
        draw_droplet_mark(draw, mark_x, mark_y, mark_size,
                          primary=ACCENT_PRIMARY, highlight=ACCENT_LIGHT)

        font_word = _get_font(44, bold=True)
        text = "Droplet"
        bbox = draw.textbbox((0, 0), text, font=font_word)
        tw = bbox[2] - bbox[0]
        draw.text(((WIDTH - tw) // 2, mark_y + mark_size + 36),
                  text, fill=TEXT_COLOR, font=font_word)

        tag_font = _get_font(14)
        tag = "Edge AI Appliance"
        bbox = draw.textbbox((0, 0), tag, font=tag_font)
        tw = bbox[2] - bbox[0]
        draw.text(((WIDTH - tw) // 2, mark_y + mark_size + 86),
                  tag, fill=LABEL_TERTIARY, font=tag_font)

        return img

    # ----- Push to display ---------------------------------------------

    def _push(self, image: Image.Image):
        # Both backends write the preview PNG: PyPortal renders the frame
        # itself from the data commands we stream over serial, and the sim
        # backend has nothing else to do with the image.
        self._current_image = image
        SIM_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        try:
            image.save(str(SIM_OUTPUT))
        except Exception as e:
            logger.debug("preview save failed: %s", e)

    # ----- Shared chrome -----------------------------------------------

    def _draw_header(self, img: Image.Image, draw: ImageDraw.ImageDraw,
                     *, show_back: bool = False, show_home: bool = False,
                     title: Optional[str] = None,
                     status: Optional[str] = None):
        """Dashboard-style header strip: brand mark + wordmark on the left,
        optional back/home button, status chip and clock on the right.

        Returns the y-coordinate where the header ends (content starts).
        """
        bar_h = 52
        draw.rectangle([(0, 0), (WIDTH, bar_h)], fill=SURFACE_SECONDARY)
        draw.line([(0, bar_h), (WIDTH, bar_h)], fill=SEPARATOR, width=1)

        font_title = _get_font(17, bold=True)
        font_small = _get_font(12, bold=True)
        font_clock = _get_font(20, bold=True)

        x_cursor = 12
        if show_back:
            self._draw_button(
                draw, x_cursor, 10, 70, 32,
                "< Back", font_small,
                region=TouchRegion("nav_back", x_cursor, 10, 70, 32,
                                   self._go_home),
            )
            x_cursor += 80
        elif show_home:
            self._draw_button(
                draw, x_cursor, 10, 70, 32,
                "Home", font_small,
                region=TouchRegion("nav_home", x_cursor, 10, 70, 32,
                                   self._go_home),
            )
            x_cursor += 80

        # Brand
        draw_droplet_mark(draw, x_cursor, 10, 32,
                          primary=ACCENT_COLOR, highlight=ACCENT_LIGHT)
        x_cursor += 36
        wordmark = title or "Droplet"
        draw.text((x_cursor, 14), wordmark, fill=TEXT_COLOR, font=font_title)

        # Clock
        clock = time.strftime("%H:%M")
        bbox = draw.textbbox((0, 0), clock, font=font_clock)
        clock_w = bbox[2] - bbox[0]
        draw.text((WIDTH - clock_w - 14, 14), clock,
                  fill=TEXT_COLOR, font=font_clock)

        # Status chip between clock and brand
        if status is not None:
            chip_font = _get_font(11, bold=True)
            chip_bbox = draw.textbbox((0, 0), status, font=chip_font)
            chip_w = (chip_bbox[2] - chip_bbox[0]) + 22
            chip_h = 20
            chip_x = WIDTH - clock_w - 14 - chip_w - 10
            chip_y = (bar_h - chip_h) // 2
            draw.rounded_rectangle(
                [(chip_x, chip_y), (chip_x + chip_w, chip_y + chip_h)],
                radius=10, fill=SURFACE_RAISED,
            )
            draw.ellipse(
                [(chip_x + 7, chip_y + 6), (chip_x + 13, chip_y + 12)],
                fill=STATUS_GREEN,
            )
            draw.text((chip_x + 16, chip_y + 3), status,
                      fill=LABEL_SECONDARY, font=chip_font)

        return bar_h + 6

    def _draw_button(self, draw: ImageDraw.ImageDraw,
                     x: int, y: int, w: int, h: int,
                     label: str, font,
                     *, region: Optional[TouchRegion] = None,
                     fill=SURFACE_RAISED, text_color=TEXT_COLOR,
                     border=True):
        """Pill button with optional touch binding + tap flash."""
        active = (region and self._last_tap_region == region.name and
                  time.time() - self._last_tap_at < 0.25)
        bg = ACCENT_SUBTLE if active else fill
        draw.rounded_rectangle([(x, y), (x + w, y + h)],
                               radius=h // 2, fill=bg)
        if border:
            draw.rounded_rectangle([(x, y), (x + w, y + h)],
                                   radius=h // 2, outline=SEPARATOR, width=1)
        bbox = draw.textbbox((0, 0), label, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        draw.text((x + (w - tw) // 2, y + (h - th) // 2 - 1),
                  label, fill=text_color if not active else ACCENT_COLOR,
                  font=font)
        if region is not None:
            self._touch_regions.append(region)

    # ----- Screen renderers --------------------------------------------

    def render_logo(self) -> Image.Image:
        if self._logo_image is None:
            return self._render_logo_fallback()
        return self._logo_image.copy()

    def render_home(self) -> Image.Image:
        """Dashboard-style tile grid. This is the root interactive screen."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        content_y = self._draw_header(
            img, draw, show_home=False,
            status="Online",
        )

        # Tile grid: 2 columns x 2 rows of primary destinations + a
        # compact system status ribbon at the foot.
        pad = 10
        tile_gap = 10
        grid_w = WIDTH - 2 * pad
        grid_h = HEIGHT - content_y - 66  # leave space for footer
        tile_w = (grid_w - tile_gap) // 2
        tile_h = (grid_h - tile_gap) // 2

        font_label = _get_font(12, bold=True)
        font_title = _get_font(19, bold=True)
        font_meta = _get_font(12)

        tiles = [
            ("CHAT", "Ask AI", "Tap to chat",     self.CHAT,     self._go_chat),
            ("SYS",  "Status", "Health & metrics", self.STATS,    self._go_stats),
            ("NET",  "Network", self._get_ip(),   self.DEVICES,  self._go_devices),
            ("CFG",  "Settings", "Brightness & more", self.SETTINGS, self._go_settings),
        ]
        for idx, (tag, title, sub, _mode, action) in enumerate(tiles):
            col = idx % 2
            row = idx // 2
            tx = pad + col * (tile_w + tile_gap)
            ty = content_y + row * (tile_h + tile_gap)
            self._draw_tile(draw, tx, ty, tile_w, tile_h,
                            tag, title, sub,
                            font_label, font_title, font_meta,
                            region=TouchRegion(f"tile_{tag.lower()}",
                                               tx, ty, tile_w, tile_h, action))

        # Status ribbon (mirrors dashboard's StatusSegment row)
        ribbon_y = HEIGHT - 56
        self._draw_status_ribbon(draw, pad, ribbon_y, WIDTH - 2 * pad, 44)

        return img

    def _draw_tile(self, draw, x, y, w, h,
                   tag, title, sub,
                   font_label, font_title, font_meta,
                   region: Optional[TouchRegion] = None):
        active = (region and self._last_tap_region == region.name and
                  time.time() - self._last_tap_at < 0.3)
        bg = SURFACE_SECONDARY if active else SURFACE_RAISED
        border = ACCENT_COLOR if active else SEPARATOR
        draw.rounded_rectangle([(x, y), (x + w, y + h)],
                               radius=14, fill=bg)
        draw.rounded_rectangle([(x, y), (x + w, y + h)],
                               radius=14, outline=border, width=1)

        # Accent tag pill in the corner
        pad = 12
        pill_w = 42
        pill_h = 20
        draw.rounded_rectangle(
            [(x + pad, y + pad), (x + pad + pill_w, y + pad + pill_h)],
            radius=10, fill=ACCENT_SUBTLE,
        )
        bbox = draw.textbbox((0, 0), tag, font=font_label)
        tw = bbox[2] - bbox[0]
        draw.text((x + pad + (pill_w - tw) // 2, y + pad + 4),
                  tag, fill=ACCENT_COLOR, font=font_label)

        # Title
        draw.text((x + pad, y + pad + pill_h + 14),
                  title, fill=TEXT_COLOR, font=font_title)
        # Subtitle
        draw.text((x + pad, y + pad + pill_h + 44),
                  sub[:28], fill=LABEL_TERTIARY, font=font_meta)

        # Corner chevron (arrow hint)
        ax = x + w - 26
        ay = y + h - 24
        draw.polygon([
            (ax, ay), (ax + 10, ay + 6), (ax, ay + 12),
        ], fill=LABEL_TERTIARY)

        if region is not None:
            self._touch_regions.append(region)

    def _draw_status_ribbon(self, draw, x, y, w, h):
        draw.rounded_rectangle([(x, y), (x + w, y + h)],
                               radius=12, fill=SURFACE_RAISED)
        draw.rounded_rectangle([(x, y), (x + w, y + h)],
                               radius=12, outline=SEPARATOR, width=1)

        font_val = _get_font(15, bold=True)
        font_cap = _get_font(10, bold=True)

        cpu_pct = psutil.cpu_percent(interval=0.0)
        try:
            mem_pct = psutil.virtual_memory().percent
        except Exception:
            mem_pct = 0
        try:
            disk_pct = psutil.disk_usage("/").percent
        except Exception:
            disk_pct = 0
        temp = self._get_cpu_temp()
        try:
            up = time.time() - psutil.boot_time()
            hrs = int(up // 3600)
            mins = int((up % 3600) // 60)
            uptime = f"{hrs}h {mins}m" if hrs < 48 else f"{int(up // 86400)}d"
        except Exception:
            uptime = "—"

        segments = [
            (f"{cpu_pct:.0f}%", "CPU"),
            (f"{mem_pct:.0f}%", "RAM"),
            (f"{disk_pct:.0f}%", "DISK"),
            (f"{temp:.0f}°C", "TEMP"),
            (uptime, "UP"),
        ]
        seg_w = w / len(segments)
        for i, (primary, caption) in enumerate(segments):
            cx = x + i * seg_w
            draw.text((cx + 12, y + 6), primary,
                      fill=TEXT_COLOR, font=font_val)
            draw.text((cx + 12, y + 26), caption,
                      fill=LABEL_TERTIARY, font=font_cap)
            if i > 0:
                draw.line([(cx, y + 8), (cx, y + h - 8)],
                          fill=SEPARATOR, width=1)

    def render_stats(self) -> Image.Image:
        """Detailed health screen — 2x2 metric cards, back button."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        content_y = self._draw_header(img, draw,
                                      show_back=True, title="Health")

        font_label = _get_font(11, bold=True)
        font_value = _get_font(26, bold=True)
        font_sm = _get_font(12)

        cpu_pct = psutil.cpu_percent(interval=0.05)
        try:
            mem = psutil.virtual_memory()
        except Exception:
            mem = None
        try:
            disk = psutil.disk_usage("/")
        except Exception:
            disk = None
        temp = self._get_cpu_temp()

        pad = 10
        gap = 10
        card_w = (WIDTH - 2 * pad - gap) // 2
        card_h = (HEIGHT - content_y - 56 - gap) // 2

        self._draw_metric_card(
            draw, pad, content_y, card_w, card_h,
            "CPU", f"{cpu_pct:.0f}%", cpu_pct,
            font_label, font_value, font_sm,
            danger_thresh=(80, 95),
        )
        mem_val = f"{mem.used / (1024**3):.1f}/{mem.total / (1024**3):.0f} GB" if mem else "n/a"
        mem_pct = mem.percent if mem else 0
        self._draw_metric_card(
            draw, pad + card_w + gap, content_y, card_w, card_h,
            "MEMORY", mem_val, mem_pct,
            font_label, font_value, font_sm,
            danger_thresh=(80, 95),
        )
        disk_val = (f"{(disk.used / (1024**3)):.0f}/{(disk.total / (1024**3)):.0f} GB"
                    if disk else "n/a")
        disk_pct = disk.percent if disk else 0
        self._draw_metric_card(
            draw, pad, content_y + card_h + gap, card_w, card_h,
            "DISK", disk_val, disk_pct,
            font_label, font_value, font_sm,
            danger_thresh=(85, 95),
        )
        self._draw_temp_card(
            draw, pad + card_w + gap, content_y + card_h + gap,
            card_w, card_h,
            temp, font_label, font_value, font_sm,
        )

        # Footer: IP + hostname (mirrors dashboard status ribbon)
        foot_y = HEIGHT - 42
        draw.text((pad, foot_y), "IP",
                  fill=LABEL_TERTIARY, font=_get_font(10, bold=True))
        draw.text((pad + 24, foot_y - 2),
                  self._get_ip(), fill=TEXT_COLOR, font=_get_font(14))

        up = time.time() - psutil.boot_time()
        days = int(up // 86400)
        hours = int((up % 86400) // 3600)
        mins = int((up % 3600) // 60)
        up_str = f"{days}d {hours}h" if days else f"{hours}h {mins}m"
        bbox = draw.textbbox((0, 0), up_str, font=_get_font(14))
        draw.text((WIDTH - (bbox[2] - bbox[0]) - pad, foot_y - 2),
                  up_str, fill=TEXT_COLOR, font=_get_font(14))
        draw.text((WIDTH - (bbox[2] - bbox[0]) - pad - 28, foot_y),
                  "UP", fill=LABEL_TERTIARY, font=_get_font(10, bold=True))

        return img

    def render_chat(self) -> Image.Image:
        """Chat-prep screen — mirrors the dashboard's hero prompt capsule.

        The device itself can't run a REPL here (no keyboard), so this
        screen shows a reminder that the user should speak (or use the
        web UI) and displays the latest LLM-pushed message when present.
        """
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        content_y = self._draw_header(img, draw,
                                      show_back=True, title="Ask AI")

        # Hero question (mirrors dashboard h1)
        font_hero = _get_font(30, bold=True)
        draw.text((16, content_y + 6), "What can I",
                  fill=TEXT_COLOR, font=font_hero)
        draw.text((16, content_y + 40), "help you with?",
                  fill=ACCENT_COLOR, font=font_hero)

        # Capsule (faux prompt input — touch target routes to web UI)
        cap_x = 16
        cap_y = content_y + 92
        cap_w = WIDTH - 32
        cap_h = 48
        draw.rounded_rectangle(
            [(cap_x, cap_y), (cap_x + cap_w, cap_y + cap_h)],
            radius=cap_h // 2, fill=SURFACE_RAISED,
        )
        draw.rounded_rectangle(
            [(cap_x, cap_y), (cap_x + cap_w, cap_y + cap_h)],
            radius=cap_h // 2, outline=ACCENT_COLOR, width=1,
        )
        sparkle = "*"
        font_body = _get_font(15)
        draw.text((cap_x + 18, cap_y + 14),
                  f"{sparkle}  Open chat on dashboard to ask…",
                  fill=LABEL_SECONDARY, font=font_body)
        # Send-button stub
        btn_w = 60
        btn_x = cap_x + cap_w - btn_w - 6
        btn_y = cap_y + 6
        btn_h = cap_h - 12
        draw.rounded_rectangle(
            [(btn_x, btn_y), (btn_x + btn_w, btn_y + btn_h)],
            radius=btn_h // 2, fill=ACCENT_COLOR,
        )
        font_btn = _get_font(13, bold=True)
        bbox = draw.textbbox((0, 0), "Ask", font=font_btn)
        draw.text((btn_x + (btn_w - (bbox[2] - bbox[0])) // 2,
                   btn_y + (btn_h - (bbox[3] - bbox[1])) // 2 - 1),
                  "Ask", fill=(255, 255, 255), font=font_btn)

        # Last message panel (if any)
        msg_y = cap_y + cap_h + 16
        msg_h = HEIGHT - msg_y - 16
        draw.rounded_rectangle(
            [(16, msg_y), (WIDTH - 16, msg_y + msg_h)],
            radius=12, fill=SURFACE_RAISED,
        )
        font_label = _get_font(10, bold=True)
        draw.text((28, msg_y + 10), "LATEST",
                  fill=LABEL_TERTIARY, font=font_label)
        if self._custom_title or self._custom_lines:
            font_title = _get_font(16, bold=True)
            draw.text((28, msg_y + 28),
                      (self._custom_title or "Message")[:40],
                      fill=TEXT_COLOR, font=font_title)
            y = msg_y + 54
            for line in (self._custom_lines or [])[:3]:
                draw.text((28, y), line[:54],
                          fill=LABEL_SECONDARY, font=_get_font(13))
                y += 20
        else:
            draw.text((28, msg_y + 28),
                      "Assistant is idle.",
                      fill=LABEL_SECONDARY, font=_get_font(14))
            draw.text((28, msg_y + 50),
                      "Tool calls and replies appear here.",
                      fill=LABEL_TERTIARY, font=_get_font(12))

        return img

    def render_devices(self) -> Image.Image:
        """Network / devices summary screen — derived from dashboard's
        devices tile + status-ribbon row."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        content_y = self._draw_header(img, draw,
                                      show_back=True, title="Network")

        pad = 16
        font_label = _get_font(10, bold=True)
        font_title = _get_font(17, bold=True)
        font_val = _get_font(16)
        font_meta = _get_font(12)

        # Primary card: this device
        card_h = 96
        draw.rounded_rectangle(
            [(pad, content_y + 4),
             (WIDTH - pad, content_y + 4 + card_h)],
            radius=14, fill=SURFACE_RAISED,
        )
        draw_droplet_mark(draw, pad + 16, content_y + 18, 52,
                          primary=ACCENT_COLOR, highlight=ACCENT_LIGHT)
        draw.text((pad + 86, content_y + 18),
                  socket.gethostname()[:24],
                  fill=TEXT_COLOR, font=font_title)
        draw.text((pad + 86, content_y + 44),
                  self._get_ip(), fill=ACCENT_COLOR, font=font_val)
        draw.text((pad + 86, content_y + 66),
                  "This device", fill=LABEL_TERTIARY, font=font_meta)

        # Two secondary cards
        sub_y = content_y + 4 + card_h + 12
        sub_h = HEIGHT - sub_y - 16
        col_w = (WIDTH - 2 * pad - 12) // 2
        for idx, (label, primary, secondary) in enumerate([
            ("LAN", self._get_ip(), "Via gateway"),
            ("UPLINK", "Online", "DNS reachable"),
        ]):
            sx = pad + idx * (col_w + 12)
            draw.rounded_rectangle(
                [(sx, sub_y), (sx + col_w, sub_y + sub_h)],
                radius=14, fill=SURFACE_RAISED,
            )
            draw.text((sx + 14, sub_y + 12),
                      label, fill=LABEL_TERTIARY, font=font_label)
            draw.text((sx + 14, sub_y + 30),
                      primary, fill=TEXT_COLOR, font=font_title)
            draw.text((sx + 14, sub_y + sub_h - 26),
                      secondary, fill=LABEL_SECONDARY, font=font_meta)
        return img

    def render_settings(self) -> Image.Image:
        """Settings screen — brightness slider + quick actions."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        content_y = self._draw_header(img, draw,
                                      show_back=True, title="Settings")

        pad = 16
        font_label = _get_font(11, bold=True)
        font_title = _get_font(17, bold=True)

        # Brightness card
        card_y = content_y + 4
        card_h = 130
        draw.rounded_rectangle(
            [(pad, card_y), (WIDTH - pad, card_y + card_h)],
            radius=14, fill=SURFACE_RAISED,
        )
        draw.text((pad + 16, card_y + 14),
                  "BRIGHTNESS", fill=LABEL_TERTIARY, font=font_label)
        draw.text((pad + 16, card_y + 32),
                  f"{self._brightness}/255",
                  fill=TEXT_COLOR, font=_get_font(24, bold=True))

        # Stepper buttons
        btn_font = _get_font(20, bold=True)
        minus_x = WIDTH - pad - 120
        plus_x = WIDTH - pad - 60
        btn_y = card_y + 18
        self._draw_button(
            draw, minus_x, btn_y, 50, 44, "-", btn_font,
            region=TouchRegion("bri_minus", minus_x, btn_y, 50, 44,
                               lambda: self.set_brightness(
                                   max(0, self._brightness - 25))),
        )
        self._draw_button(
            draw, plus_x, btn_y, 50, 44, "+", btn_font,
            region=TouchRegion("bri_plus", plus_x, btn_y, 50, 44,
                               lambda: self.set_brightness(
                                   min(255, self._brightness + 25))),
        )

        # Brightness bar
        bar_x = pad + 16
        bar_y = card_y + card_h - 22
        bar_w = WIDTH - 2 * pad - 32
        draw.rounded_rectangle(
            [(bar_x, bar_y), (bar_x + bar_w, bar_y + 8)],
            radius=4, fill=SURFACE_SECONDARY,
        )
        fill_w = int(bar_w * self._brightness / 255)
        if fill_w > 0:
            draw.rounded_rectangle(
                [(bar_x, bar_y), (bar_x + fill_w, bar_y + 8)],
                radius=4, fill=ACCENT_COLOR,
            )

        # Quick actions row
        act_y = card_y + card_h + 14
        act_h = HEIGHT - act_y - 16
        col_w = (WIDTH - 2 * pad - 12) // 2

        # Show logo
        draw.rounded_rectangle(
            [(pad, act_y), (pad + col_w, act_y + act_h)],
            radius=14, fill=SURFACE_RAISED,
        )
        draw.text((pad + 14, act_y + 14),
                  "SHOW LOGO", fill=LABEL_TERTIARY, font=font_label)
        draw.text((pad + 14, act_y + 34),
                  "Splash screen", fill=TEXT_COLOR, font=font_title)
        self._touch_regions.append(TouchRegion(
            "act_logo", pad, act_y, col_w, act_h,
            lambda: self._set_mode(self.LOGO),
        ))

        # Reboot-cycle / home
        rx = pad + col_w + 12
        draw.rounded_rectangle(
            [(rx, act_y), (rx + col_w, act_y + act_h)],
            radius=14, fill=SURFACE_RAISED,
        )
        draw.text((rx + 14, act_y + 14),
                  "CYCLE", fill=LABEL_TERTIARY, font=font_label)
        label = "Auto-cycle off" if not self._cycle_running or self._cycle_paused_until > time.time() else "Auto-cycle on"
        draw.text((rx + 14, act_y + 34),
                  label, fill=TEXT_COLOR, font=font_title)
        self._touch_regions.append(TouchRegion(
            "act_cycle", rx, act_y, col_w, act_h,
            self._toggle_cycle,
        ))

        return img

    def render_message(self, title: str, lines: List[str]) -> Image.Image:
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        content_y = self._draw_header(img, draw,
                                      show_home=True, title=title[:24])

        font_body = _get_font(17)
        y = content_y + 18
        draw.rounded_rectangle(
            [(16, content_y + 6), (WIDTH - 16, HEIGHT - 16)],
            radius=14, fill=SURFACE_RAISED,
        )
        for line in lines[:10]:
            draw.text((28, y), line[:52],
                      fill=TEXT_COLOR, font=font_body)
            y += 24
        return img

    @staticmethod
    def _draw_metric_card(draw, x, y, w, h, label, value, pct,
                          font_label, font_value, font_sm, danger_thresh=(80, 95)):
        draw.rounded_rectangle([(x, y), (x + w, y + h)],
                               radius=14, fill=CARD_COLOR)
        draw.text((x + 14, y + 12), label, fill=LABEL_TERTIARY, font=font_label)
        draw.text((x + 14, y + 30), value, fill=TEXT_COLOR, font=font_value)
        bar_x = x + 14
        bar_y = y + h - 22
        bar_w = w - 28
        draw.rounded_rectangle([(bar_x, bar_y), (bar_x + bar_w, bar_y + 8)],
                               radius=4, fill=SURFACE_SECONDARY)
        fill_w = int(bar_w * min(max(pct, 0), 100) / 100)
        if fill_w > 0:
            warn, crit = danger_thresh
            color = (ACCENT_COLOR if pct < warn
                     else STATUS_ORANGE if pct < crit
                     else STATUS_RED)
            draw.rounded_rectangle([(bar_x, bar_y), (bar_x + fill_w, bar_y + 8)],
                                   radius=4, fill=color)

    @staticmethod
    def _draw_temp_card(draw, x, y, w, h, temp,
                        font_label, font_value, font_sm):
        draw.rounded_rectangle([(x, y), (x + w, y + h)],
                               radius=14, fill=CARD_COLOR)
        draw.text((x + 14, y + 12), "TEMP",
                  fill=LABEL_TERTIARY, font=font_label)
        color = (TEXT_COLOR if temp < 70
                 else STATUS_ORANGE if temp < 85
                 else STATUS_RED)
        draw.text((x + 14, y + 30), f"{temp:.0f}\u00b0C",
                  fill=color, font=font_value)
        status_text = ("nominal" if temp < 70
                       else "warm" if temp < 85
                       else "hot")
        status_color = (STATUS_GREEN if temp < 70
                        else STATUS_ORANGE if temp < 85
                        else STATUS_RED)
        draw.text((x + 14, y + h - 24), status_text,
                  fill=status_color, font=font_sm)

    # ----- Sensor helpers ----------------------------------------------

    @staticmethod
    def _get_cpu_temp() -> float:
        # psutil.sensors_temperatures() blows up on Jetson because some
        # thermal zones (soc0-thermal, BCPU-therm, PLL-therm) return
        # blank strings from /sys — psutil can't parse them. Read the
        # thermal zones directly instead and pick the hottest valid one.
        best = 0.0
        try:
            for zone in sorted(os.listdir("/sys/class/thermal")):
                if not zone.startswith("thermal_zone"):
                    continue
                try:
                    with open(f"/sys/class/thermal/{zone}/type") as f:
                        zone_type = f.read().strip().lower()
                    # Skip obviously-not-CPU zones
                    if any(bad in zone_type for bad in ("gpu", "pll", "aux")):
                        continue
                    with open(f"/sys/class/thermal/{zone}/temp") as f:
                        raw = f.read().strip()
                    if not raw:
                        continue
                    t = int(raw) / 1000.0
                    if 10.0 <= t <= 120.0 and t > best:
                        best = t
                except Exception:
                    continue
        except Exception:
            pass
        return best

    @staticmethod
    def _get_ip() -> str:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except Exception:
            return "unknown"

    # ----- Display control ---------------------------------------------

    def _set_mode(self, mode: str, *, pause_cycle: bool = True):
        with self._lock:
            self._current_mode = mode
            if pause_cycle:
                self._cycle_paused_until = time.time() + 60
            self._render_current_locked()

    def show_logo(self):
        self._set_mode(self.LOGO)

    def show_home(self):
        self._set_mode(self.HOME, pause_cycle=False)

    def show_stats(self):
        # Kept for backwards-compat with the orchestrator client + cycle loop.
        with self._lock:
            self._current_mode = self.STATS
            self._pyportal_send("stats", self._gather_stats())
            self._render_current_locked()

    def show_message(self, title: str, lines: List[str]):
        with self._lock:
            self._current_mode = self.MESSAGE
            self._custom_title = title
            self._custom_lines = lines
            self._cycle_paused_until = time.time() + MESSAGE_HOLD
            self._message_clear_at = time.time() + MESSAGE_RETURN_HOME_AFTER
            self._pyportal_send("message", {"title": title, "lines": list(lines)})
            self._render_current_locked()

    def show_custom_image(self, image: Image.Image):
        with self._lock:
            self._current_mode = "custom"
            self._cycle_paused_until = time.time() + MESSAGE_HOLD
            resized = image.convert("RGB").resize((WIDTH, HEIGHT))
            self._pyportal_send("message", {
                "title": "Custom",
                "lines": ["image from orchestrator"],
            })
            self._push(resized)

    def set_brightness(self, value: int):
        self._brightness = max(0, min(255, value))
        if self._backend == "pyportal":
            try:
                with self._pyportal_lock:
                    if self._pyportal is not None:
                        self._pyportal.write(
                            json.dumps({"mode": "brightness",
                                        "value": self._brightness}).encode()
                            + b"\n"
                        )
                        self._pyportal.flush()
            except Exception as e:
                logger.warning("PyPortal brightness write failed: %s", e)
        # Re-render settings page if that's where we are so the number
        # and bar update instantly.
        with self._lock:
            if self._current_mode == self.SETTINGS:
                self._render_current_locked()

    # ----- Navigation helpers (bound to touch regions) ------------------

    def _go_home(self):
        self._set_mode(self.HOME, pause_cycle=False)

    def _go_stats(self):
        self._set_mode(self.STATS)

    def _go_chat(self):
        self._set_mode(self.CHAT)

    def _go_devices(self):
        self._set_mode(self.DEVICES)

    def _go_settings(self):
        self._set_mode(self.SETTINGS)

    def _toggle_cycle(self):
        if self._cycle_running and self._cycle_paused_until < time.time():
            self.stop_cycle()
        else:
            self.resume_cycle()
            self.start_cycle()
        with self._lock:
            self._render_current_locked()

    # ----- Render dispatch ---------------------------------------------

    def _render_current(self):
        with self._lock:
            self._render_current_locked()

    def _render_current_locked(self):
        """Render whatever the current screen is. Assumes _lock held."""
        mode = self._current_mode
        if mode == self.LOGO:
            img = self.render_logo()
        elif mode == self.STATS:
            img = self.render_stats()
        elif mode == self.CHAT:
            img = self.render_chat()
        elif mode == self.DEVICES:
            img = self.render_devices()
        elif mode == self.SETTINGS:
            img = self.render_settings()
        elif mode == self.MESSAGE:
            img = self.render_message(self._custom_title or "Message",
                                      self._custom_lines or [])
        else:  # HOME and fallback
            img = self.render_home()
        self._push(img)

    # ----- Structured-data helpers (used by PyPortal backend) ----------

    def _gather_stats(self) -> dict:
        try:
            cpu_pct = psutil.cpu_percent(interval=0.05)
        except Exception:
            cpu_pct = None
        try:
            mem_pct = psutil.virtual_memory().percent
        except Exception:
            mem_pct = None
        try:
            disk_pct = psutil.disk_usage("/").percent
        except Exception:
            disk_pct = None
        temp = self._get_cpu_temp()
        try:
            up = time.time() - psutil.boot_time()
            days = int(up // 86400)
            hours = int((up % 86400) // 3600)
            mins = int((up % 3600) // 60)
            uptime = f"{days}d {hours}h" if days else f"{hours}h {mins}m"
        except Exception:
            uptime = None
        return {
            "cpu": round(cpu_pct) if cpu_pct is not None else None,
            "mem": round(mem_pct) if mem_pct is not None else None,
            "disk": round(disk_pct) if disk_pct is not None else None,
            "temp": round(temp) if isinstance(temp, (int, float)) else temp,
            "ip": self._get_ip(),
            "hostname": socket.gethostname(),
            "uptime": uptime,
            # Wall-clock for the PyPortal header. The PyPortal has no RTC
            # and time.localtime() there counts from boot, so we push
            # local time on every stats update. Container runs UTC so
            # we compute the zoned time explicitly.
            "now": (datetime.now(_TZ) if _TZ else datetime.now()).strftime("%H:%M"),
        }

    # ----- Wi-Fi helper -------------------------------------------------

    def _bridge_get(self, path: str, timeout: float = 6.0) -> Optional[dict]:
        try:
            with urllib.request.urlopen(
                    WIFI_HELPER_URL + path, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:                                       # noqa: BLE001
            logger.debug("bridge %s fetch failed: %s", path, e)
            return None

    def fetch_wifi(self, timeout: float = 6.0) -> Optional[dict]:
        return self._bridge_get("/wifi", timeout)

    def fetch_files(self, timeout: float = 6.0) -> Optional[dict]:
        return self._bridge_get("/files", timeout)

    def fetch_cameras(self, timeout: float = 6.0) -> Optional[dict]:
        return self._bridge_get("/cameras", timeout)

    def fetch_qr(self, timeout: float = 12.0) -> Optional[dict]:
        return self._bridge_get("/openwrt/qr", timeout)

    def fetch_drives(self, timeout: float = 4.0) -> Optional[dict]:
        return self._bridge_get("/drives", timeout)

    def connect_wifi(self, ssid: str, password: str = "",
                     timeout: float = 30.0) -> dict:
        body = json.dumps({"ssid": ssid, "password": password}).encode()
        req = urllib.request.Request(
            WIFI_HELPER_URL + "/wifi/connect",
            data=body, method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode("utf-8"))
            except Exception:
                return {"ok": False, "message": str(e)}
        except Exception as e:                                       # noqa: BLE001
            return {"ok": False, "message": str(e)}

    def get_status(self) -> dict:
        return {
            "mode": self._current_mode,
            "backend": self._backend,
            "simulated": self._backend == "sim",
            "resolution": f"{WIDTH}x{HEIGHT}",
            "brightness": self._brightness,
            "cycling": (self._cycle_running and
                        time.time() >= self._cycle_paused_until),
        }

    @property
    def _simulated(self) -> bool:
        return self._backend == "sim"

    # ----- Touch dispatch ----------------------------------------------

    def handle_touch(self, x: int, y: int) -> Optional[str]:
        """Called by the cycle loop on a press->release event.

        Matches the tap against registered regions; if one matches, fires
        its action and returns its name. Otherwise returns None.
        """
        with self._touch_regions_lock:
            regions = list(self._touch_regions)
        for r in regions:
            if r.contains(x, y):
                self._last_tap_region = r.name
                self._last_tap_at = time.time()
                try:
                    r.action()
                except Exception as e:
                    logger.warning("Touch action %s failed: %s", r.name, e)
                return r.name
        return None

    # ----- Auto-cycle / interactive loop -------------------------------

    def start_cycle(self):
        if self._cycle_thread and self._cycle_thread.is_alive():
            return
        self._cycle_running = True
        self._cycle_thread = threading.Thread(target=self._cycle_loop, daemon=True)
        self._cycle_thread.start()
        logger.info("Display cycle thread started (auto_cycle=%s)", AUTO_CYCLE)

    def stop_cycle(self):
        self._cycle_running = False

    def resume_cycle(self):
        self._cycle_paused_until = 0.0

    def bind_touch_source(self, source):
        """Give the display a reference to the TouchReader so the cycle
        loop can consume press/release events. Decoupling via a setter
        keeps the two objects constructible in either order."""
        self._touch_source = source

    def _cycle_loop(self):
        """Combined interactive + auto-cycle loop.

        Runs constantly while the service is up. Every tick it:
          1. Checks for a new touch press->release and dispatches it.
          2. Re-renders live screens (stats/home/settings) so metrics
             and tap highlights stay fresh.
          3. Pushes stats + wifi scan snapshots to the PyPortal so its
             screens stay current.
          4. Optionally auto-advances if AUTO_CYCLE=1 and we're idle.
        """
        last_press = 0
        last_release = 0
        last_full_render = 0.0
        last_stats_push = 0.0
        last_wifi_push = 0.0
        last_files_push = 0.0
        last_cams_push = 0.0
        last_backend_retry = 0.0
        serial_buf = b""
        while self._cycle_running:
            # If we started on sim because USB enumeration hadn't finished
            # yet, keep probing every 5s and promote to pyportal once it
            # appears. Covers the cold-boot race where the Jetson starts
            # the container before /dev/ttyACM* is ready.
            if self._backend != "pyportal":
                if time.time() - last_backend_retry > 5.0:
                    last_backend_retry = time.time()
                    if BACKEND in ("auto", "pyportal") and self._try_pyportal():
                        logger.info("Promoted backend: sim -> pyportal")
            touch = getattr(self, "_touch_source", None)
            if touch is not None:
                state = touch.get_state()
                # Press->release edge => tap
                if (state.get("release_count", 0) > last_release
                        and state.get("press_count", 0) >= last_press
                        and state.get("x") is not None
                        and state.get("y") is not None):
                    x, y = state["x"], state["y"]
                    hit = self.handle_touch(x, y)
                    if hit:
                        logger.info("Tap %s at (%d,%d)", hit, x, y)
                last_press = state.get("press_count", 0) if touch else 0
                last_release = state.get("release_count", 0) if touch else 0

            now = time.time()

            # Return home after a message timeout
            if (self._current_mode == self.MESSAGE and
                    self._message_clear_at and
                    now >= self._message_clear_at):
                self._message_clear_at = 0
                self._go_home()

            # Live re-render of time-sensitive screens
            live = (self._current_mode in (self.HOME, self.STATS, self.SETTINGS))
            if live and (now - last_full_render) > 1.0:
                with self._lock:
                    self._render_current_locked()
                last_full_render = now

            # Keep the PyPortal's local data snapshot fresh. The PyPortal
            # renders locally; we push data every few seconds so every
            # screen has live numbers when the user navigates to it.
            # A longer cadence (8s) keeps perceived flicker low — the
            # firmware re-renders the active screen on each push.
            if self._backend == "pyportal" and (now - last_stats_push) > 8.0:
                self._pyportal_send("stats", self._gather_stats())
                last_stats_push = now
            if self._backend == "pyportal" and (now - last_wifi_push) > WIFI_REFRESH_SECONDS:
                snap = self.fetch_wifi()
                if snap is not None:
                    self._pyportal_send("wifi", snap)
                last_wifi_push = now
            if self._backend == "pyportal" and (now - last_files_push) > FILES_REFRESH_SECONDS:
                fs = self.fetch_files()
                if fs is not None:
                    self._pyportal_send("files", fs)
                last_files_push = now
            if self._backend == "pyportal" and (now - last_cams_push) > CAMERAS_REFRESH_SECONDS:
                cams = self.fetch_cameras()
                if cams is not None:
                    self._pyportal_send("cameras", cams)
                last_cams_push = now
            if self._backend == "pyportal" and (now - last_files_push) > 0 \
                    and (now - last_files_push) > FILES_REFRESH_SECONDS:
                # (Reuse the files timer for drives — they change on the
                # same event cadence and we don't need a separate tick.)
                pass
            # Drives poll — separate, shorter cadence so hot-plug is snappy.
            if self._backend == "pyportal":
                if not hasattr(self, "_last_drives_push"):
                    self._last_drives_push = 0.0
                if (now - self._last_drives_push) > 8.0:
                    drv = self.fetch_drives()
                    if drv is not None:
                        self._pyportal_send("drives", drv)
                    self._last_drives_push = now

            # Handle async requests from the PyPortal firmware. The
            # firmware emits plain TEXT:arg lines on its side channel —
            # we drain them here and trigger a one-shot refresh.
            if self._backend == "pyportal" and self._pyportal is not None:
                try:
                    with self._pyportal_lock:
                        while self._pyportal.in_waiting:
                            serial_buf += self._pyportal.read(
                                self._pyportal.in_waiting)
                except Exception as e:
                    logger.debug("pyportal read failed: %s — reconnecting", e)
                    try:
                        with self._pyportal_lock:
                            try:
                                self._pyportal.close()
                            except Exception:
                                pass
                            self._pyportal = None
                    except Exception:
                        pass
                    self._try_pyportal()
                while b"\n" in serial_buf:
                    line, _, serial_buf = serial_buf.partition(b"\n")
                    txt = line.decode("utf-8", errors="ignore").strip()
                    if txt == "REQUEST_QR":
                        qr = self.fetch_qr()
                        if qr is not None:
                            self._pyportal_send("qr", qr)
                    elif txt == "RESCAN_WIFI":
                        snap = self.fetch_wifi()
                        if snap is not None:
                            self._pyportal_send("wifi", snap)
                    elif txt.startswith("TAP:") or txt.startswith("NAV:") \
                            or txt.startswith("TOUCH:"):
                        logger.info("pyportal: %s", txt)
                    elif txt:
                        logger.info("pyportal: %s", txt)

            # Optional carousel for demo mode
            if AUTO_CYCLE and now >= self._cycle_paused_until:
                # Alternate logo <-> stats every LOGO_DURATION seconds
                t = int(now // LOGO_DURATION) % 2
                desired = self.LOGO if t == 0 else self.STATS
                if self._current_mode != desired:
                    self._set_mode(desired, pause_cycle=False)

            time.sleep(0.08)


# Legacy alias so existing callers keep working without changes.
OLEDDisplay = TFTDisplay
