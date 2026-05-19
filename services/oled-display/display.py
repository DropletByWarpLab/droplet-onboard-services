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

Visual system: redesigned 2026-05-18 to match `preview.html` (Direction
C / C / A — editorial-numeric idle, sparkline-hero stats, QR-right pair).
Three customer-facing screens: IDLE (clock screensaver), STATS (live
health overview), QR (Wi-Fi pairing). MESSAGE is an ephemeral overlay
pushed by the LLM. Tokens here mirror the `T` object at the top of
`preview.html`'s script block.
"""

import os
import time
import json
import socket
import logging
import threading
import urllib.request
import urllib.error
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Any, Callable, Tuple, Deque

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
WIFI_HELPER_URL = os.environ.get(
    "WIFI_HELPER_URL", "http://127.0.0.1:9090")
WIFI_REFRESH_SECONDS = int(os.environ.get("WIFI_REFRESH_SECONDS", "20"))
FILES_REFRESH_SECONDS = int(os.environ.get("FILES_REFRESH_SECONDS", "30"))
CAMERAS_REFRESH_SECONDS = int(os.environ.get("CAMERAS_REFRESH_SECONDS", "15"))

# ---------------------------------------------------------------------------
# Design tokens — mirror the `T` object in preview.html (Direction C/C/A
# redesign, 2026-05-18). The firmware renders flat shapes only, so any
# alpha-looking tones below are pre-blended on the bg surface. Existing
# constant names are preserved so call-sites elsewhere keep compiling.
# ---------------------------------------------------------------------------
# Surfaces
BG_COLOR          = (0x05, 0x05, 0x07)   # T.bg     #050507
PANEL_COLOR       = (0x0D, 0x0D, 0x12)   # T.panel  #0d0d12
SURFACE_SECONDARY = (0x14, 0x14, 0x20)   # T.surface  #141420
SURFACE_RAISED    = (0x14, 0x14, 0x20)   # alias of surface for legacy callers
SURFACE_ACTIVE    = (0x1D, 0x1D, 0x2E)   # T.surface2 #1d1d2e
SEPARATOR         = (0x2A, 0x2A, 0x38)   # T.sep      #2a2a38
SEPARATOR_2       = (0x3A, 0x3A, 0x4A)   # T.sep2     #3a3a4a
TRACK_COLOR       = (0x1F, 0x1F, 0x30)   # T.track    #1f1f30

# Labels
TEXT_COLOR        = (0xFF, 0xFF, 0xFF)
LABEL_SECONDARY   = (0xC8, 0xC8, 0xD4)   # T.label2  #c8c8d4
LABEL_TERTIARY    = (0x8B, 0x8B, 0x9C)   # T.label3  #8b8b9c
LABEL_QUATERNARY  = (0x54, 0x54, 0x66)   # T.label4  #545466

# Accent (indigo)
ACCENT_COLOR      = (0x81, 0x8C, 0xF8)   # T.accent     #818cf8
ACCENT_PRIMARY    = (0x81, 0x8C, 0xF8)   # mark primary fill = accent
ACCENT_LIGHT      = (0xB4, 0xBA, 0xFF)   # T.accentInk  #b4baff
ACCENT_DIM        = (0x5B, 0x62, 0xC7)   # T.accentDim  #5b62c7
# Sparkline fill: pre-blended #818cf822 (~13% alpha) over #050507 -> ~#15172a.
ACCENT_FILL_SOFT  = (0x15, 0x17, 0x2A)
# Pre-blended orange chip background: rgba(255,159,10,0.18) over bg.
ORANGE_CHIP_BG    = (0x33, 0x25, 0x0E)
# Pre-blended accent-subtle for legacy callers: rgba(129,140,248,0.18) over bg.
ACCENT_SUBTLE     = (0x2A, 0x2D, 0x3D)

# System status
STATUS_RED        = (0xFF, 0x45, 0x3A)   # T.red    #ff453a
STATUS_ORANGE     = (0xFF, 0x9F, 0x0A)   # T.orange #ff9f0a
STATUS_GREEN      = (0x30, 0xD1, 0x58)   # T.green  #30d158

# Legacy aliases retained so any peripheral code still imports cleanly.
CARD_COLOR        = SURFACE_SECONDARY
TEMP_WARN         = STATUS_ORANGE
TEMP_CRIT         = STATUS_RED

# ---------------------------------------------------------------------------
# Assets + cycle timing
# ---------------------------------------------------------------------------
ASSETS_DIR = Path(__file__).parent / "assets"
SIM_OUTPUT = Path(os.environ.get("SIM_OUTPUT", "/tmp/tft_preview.png"))

# Auto-cycle disabled by default on the touch build: a touch display is
# for interaction, not a billboard. Setting AUTO_CYCLE=1 restores the
# old idle <-> stats carousel for headless demos.
AUTO_CYCLE = os.environ.get("AUTO_CYCLE", "0") == "1"
LOGO_DURATION = 5       # idle screen tick in auto-cycle mode
STATS_DURATION = 10
MESSAGE_HOLD = 30
MESSAGE_RETURN_HOME_AFTER = MESSAGE_HOLD

# Sparkline depth (matches preview.html's 48-point buffer).
SPARK_LEN = 48


# ---------------------------------------------------------------------------
# Font loader — try Inter first, fall back to DejaVu.
# ---------------------------------------------------------------------------
_FONT_CACHE: dict = {}

# Search order for TrueType faces. Inter is preferred (matches preview.html);
# DejaVu is the universal Debian fallback that the existing container ships.
_INTER_REGULAR_NAMES = ("Inter-Regular.ttf", "Inter.ttf", "Inter-Medium.ttf")
_INTER_BOLD_NAMES = ("Inter-Bold.ttf", "Inter-SemiBold.ttf", "Inter-ExtraBold.ttf")
_DEJAVU_REGULAR_NAMES = ("DejaVuSans.ttf",)
_DEJAVU_BOLD_NAMES = ("DejaVuSans-Bold.ttf",)
# Windows fallback — Segoe UI ships on every modern Windows install, so the
# host-side preview renders correctly when devs run this locally (e.g. the
# Stefan dev box on Windows 11 without DejaVu installed). Production
# containers still have DejaVu and pick that up first.
_SYSTEM_REGULAR_NAMES = ("segoeui.ttf", "arial.ttf", "calibri.ttf")
_SYSTEM_BOLD_NAMES = ("segoeuib.ttf", "arialbd.ttf", "calibrib.ttf")

_FONT_SEARCH_PATHS = (
    str(ASSETS_DIR / "fonts"),
    str(ASSETS_DIR),
    "/usr/share/fonts/truetype/inter",
    "/usr/share/fonts/opentype/inter",
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts",
    # Windows
    "C:/Windows/Fonts",
    os.path.expandvars("%LOCALAPPDATA%/Microsoft/Windows/Fonts"),
)


def _find_font_file(names: Tuple[str, ...]) -> Optional[str]:
    for search in _FONT_SEARCH_PATHS:
        try:
            base = Path(search)
            if not base.exists():
                continue
            for n in names:
                p = base / n
                if p.exists():
                    return str(p)
        except Exception:
            continue
    return None


def _format_idle_date(dt: datetime) -> str:
    """ALL-CAPS date string for the firmware idle screen ("MONDAY, MAY 18").

    The PyPortal has no locale + no `%-d` strftime directive, so we
    compute the format on the host and push it as a plain string. The
    `%-d` POSIX directive isn't available on Windows either, so we
    build the day without zero-padding manually.
    """
    return f"{dt.strftime('%A')}, {dt.strftime('%b')} {dt.day}".upper()


def _get_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    key = (size, bold)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    candidates = (
        _INTER_BOLD_NAMES if bold else _INTER_REGULAR_NAMES,
        _DEJAVU_BOLD_NAMES if bold else _DEJAVU_REGULAR_NAMES,
        _SYSTEM_BOLD_NAMES if bold else _SYSTEM_REGULAR_NAMES,
    )
    for names in candidates:
        path = _find_font_file(names)
        if path:
            try:
                f = ImageFont.truetype(path, size)
                _FONT_CACHE[key] = f
                return f
            except Exception:
                continue
    f = ImageFont.load_default()
    _FONT_CACHE[key] = f
    return f


def _measure(draw: ImageDraw.ImageDraw, s: str, font) -> Tuple[int, int]:
    try:
        bbox = draw.textbbox((0, 0), s, font=font)
        return bbox[2] - bbox[0], bbox[3] - bbox[1]
    except Exception:
        # Bitmap-default fallback
        return font.getsize(s) if hasattr(font, "getsize") else (len(s) * 6, 11)


def _draw_text(draw: ImageDraw.ImageDraw, s: str, x: int, y: int, *,
               font, color, align: str = "left", baseline: str = "top",
               letter: float = 0.0):
    """Drop-in mirror of preview.html's `text()` helper.

    Supports align (left/center/right) + baseline (top/middle/bottom) and
    optional letter spacing (rendered char-by-char when non-zero).
    """
    if letter and len(s) > 1:
        # Per-char layout so we can space the glyphs explicitly. Mirrors
        # the canvas branch with the same name in preview.html.
        widths = []
        total = 0
        for ch in s:
            w, _ = _measure(draw, ch, font)
            widths.append(w)
            total += w
        total += int(letter * (len(s) - 1))
        if align == "center":
            cx = x - total // 2
        elif align == "right":
            cx = x - total
        else:
            cx = x
        # Baseline adjust — same as the simple branch below.
        _, th = _measure(draw, s, font)
        if baseline == "middle":
            ty = y - th // 2
        elif baseline == "bottom":
            ty = y - th
        else:
            ty = y
        for ch, w in zip(s, widths):
            draw.text((cx, ty), ch, fill=color, font=font)
            cx += w + int(letter)
        return
    tw, th = _measure(draw, s, font)
    if align == "center":
        tx = x - tw // 2
    elif align == "right":
        tx = x - tw
    else:
        tx = x
    if baseline == "middle":
        ty = y - th // 2
    elif baseline == "bottom":
        ty = y - th
    else:
        ty = y
    draw.text((tx, ty), s, fill=color, font=font)


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
    primary: Tuple[int, int, int] = ACCENT_COLOR,
    highlight: Tuple[int, int, int] = ACCENT_LIGHT,
):
    """Draw the Droplet brand mark at (x, y) sized to `size` pixels tall.

    (x, y) is the top-left of the bounding box; the mark is drawn
    proportionally so the full 52x60 geometry fits inside `size x size`.
    """
    vw, vh = _MARK_VIEWBOX
    scale = size / vh
    x_off = x + (size - int(vw * scale)) // 2
    y_off = y

    def proj(pt):
        return (int(x_off + pt[0] * scale), int(y_off + pt[1] * scale))

    draw.polygon([proj(p) for p in _MARK_LEFT], fill=primary)
    draw.polygon([proj(p) for p in _MARK_RIGHT], fill=highlight)


# ---------------------------------------------------------------------------
# Pseudo-QR (used when the bridge hasn't returned a real matrix yet, so the
# preview still shows the right *shape* of UI). Mirrors preview.html's
# drawFakeQR — three finder squares + deterministic noise.
# ---------------------------------------------------------------------------
def _draw_fake_qr(draw: ImageDraw.ImageDraw, x: int, y: int, size: int,
                  seed: int = 1, n_cells: int = 25,
                  bg: Tuple[int, int, int] = (255, 255, 255),
                  fg: Tuple[int, int, int] = (0, 0, 0)):
    cell = size / n_cells
    draw.rectangle([(x, y), (x + size, y + size)], fill=bg)
    for i in range(n_cells):
        for j in range(n_cells):
            in_finder = ((i < 7 and j < 7) or
                         (i < 7 and j >= n_cells - 7) or
                         (i >= n_cells - 7 and j < 7))
            if in_finder:
                li = i - (n_cells - 7) if i >= n_cells - 7 else i
                lj = j - (n_cells - 7) if j >= n_cells - 7 else j
                on_border = li == 0 or li == 6 or lj == 0 or lj == 6
                on_inner = 2 <= li <= 4 and 2 <= lj <= 4
                if on_border or on_inner:
                    draw.rectangle(
                        [(int(x + j * cell), int(y + i * cell)),
                         (int(x + (j + 1) * cell), int(y + (i + 1) * cell))],
                        fill=fg,
                    )
                continue
            s = (i * 73856093) ^ (j * 19349663) ^ (seed * 83492791)
            s = (s ^ (s >> 13)) * 1274126177
            v = ((s ^ (s >> 16)) & 0xff) / 255.0
            if v > 0.52:
                draw.rectangle(
                    [(int(x + j * cell), int(y + i * cell)),
                     (int(x + (j + 1) * cell), int(y + (i + 1) * cell))],
                    fill=fg,
                )


def _draw_qr_matrix(draw: ImageDraw.ImageDraw, x: int, y: int, size: int,
                    matrix: List[List[int]],
                    bg: Tuple[int, int, int] = (255, 255, 255),
                    fg: Tuple[int, int, int] = (0, 0, 0)):
    """Render a real binary QR matrix from the bridge."""
    n = len(matrix)
    if n == 0:
        return
    cell = size / n
    draw.rectangle([(x, y), (x + size, y + size)], fill=bg)
    for i in range(n):
        row = matrix[i]
        for j in range(min(n, len(row))):
            if row[j]:
                draw.rectangle(
                    [(int(x + j * cell), int(y + i * cell)),
                     (int(x + (j + 1) * cell + 0.5),
                      int(y + (i + 1) * cell + 0.5))],
                    fill=fg,
                )


def _fmt_duration(secs: int) -> str:
    secs = max(0, int(secs))
    m, s = divmod(secs, 60)
    return f"{m}:{s:02d}"


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
    """PyPortal-backed 480x320 TFT controller with touch-driven screens."""

    # Screen ids — the redesign collapses the carousel to two interactive
    # screens (STATS + QR) plus an IDLE screensaver and a MESSAGE overlay.
    # HOME/LOGO are kept as aliases so legacy callers (orchestrator,
    # FastAPI routes, the auto-cycle loop) keep resolving.
    IDLE = "idle"
    STATS = "stats"
    QR = "qr"
    MESSAGE = "message"
    # Aliases for backward compatibility — `show_home` -> stats,
    # `show_logo` -> idle.
    HOME = STATS
    LOGO = IDLE

    def __init__(self):
        self._pyportal = None
        self._pyportal_lock = threading.Lock()
        self._pyportal_path: Optional[str] = None
        self._needs_resync = False
        self._backend = "sim"
        self._current_mode = self.IDLE
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
        # Rolling sparkline buffer for the stats hero (CPU history).
        self._cpu_spark: Deque[float] = deque(maxlen=SPARK_LEN)
        # Cached QR snapshot (populated by the cycle loop / fetch_qr).
        self._qr_snapshot: Optional[dict] = None
        # Optional alert list — empty by default. Anything that wants to
        # surface alerts on the panel can push entries via show_message
        # or by mutating this list before render_stats runs.
        self._alerts: List[dict] = []

        self._init_device()
        self._load_logo()
        # First frame — render idle so the screen isn't blank on boot.
        self._render_current()

    # ----- Backend init -------------------------------------------------

    def _init_device(self):
        # PyPortal takes several seconds to finish USB enumeration after a
        # Jetson reboot, so retry a few times before falling through to sim.
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
            import serial  # noqa: F401
        except ImportError:
            return False
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
            time.sleep(0.3)
            s.reset_input_buffer()
            s.write(b'{"mode":"ping"}\n')
            s.flush()
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
            self._pyportal_path = path
            self._backend = "pyportal"
            self._needs_resync = True
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
            logger.warning("PyPortal write failed (mode=%s): %s — reconnecting",
                           mode, e)
            try:
                with self._pyportal_lock:
                    try:
                        self._pyportal.close()
                    except Exception:
                        pass
                    self._pyportal = None
                    self._backend = "sim"
            except Exception:
                pass
            if self._try_pyportal():
                try:
                    with self._pyportal_lock:
                        self._pyportal.write(
                            json.dumps(payload).encode("utf-8") + b"\n")
                        self._pyportal.flush()
                except Exception as e2:
                    logger.debug("resend after reconnect failed: %s", e2)

    # ----- Assets -------------------------------------------------------

    def _load_logo(self):
        """Allow a marketing PNG override for the idle splash.

        The redesign's idle screen is procedural (clock + brand mark +
        date + SSID), but we keep a PNG hook so product can drop in a
        full-bleed splash later by saving `assets/logo_480.png`. If
        present, that PNG is shown as-is whenever IDLE is the active mode.
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
        # No override — leave as None so render_idle() draws the procedural one.
        self._logo_image = None

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

    # ----- Page indicator (replaces the old bottom nav pills) ----------

    def _draw_page_indicator(self, draw: ImageDraw.ImageDraw, active: str):
        """Two small dots at the bottom centre — accent for active, sep2
        for inactive. Replaces the carousel's pill tab bar which is gone
        in the redesign.
        """
        cy = HEIGHT - 10
        r = 2  # 4 px diameter
        # Centre two dots 10 px apart around WIDTH/2.
        positions = [
            ("stats", WIDTH // 2 - 5),
            ("qr", WIDTH // 2 + 5),
        ]
        for name, cx in positions:
            color = ACCENT_COLOR if name == active else SEPARATOR_2
            draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=color)

    # ----- Screen renderers --------------------------------------------

    def render_idle(self) -> Image.Image:
        """Direction C — editorial-numeric idle (clock screensaver).

        Small Droplet mark + "DROPLET" eyebrow + "on-prem AI" tagline
        top, massive 140 px HH:MM clock centred, ALL-CAPS date bottom-
        left, SSID bottom-right in accent. Colon blinks every second.
        """
        # Marketing override beats the procedural idle if provided.
        if self._logo_image is not None:
            return self._logo_image.copy()

        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        # Brand bug + eyebrow
        draw_droplet_mark(draw, 20, 18, 20, ACCENT_COLOR, ACCENT_LIGHT)
        _draw_text(draw, "DROPLET", 50, 24,
                   font=_get_font(9, bold=True), color=LABEL_TERTIARY, letter=2)
        _draw_text(draw, "on-prem AI", WIDTH - 20, 24,
                   font=_get_font(9), color=LABEL_QUATERNARY,
                   align="right", letter=1)

        # Hero clock — 140 px tabular numbers, colon blinks each second.
        now = datetime.now(_TZ) if _TZ else datetime.now()
        hh = f"{now.hour:02d}"
        mm = f"{now.minute:02d}"
        colon = ":" if (now.second % 2) == 0 else " "
        clock_str = hh + colon + mm
        # 140 px Inter @ ExtraBold — fall back to whatever big TTF we have.
        clock_font = _get_font(140, bold=True)
        _draw_text(draw, clock_str, WIDTH // 2, 168,
                   font=clock_font, color=TEXT_COLOR,
                   align="center", baseline="middle", letter=-6)

        # Date bottom-left, SSID bottom-right.
        date_str = now.strftime("%A, %b %-d").upper() if os.name != "nt" \
            else now.strftime("%A, %b %d").upper()
        _draw_text(draw, date_str, 20, HEIGHT - 28,
                   font=_get_font(11, bold=True), color=LABEL_TERTIARY,
                   letter=1.6)
        ssid = self._current_ssid()
        _draw_text(draw, ssid, WIDTH - 20, HEIGHT - 28,
                   font=_get_font(11, bold=True), color=ACCENT_COLOR,
                   align="right")

        return img

    # Back-compat alias — callers still ask for render_logo().
    def render_logo(self) -> Image.Image:
        return self.render_idle()

    def render_stats(self) -> Image.Image:
        """Direction C — sparkline-hero stats overview.

        CPU hero top-left (eyebrow + 64 px number), time + alert bubble
        top-right, full-width 32 px sparkline at y=100, 4-column
        tabular row (MEM/DISK/TEMP/CAMERAS) at y=170, hostname·IP +
        alert summary footer.
        """
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        stats = self._gather_stats()
        # Update the rolling spark before the render so the line matches
        # the current hero number.
        cpu_val = stats.get("cpu")
        if isinstance(cpu_val, (int, float)):
            self._cpu_spark.append(float(cpu_val))

        # Hero metric — CPU
        cpu_pct = stats.get("cpu") if stats.get("cpu") is not None else 0
        _draw_text(draw, "CPU LOAD", 20, 18,
                   font=_get_font(10, bold=True), color=LABEL_TERTIARY,
                   letter=1.6)
        _draw_text(draw, f"{int(cpu_pct)}%", 20, 32,
                   font=_get_font(64, bold=True), color=TEXT_COLOR,
                   letter=-3)

        # Time + alert bubble on the right
        now = datetime.now(_TZ) if _TZ else datetime.now()
        open_alerts = [a for a in self._alerts if not a.get("cleared")]
        open_count = len(open_alerts)
        if open_count > 0:
            bx, by, br = WIDTH - 28, 24, 13
            draw.ellipse([(bx - br, by - br), (bx + br, by + br)],
                         fill=STATUS_RED)
            _draw_text(draw, "!", bx, by,
                       font=_get_font(16, bold=True), color=TEXT_COLOR,
                       align="center", baseline="middle")
            if open_count > 1:
                cw, ch = 16, 13
                draw.rounded_rectangle(
                    [(bx + br - 6, by - br - 4),
                     (bx + br - 6 + cw, by - br - 4 + ch)],
                    radius=ch // 2, fill=TEXT_COLOR)
                _draw_text(draw, str(open_count),
                           bx + br - 6 + cw // 2,
                           by - br - 4 + ch // 2,
                           font=_get_font(9, bold=True), color=STATUS_RED,
                           align="center", baseline="middle")
            # Bubble is the tap target to open the (preview-only) drawer.
            self._touch_regions.append(TouchRegion(
                "alerts_open", bx - br - 6, by - br - 6,
                br * 2 + 12, br * 2 + 12, self._toggle_alerts))
        else:
            # OK dot + label
            draw.ellipse([(WIDTH - 30, 24), (WIDTH - 22, 32)],
                         fill=STATUS_GREEN)
            _draw_text(draw, "OK", WIDTH - 36, 28,
                       font=_get_font(11, bold=True), color=STATUS_GREEN,
                       align="right", baseline="middle")

        _draw_text(draw, now.strftime("%H:%M"), WIDTH - 20, 50,
                   font=_get_font(12, bold=True), color=LABEL_SECONDARY,
                   align="right")

        # Hero sparkline
        self._draw_sparkline(draw, 20, 100, WIDTH - 40, 32, list(self._cpu_spark))

        # Hairline separator between the spark and the tabular row.
        draw.rectangle([(20, 152), (WIDTH - 20, 153)], fill=SEPARATOR)

        # 4 tabular columns
        cams = self._current_cameras()
        mem = stats.get("mem")
        disk = stats.get("disk")
        temp = stats.get("temp")
        cols = [
            ("MEM",     f"{int(mem)}%" if mem is not None else "—",
                LABEL_SECONDARY),
            ("DISK",    f"{int(disk)}%" if disk is not None else "—",
                LABEL_SECONDARY),
            ("TEMP",    f"{int(temp)}°" if temp is not None else "—",
                LABEL_SECONDARY),
            ("CAMERAS", f"{cams[0]}/{cams[1]}" if cams else "—/—",
                STATUS_GREEN),
        ]
        col_w = (WIDTH - 40) / 4
        for i, (lbl, val, color) in enumerate(cols):
            x = int(20 + i * col_w)
            _draw_text(draw, lbl, x, 170,
                       font=_get_font(9, bold=True), color=LABEL_TERTIARY,
                       letter=1.4)
            _draw_text(draw, val, x, 188,
                       font=_get_font(28, bold=True), color=color)

        # Bottom strip — hostname · ip on the left, alert summary on right.
        hostname = stats.get("hostname") or socket.gethostname()
        ip = stats.get("ip") or self._get_ip()
        _draw_text(draw, f"{hostname} · {ip}", 20, HEIGHT - 26,
                   font=_get_font(11, bold=True), color=LABEL_TERTIARY)
        all_clear = open_count == 0
        draw.ellipse([(WIDTH - 99, HEIGHT - 24), (WIDTH - 93, HEIGHT - 18)],
                     fill=STATUS_GREEN if all_clear else STATUS_RED)
        msg = "All good" if all_clear else \
            f"{open_count} alert" + ("s" if open_count > 1 else "")
        _draw_text(draw, msg, WIDTH - 20, HEIGHT - 26,
                   font=_get_font(11, bold=True),
                   color=STATUS_GREEN if all_clear else STATUS_RED,
                   align="right")

        # Two-dot page indicator
        self._draw_page_indicator(draw, "stats")

        return img

    def render_qr(self) -> Image.Image:
        """Direction A — QR right + password chip.

        Eyebrow "PAIR" + "Join Wi-Fi" h1 top-left, NETWORK + SSID,
        PASSWORD + plaintext password (so a guest can type it instead
        of scanning), optional TTL chip, "⟳ Rotate password" pill, and
        a 200×200 QR card with the brand mark inset at the centre.
        """
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        snap = self._qr_snapshot or {}
        ssid = (snap.get("ssid") or snap.get("network")
                or self._current_ssid())
        password = (snap.get("key") or snap.get("password")
                    or snap.get("psk") or "")
        ttl_secs = snap.get("ttl_seconds")
        if ttl_secs is None:
            ttl_secs = snap.get("expires_in")
        matrix = snap.get("matrix")

        # Eyebrow + headline (left column)
        _draw_text(draw, "PAIR", 20, 22,
                   font=_get_font(9, bold=True), color=ACCENT_COLOR, letter=2)
        _draw_text(draw, "Join Wi-Fi", 20, 38,
                   font=_get_font(22, bold=True), color=TEXT_COLOR)

        # QR card (right) — 200×200 with a 10 px white card frame.
        qr_size = 200
        qx = WIDTH - qr_size - 30
        qy = 60
        draw.rounded_rectangle(
            [(qx - 10, qy - 10), (qx + qr_size + 10, qy + qr_size + 10)],
            radius=14, fill=(255, 255, 255))
        if isinstance(matrix, list) and matrix and isinstance(matrix[0], list):
            _draw_qr_matrix(draw, qx, qy, qr_size, matrix)
        else:
            # Deterministic seed off the SSID so the preview looks stable.
            seed = (sum(ord(c) for c in ssid) or 1) & 0x7fffffff
            _draw_fake_qr(draw, qx, qy, qr_size, seed=seed)
        # Brand-mark inset at the centre, with a thin white pad so the
        # mark stays legible against any QR module density.
        mc = 30
        inset_x = qx + qr_size // 2 - mc // 2
        inset_y = qy + qr_size // 2 - mc // 2
        draw.rounded_rectangle(
            [(inset_x - 3, inset_y - 3),
             (inset_x + mc + 3, inset_y + mc + 3)],
            radius=6, fill=(255, 255, 255))
        draw_droplet_mark(draw, inset_x, inset_y, mc,
                          ACCENT_COLOR, ACCENT_LIGHT)

        # NETWORK + SSID
        _draw_text(draw, "NETWORK", 20, 92,
                   font=_get_font(9, bold=True), color=LABEL_TERTIARY,
                   letter=1.4)
        _draw_text(draw, ssid, 20, 108,
                   font=_get_font(17, bold=True), color=TEXT_COLOR)

        # PASSWORD + plaintext value
        _draw_text(draw, "PASSWORD", 20, 142,
                   font=_get_font(9, bold=True), color=LABEL_TERTIARY,
                   letter=1.4)
        _draw_text(draw, password or "—", 20, 158,
                   font=_get_font(14, bold=True), color=ACCENT_LIGHT)

        # TTL chip — only when rotation is enabled.
        if isinstance(ttl_secs, (int, float)) and ttl_secs > 0:
            ttl_str = "KEY " + _fmt_duration(int(ttl_secs))
            chip_font = _get_font(10, bold=True)
            ttl_w_text, _ = _measure(draw, ttl_str, chip_font)
            ttl_w = ttl_w_text + 20
            urgent = ttl_secs < 60
            fill = ORANGE_CHIP_BG if urgent else SURFACE_SECONDARY
            stroke = STATUS_ORANGE if urgent else SEPARATOR
            color = STATUS_ORANGE if urgent else LABEL_SECONDARY
            draw.rounded_rectangle([(20, 184), (20 + ttl_w, 204)],
                                   radius=10, fill=fill)
            draw.rounded_rectangle([(20, 184), (20 + ttl_w, 204)],
                                   radius=10, outline=stroke, width=1)
            _draw_text(draw, ttl_str, 20 + ttl_w // 2, 194,
                       font=chip_font, color=color,
                       align="center", baseline="middle", letter=0.6)

        # Rotate pill — 44 px tap target.
        btn_y, btn_w, btn_h = 224, 200, 44
        draw.rounded_rectangle([(20, btn_y), (20 + btn_w, btn_y + btn_h)],
                               radius=12, fill=SURFACE_SECONDARY)
        draw.rounded_rectangle([(20, btn_y), (20 + btn_w, btn_y + btn_h)],
                               radius=12, outline=SEPARATOR_2, width=1)
        _draw_text(draw, "↻  Rotate password",
                   20 + btn_w // 2, btn_y + btn_h // 2,
                   font=_get_font(13, bold=True), color=LABEL_SECONDARY,
                   align="center", baseline="middle")
        self._touch_regions.append(TouchRegion(
            "qr_rotate", 20, btn_y, btn_w, btn_h, self._rotate_now))

        # Two-dot page indicator
        self._draw_page_indicator(draw, "qr")

        return img

    def render_message(self, title: str, lines: List[str]) -> Image.Image:
        """LLM-pushed ephemeral message. Restyled to the new dark palette.

        Eyebrow "MESSAGE", title in the hero slot, the lines in a soft
        surface card below. Auto-dismisses to STATS after MESSAGE_HOLD.
        """
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        # Header strip — eyebrow + clock
        _draw_text(draw, "MESSAGE", 20, 22,
                   font=_get_font(9, bold=True), color=ACCENT_COLOR, letter=2)
        now = datetime.now(_TZ) if _TZ else datetime.now()
        _draw_text(draw, now.strftime("%H:%M"), WIDTH - 20, 22,
                   font=_get_font(11, bold=True), color=LABEL_TERTIARY,
                   align="right")

        # Title
        _draw_text(draw, (title or "Message")[:40], 20, 38,
                   font=_get_font(22, bold=True), color=TEXT_COLOR)

        # Body card
        card_top = 80
        card_bottom = HEIGHT - 24
        draw.rounded_rectangle([(20, card_top), (WIDTH - 20, card_bottom)],
                               radius=14, fill=SURFACE_SECONDARY)
        draw.rounded_rectangle([(20, card_top), (WIDTH - 20, card_bottom)],
                               radius=14, outline=SEPARATOR, width=1)

        font_body = _get_font(15)
        y = card_top + 18
        max_lines = max(1, (card_bottom - card_top - 36) // 22)
        for line in (lines or [])[:max_lines]:
            _draw_text(draw, line[:54], 36, y,
                       font=font_body, color=TEXT_COLOR)
            y += 22

        return img

    def render_alerts_drawer(self,
                             base: Optional[Image.Image] = None,
                             ) -> Image.Image:
        """Right-side drawer overlay on top of the current frame.

        Per the design brief the "55% black scrim" is pre-blended to a
        flat dim rather than carrying alpha through to the firmware.
        """
        if base is None:
            base = self.render_stats()
        img = base.copy()
        draw = ImageDraw.Draw(img)

        # Scrim: 55% black over the existing pixels. PIL can do this with
        # an alpha-composite, which is fine for the host-side preview
        # (the firmware draws solid panel chrome instead — see brief).
        scrim = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 140))
        img_rgba = img.convert("RGBA")
        img_rgba.alpha_composite(scrim)
        img = img_rgba.convert("RGB")
        draw = ImageDraw.Draw(img)

        dw = 300
        dx = WIDTH - dw
        draw.rectangle([(dx, 0), (dx + dw, HEIGHT)], fill=PANEL_COLOR)
        draw.line([(dx, 0), (dx, HEIGHT)], fill=SEPARATOR, width=1)

        _draw_text(draw, "ALERTS", dx + 14, 16,
                   font=_get_font(11, bold=True), color=LABEL_SECONDARY,
                   letter=1.4)
        open_count = sum(1 for a in self._alerts if not a.get("cleared"))
        _draw_text(draw, f"{open_count} open", dx + dw - 50, 16,
                   font=_get_font(10), color=LABEL_TERTIARY)
        _draw_text(draw, "✕", dx + dw - 16, 16,
                   font=_get_font(18), color=LABEL_SECONDARY,
                   align="right")
        self._touch_regions.append(TouchRegion(
            "alerts_close", dx + dw - 32, 6, 28, 28, self._toggle_alerts))

        y = 44
        row_h = 58
        visible = self._alerts[:4]
        if not visible:
            _draw_text(draw, "No alerts.", dx + dw // 2, HEIGHT // 2,
                       font=_get_font(14), color=LABEL_TERTIARY,
                       align="center", baseline="middle")
        else:
            for i, a in enumerate(visible):
                cleared = bool(a.get("cleared"))
                bg = SURFACE_SECONDARY if cleared else SURFACE_ACTIVE
                draw.rounded_rectangle(
                    [(dx + 10, y), (dx + dw - 10, y + row_h - 6)],
                    radius=8, fill=bg)
                draw.rounded_rectangle(
                    [(dx + 10, y), (dx + dw - 10, y + row_h - 6)],
                    radius=8, outline=SEPARATOR, width=1)
                if cleared:
                    icon_col = LABEL_TERTIARY
                elif a.get("type") == "cam":
                    icon_col = STATUS_RED
                else:
                    icon_col = STATUS_ORANGE
                draw.ellipse([(dx + 19, y + 19), (dx + 29, y + 29)],
                             fill=icon_col)
                title = str(a.get("title", ""))
                detail = str(a.get("detail", ""))
                when = str(a.get("time", ""))
                _draw_text(draw, title, dx + 40, y + 10,
                           font=_get_font(12, bold=True),
                           color=LABEL_TERTIARY if cleared else TEXT_COLOR)
                _draw_text(draw, detail, dx + 40, y + 26,
                           font=_get_font(10), color=LABEL_TERTIARY)
                _draw_text(draw, when, dx + 40, y + 40,
                           font=_get_font(9), color=LABEL_QUATERNARY)
                if not cleared:
                    _draw_text(draw, "×", dx + dw - 22, y + 26,
                               font=_get_font(18), color=LABEL_TERTIARY,
                               align="center", baseline="middle")
                    self._touch_regions.append(TouchRegion(
                        f"alerts_clear_{i}", dx + dw - 36, y + 4,
                        30, row_h - 12,
                        lambda idx=i: self._clear_alert(idx)))
                y += row_h

        cbtn_y = HEIGHT - 52
        draw.rounded_rectangle(
            [(dx + 14, cbtn_y), (dx + dw - 14, cbtn_y + 40)],
            radius=12, fill=SURFACE_ACTIVE)
        draw.rounded_rectangle(
            [(dx + 14, cbtn_y), (dx + dw - 14, cbtn_y + 40)],
            radius=12, outline=SEPARATOR_2, width=1)
        _draw_text(draw, "Clear all", dx + dw // 2, cbtn_y + 20,
                   font=_get_font(13, bold=True), color=LABEL_SECONDARY,
                   align="center", baseline="middle")
        self._touch_regions.append(TouchRegion(
            "alerts_clear_all", dx + 14, cbtn_y, dw - 28, 40,
            self._clear_all_alerts))

        return img

    # ----- Sparkline helper --------------------------------------------

    def _draw_sparkline(self, draw: ImageDraw.ImageDraw,
                        sx: int, sy: int, sw: int, sh: int,
                        series: List[float]):
        """Solid-fill sparkline below a 1 px stroke, exactly as in
        preview.html. Both fill and stroke are flat colors (no alpha)
        so the polyline ports cleanly to firmware.
        """
        # Baseline hairline
        draw.rectangle([(sx, sy + sh - 1), (sx + sw, sy + sh)], fill=SEPARATOR)

        if not series:
            return
        if len(series) == 1:
            series = [series[0], series[0]]

        lo = min(series)
        hi = max(series)
        span = max(1.0, hi - lo)
        points = []
        for i, v in enumerate(series):
            px = sx + (i / (len(series) - 1)) * sw
            py = sy + sh - ((v - lo) / span) * sh
            points.append((px, py))

        # Filled polygon below the line (flat #15172a, pre-blended)
        fill_poly = points + [(sx + sw, sy + sh), (sx, sy + sh)]
        draw.polygon([(int(x), int(y)) for x, y in fill_poly],
                     fill=ACCENT_FILL_SOFT)
        # Stroke line on top — 2 px so it reads at arm's length.
        draw.line([(int(x), int(y)) for x, y in points],
                  fill=ACCENT_COLOR, width=2)

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

    def _current_ssid(self) -> str:
        """Best-effort SSID readout for the idle/QR screens.

        Falls back to a friendly default so the preview never shows
        empty when the bridge is briefly unreachable.
        """
        if self._qr_snapshot:
            v = (self._qr_snapshot.get("ssid")
                 or self._qr_snapshot.get("network"))
            if v:
                return str(v)
        try:
            w = self.fetch_wifi(timeout=1.0)
            if isinstance(w, dict):
                cur = w.get("current") or w.get("connected") or {}
                if isinstance(cur, dict) and cur.get("ssid"):
                    return str(cur["ssid"])
                if w.get("ssid"):
                    return str(w["ssid"])
        except Exception:
            pass
        return "Droplet-AI"

    def _current_cameras(self) -> Optional[Tuple[int, int]]:
        try:
            c = self.fetch_cameras(timeout=1.0)
            if not isinstance(c, dict):
                return None
            online = c.get("online")
            total = c.get("total")
            if online is None and isinstance(c.get("cameras"), list):
                cams = c["cameras"]
                total = len(cams)
                online = sum(1 for x in cams if x.get("online"))
            if online is not None and total is not None:
                return int(online), int(total)
        except Exception:
            pass
        return None

    # ----- Display control ---------------------------------------------

    def _set_mode(self, mode: str, *, pause_cycle: bool = True):
        with self._lock:
            self._current_mode = mode
            if pause_cycle:
                self._cycle_paused_until = time.time() + 60
            self._render_current_locked()

    def show_logo(self):
        """Show the idle/screensaver screen. (Alias retained for callers
        that still use the old name — `logo` == `idle` in the redesign.)
        """
        self._set_mode(self.IDLE)

    def show_home(self):
        """Show the stats overview. Kept as the canonical 'home' for the
        orchestrator and FastAPI routes that hand-off to this display.
        """
        self._set_mode(self.STATS, pause_cycle=False)

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
        with self._lock:
            self._render_current_locked()

    # ----- Internal action handlers (bound to touch regions) ------------

    def _go_idle(self):
        self._set_mode(self.IDLE, pause_cycle=False)

    def _go_stats(self):
        self._set_mode(self.STATS)

    def _go_qr(self):
        self._set_mode(self.QR)

    def _toggle_alerts(self):
        # Preview-only drawer toggle. The firmware owns its own drawer
        # state; on the host side we just flip a flag and re-render.
        self._alerts_open = not getattr(self, "_alerts_open", False)
        with self._lock:
            self._render_current_locked()

    def _clear_alert(self, idx: int):
        if 0 <= idx < len(self._alerts):
            self._alerts[idx]["cleared"] = True
        with self._lock:
            self._render_current_locked()

    def _clear_all_alerts(self):
        self._alerts = []
        self._alerts_open = False
        with self._lock:
            self._render_current_locked()

    def _rotate_now(self):
        """Tap handler for the QR-screen rotate pill. Best-effort; the
        bridge is the source of truth, so we kick it and let the next
        QR fetch refresh the snapshot."""
        try:
            self.rotate_wifi_key()
            self._qr_snapshot = self.fetch_qr() or self._qr_snapshot
        except Exception as e:                                       # noqa: BLE001
            logger.warning("rotate_wifi_key failed: %s", e)
        with self._lock:
            self._render_current_locked()

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
        if mode == self.IDLE:
            img = self.render_idle()
        elif mode == self.STATS:
            img = self.render_stats()
            if getattr(self, "_alerts_open", False):
                img = self.render_alerts_drawer(img)
        elif mode == self.QR:
            img = self.render_qr()
        elif mode == self.MESSAGE:
            img = self.render_message(self._custom_title or "Message",
                                      self._custom_lines or [])
        else:  # fallback
            img = self.render_stats()
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
            # ALL-CAPS date string for the redesigned idle screen
            # ("MONDAY, MAY 18"). Pushed alongside `now` so the
            # firmware doesn't need a locale or strftime '-d' (those
            # don't exist in CircuitPython).
            "date": _format_idle_date(datetime.now(_TZ) if _TZ else datetime.now()),
        }

    def _push_full_state(self) -> None:
        """Send a complete state snapshot to the firmware: stats + wifi +
        drives + cameras + files. Idempotent; bridge fetch failures are
        logged and skipped (the periodic loop will catch up on the next
        tick).
        """
        try:
            self._pyportal_send("stats", self._gather_stats())
        except Exception as e:                              # noqa: BLE001
            logger.warning("resync stats failed: %s", e)
        for mode, fetch in (
            ("wifi", self.fetch_wifi),
            ("drives", self.fetch_drives),
            ("cameras", self.fetch_cameras),
            ("files", self.fetch_files),
        ):
            try:
                snap = fetch()
                if snap is not None:
                    self._pyportal_send(mode, snap)
            except Exception as e:                          # noqa: BLE001
                logger.warning("resync %s failed: %s", mode, e)

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
        snap = self._bridge_get("/openwrt/qr", timeout)
        if snap is not None:
            self._qr_snapshot = snap
        return snap

    def rotate_wifi_key(self, timeout: float = 30.0) -> Optional[dict]:
        """Ask device-bridge to roll the Droplet-AI WPA key. Used by the
        PyPortal's "Rotate now" button on the QR screen — the board sends
        `ROTATE_KEY` over serial, we POST here, then re-push /openwrt/qr
        so the display shows the new QR immediately.

        Sends the bridge auth token as `X-Droplet-Auth` so the bridge's
        rate-limited rotate endpoint accepts it. Token comes from
        SERVICE_SECRET (same one the orchestrator uses to talk to this
        service), falling back to BRIDGE_AUTH_TOKEN if set separately.
        """
        headers = {"Content-Type": "application/json"}
        token = (os.environ.get("BRIDGE_AUTH_TOKEN")
                 or os.environ.get("SERVICE_SECRET")
                 or os.environ.get("DEVICE_SECRET_KEY")
                 or "").strip()
        if token:
            headers["X-Droplet-Auth"] = token
        req = urllib.request.Request(
            WIFI_HELPER_URL + "/openwrt/wifi/rotate",
            data=b"", method="POST",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode("utf-8"))
            except Exception:
                return {"ok": False, "error": str(e)}
        except Exception as e:                                       # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def fetch_drives(self, timeout: float = 4.0) -> Optional[dict]:
        return self._bridge_get("/drives", timeout)

    def connect_wifi(self, ssid: str, password: str = "",
                     timeout: float = 30.0) -> dict:
        body = json.dumps({"ssid": ssid, "password": password}).encode()
        headers = {"Content-Type": "application/json"}
        token = (os.environ.get("BRIDGE_AUTH_TOKEN")
                 or os.environ.get("SERVICE_SECRET")
                 or os.environ.get("DEVICE_SECRET_KEY")
                 or "").strip()
        if token:
            headers["X-Droplet-Auth"] = token
        req = urllib.request.Request(
            WIFI_HELPER_URL + "/wifi/connect",
            data=body, method="POST",
            headers=headers,
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
          2. Re-renders live screens (idle/stats) so metrics and tap
             highlights stay fresh.
          3. Pushes stats + wifi + cameras + drives + files snapshots
             to the PyPortal so its screens stay current.
          4. Optionally auto-advances between IDLE and STATS if
             AUTO_CYCLE=1 (legacy demo mode).
        """
        last_press = 0
        last_release = 0
        last_full_render = 0.0
        last_stats_push = 0.0
        last_wifi_push = 0.0
        last_files_push = 0.0
        last_cams_push = 0.0
        last_backend_retry = 0.0
        last_liveness_check = 0.0
        serial_buf = b""
        while self._cycle_running:
            # Liveness check: detect a stale PyPortal serial fd left behind
            # by a USB re-enumeration. The kernel renumbers ttyACM* on
            # firmware reset / replug / hub reset, but our open fd to the
            # old node doesn't fail — writes silently succeed-with-no-effect
            # and reads return zero bytes, so the existing reconnect-on-
            # IOError path in `_pyportal_send` never triggers. If our path
            # has vanished from /dev, drop the fd and let the promotion
            # block below re-probe whatever ttyACM* is now live.
            if (self._backend == "pyportal" and self._pyportal_path
                    and time.time() - last_liveness_check > 2.0):
                last_liveness_check = time.time()
                if not os.path.exists(self._pyportal_path):
                    logger.warning(
                        "PyPortal device %s vanished (USB re-enumeration?) "
                        "— dropping fd and re-probing",
                        self._pyportal_path)
                    try:
                        with self._pyportal_lock:
                            try:
                                if self._pyportal is not None:
                                    self._pyportal.close()
                            except Exception:
                                pass
                            self._pyportal = None
                            self._pyportal_path = None
                            self._backend = "sim"
                    except Exception:
                        pass
                    last_backend_retry = 0.0

            if self._backend != "pyportal":
                if time.time() - last_backend_retry > 5.0:
                    last_backend_retry = time.time()
                    if BACKEND in ("auto", "pyportal") and self._try_pyportal():
                        logger.info("Promoted backend: sim -> pyportal")

            if self._backend == "pyportal" and self._needs_resync:
                self._needs_resync = False
                logger.info("post-probe resync — pushing full state")
                self._push_full_state()
                now_anchor = time.time()
                last_stats_push = now_anchor
                last_wifi_push = now_anchor
                last_files_push = now_anchor
                last_cams_push = now_anchor
                self._last_drives_push = now_anchor
            touch = getattr(self, "_touch_source", None)
            if touch is not None:
                state = touch.get_state()
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
                self._go_stats()

            # Live re-render of time-sensitive screens (idle blinks colon
            # at 1 Hz; stats sparkline ticks with each gather).
            live = (self._current_mode in (self.IDLE, self.STATS))
            if live and (now - last_full_render) > 1.0:
                with self._lock:
                    self._render_current_locked()
                last_full_render = now

            # Keep the PyPortal's local data snapshot fresh. The PyPortal
            # renders locally; we push data every few seconds so every
            # screen has live numbers when the user navigates to it.
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
                    if txt in ("READY", "REQUEST_STATE"):
                        logger.info("pyportal: %s — resyncing full state", txt)
                        self._push_full_state()
                        last_stats_push = now
                        last_wifi_push = now
                        last_files_push = now
                        last_cams_push = now
                        self._last_drives_push = now
                    elif txt == "REQUEST_QR":
                        qr = self.fetch_qr()
                        if qr is not None:
                            self._pyportal_send("qr", qr)
                    elif txt == "ROTATE_KEY":
                        resp = self.rotate_wifi_key()
                        logger.info("pyportal: rotate -> %s", resp)
                        qr = self.fetch_qr()
                        if qr is not None:
                            self._pyportal_send("qr", qr)
                    elif txt == "RESCAN_WIFI":
                        snap = self.fetch_wifi()
                        if snap is not None:
                            self._pyportal_send("wifi", snap)
                    elif txt.startswith("NAV:"):
                        logger.info("pyportal: %s", txt)
                        if txt == "NAV:qr":
                            qr = self.fetch_qr()
                            if qr is not None:
                                self._pyportal_send("qr", qr)
                    elif txt.startswith("TAP:") or txt.startswith("TOUCH:") \
                            or txt.startswith("SWIPE:"):
                        logger.info("pyportal: %s", txt)
                    elif txt:
                        logger.info("pyportal: %s", txt)

            # Optional carousel for demo mode — alternate idle <-> stats.
            if AUTO_CYCLE and now >= self._cycle_paused_until:
                t = int(now // LOGO_DURATION) % 2
                desired = self.IDLE if t == 0 else self.STATS
                if self._current_mode != desired:
                    self._set_mode(desired, pause_cycle=False)

            time.sleep(0.08)
