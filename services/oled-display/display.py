"""
Droplet TFT Display Driver
===========================
Drives the front-panel 480x320 TFT via an Adafruit PyPortal Titano (the status
display) connected over USB-serial. The display's own SAMD51 + ILI9341 handles
rendering; this module streams JSON commands over /dev/ttyACM* and mirrors every
frame to a preview PNG so the dashboard can show what's on the panel.

Backends:
  1. pyportal   - USB-serial to an Adafruit PyPortal Titano / status display (primary)
  2. simulated  - writes a PNG to SIM_OUTPUT (dev/CI fallback, auto-used
                  when no status display is present)

The direct-SPI / luma.lcd / fbtft-framebuffer paths were removed after the
pivot to the status display (the inference host's GPIO/SPI driver stack is
incompatible with the GPIO-header TFT shields we originally targeted; see WARP-127).
gpio_shim, the old GPIO library, luma, spidev, and the XPT2046 touch code
are gone.

The visual system mirrors the web dashboard (`apps/web-dashboard/`) so the
on-device screen looks like a compact version of the admin UI: same Droplet
brand mark (faceted indigo drop, geometry from `DropletMark.tsx` /
`public/logo.svg`), same color tokens (dark mode surface + `#818cf8` accent),
same tile / status-chip layout.
"""

import os
import re
import ssl
import glob
import time
import json
import socket
import logging
import threading
import urllib.request
import urllib.error
from datetime import datetime
from datetime import datetime as _dt_datetime
from pathlib import Path
from typing import Optional, List, Any, Callable, Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError:  # py<3.9
    ZoneInfo = None  # type: ignore

# Timezone for the wall-clock we push to the status display. The container
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
# The safe area — WARP-1702
# ---------------------------------------------------------------------------
# The screens further down are authored against the raw frame edge: their
# margins are literals measured from x=0 and from WIDTH/HEIGHT. That is correct
# on a 480x320 TFT, where every pixel reaches the eye. On the 1424x280 rack bar
# it is not — the bezel/driver board eats a strip on each side, which is why
# WARP-1644 gave layout_wide a safe area.
#
# Only `system` and `debug` route through layout_wide, so every other screen
# still ran off the glass: the founder's photo of the home tile grid had the
# mark sliced, "Ask AI" reading "sk AI" and the status ribbon cut off.
#
# Rather than re-derive coordinates in eight renderers, those renderers draw
# onto a canvas the size of the SAFE AREA and hand it to `_fit_panel()`, which
# composites it into the panel frame at the inset. Their literals stay correct
# because every one of them is relative to the canvas origin — which is exactly
# why this is done with a canvas rather than by threading an origin through.
#
# On a 480x320 panel the inset is (0, 0), the canvas IS the frame and
# `_fit_panel` is a no-op, so that path renders byte-identically to before.
def _safe_inset() -> Tuple[int, int]:
    """(x, y) bezel inset for the current panel. (0, 0) unless wide.

    Deferred import: layout_wide imports us, so this cannot be module-level.
    It is also the single source of the inset — the env knobs stay documented
    in one place (layout_wide.SAFE_INSET_*) rather than being read twice.
    """
    try:
        import layout_wide
        if not layout_wide.is_wide():
            return 0, 0
        return layout_wide.SAFE_INSET_X, layout_wide.SAFE_INSET_Y
    except Exception:                                           # noqa: BLE001
        # A display backend must never take the service down over geometry.
        return 0, 0


def _safe_canvas(bg) -> Image.Image:
    """Blank canvas for a 480x320-authored screen: the panel minus the bezel."""
    ix, iy = _safe_inset()
    return Image.new("RGB", (WIDTH - 2 * ix, HEIGHT - 2 * iy), bg)

# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------
# "auto" (default) probes the status display on USB-serial and falls back to "sim".
# "pyportal" / "sim" force a specific backend (primarily for CI / dev).
#
# WARP-1640 adds "fb": the rack panel is a plain HDMI monitor on the box's own
# iGPU, so the HOST renders and blits (see fb.py) rather than streaming JSON to
# firmware that draws for us.
#
# "fb" is deliberately EXPLICIT-ONLY and is never reached from "auto". The 5s
# promotion loop below re-probes USB every tick, so an auto-selected fb backend
# would silently lose the panel to any PyPortal plugged in later.
BACKEND = os.environ.get("DISPLAY_BACKEND", "auto").lower()

# Backends whose screens are driven from `self._v3`, i.e. the ones that need
# the cycle loop's periodic data pumps running. Getting this wrong is the
# single most expensive mistake in this file: `_v3` is populated ONLY via
# `_mirror_to_v3()` <- `_pyportal_send()`, so a backend missing from here
# renders CPU 0% / MEM 0% / DISK 0% forever while every renderer works
# perfectly — it is drawing an empty dict.
_DATA_BACKENDS = ("pyportal", "fb")

# --- Host sensor discovery (see _get_cpu_temp / _get_gpu) -------------------
# hwmon drivers that report *CPU die/package* temperature. Deliberately a
# whitelist: sweeping every hwmon node would pick up the chipset, an NVMe or
# the GPU and print it under "TEMP".
#   k10temp  — AMD Zen (the mini-rack box)      coretemp — Intel core/package
#   zenpower — 3rd-party AMD Zen driver         cpu_thermal / soc_thermal — ARM
_CPU_HWMON_DRIVERS = frozenset({
    "k10temp", "zenpower", "coretemp", "cpu_thermal", "soc_thermal",
})
# Per-input labels worth reading on those drivers. Tctl is AMD's control
# temperature (the one every tool quotes); Tdie is the physical die reading;
# "package id 0" is Intel's whole-package sensor. Tccd1..N are per-CCD and
# excluded — they run cooler than Tctl and would understate the box.
_CPU_HWMON_LABELS = frozenset({"tctl", "tdie", "package id 0"})
# `card0` / `card1` are GPUs; `card1-HDMI-A-3` is a connector hanging off one.
_DRM_CARD_RE = re.compile(r"card\d+")
# sysfs roots, named so tests can point them at a fixture tree. Docker mounts
# /sys read-only into the container by default, which is all these reads need.
_SYS_THERMAL = "/sys/class/thermal"
_SYS_HWMON = "/sys/class/hwmon"
_SYS_DRM = "/sys/class/drm"
_SYS_GPU_LOAD_GLOBS = ("/sys/devices/platform/*.gpu/load",
                       "/sys/devices/platform/gpu.0/load")

# Status display backend (USB-serial-connected Adafruit PyPortal Titano).
PYPORTAL_TTY = os.environ.get("PYPORTAL_TTY", "/dev/ttyACM1")
PYPORTAL_BAUD = int(os.environ.get("PYPORTAL_BAUD", "115200"))

# Host-side device-bridge URL (see services/oled-display/device-bridge.py).
# The bridge runs on the appliance host and exposes /wifi, /files, /cameras,
# /drives, /openwrt/qr so the container gets live data without mounting
# NetworkManager/DBus/etc. inside. Default 127.0.0.1 because the bridge
# binds to loopback by default (see BRIDGE_BIND in device-bridge.py).
WIFI_HELPER_URL = os.environ.get(
    "WIFI_HELPER_URL", "http://127.0.0.1:9090")
WIFI_REFRESH_SECONDS = int(os.environ.get("WIFI_REFRESH_SECONDS", "20"))
FILES_REFRESH_SECONDS = int(os.environ.get("FILES_REFRESH_SECONDS", "30"))
CAMERAS_REFRESH_SECONDS = int(os.environ.get("CAMERAS_REFRESH_SECONDS", "15"))
# WARP-1645 — the orchestrator's health monitor refreshes on its own 15s
# cadence, so there is nothing to gain by polling faster than it updates.
SERVICES_REFRESH_SECONDS = int(os.environ.get("SERVICES_REFRESH_SECONDS", "15"))

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

# Semantic aliases used across screens
CARD_COLOR       = SURFACE_RAISED
TEMP_WARN        = STATUS_ORANGE
TEMP_CRIT        = STATUS_RED

# ---------------------------------------------------------------------------
# py-v3 palette (design_handoff_pyportal_touchscreen/README.md "Design Tokens")
# The redesigned idle / System+Wi-Fi / power-sequence screens use this token
# set verbatim. Kept separate from the legacy dashboard-mirror tokens above so
# the older home/chat/devices/settings renderers (still reachable for
# back-compat) are untouched. Every value below maps 1:1 to a row in the
# handoff token table; rgba tokens are flattened to the nearest solid.
# ---------------------------------------------------------------------------
V3_BG        = (0x05, 0x05, 0x07)   # #050507 screen background
V3_PANEL     = (0x0D, 0x0D, 0x12)   # #0d0d12 alerts drawer background
V3_SURFACE   = (0x14, 0x14, 0x20)   # #141420 chips, inactive pills
V3_SURFACE2  = (0x1D, 0x1D, 0x2E)   # #1d1d2e alert rows, "Clear all"
V3_SEP       = (0x2A, 0x2A, 0x38)   # #2a2a38 hairline dividers
V3_SEP2      = (0x3A, 0x3A, 0x4A)   # #3a3a4a stronger borders
V3_TEXT      = (0xFF, 0xFF, 0xFF)   # #ffffff primary numerics & values
V3_LABEL2    = (0xC8, 0xC8, 0xD4)   # #c8c8d4 clock time, button labels
V3_LABEL3    = (0x8B, 0x8B, 0x9C)   # #8b8b9c eyebrows / captions
V3_LABEL4    = (0x54, 0x54, 0x66)   # #545466 faint / standby text
V3_ACCENT    = (0x81, 0x8C, 0xF8)   # #818cf8 sparkline, rule, SSID, mark
V3_ACCENT_DIM = (0x5B, 0x62, 0xC7)  # #5b62c7 seconds hairline
V3_ACCENT_INK = (0xB4, 0xBA, 0xFF)  # #b4baff mark highlight, password text
# accentSubtle rgba(129,140,248,0.18) over #050507 -> nearest solid fill for
# the active toggle cell (0.18*accent + 0.82*bg, per-channel).
V3_ACCENT_SUBTLE = (0x1B, 0x1D, 0x32)  # ~#1b1d32
# Waiting dots at rest on the claim screen — #818cf8 @ 30% over the bg.
V3_ACCENT_FAINT = (0x2B, 0x2F, 0x52)
# rgba(255,159,10,0.18) over #050507 -> orange-tinted KEY-pill fill when <60s.
V3_ORANGE_SUBTLE = (0x32, 0x21, 0x08)  # ~#322108
V3_TRACK     = (0x1F, 0x1F, 0x30)   # #1f1f30 progress/seconds track
V3_GREEN     = (0x30, 0xD1, 0x58)   # #30d158 OK status, cameras online
V3_ORANGE    = (0xFF, 0x9F, 0x0A)   # #ff9f0a warnings, key-expiring
V3_RED       = (0xFF, 0x45, 0x3A)   # #ff453a alerts, critical
V3_WHITE     = (0xFF, 0xFF, 0xFF)   # #ffffff QR card
# sparkline fill #818cf822 (accent @ ~13% alpha) over bg -> nearest solid.
V3_SPARK_FILL = (0x16, 0x17, 0x27)  # ~#161727
# CRT phosphor line on shutdown collapse (#eaeaff).
V3_PHOSPHOR  = (0xEA, 0xEA, 0xFF)   # #eaeaff

# ---------------------------------------------------------------------------
# Assets + cycle timing
# ---------------------------------------------------------------------------
ASSETS_DIR = Path(__file__).parent / "assets"
SIM_OUTPUT = Path(os.environ.get("SIM_OUTPUT", "/tmp/tft_preview.png"))

# Auto-cycle disabled by default on the touch build: a touch display is
# for interaction, not a billboard. Setting AUTO_CYCLE=1 restores the
# old logo -> stats carousel for headless demos.
AUTO_CYCLE = os.environ.get("AUTO_CYCLE", "0") == "1"

# WARP-1641 — how long the debug screen's "return console" button stays armed
# after the first tap. Long enough to be a deliberate second press, short
# enough that walking away disarms it.
CONSOLE_CONFIRM_SECONDS = float(os.environ.get("CONSOLE_CONFIRM_SECONDS", "4"))

# ---------------------------------------------------------------------------
# Boot readiness (WARP-624; redirect/TLS fix WARP-638)
# ---------------------------------------------------------------------------
# The panel opens on the boot screen at construction and stays there until
# the system is healthy, then flips to the live UI. Health is probed against
# the same-host orchestrator behind the nginx gateway (loopback — matches
# droplet-device-bridge.service's ORCHESTRATOR_URL=http://127.0.0.1). A 2xx
# means "ready". If we never see a 2xx within BOOT_MAX_SECONDS we surface the
# UI anyway so a degraded stack still shows something instead of a stuck
# splash. Both knobs are overridable; defaults stay on loopback so there are
# no host-specific defaults baked in.
#
# WARP-638: nginx :80 issues `301 -> https://$host$request_uri`, and the HTTPS
# vhost serves a SELF-SIGNED cert. urllib follows the redirect to
# https://127.0.0.1/api/health and, with default verification, raises
# SSLCertVerificationError — so the probe returned False on EVERY tick and the
# splash sat for the full 90s on every (re)start. The probe now uses an
# unverified SSL context (loopback to our own gateway's self-signed cert —
# there's nothing to verify against), so a warm stack reads ready in ~1 probe.
BOOT_READINESS_URL = os.environ.get(
    "BOOT_READINESS_URL", "http://127.0.0.1/api/health")
# Unverified context for the loopback HTTPS hop after the :80->:443 redirect.
# Scoped to the readiness probe only; nothing else in this module makes TLS
# calls (the bridge endpoints are plain-HTTP loopback).
_READINESS_SSL_CTX = ssl.create_default_context()
_READINESS_SSL_CTX.check_hostname = False
_READINESS_SSL_CTX.verify_mode = ssl.CERT_NONE


def _env_positive_int(name: str, default: int, raw: Optional[str] = None) -> int:
    """Read a positive-int env var, degrading gracefully instead of raising.

    L1 (WARP-624): a malformed value (e.g. ``BOOT_MAX_SECONDS=ninety``) would
    otherwise raise ValueError at import and kill the whole service. We fall
    back to ``default`` on anything non-integer and clamp non-positive values
    to ``default`` too — a zero/negative boot budget would make the timeout
    fallback fire instantly (or never make sense). ``raw`` is injectable for
    deterministic tests.
    """
    if raw is None:
        raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        logger.warning(
            "%s=%r is not an integer — falling back to %s", name, raw, default)
        return default
    if value <= 0:
        logger.warning(
            "%s=%r must be positive — falling back to %s", name, raw, default)
        return default
    return value


BOOT_MAX_SECONDS = _env_positive_int("BOOT_MAX_SECONDS", 90)
# How often the cycle loop actually probes readiness. The loop ticks ~12.5x/s;
# gating the probe to every 2s keeps it cheap.
BOOT_READINESS_INTERVAL = float(os.environ.get("BOOT_READINESS_INTERVAL", "2.0"))
# How often the cycle loop verifies the live PyPortal link (WARP-638): stat the
# ttyACM node to spot a USB re-enumeration after a device reset. Same 2s cadence
# as the readiness probe — cheap, but fast enough that a reset is noticed and
# the port reopened within a couple seconds instead of the device sitting on
# its boot screen against a stale host fd.
LIVENESS_CHECK_INTERVAL = float(
    os.environ.get("LIVENESS_CHECK_INTERVAL", "2.0"))
LOGO_DURATION = 5
STATS_DURATION = 10
MESSAGE_HOLD = 30
# How long an LLM message pins the screen. After that we return to home.
MESSAGE_RETURN_HOME_AFTER = MESSAGE_HOLD


# Font discovery for the sim. The handoff renders in Inter (weights 300-800)
# and leans on heavy weights (800) for hero numerals. On the device this is a
# bundled bitmap font; in the CPython sim we want a real proportional TTF so
# the preview PNG reads like the design. We search a small candidate list per
# weight class (Inter first if present, then a heavy platform default) and
# cache the resolved FreeType faces by (size, weight). The sim font is purely
# cosmetic — it does NOT affect what the device draws.
_FONT_CACHE: dict = {}

# Candidate face files, ordered best-first, per weight bucket. "heavy" backs
# the 800-weight heroes; "bold" backs 700; "regular" backs 400-600.
_FONT_CANDIDATES = {
    "heavy": [
        "Inter-ExtraBold.ttf", "Inter-Bold.ttf", "Inter_28pt-ExtraBold.ttf",
        # Windows
        "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf",
        # Linux (container)
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "DejaVuSans-Bold.ttf",
        # macOS
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ],
    "bold": [
        "Inter-Bold.ttf", "Inter-SemiBold.ttf",
        "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ],
    "regular": [
        "Inter-Regular.ttf", "Inter-Medium.ttf",
        "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ],
}

# Extra directories Inter might live in (bundled alongside the device font, or
# dropped into the service dir during dev).
_FONT_SEARCH_DIRS = [
    Path(__file__).parent / "pyportal" / "lib" / "fonts",
    Path(__file__).parent / "assets" / "fonts",
    Path("/usr/share/fonts/truetype/inter"),
    Path("/usr/share/fonts/opentype/inter"),
    Path("C:/Windows/Fonts"),
]


def _resolve_font_file(name: str) -> Optional[str]:
    p = Path(name)
    if p.is_absolute():
        return str(p) if p.exists() else None
    for d in _FONT_SEARCH_DIRS:
        cand = d / name
        if cand.exists():
            return str(cand)
    # Bare DejaVu names resolve via the legacy /usr/share search too.
    for search in ("/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/"):
        cand = Path(search) / name
        if cand.exists():
            return str(cand)
    return None


def _get_font(size: int, bold: bool = False,
              weight: str = "") -> ImageFont.FreeTypeFont:
    """Resolve a FreeType face for the sim at `size` px.

    `weight` is one of "heavy" (800 heroes) / "bold" (700) / "regular";
    `bold=True` is kept for back-compat and maps to the "bold" bucket. Falls
    back to PIL's built-in bitmap font only if no TTF is found anywhere.
    """
    bucket = weight or ("bold" if bold else "regular")
    if bucket not in _FONT_CANDIDATES:
        bucket = "regular"
    key = (size, bucket)
    cached = _FONT_CACHE.get(key)
    if cached is not None:
        return cached
    face = None
    for name in _FONT_CANDIDATES[bucket]:
        resolved = _resolve_font_file(name)
        if resolved:
            try:
                face = ImageFont.truetype(resolved, size)
                break
            except Exception:
                continue
    if face is None:
        face = ImageFont.load_default()
    _FONT_CACHE[key] = face
    return face


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


def draw_droplet_mark_liquid(
    img: Image.Image, draw: ImageDraw.ImageDraw,
    x: int, y: int, size: int, frac: float,
):
    """Draw the mark as a vessel filled to `frac` (0..1) with accent liquid.

    Used by the boot (fill) / shutdown (drain) power sequences. The empty
    shell is a dim outline of MARK_LEFT; the liquid is the accent fill clipped
    to the body silhouette. Mirrors preview.html drawMarkLiquid /
    markSilhouette. `img` is the frame `draw` is bound to (PIL gives no public
    way back from a Draw to its Image, so callers pass both).
    """
    vw, vh = _MARK_VIEWBOX
    scale = size / vh
    x_off = x + (size - int(vw * scale)) // 2
    y_off = y

    def proj(pt):
        return (int(x_off + pt[0] * scale), int(y_off + pt[1] * scale))

    body = [proj(p) for p in _MARK_LEFT]
    # Empty shell — dim flat fill so the vessel reads before it fills.
    draw.polygon(body, fill=(0x18, 0x18, 0x28))
    frac = max(0.0, min(1.0, frac))
    if frac <= 0.002:
        return
    # Liquid level rises from the bottom of the body (viewbox y=48) upward.
    top = y_off
    bottom = y_off + int(48 * scale)
    level = bottom - int((bottom - top) * frac)
    # Build a clip mask = body silhouette ∩ (everything at/below the level).
    from PIL import ImageChops
    body_mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(body_mask).polygon(body, fill=255)
    level_mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(level_mask).rectangle(
        [x_off - 4, level, x_off + int(vw * scale) + 4, bottom + 6], fill=255)
    liquid = Image.new("RGB", img.size, V3_ACCENT)
    img.paste(liquid, (0, 0), ImageChops.multiply(body_mask, level_mask))


def _v3_text(draw: ImageDraw.ImageDraw, s: str, x: int, y: int, *,
             font: ImageFont.FreeTypeFont, fill, anchor: str = "la",
             tracking: float = 0.0):
    """Draw text with optional per-character letter-spacing (tracking).

    PIL has no tracking, so when `tracking != 0` we lay out glyphs manually.
    `anchor` follows PIL's two-letter convention but we only special-case the
    horizontal part for tracked text (l/m/r); vertical uses the PIL anchor.
    Returns the total advance width drawn. Mirrors preview.html text()'s
    letter-spacing handling. (design_handoff: eyebrow +1.2..+2, clock -6.)
    """
    if not tracking:
        draw.text((x, y), s, font=font, fill=fill, anchor=anchor)
        return int(draw.textlength(s, font=font))
    # Manual tracked layout.
    widths = [draw.textlength(ch, font=font) for ch in s]
    total = sum(widths) + tracking * (len(s) - 1) if s else 0
    halign = anchor[0] if anchor else "l"
    if halign == "m":
        cx = x - total / 2
    elif halign == "r":
        cx = x - total
    else:
        cx = x
    vanchor = "l" + (anchor[1] if len(anchor) > 1 else "a")
    for ch, w in zip(s, widths):
        draw.text((cx, y), ch, font=font, fill=fill, anchor=vanchor)
        cx += w + tracking
    return int(total)


def _v3_text_width(draw: ImageDraw.ImageDraw, s: str,
                   font: ImageFont.FreeTypeFont, tracking: float = 0.0) -> float:
    if not s:
        return 0.0
    w = sum(draw.textlength(ch, font=font) for ch in s)
    return w + tracking * (len(s) - 1)


def _rrect(draw: ImageDraw.ImageDraw, x, y, w, h, r, *, fill=None,
           outline=None, width=1):
    """Rounded rect convenience wrapper (clamps radius)."""
    r = int(max(0, min(r, w / 2, h / 2)))
    draw.rounded_rectangle([(x, y), (x + w, y + h)], radius=r,
                           fill=fill, outline=outline, width=width)


def _wifi_qr_payload(ssid: str, key: str) -> str:
    """Format a WPA WiFi-join QR payload with metacharacter escaping (WARP-819).

    The single-box AP is always WPA2-PSK, so the security type is a fixed
    `WPA` and the field order is T;S;P — identical to device-bridge.py's
    `_hostapd_wifi_payload`. Escapes the WiFi-QR metacharacters (\\ ; , : ")
    per the de-facto standard so an SSID/PSK containing them still scans. This
    is the sim-only encode path; on the device the firmware paints the
    host-supplied matrix verbatim (the bridge does the real encode), so the two
    stay byte-identical.
    """
    def esc(s: str) -> str:
        return (s or "").replace("\\", "\\\\").replace(";", "\\;") \
                        .replace(",", "\\,").replace(":", "\\:") \
                        .replace('"', '\\"')

    return "WIFI:T:WPA;S:{};P:{};;".format(esc(ssid), esc(key))


def _setup_qr_payload(setup_url: str, code: str) -> str:
    """Build the scan-to-claim deep link: `<setup_url>?c=<CODE>`.

    Design-handoff claim screen: scanning the QR lands the phone in the setup
    wizard with the claim code in the `c` query param (ClaimStep prefills it).
    The code goes bare — separators stripped, upper-cased — matching the
    orchestrator's normalizeClaimCode(), which ignores non-alphanumerics; the
    bare form also keeps the QR a version smaller. Returns "" when either part
    is missing (no deep link to encode — the card degrades to mark-only).
    """
    url = (setup_url or "").strip()
    bare = "".join(ch for ch in (code or "") if ch.isalnum()).upper()
    if not url or not bare:
        return ""
    return "{}{}c={}".format(url, "&" if "?" in url else "?", bare)


# Hard cap on the claim QR matrix we put on the serial wire — mirrors
# ClaimRequest's wifi_qr_matrix max_length=64 (main.py), which exists because
# a v-large QR would OOM the PyPortal. The internal encode path must honor the
# same firmware-tolerance contract: an oversized payload (e.g. a long custom
# setup_url) degrades to the no-QR variant rather than shipping a heap bomb.
_CLAIM_QR_MAX_ROWS = 64


def _encode_qr_matrix(payload: str) -> Optional[List[List[int]]]:
    """Encode `payload` into a 0/1 QR bit-matrix, host-side.

    The firmware never encodes on-device (same contract as the Wi-Fi QR the
    bridge encodes) — this is the host half that feeds the claim frame's
    `setup_qr_matrix`. ERROR_CORRECT_Q (~25% recovery), NOT the M the generic
    `_draw_qr` fallback uses: the claim card paints a 32px white droplet-mark
    pad dead-centre over the symbol, which at M corrupts more codewords than
    Reed-Solomon can recover (the padded symbol fails to decode at M and
    decodes cleanly at Q for the typical deep-link payload). Returns None
    when the `qrcode` dep is unavailable or the symbol would exceed
    `_CLAIM_QR_MAX_ROWS` — the claim screen then renders the no-QR variant
    (graceful degradation, never a firmware heap risk).
    """
    if not payload:
        return None
    try:
        import qrcode
        qr = qrcode.QRCode(
            border=0, error_correction=qrcode.constants.ERROR_CORRECT_Q)
        qr.add_data(payload)
        qr.make(fit=True)
        matrix = [[1 if cell else 0 for cell in row]
                  for row in qr.get_matrix()]
        if len(matrix) > _CLAIM_QR_MAX_ROWS:
            return None
        return matrix
    except Exception:
        return None


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
    """Status-display-backed 480x320 TFT controller with touch-driven screens."""

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
    # Lifecycle overlays (WARP-624) — modal, not part of the touch carousel.
    BOOT = "boot"
    SHUTDOWN = "shutdown"
    # Onboarding claim screen (WARP-632 / ADR-017) — modal, host-driven. Shown
    # while the box is unclaimed; the orchestrator mints the code and pushes it.
    CLAIM = "claim"
    # py-v3 redesign live states. IDLE = editorial clock; SYSTEM = combined
    # System+Wi-Fi (replaces the old separate stats + qr screens); STANDBY =
    # powered-off "tap to power on". The device firmware mirrors these 1:1.
    IDLE = "idle"
    SYSTEM = "system"
    STANDBY = "standby"
    # WARP-1641 — the rack panel's recovery screen. Reachable only by touch;
    # the orchestrator never pushes it. Wide layouts only (the 480x320 screens
    # have their own settings surface).
    DEBUG = "debug"

    def __init__(self):
        self._pyportal = None
        self._pyportal_lock = threading.Lock()
        # Path of the ttyACM the live fd was opened on. Tracked so the cycle
        # loop can detect a USB re-enumeration: when the kernel renumbers the
        # CDC interfaces (firmware reset, replug, host-side hub reset) the
        # original device node disappears but our open fd silently no-ops —
        # writes succeed without doing anything and reads return zero bytes,
        # so the existing reconnect-on-IOError path in `_pyportal_send` never
        # fires. A periodic `os.path.exists(self._pyportal_path)` check is
        # the cheapest reliable way to spot a dead fd.
        self._pyportal_path: Optional[str] = None
        # Throttle for the periodic liveness check (WARP-638). The cycle loop
        # calls _check_pyportal_liveness() every tick (~12.5x/s) but the actual
        # /dev stat only runs once per LIVENESS_CHECK_INTERVAL.
        self._last_liveness_check = 0.0
        # Set by `_probe_pyportal` on every successful probe; cleared by the
        # cycle loop after it runs `_push_full_state`. Probe always discards
        # the firmware's pre-probe READY/REQUEST_STATE handshake (the probe
        # calls `reset_input_buffer()` before pinging, and only reads enough
        # bytes to confirm an OK), so we can't rely on the in-loop READY
        # handler to fire on a fresh probe. Without this flag, the firmware
        # would sit with empty state until the slowest periodic push tick
        # (files = 30s) — i.e. "the screen doesn't auto-fill on reboot".
        self._needs_resync = False
        self._backend = "sim"
        # Open on the boot screen (WARP-624): a cold power-on must read
        # "Starting Droplet" until the readiness check (or its timeout)
        # flips us to the live UI.
        self._current_mode = self.BOOT
        # Boot/shutdown caption state, rendered by render_boot/render_shutdown.
        self._boot_stage = "Starting up"
        self._boot_detail = ""
        self._boot_pct: Optional[int] = None
        self._shutdown_reason = ""
        self._shutdown_phase = "stopping"
        # Claim screen state (WARP-632). Set by show_claim from the
        # orchestrator's minted code; retained so a live re-render keeps showing
        # the same code + setup URL.
        self._claim_code = ""
        self._claim_setup_url = ""
        # WARP-819: optional Wi-Fi-connect creds shown on the claim screen so a
        # first-boot user can join the box's Wi-Fi with no prior config. Empty
        # by default; render_claim falls back to the claim-only layout when the
        # matrix/ssid/psk are absent (an older orchestrator that doesn't send
        # them, or the bridge being down at claim time).
        self._claim_wifi_ssid = ""
        self._claim_wifi_psk = ""
        self._claim_wifi_qr_matrix = None
        # Design-handoff scan-to-claim QR: the setup deep-link matrix, derived
        # host-side by show_claim (the firmware never encodes) and retained so
        # re-renders keep painting the same QR the panel shows.
        self._claim_setup_qr_matrix = None
        # Signature of the last claim frame sent — show_claim no-ops an
        # unchanged push (the orchestrator re-pushes every poll tick while
        # unclaimed; an identical frame would make the firmware tear down and
        # rebuild the same tree, blanking the panel for nothing).
        self._claim_frame_sig = None
        # Readiness transition state. `_boot_complete` is an explicit flag —
        # we never infer "done" from the absence of something. `_boot_started_at`
        # anchors the timeout; `_last_readiness_check` gates the probe cadence.
        self._boot_complete = False
        self._boot_started_at = time.time()
        self._last_readiness_check = 0.0
        # WARP-638: set once a real stats frame has been ingested. On a WARM
        # start the orchestrator is already up and pushing stats, so a live
        # link + fresh data IS readiness — the warm-start short-circuit in
        # _readiness_tick uses this to surface the UI in a few seconds instead
        # of waiting on the HTTP probe (or, worse, the 90s timeout).
        self._got_live_data = False
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

        # --- py-v3 redesign live state (idle / System+Wi-Fi / alerts) -------
        # 12/24 clock mode. Persisted on the device to /clock_mode.txt; in the
        # host sim it lives in RAM (the sim has no device FS). Default '24'.
        self._clock_mode = "24"
        # Live data snapshot the redesigned screens render from, seeded with the
        # handoff sample shape so a cold sim renders something sensible.
        self._v3 = {
            "cpu": 0, "mem": 0, "disk": 0,
            # None, not 0 — a cold panel must render `—` for a sensor it has
            # not read yet (WARP-1643). `gpu` is often None permanently: most
            # boxes have no GPU to report.
            "temp": None, "gpu": None,
            "ip": "-", "hostname": "droplet", "uptime": "-", "now": "",
            "date": "",
            "sparks_cpu": [],
            "wifi": {"ssid": "Droplet-AI", "clients": 0, "channel": 0,
                     "band": "", "key_ttl_seconds": 0, "password": ""},
            "cameras": {"online": 0, "total": 0},
            # WARP-1645 — filled by fetch_services(). All-None so a cold box
            # renders em dashes; see WARP-1643 on why not zeros.
            "services": {"up": None, "total": None, "status": None,
                         "degraded": []},
            "wan_latency_ms": 0, "lan_clients": 0,
        }
        self._v3_spark_len = 48  # handoff: 48-sample CPU history
        # Alerts drawer state — list of {type, title, detail, time, cleared}.
        self._alerts: List[dict] = []
        self._events_open = False
        # Live touch feedback: momentary highlight after a tap
        self._last_tap_region: Optional[str] = None
        self._last_tap_at: float = 0.0
        # WARP-1640 — set by _init_device() when DISPLAY_BACKEND=fb; stays None
        # on every other backend so _push()'s check is a plain identity test.
        self._fb = None
        # WARP-1641 — debug screen's two-tap console handback.
        self._console_confirm_until: float = 0.0
        self._console_last_result: str = ""

        self._init_device()
        self._load_logo()
        # First frame — render home so the screen isn't blank on boot.
        self._render_current()

    # ----- Backend init -------------------------------------------------

    def _init_device(self):
        # WARP-1640 — the rack panel. Explicit opt-in only: returning here
        # BEFORE the USB probe is what keeps a later-plugged PyPortal from
        # stealing the panel via the cycle loop's promotion path.
        if BACKEND == "fb":
            from fb import FramebufferBackend
            self._fb = FramebufferBackend.open()
            if self._fb is not None:
                self._backend = "fb"
                logger.info("TFT initialised on the framebuffer panel "
                            "(%dx%d stride=%d)", self._fb.width,
                            self._fb.height, self._fb.stride)
                return
            # open() already logged why. Fall through to sim so the service
            # still serves /display/preview and the orchestrator's pushes
            # still land — a missing panel must not take the container down.
            logger.warning("framebuffer backend requested but unavailable — "
                           "falling back to sim")
            self._backend = "sim"
            return

        # The status display takes several seconds to finish USB enumeration
        # after the host reboots, so retry a few times before falling through
        # to sim. Otherwise a cold boot leaves the user with a blank screen
        # until the container is restarted.
        if BACKEND in ("auto", "pyportal"):
            attempts = 6 if BACKEND == "auto" else 1
            for attempt in range(attempts):
                if self._try_pyportal():
                    return
                if attempt < attempts - 1:
                    time.sleep(2)
        self._backend = "sim"
        logger.warning("Using simulated display (no status display detected on USB)")

    def _try_pyportal(self) -> bool:
        try:
            import serial
        except ImportError:
            return False
        # The status display can re-enumerate as ttyACM0/1/2 depending on
        # which USB interface ends up as "data" vs "console" at boot. Try each
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
            # different serial device (e.g. the display's REPL console).
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
            # Ask the cycle loop to push a full state burst on its next
            # tick. Necessary because the probe above ran
            # `reset_input_buffer()` before pinging, which discards the
            # firmware's READY/REQUEST_STATE handshake — without an
            # explicit resync, the firmware would render empty fields
            # until the slowest periodic push tick (30s).
            self._needs_resync = True
            logger.info("TFT initialised via status display on %s @ %d baud",
                        path, PYPORTAL_BAUD)
            return True
        except Exception as e:
            logger.debug("status display probe %s failed: %s", path, e)
            return False

    def _wants_data(self) -> bool:
        """Does this backend need the cycle loop's periodic data pumps?

        WARP-1640. The pumps call `_pyportal_send()`, whose FIRST action is
        `_mirror_to_v3()` — i.e. they are how `self._v3` gets populated, on
        every backend, regardless of whether a serial device exists.
        `_pyportal_send` is safe with no device attached: it returns right
        after the mirror.

        The name is historical; the behaviour is not PyPortal-specific. Gating
        these on `== "pyportal"` is what would leave the rack panel rendering
        CPU 0% / MEM 0% / DISK 0% forever."""
        return self._backend in _DATA_BACKENDS

    def _mirror_to_v3(self, mode: str, data: Optional[dict]) -> None:
        """Feed the host's own py-v3 preview from the SAME frames we send the
        device, so the rendered PNG matches what the panel shows. Best-effort;
        unknown modes are ignored."""
        if not data:
            return
        try:
            if mode == "stats":
                self.update_stats(data)
            elif mode == "wifi":
                self.update_wifi(data)
            elif mode == "cameras":
                self.update_cameras(data)
            elif mode == "services":
                self.update_services(data)
        except Exception as e:                                  # noqa: BLE001
            logger.debug("v3 mirror (%s) failed: %s", mode, e)

    def _pyportal_send(self, mode: str, data: Optional[dict] = None):
        # Mirror into the host preview store before the connection check so the
        # sim preview stays live even when no physical panel is attached.
        self._mirror_to_v3(mode, data)
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
            # I/O error usually means the status display re-enumerated on
            # USB (e.g. firmware reloaded) and our file handle is stale.
            # Drop the handle, try to re-probe; subsequent calls will
            # either reconnect or stay quiet until the display is back.
            logger.warning("status display write failed (mode=%s): %s — reconnecting", mode, e)
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

    def _fit_panel(self, img: Image.Image, bg) -> Image.Image:
        """Composite a safe-area canvas into the full panel frame (WARP-1702).

        Returns `img` untouched when it already fills the panel — which covers
        both the wide-native screens (layout_wide draws at full size and does
        its own insetting) and every screen on a 480x320 panel.

        Touch regions are recorded by the renderers in CANVAS coordinates, so
        they are translated here, in the same place and by the same offset as
        the pixels. Doing it anywhere else is how the two drift apart.
        """
        if img.size == (WIDTH, HEIGHT):
            return img
        ox = (WIDTH - img.width) // 2
        oy = (HEIGHT - img.height) // 2
        frame = Image.new("RGB", (WIDTH, HEIGHT), bg)
        frame.paste(img, (ox, oy))
        with self._touch_regions_lock:
            for r in self._touch_regions:
                r.x += ox
                r.y += oy
        return frame

    def _push(self, image: Image.Image):
        # Every backend writes the preview PNG: the PyPortal renders the frame
        # itself from the data commands we stream over serial, the sim backend
        # has nothing else to do with the image, and on the framebuffer panel
        # the preview is how we verify remotely (GET /display/preview) without
        # standing in front of the rack.
        self._current_image = image
        # WARP-1640 — the rack panel. This is the ONLY place pixels reach the
        # framebuffer. FramebufferBackend.blit() already swallows its own
        # errors, but this is the render thread: belt-and-braces here means a
        # panel problem degrades to "preview still works" instead of killing
        # every screen update for the rest of the process's life.
        if self._fb is not None:
            try:
                self._fb.blit(image)
            except Exception as e:                              # noqa: BLE001
                logger.warning("panel blit failed: %s", e)
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
        # Extents come off the canvas, not WIDTH: on the rack panel the canvas
        # is the safe area, not the whole frame (WARP-1702).
        cw = img.width
        bar_h = 52
        draw.rectangle([(0, 0), (cw, bar_h)], fill=SURFACE_SECONDARY)
        draw.line([(0, bar_h), (cw, bar_h)], fill=SEPARATOR, width=1)

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
        draw.text((cw - clock_w - 14, 14), clock,
                  fill=TEXT_COLOR, font=font_clock)

        # Status chip between clock and brand
        if status is not None:
            chip_font = _get_font(11, bold=True)
            chip_bbox = draw.textbbox((0, 0), status, font=chip_font)
            chip_w = (chip_bbox[2] - chip_bbox[0]) + 22
            chip_h = 20
            chip_x = cw - clock_w - 14 - chip_w - 10
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
        img = _safe_canvas(BG_COLOR)
        cw, ch = img.size
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        content_y = self._draw_header(
            img, draw, show_home=False,
            status="Online",
        )

        font_label = _get_font(12, bold=True)
        font_title = _get_font(19, bold=True)
        font_meta = _get_font(12)

        tiles = [
            ("CHAT", "Ask AI", "Tap to chat",     self.CHAT,     self._go_chat),
            ("SYS",  "Status", "Health & metrics", self.STATS,    self._go_stats),
            ("NET",  "Network", self._get_ip(),   self.DEVICES,  self._go_devices),
            ("CFG",  "Settings", "Brightness & more", self.SETTINGS, self._go_settings),
        ]

        # Tile grid + a compact system status ribbon at the foot.
        #
        # WARP-1702 — the column count follows the panel shape. A tile needs
        # ~100px of height for its pill, title and subtitle, and the rack bar
        # has only ~270 to spend on header + grid + ribbon. Two rows do not fit
        # there: the subtitles were clipped by the tile edge and then again by
        # the ribbon. A 5:1 bar wants a single row of four anyway, and it has
        # the width to spare.
        pad = 10
        tile_gap = 10
        cols = 4 if cw >= 3 * ch else 2
        rows = -(-len(tiles) // cols)
        grid_h = ch - content_y - 66  # leave space for footer
        tile_w = (cw - 2 * pad - (cols - 1) * tile_gap) // cols
        tile_h = (grid_h - (rows - 1) * tile_gap) // rows

        for idx, (tag, title, sub, _mode, action) in enumerate(tiles):
            col = idx % cols
            row = idx // cols
            tx = pad + col * (tile_w + tile_gap)
            ty = content_y + row * (tile_h + tile_gap)
            self._draw_tile(draw, tx, ty, tile_w, tile_h,
                            tag, title, sub,
                            font_label, font_title, font_meta,
                            region=TouchRegion(f"tile_{tag.lower()}",
                                               tx, ty, tile_w, tile_h, action))

        # Status ribbon (mirrors dashboard's StatusSegment row)
        ribbon_y = ch - 56
        self._draw_status_ribbon(draw, pad, ribbon_y, cw - 2 * pad, 44)

        return self._fit_panel(img, BG_COLOR)

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
        # Legacy 480×320 PyPortal frame: formats with `:.0f`, so it needs a
        # float. `or 0.0` preserves the exact pre-WARP-1643 rendering here —
        # only the wide rack panel learns to say "—".
        temp = self._get_cpu_temp() or 0.0
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
        img = _safe_canvas(BG_COLOR)
        cw, ch = img.size
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
        # Legacy frame — see the note in render_stats(); needs a float.
        temp = self._get_cpu_temp() or 0.0

        pad = 10
        gap = 10
        card_w = (cw - 2 * pad - gap) // 2
        card_h = (ch - content_y - 56 - gap) // 2

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
        foot_y = ch - 42
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
        draw.text((cw - (bbox[2] - bbox[0]) - pad, foot_y - 2),
                  up_str, fill=TEXT_COLOR, font=_get_font(14))
        draw.text((cw - (bbox[2] - bbox[0]) - pad - 28, foot_y),
                  "UP", fill=LABEL_TERTIARY, font=_get_font(10, bold=True))

        return self._fit_panel(img, BG_COLOR)

    def render_chat(self) -> Image.Image:
        """Chat-prep screen — mirrors the dashboard's hero prompt capsule.

        The device itself can't run a REPL here (no keyboard), so this
        screen shows a reminder that the user should speak (or use the
        web UI) and displays the latest LLM-pushed message when present.
        """
        img = _safe_canvas(BG_COLOR)
        cw, ch = img.size
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
        cap_w = cw - 32
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
        msg_h = ch - msg_y - 16
        draw.rounded_rectangle(
            [(16, msg_y), (cw - 16, msg_y + msg_h)],
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

        return self._fit_panel(img, BG_COLOR)

    def render_devices(self) -> Image.Image:
        """Network / devices summary screen — derived from dashboard's
        devices tile + status-ribbon row."""
        img = _safe_canvas(BG_COLOR)
        cw, ch = img.size
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
             (cw - pad, content_y + 4 + card_h)],
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
        sub_h = ch - sub_y - 16
        col_w = (cw - 2 * pad - 12) // 2
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
        return self._fit_panel(img, BG_COLOR)

    def render_settings(self) -> Image.Image:
        """Settings screen — brightness slider + quick actions."""
        img = _safe_canvas(BG_COLOR)
        cw, ch = img.size
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
            [(pad, card_y), (cw - pad, card_y + card_h)],
            radius=14, fill=SURFACE_RAISED,
        )
        draw.text((pad + 16, card_y + 14),
                  "BRIGHTNESS", fill=LABEL_TERTIARY, font=font_label)
        draw.text((pad + 16, card_y + 32),
                  f"{self._brightness}/255",
                  fill=TEXT_COLOR, font=_get_font(24, bold=True))

        # Stepper buttons
        btn_font = _get_font(20, bold=True)
        minus_x = cw - pad - 120
        plus_x = cw - pad - 60
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
        bar_w = cw - 2 * pad - 32
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
        act_h = ch - act_y - 16
        col_w = (cw - 2 * pad - 12) // 2

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

        return self._fit_panel(img, BG_COLOR)

    def render_message(self, title: str, lines: List[str]) -> Image.Image:
        img = _safe_canvas(BG_COLOR)
        cw, ch = img.size
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        content_y = self._draw_header(img, draw,
                                      show_home=True, title=title[:24])

        font_body = _get_font(17)
        y = content_y + 18
        draw.rounded_rectangle(
            [(16, content_y + 6), (cw - 16, ch - 16)],
            radius=14, fill=SURFACE_RAISED,
        )
        for line in lines[:10]:
            draw.text((28, y), line[:52],
                      fill=TEXT_COLOR, font=font_body)
            y += 24
        return self._fit_panel(img, BG_COLOR)

    def render_boot(self, stage=None, detail: str = "",
                    pct: Optional[int] = None, *,
                    progress: Optional[float] = None) -> Image.Image:
        """Boot power sequence — the droplet vessel fills with accent liquid.

        Two call shapes (one renderer, no derived state):
          * ``render_boot(progress=0.0..1.0)`` — the py-v3 animated frame
            driven by an explicit fill fraction (used by the animation/PNG
            path).
          * ``render_boot(stage, detail, pct)`` — the WARP-624 host call
            (readiness/show_boot). ``pct`` (0..100) maps to the same fill
            fraction; a 4-stage status line is derived from ``stage`` only
            when ``progress`` is not given.

        Layout from design_handoff README §4 / preview.html drawBootFrame:
        116px vessel ~y=44, DROPLET wordmark, 4-stage status line, 184px
        progress bar, ``Droplet OS · v2.4`` footer.
        """
        if progress is None:
            progress = (max(0, min(100, int(pct))) / 100.0) if pct is not None else 0.45
        progress = max(0.0, min(1.0, progress))

        img = Image.new("RGB", (WIDTH, HEIGHT), V3_BG)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        size = 116
        mx = (WIDTH - size) // 2
        my = 44
        mb = my + int(size * 48 / 60)
        if progress >= 0.999:
            draw_droplet_mark(draw, mx, my, size, primary=V3_ACCENT,
                              highlight=V3_ACCENT_INK)
        else:
            draw_droplet_mark_liquid(img, draw, mx, my, size, progress)

        font_word = _get_font(14, weight="heavy")
        _v3_text(draw, "DROPLET", WIDTH // 2, mb + 22, font=font_word,
                 fill=V3_TEXT, anchor="ma", tracking=5)

        # 4-stage status line. If a host stage string was supplied and no
        # explicit progress, surface that text; otherwise derive from fill.
        stages = ["Mounting storage", "Starting network",
                  "Loading models", "Ready"]
        if stage and pct is not None:
            status = str(stage)[:40]
            done = pct is not None and pct >= 100
        else:
            si = min(len(stages) - 1, int(progress * len(stages)))
            status = stages[si]
            done = si == len(stages) - 1
        font_status = _get_font(12, weight="regular")
        _v3_text(draw, status, WIDTH // 2, mb + 46, font=font_status,
                 fill=V3_GREEN if done else V3_LABEL3, anchor="ma", tracking=0.4)
        if detail and not done:
            font_detail = _get_font(11, weight="regular")
            _v3_text(draw, str(detail)[:48], WIDTH // 2, mb + 62,
                     font=font_detail, fill=V3_LABEL4, anchor="ma")

        # 184px progress bar.
        bw = 184
        bx = (WIDTH - bw) // 2
        byy = mb + 70
        _rrect(draw, bx, byy, bw, 3, 1.5, fill=V3_TRACK)
        fw = max(3, int(bw * progress))
        _rrect(draw, bx, byy, fw, 3, 1.5,
               fill=V3_GREEN if done else V3_ACCENT)

        font_foot = _get_font(10, weight="regular")
        _v3_text(draw, "Droplet OS · v2.4", WIDTH // 2, HEIGHT - 22,
                 font=font_foot, fill=V3_LABEL4, anchor="ma", tracking=0.5)
        return img

    def render_shutdown(self, reason: str = "", phase: str = "stopping", *,
                        progress: Optional[float] = None) -> Image.Image:
        """Shutdown power sequence — liquid drains, then a CRT collapse.

        Two call shapes (one renderer):
          * ``render_shutdown(progress=0.0..1.0)`` — animated frame. The first
            ~80% drains the vessel + shows the status line; the last ~20% is
            the CRT collapse (content thins to a phosphor line, then a dot).
          * ``render_shutdown(reason, phase)`` — WARP-624 host call. A bare
            ``stopping`` shows the drain frame; ``halted`` shows the
            fully-collapsed phosphor dot ("safe to power off").

        Layout from design_handoff README §4 / preview.html drawShutdownFrame.
        """
        if progress is None:
            progress = 0.95 if phase == "halted" else 0.35
        progress = max(0.0, min(1.0, progress))

        img = Image.new("RGB", (WIDTH, HEIGHT), V3_BG)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        size = 116
        mx = (WIDTH - size) // 2
        my = 44
        mb = my + int(size * 48 / 60)
        # collapse phase begins at 80% of the sequence.
        collapse_start = 0.80
        if progress < collapse_start:
            drain_p = 1.0 - (progress / collapse_start)
            draw_droplet_mark_liquid(img, draw, mx, my, size, drain_p)
            font_word = _get_font(14, weight="heavy")
            _v3_text(draw, "DROPLET", WIDTH // 2, mb + 22, font=font_word,
                     fill=V3_LABEL2, anchor="ma", tracking=5)
            stages = ["Stopping services", "Unmounting storage", "Powering off"]
            prog = progress / collapse_start
            si = min(len(stages) - 1, int(prog * len(stages)))
            font_status = _get_font(12, weight="regular")
            _v3_text(draw, stages[si], WIDTH // 2, mb + 46, font=font_status,
                     fill=V3_LABEL3, anchor="ma", tracking=0.4)
        else:
            cp = (progress - collapse_start) / (1.0 - collapse_start)
            if cp < 0.55:
                h = int((1 - cp / 0.55) * 9 + 2)
                draw.rectangle([0, HEIGHT // 2 - h // 2, WIDTH,
                                HEIGHT // 2 - h // 2 + h], fill=V3_PHOSPHOR)
            elif cp < 0.93:
                w = int((1 - (cp - 0.55) / 0.38) * WIDTH + 3)
                w = max(3, w)
                draw.rectangle([WIDTH // 2 - w // 2, HEIGHT // 2 - 1,
                                WIDTH // 2 - w // 2 + w, HEIGHT // 2 + 1],
                               fill=V3_PHOSPHOR)
            # else: fully black (frame already V3_BG).
        return img

    # ------------------------------------------------------------------
    # py-v3 redesign renderers (idle / System+Wi-Fi / standby + alerts)
    # Mirror services/oled-display/pyportal/code.py 1:1; coordinates &
    # colors come from design_handoff README + preview.html.
    # ------------------------------------------------------------------

    @property
    def clock_mode(self) -> str:
        return self._clock_mode

    def set_clock_mode(self, mode: str) -> None:
        """Set 12/24 mode. Only '12'/'24' accepted (garbage is ignored)."""
        if mode in ("12", "24"):
            self._clock_mode = mode

    def _fmt_clock_parts(self, now: Optional[_dt_datetime] = None) -> dict:
        """Shared 12/24 clock formatter (idle hero + System header reuse it).

        Mirrors preview.html fmtClock(): 12h drops the leading hour zero and
        carries an AM/PM suffix; 24h pads the hour. Returns the pieces so the
        caller can lay out the hero (colon blink, AM/PM placement) itself.
        """
        if now is None:
            now = _dt_datetime.now(_TZ) if _TZ else _dt_datetime.now()
        is12 = self._clock_mode == "12"
        h = now.hour
        suffix = "PM" if h >= 12 else "AM"
        if is12:
            h = ((h + 11) % 12) + 1
            hh = str(h)
        else:
            hh = "{:02d}".format(h)
        mm = "{:02d}".format(now.minute)
        return {"hh": hh, "mm": mm, "suffix": suffix if is12 else "",
                "is12": is12, "second": now.second,
                "str": hh + ":" + mm + ((" " + suffix) if is12 else "")}

    # ----- alerts -------------------------------------------------------

    def push_alert(self, alert: dict) -> None:
        a = dict(alert)
        a.setdefault("type", "sys")
        a.setdefault("cleared", False)
        a.setdefault("detail", "")
        a.setdefault("time", "")
        self._alerts.insert(0, a)
        if len(self._alerts) > 20:
            self._alerts = self._alerts[:20]

    def _open_alerts_count(self) -> int:
        return sum(1 for a in self._alerts if not a.get("cleared"))

    # ----- live-data updates -------------------------------------------

    def update_stats(self, data: dict) -> None:
        # A real stats frame landed — mark live data present for the warm-start
        # readiness short-circuit (WARP-638).
        self._got_live_data = True
        for k in ("cpu", "mem", "disk", "temp", "ip", "hostname", "uptime",
                  "now", "date", "gpu"):
            if k in data and data[k] is not None:
                self._v3[k] = data[k]
        # `temp` and `gpu` are the only keys allowed to go back to None. They
        # are read straight off host sysfs, so "sensor disappeared" is a real
        # state (a card unbinding, /sys going away) — and the None-skip above
        # would otherwise pin the last good reading on the glass forever. A
        # frozen 61° is the same species of lie as a fake 0°.
        for k in ("temp", "gpu"):
            if k in data and data[k] is None:
                self._v3[k] = None
        try:
            self._v3["sparks_cpu"].append(float(self._v3.get("cpu") or 0))
            if len(self._v3["sparks_cpu"]) > self._v3_spark_len:
                self._v3["sparks_cpu"] = \
                    self._v3["sparks_cpu"][-self._v3_spark_len:]
        except (TypeError, ValueError):
            pass

    def update_wifi(self, data: dict) -> None:
        for k, v in data.items():
            self._v3["wifi"][k] = v

    def update_services(self, data: dict) -> None:
        """WARP-1645. Replaces wholesale rather than merging: `degraded` is a
        list, and merging would leave a service showing as down after it
        recovered."""
        if isinstance(data, dict):
            self._v3["services"] = data

    def update_cameras(self, data: dict) -> None:
        self._v3["cameras"] = {"online": data.get("online", 0),
                               "total": data.get("total", 0)}

    def update_net(self, data: dict) -> None:
        if "wan_latency_ms" in data:
            self._v3["wan_latency_ms"] = data["wan_latency_ms"]
        if "lan_clients" in data:
            self._v3["lan_clients"] = data["lan_clients"]

    def seed_cpu_history(self, value: float, n: Optional[int] = None) -> None:
        """Fill the CPU sparkline buffer with jittered samples around `value`
        so a freshly-seeded sim renders a believable sparkline (dev/PNG only)."""
        import random
        n = n or self._v3_spark_len
        self._v3["sparks_cpu"] = [
            max(3.0, min(92.0, value + random.uniform(-6, 6))) for _ in range(n)
        ]

    # ----- the redesigned frames ---------------------------------------

    def render_idle(self, now: Optional[_dt_datetime] = None) -> Image.Image:
        """Editorial hero clock (design_handoff §1 / preview.html drawIdle)."""
        if now is None:
            now = _dt_datetime.now(_TZ) if _TZ else _dt_datetime.now()
        img = _safe_canvas(V3_BG)
        cw, ch = img.size
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        # Brand bug — top-left mark + DROPLET eyebrow.
        draw_droplet_mark(draw, 20, 18, 20, primary=V3_ACCENT,
                          highlight=V3_ACCENT_INK)
        _v3_text(draw, "DROPLET", 50, 24, font=_get_font(9, weight="bold"),
                 fill=V3_LABEL3, tracking=2)

        # 12/24 segmented toggle — top-right (two 38px cells, h26).
        seg_w, seg_h, tg_y = 38, 26, 17
        tg_x = cw - 20 - seg_w * 2
        _rrect(draw, tg_x, tg_y, seg_w * 2, seg_h, 8, fill=V3_SURFACE)
        _rrect(draw, tg_x, tg_y, seg_w * 2, seg_h, 8, outline=V3_SEP, width=1)
        for i, opt in enumerate(("12", "24")):
            cx = tg_x + i * seg_w
            on = self._clock_mode == opt
            if on:
                _rrect(draw, cx, tg_y, seg_w, seg_h, 8, fill=V3_ACCENT_SUBTLE)
            _v3_text(draw, opt, cx + seg_w // 2, tg_y + seg_h // 2,
                     font=_get_font(12, weight="heavy" if on else "regular"),
                     fill=V3_ACCENT_INK if on else V3_LABEL4, anchor="mm")
            self._touch_regions.append(TouchRegion(
                "toggle_" + opt, cx, tg_y - 4, seg_w, seg_h + 8,
                (lambda o=opt: self.set_clock_mode(o))))
        # 1px divider between cells.
        draw.rectangle([tg_x + seg_w, tg_y + 5, tg_x + seg_w,
                        tg_y + seg_h - 5], fill=V3_SEP)

        # Hero clock — 132px, weight 800, -6 tracking, colon blink.
        parts = self._fmt_clock_parts(now)
        colon = ":" if (parts["second"] % 2 == 0) else " "
        time_str = parts["hh"] + colon + parts["mm"]
        clock_y = 150
        hero = _get_font(132, weight="heavy")
        tw = _v3_text_width(draw, time_str, hero, tracking=-6)
        suffix_gap = 14
        suffix_font = _get_font(24, weight="heavy")
        suffix_w = (_v3_text_width(draw, parts["suffix"], suffix_font, 1)
                    + suffix_gap) if parts["is12"] else 0
        cx_center = cw / 2 - suffix_w / 2
        _v3_text(draw, time_str, int(cx_center), clock_y, font=hero,
                 fill=V3_TEXT, anchor="mm", tracking=-6)
        if parts["is12"]:
            right_edge = cx_center + tw / 2
            _v3_text(draw, parts["suffix"], int(right_edge + suffix_gap),
                     clock_y, font=suffix_font, fill=V3_ACCENT, anchor="lm",
                     tracking=1)

        # 56x3 accent rule under the clock at y=220.
        rule_w = 56
        _rrect(draw, cw // 2 - rule_w // 2, clock_y + 70, rule_w, 3, 1.5,
               fill=V3_ACCENT)

        # Bottom-left date.
        date_str = (self._v3.get("date") or
                    now.strftime("%A, %b %d")).upper()
        _v3_text(draw, date_str, 20, ch - 28,
                 font=_get_font(11, weight="bold"), fill=V3_LABEL3, tracking=1.6)

        # Bottom-right green dot + SSID.
        ssid = str(self._v3["wifi"].get("ssid") or "Droplet-AI")
        ssid_font = _get_font(11, weight="bold")
        ssid_w = _v3_text_width(draw, ssid, ssid_font)
        draw.ellipse([cw - 20 - ssid_w - 14 - 3, ch - 23 - 3,
                      cw - 20 - ssid_w - 14 + 3, ch - 23 + 3],
                     fill=V3_GREEN)
        _v3_text(draw, ssid, cw - 20, ch - 28, font=ssid_font,
                 fill=V3_ACCENT, anchor="ra")

        # Seconds progress hairline along the bottom edge.
        sec_frac = parts["second"] / 60.0
        draw.rectangle([0, ch - 2, cw, ch], fill=V3_TRACK)
        draw.rectangle([0, ch - 2, max(2, int(cw * sec_frac)), ch],
                       fill=V3_ACCENT_DIM)

        self._touch_regions.append(TouchRegion(
            "idle_wake", 0, 0, cw, ch, lambda: self._go_system()))
        return self._fit_panel(img, V3_BG)

    def render_debug(self, now: Optional[_dt_datetime] = None) -> Image.Image:
        """WARP-1641 — the rack panel's debug / recovery screen.

        Wide layouts only. On a 480x320 panel there is no room for it and the
        existing settings screen already covers that shape, so we fall back to
        the combined System screen rather than rendering something cramped."""
        import layout_wide
        if not layout_wide.is_wide():
            return self.render_system(now=now)
        return layout_wide.render_debug(self, now=now)

    def render_system(self, now: Optional[_dt_datetime] = None) -> Image.Image:
        """Combined System + Wi-Fi screen (design_handoff §2 / drawStats).

        WARP-1641: on a wide panel (aspect >= 3) this hands off to
        layout_wide. The 480x320 body below is authored against hardcoded
        coordinates — the column divider at x=288, a footer at y=244 and
        another at HEIGHT-24, which are 52px apart at height 320 and COLLIDE
        at 280 — so it is not a matter of it looking cramped; it is wrong.
        Dispatching on geometry rather than a global flag keeps every existing
        renderer and test byte-identical, and keeps a box with two
        differently-shaped panels working."""
        import layout_wide
        if layout_wide.is_wide():
            return layout_wide.render_status(self, now=now)
        if now is None:
            now = _dt_datetime.now(_TZ) if _TZ else _dt_datetime.now()
        img = Image.new("RGB", (WIDTH, HEIGHT), V3_BG)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []
        v = self._v3
        open_count = self._open_alerts_count()

        # ---- header band ----
        _v3_text(draw, "SYSTEM", 20, 12, font=_get_font(9, weight="bold"),
                 fill=V3_LABEL3, tracking=1.6)
        clk = self._fmt_clock_parts(now)["str"]
        clk_font = _get_font(13, weight="bold")
        _v3_text(draw, clk, WIDTH - 20, 9, font=clk_font, fill=V3_LABEL2,
                 anchor="ra")
        time_w = _v3_text_width(draw, clk, clk_font)
        if open_count > 0:
            br = 11
            bx = int(WIDTH - 20 - time_w - 20 - br)
            by = 17
            draw.ellipse([bx - br, by - br, bx + br, by + br], fill=V3_RED)
            _v3_text(draw, "!", bx, by, font=_get_font(15, weight="heavy"),
                     fill=V3_WHITE, anchor="mm")
            if open_count > 1:
                cw, cch = 15, 12
                _rrect(draw, bx + br - 5, by - br - 3, cw, cch, cch // 2,
                       fill=V3_WHITE)
                _v3_text(draw, str(open_count), bx + br - 5 + cw // 2,
                         by - br - 3 + cch // 2,
                         font=_get_font(8, weight="bold"), fill=V3_RED,
                         anchor="mm")
            self._touch_regions.append(TouchRegion(
                "alert_badge", bx - br - 6, by - br - 7, br * 2 + 14,
                br * 2 + 14, self._open_drawer))
        else:
            sxs = int(WIDTH - 20 - time_w - 16)
            draw.ellipse([sxs - 4, 16 - 4, sxs + 4, 16 + 4], fill=V3_GREEN)
            _v3_text(draw, "OK", sxs - 8, 16, font=_get_font(11, weight="bold"),
                     fill=V3_GREEN, anchor="rm")
        draw.rectangle([20, 32, WIDTH - 20, 32], fill=V3_SEP)

        # ---- column divider at x=288 ----
        DIV = 288
        INW = DIV - 20 - 22
        draw.rectangle([DIV, 46, DIV, HEIGHT - 24], fill=V3_SEP)

        # ===== LEFT: system =====
        _v3_text(draw, "CPU LOAD", 20, 46, font=_get_font(9, weight="bold"),
                 fill=V3_LABEL3, tracking=1.6)
        _v3_text(draw, "{}%".format(int(v.get("cpu") or 0)), 20, 58,
                 font=_get_font(52, weight="heavy"), fill=V3_TEXT, tracking=-2)

        # sparkline (48-sample CPU history).
        sp = v.get("sparks_cpu") or []
        sx, sy, sw, sh = 20, 120, INW, 40
        draw.rectangle([sx, sy + sh - 1, sx + sw, sy + sh - 1], fill=V3_SEP)
        if len(sp) >= 2:
            lo, hi = min(sp), max(sp)
            span = max(1.0, hi - lo)
            pts = [(sx + (i / (len(sp) - 1)) * sw,
                    sy + sh - ((val - lo) / span) * sh)
                   for i, val in enumerate(sp)]
            # filled area under the line.
            draw.polygon(pts + [(sx + sw, sy + sh), (sx, sy + sh)],
                         fill=V3_SPARK_FILL)
            draw.line(pts, fill=V3_ACCENT, width=2, joint="curve")

        draw.rectangle([20, 172, 20 + INW, 172], fill=V3_SEP)

        # tabular metrics row (MEM / DISK / TEMP / CAM).
        cams = v.get("cameras") or {}
        cols = [
            ("MEM", "{}%".format(int(v.get("mem") or 0)), V3_TEXT),
            ("DISK", "{}%".format(int(v.get("disk") or 0)), V3_TEXT),
            ("TEMP", "{}°".format(int(v.get("temp") or 0)), V3_TEXT),
            ("CAM", "{}/{}".format(cams.get("online", 0),
                                   cams.get("total", 0)), V3_GREEN),
        ]
        col_w = INW / 4
        for i, (lbl, val, col) in enumerate(cols):
            x = int(20 + i * col_w)
            _v3_text(draw, lbl, x, 182, font=_get_font(9, weight="bold"),
                     fill=V3_LABEL3, tracking=1.2)
            _v3_text(draw, val, x, 196, font=_get_font(22, weight="heavy"),
                     fill=col)

        # detail line.
        _v3_text(draw, "WAN {}ms   ·   UP {}   ·   LAN {}".format(
                     v.get("wan_latency_ms", 0), v.get("uptime", "-"),
                     v.get("lan_clients", 0)),
                 20, 244, font=_get_font(10, weight="regular"), fill=V3_LABEL3)

        # bottom strip.
        _v3_text(draw, "{} · {}".format(v.get("hostname", "-"),
                                              v.get("ip", "-")),
                 20, HEIGHT - 24, font=_get_font(10, weight="regular"),
                 fill=V3_LABEL3)

        # ===== RIGHT: Wi-Fi pairing =====
        RX = 300
        RW = WIDTH - 20 - RX  # 160
        _v3_text(draw, "PAIR · WI-FI", RX, 46,
                 font=_get_font(9, weight="bold"), fill=V3_ACCENT, tracking=1.6)

        # QR card (132x132, white, radius 12) + droplet mark inset center.
        card_w = 132
        card_x = RX + (RW - card_w) // 2
        card_y = 60
        _rrect(draw, card_x, card_y, card_w, card_w, 12, fill=V3_WHITE)
        wifi = v.get("wifi") or {}
        # WARP-819: escape WiFi-QR metachars (same helper as the claim screen)
        # so a special-char SSID/PSK still scans, matching device-bridge.py.
        payload = _wifi_qr_payload(
            wifi.get("ssid") or "Droplet-AI", wifi.get("password") or "")
        self._draw_qr(img, draw, card_x + 9, card_y + 9, card_w - 18,
                      payload=payload)
        mc = 26
        mcx = card_x + 9 + (card_w - 18) // 2 - mc // 2
        mcy = card_y + 9 + (card_w - 18) // 2 - mc // 2
        _rrect(draw, mcx - 3, mcy - 3, mc + 6, mc + 6, 6, fill=V3_WHITE)
        draw_droplet_mark(draw, mcx, mcy, mc, primary=V3_ACCENT,
                          highlight=V3_ACCENT_INK)

        yy = card_y + card_w + 14
        _v3_text(draw, "NETWORK", RX, yy, font=_get_font(9, weight="bold"),
                 fill=V3_LABEL3, tracking=1.2)
        _v3_text(draw, str(wifi.get("ssid") or "Droplet-AI"), RX, yy + 12,
                 font=_get_font(14, weight="bold"), fill=V3_TEXT)
        _v3_text(draw, "PASSWORD", RX, yy + 34, font=_get_font(9, weight="bold"),
                 fill=V3_LABEL3, tracking=1.2)
        _v3_text(draw, str(wifi.get("password") or ""), RX, yy + 46,
                 font=_get_font(13, weight="regular"), fill=V3_ACCENT_INK)

        # KEY rotate pill + TTL chip — ONLY when key rotation is enabled.
        # WARP-638: mirrors the firmware. The box default is rotation OFF (the
        # bridge's qr_snapshot returns rotation_enabled=False), and tapping the
        # pill in that state drove a fresh-QR re-render that OOMed the SAMD51.
        # When rotation is disabled we draw NO pill and register NO tap region,
        # so the host preview matches the panel and there's no rotate affordance.
        if bool(wifi.get("rotation_enabled")):
            secs = int(wifi.get("key_ttl_seconds") or 0)
            warn = secs < 60
            pill_y = yy + 68
            pill_h = 26
            _rrect(draw, RX, pill_y, RW, pill_h, 8,
                   fill=V3_ORANGE_SUBTLE if warn else V3_SURFACE)
            _rrect(draw, RX, pill_y, RW, pill_h, 8,
                   outline=V3_ORANGE if warn else V3_SEP2, width=1)
            # U+21BB (↻) reads as the handoff's ⟳ rotate glyph and, unlike ⟳
            # (U+27F3), is present in Inter — so the sim PNG shows a real arrow,
            # not tofu.
            _v3_text(draw, "↻  KEY {}:{:02d}".format(secs // 60, secs % 60),
                     RX + RW // 2, pill_y + pill_h // 2,
                     font=_get_font(11, weight="bold"),
                     fill=V3_ORANGE if warn else V3_LABEL2, anchor="mm")
            self._touch_regions.append(TouchRegion(
                "key_rotate", RX, pill_y - 3, RW, pill_h + 6,
                self._rotate_key))

        # Alerts drawer overlay.
        if self._events_open:
            self._render_alerts_drawer(draw)
        return img

    def _draw_qr(self, img: Image.Image, draw: ImageDraw.ImageDraw,
                 x: int, y: int, size: int, payload: str = None,
                 matrix: Optional[List[List[int]]] = None) -> None:
        """Render a Wi-Fi join QR into the white card.

        Two sources, in priority order:
          1. an explicit host-supplied `matrix` (0/1 rows) — painted verbatim.
             This is the production-faithful path: the firmware paints the same
             host-encoded matrix on the device, so passing it here keeps the sim
             preview byte-identical to the panel (WARP-819).
          2. otherwise encode `payload` with the `qrcode` package (a service
             dep) — the sim-only fallback when no matrix was supplied.
        Falls back to a deterministic pseudo-matrix purely so the sim/PNG still
        shows a card if neither a matrix nor qrcode is available.
        """
        if not matrix and payload is not None:
            try:
                import qrcode
                qr = qrcode.QRCode(
                    border=0,
                    error_correction=qrcode.constants.ERROR_CORRECT_M)
                qr.add_data(payload)
                qr.make(fit=True)
                matrix = qr.get_matrix()
            except Exception:
                matrix = None
        if not matrix:
            # Deterministic pseudo-matrix (layout only).
            n = 25
            matrix = [[((i * 73856093) ^ (j * 19349663)) >> 8 & 1
                       for j in range(n)] for i in range(n)]
        n = len(matrix)
        cell = size / n
        for i, row in enumerate(matrix):
            for j, val in enumerate(row):
                if val:
                    px = x + j * cell
                    py = y + i * cell
                    draw.rectangle([px, py, px + cell + 0.6, py + cell + 0.6],
                                   fill=(0x0A, 0x0A, 0x1E))

    def _render_alerts_drawer(self, draw: ImageDraw.ImageDraw) -> None:
        """300px right drawer over the System screen (design_handoff §3)."""
        # Dim — emulate rgba(0,0,0,0.55) with a flat dark wash (sim has no
        # alpha-composite here; the device dims via a solid black overlay too).
        dim = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 140))
        # Paint dim onto the frame the caller is drawing into.
        # (draw is bound to the system image; reuse it via blend.)
        # Simpler: draw a near-black flat over everything.
        draw.rectangle([0, 0, WIDTH, HEIGHT], fill=(2, 2, 3))
        _ = dim  # documented intent; flat fill is the device-faithful path
        dw = 300
        dx = WIDTH - dw
        draw.rectangle([dx, 0, WIDTH, HEIGHT], fill=V3_PANEL)
        draw.rectangle([dx, 0, dx, HEIGHT], fill=V3_SEP)

        _v3_text(draw, "ALERTS", dx + 14, 16, font=_get_font(11, weight="bold"),
                 fill=V3_LABEL2, tracking=1.4)
        n = self._open_alerts_count()
        # Close control on the far right; the "n open" count is right-aligned
        # just left of it with clearance so the two never collide. U+00D7 (×)
        # reads as a close glyph and renders in Inter (unlike ✕ / U+2715).
        _v3_text(draw, "×", dx + dw - 16, 14,
                 font=_get_font(20, weight="regular"), fill=V3_LABEL2,
                 anchor="ma")
        _v3_text(draw, "{} open".format(n), dx + dw - 36, 16,
                 font=_get_font(10, weight="regular"), fill=V3_LABEL3,
                 anchor="ra")
        self._touch_regions.append(TouchRegion(
            "drawer_close", dx + dw - 32, 6, 28, 28, self._close_drawer))

        y = 44
        row_h = 58
        visible = self._alerts[:4]
        if not visible:
            _v3_text(draw, "No alerts.", dx + dw // 2, HEIGHT // 2,
                     font=_get_font(14, weight="regular"), fill=V3_LABEL3,
                     anchor="mm")
        else:
            for i, a in enumerate(visible):
                cleared = a.get("cleared")
                _rrect(draw, dx + 10, y, dw - 20, row_h - 6, 8,
                       fill=V3_SURFACE if cleared else V3_SURFACE2)
                _rrect(draw, dx + 10, y, dw - 20, row_h - 6, 8,
                       outline=V3_SEP, width=1)
                icon = (V3_LABEL3 if cleared else
                        (V3_RED if a.get("type") == "cam" else V3_ORANGE))
                draw.ellipse([dx + 24 - 5, y + 24 - 5, dx + 24 + 5, y + 24 + 5],
                             fill=icon)
                _v3_text(draw, str(a.get("title") or "")[:26], dx + 40, y + 10,
                         font=_get_font(12, weight="bold"),
                         fill=V3_LABEL3 if cleared else V3_TEXT)
                _v3_text(draw, str(a.get("detail") or "")[:30], dx + 40, y + 26,
                         font=_get_font(10, weight="regular"), fill=V3_LABEL3)
                _v3_text(draw, str(a.get("time") or "")[:16], dx + 40, y + 40,
                         font=_get_font(9, weight="regular"), fill=V3_LABEL4)
                if not cleared:
                    _v3_text(draw, "×", dx + dw - 22, y + 26,
                             font=_get_font(18, weight="regular"),
                             fill=V3_LABEL3, anchor="mm")
                    self._touch_regions.append(TouchRegion(
                        "drawer_clear_{}".format(i), dx + dw - 36, y + 4, 30,
                        row_h - 12, (lambda ii=i: self._clear_alert(ii))))
                y += row_h

        cbtn_y = HEIGHT - 52
        _rrect(draw, dx + 14, cbtn_y, dw - 28, 40, 12, fill=V3_SURFACE2)
        _rrect(draw, dx + 14, cbtn_y, dw - 28, 40, 12, outline=V3_SEP2, width=1)
        _v3_text(draw, "Clear all", dx + dw // 2, cbtn_y + 20,
                 font=_get_font(13, weight="regular"), fill=V3_LABEL2,
                 anchor="mm")
        self._touch_regions.append(TouchRegion(
            "drawer_clear_all", dx + 14, cbtn_y, dw - 28, 40,
            self._clear_all_alerts))

    def render_standby(self) -> Image.Image:
        """Powered-off standby screen (design_handoff §4 Standby)."""
        img = Image.new("RGB", (WIDTH, HEIGHT), V3_BG)
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []
        size = 78
        mx = (WIDTH - size) // 2
        my = HEIGHT // 2 - int(size * 0.55)
        mb = my + int(size * 48 / 60)
        draw_droplet_mark(draw, mx, my, size, primary=(0x14, 0x14, 0x22),
                          highlight=(0x1A, 0x1A, 0x30))
        _v3_text(draw, "STANDBY", WIDTH // 2, mb + 20,
                 font=_get_font(10, weight="bold"), fill=V3_LABEL4, anchor="ma",
                 tracking=3)
        _v3_text(draw, "tap to power on", WIDTH // 2, mb + 38,
                 font=_get_font(11, weight="regular"), fill=V3_LABEL3,
                 anchor="ma")
        self._touch_regions.append(TouchRegion(
            "standby_wake", 0, 0, WIDTH, HEIGHT, lambda: self._go_system()))
        return img

    def render_claim(self, code: str, setup_url: str,
                     wifi_ssid: Optional[str] = None,
                     wifi_psk: Optional[str] = None,
                     wifi_qr_matrix: Optional[List[List[int]]] = None,
                     setup_qr_matrix: Optional[List[List[int]]] = None
                     ) -> Image.Image:
        """Onboarding claim screen (WARP-632 / ADR-017), design-handoff
        two-column layout ("PyPortal First Boot — Claim Code").

        A header band (brand mark + DROPLET wordmark, FIRST-TIME SETUP status
        on the right), then two columns split by a hairline: the LEFT column
        is the hero — the claim code drawn as its dash-separated groups with
        accent dash bars between them, an accent rule, and the numbered
        link steps — and the RIGHT column is a white scan QR card. The foot
        carries the WAITING TO BE CLAIMED dots over a 2px scan track.
        Tokens, mark and spacing match the boot/idle/System screens. Mirrors
        the firmware's render_claim() 1:1.

        Without a Wi-Fi block the QR deep-links the setup wizard
        (`<setup_url>?c=<CODE>` — host-encoded `setup_qr_matrix` preferred,
        sim-side payload encode as the fallback) so a scan lands with the
        code prefilled. WARP-819: when the box's Wi-Fi-connect creds are
        supplied, the join-QR takes the card instead (joining the box's
        Wi-Fi is the one step a fresh phone can't do by hand) with the
        SSID/PSK as readable text under it (camera-less manual join), and
        the steps gain a "Join Wi-Fi" first step. A partial Wi-Fi block
        degrades to the claim-only layout, unchanged.

        Modal + host-driven: the orchestrator mints the code and pushes it
        while the box is unclaimed; the host navigates away once it's claimed.

        Deliberate descopes from the handoff card (revisit knowingly, not by
        accident): the bottom-left DEVICE id line (no device identity exists
        in the claim-frame contract — adding one is an orchestrator change),
        the claimed-success confirm screen (drawClaimed — needs a new
        orchestrator-pushed mode; today the host simply navigates away), and
        the header-dot pulse + scan-track shimmer (static on both halves;
        the WAITING dots are the claim screen's only motion, firmware heap
        discipline).
        """
        has_wifi = bool(wifi_qr_matrix and wifi_ssid)

        img = _safe_canvas(V3_BG)
        cw, ch = img.size
        draw = ImageDraw.Draw(img)
        with self._touch_regions_lock:
            self._touch_regions = []

        # ---- Header band: mark + wordmark, first-time-setup status --------
        font_eyebrow = _get_font(9, weight="bold")
        draw_droplet_mark(draw, 20, 17, 20,
                          primary=V3_ACCENT, highlight=V3_ACCENT_INK)
        _v3_text(draw, "DROPLET", 50, 21, font=font_eyebrow,
                 fill=V3_LABEL3, tracking=2)
        setup_lbl = "FIRST-TIME SETUP"
        slw = _v3_text_width(draw, setup_lbl, font_eyebrow, 1.4)
        _v3_text(draw, setup_lbl, cw - 20, 21, font=font_eyebrow,
                 fill=V3_ACCENT, anchor="ra", tracking=1.4)
        # Status dot left of the label. Static on BOTH halves — the design's
        # slow alpha pulse is dropped on firmware (heap discipline: the
        # WAITING dots carry the claim screen's only motion).
        dcx = int(cw - 20 - slw - 12)
        draw.ellipse([dcx - 3, 23, dcx + 3, 29], fill=V3_ACCENT)
        draw.rectangle([20, 44, cw - 20, 44], fill=V3_SEP)

        # ---- Column divider ------------------------------------------------
        div_x = 284
        draw.rectangle([div_x, 58, div_x, ch - 26], fill=V3_SEP)

        # ================= LEFT — claim code hero + steps ===================
        _v3_text(draw, "CLAIM CODE", 20, 56, font=font_eyebrow,
                 fill=V3_ACCENT, tracking=1.6)

        # Hero code — the dash-separated groups drawn with accent dash bars
        # between them; auto-fits the heavy face into the column.
        code_text = (code or "").strip().upper()
        groups = [g for g in code_text.split("-") if g]
        code_y = 76
        left_max = div_x - 20 - 16
        if groups:
            size = 30
            font_code = _get_font(size, weight="heavy")
            while size > 14:
                font_code = _get_font(size, weight="heavy")
                gap = max(5, int(size * 0.30))
                dash_w = max(6, int(size * 0.30))
                total = (sum(_v3_text_width(draw, g, font_code, 1)
                             for g in groups)
                         + (len(groups) - 1) * (gap * 2 + dash_w))
                if total <= left_max:
                    break
                size -= 1
            dash_h = max(3, int(size * 0.09))
            cx = 20.0
            for i, group in enumerate(groups):
                cx += _v3_text(draw, group, int(cx), code_y, font=font_code,
                               fill=V3_TEXT, tracking=1)
                if i < len(groups) - 1:
                    cx += gap
                    _rrect(draw, cx, code_y + size * 0.55 - dash_h / 2,
                           dash_w, dash_h, dash_h // 2, fill=V3_ACCENT)
                    cx += dash_w + gap
            code_h = size
        else:
            # Host hasn't pushed a code yet — defensive placeholder, like the
            # firmware's "----  ----".
            _v3_text(draw, "— — — —", 20, code_y,
                     font=_get_font(30, weight="heavy"), fill=V3_LABEL4)
            code_h = 30

        # Accent rule under the code.
        _rrect(draw, 20, code_y + code_h + 16, 56, 3, 1, fill=V3_ACCENT)

        # Numbered link steps. With Wi-Fi creds the join step leads — a fresh
        # phone can't reach the setup URL before it's on the box's network.
        host = (setup_url or "").strip()
        for prefix in ("https://", "http://"):
            if host.startswith(prefix):
                host = host[len(prefix):]
                break
        host = host.rstrip("/")

        _v3_text(draw, "TO LINK THIS DEVICE", 20, 148,
                 font=font_eyebrow, fill=V3_LABEL3, tracking=1.2)
        steps = []
        if has_wifi:
            steps.append(("Join Wi-Fi", str(wifi_ssid or "")[:18]))
        if host:
            # A long named-address hostname overflows the inline slot — wrap
            # the address onto its own line rather than truncating the /setup
            # path away (in the Wi-Fi layout this text is the only typed
            # setup pointer; the setup QR is deliberately off that card).
            steps.append(("Go to", host[:37]))
        steps.append(("Enter the code above", ""))

        font_step = _get_font(12, weight="regular")
        font_step_b = _get_font(12, weight="bold")
        font_badge = _get_font(11, weight="heavy")
        sy = 168
        for i, (lead, em) in enumerate(steps):
            _rrect(draw, 20, sy, 18, 18, 5, fill=V3_ACCENT_SUBTLE)
            _v3_text(draw, str(i + 1), 29, sy + 9, font=font_badge,
                     fill=V3_ACCENT_INK, anchor="mm")
            if em and len(em) > 26:
                _v3_text(draw, lead, 46, sy + 9, font=font_step,
                         fill=V3_LABEL2, anchor="lm")
                _v3_text(draw, em, 46, sy + 23, font=font_step_b,
                         fill=V3_ACCENT_INK, anchor="lm")
                sy += 14
            elif em:
                lead_w = _v3_text(draw, lead + " ", 46, sy + 9, font=font_step,
                                  fill=V3_LABEL2, anchor="lm")
                _v3_text(draw, em, 46 + lead_w, sy + 9, font=font_step_b,
                         fill=V3_ACCENT_INK, anchor="lm")
            else:
                _v3_text(draw, lead, 46, sy + 9, font=font_step,
                         fill=V3_LABEL2, anchor="lm")
            sy += 28

        # ================= RIGHT — scan QR card =============================
        rx = div_x + 16
        rw = cw - 20 - rx
        # Resolve the card's matrix FIRST so the eyebrow/caption stay honest:
        # a card with no scannable matrix must never read "SCAN TO CLAIM".
        # The firmware applies the same rule, so preview and panel agree in
        # the no-matrix skew window too — no pseudo-QR paper-over here.
        if has_wifi:
            qr_payload = _wifi_qr_payload(wifi_ssid or "", wifi_psk or "")
            qr_matrix = wifi_qr_matrix
        else:
            qr_payload = _setup_qr_payload(setup_url, code_text)
            qr_matrix = setup_qr_matrix or _encode_qr_matrix(qr_payload)
        has_qr = bool(qr_matrix)
        if has_wifi:
            eyebrow_r = "SCAN TO JOIN WI-FI"
        else:
            eyebrow_r = "SCAN TO CLAIM" if has_qr else "SETUP"
        _v3_text(draw, eyebrow_r, rx, 56, font=font_eyebrow, fill=V3_ACCENT,
                 tracking=1.2)

        card_w = 128
        card_x = rx + (rw - card_w) // 2
        card_y = 72
        _rrect(draw, card_x, card_y, card_w, card_w, 12, fill=V3_WHITE)
        qx, qy, qz = card_x + 9, card_y + 9, card_w - 18
        if has_qr:
            # Production-faithful: paint the host-encoded matrix (what the
            # firmware paints) so preview and panel match (WARP-819 idiom).
            self._draw_qr(img, draw, qx, qy, qz,
                          payload=qr_payload or None, matrix=qr_matrix)
        # Centre mark pad: sits inside the ECC budget — the setup matrix is
        # encoded at ERROR_CORRECT_Q for exactly this overlay (see
        # _encode_qr_matrix).
        mc = 26
        mcx = card_x + card_w // 2 - mc // 2
        mcy = card_y + card_w // 2 - mc // 2
        _rrect(draw, mcx - 3, mcy - 3, mc + 6, mc + 6, 6, fill=V3_WHITE)
        draw_droplet_mark(draw, mcx, mcy, mc, primary=V3_ACCENT,
                          highlight=V3_ACCENT_INK)

        cap_y = card_y + card_w + 12
        if has_wifi:
            _v3_text(draw, "Joins this Droplet's Wi-Fi", rx + rw // 2, cap_y,
                     font=_get_font(10, weight="regular"), fill=V3_LABEL3,
                     anchor="ma")
            # Readable creds under the card — camera-less manual join
            # (WARP-819): the SSID and the password as text.
            _v3_text(draw, str(wifi_ssid or "")[:20], rx + rw // 2, cap_y + 17,
                     font=_get_font(12, weight="bold"), fill=V3_TEXT,
                     anchor="ma")
            # The PSK is the thing a camera-less user types by hand, so it must
            # be shown in FULL: truncating a longer passphrase silently breaks
            # the join. Mirror the firmware (pyportal/code.py): the card holds
            # rw // 6 chars per line, so wrap the PSK across as many lines as it
            # needs (WARP-819 preview/panel parity).
            psk_text = str(wifi_psk or "")
            psk_cpl = max(1, rw // 6)
            psk_font = _get_font(11, weight="regular")
            psk_y = cap_y + 34
            for i in range(0, len(psk_text), psk_cpl):
                _v3_text(draw, psk_text[i:i + psk_cpl], rx + rw // 2, psk_y,
                         font=psk_font, fill=V3_ACCENT_INK, anchor="ma")
                psk_y += 12
        else:
            _v3_text(draw,
                     "Opens setup on your phone" if has_qr
                     else "Use the address above",
                     rx + rw // 2, cap_y,
                     font=_get_font(10, weight="regular"), fill=V3_LABEL3,
                     anchor="ma")

        # ---- Foot: waiting status + scan track -----------------------------
        waiting = "WAITING TO BE CLAIMED"
        wlw = _v3_text_width(draw, waiting, font_eyebrow, 0.6)
        _v3_text(draw, waiting, cw - 20, ch - 27, font=font_eyebrow,
                 fill=V3_ACCENT, anchor="ra", tracking=0.6)
        for i in range(3):
            ddx = int(cw - 20 - wlw - 22 + i * 7)
            draw.ellipse([ddx - 2, ch - 25, ddx + 2, ch - 21],
                         fill=V3_ACCENT if i == 0 else V3_ACCENT_FAINT)

        # 2px scan track with an accent segment. Static on BOTH halves — the
        # design's travelling shimmer is dropped on firmware (same heap
        # discipline; the WAITING dots are the only claim-screen motion).
        draw.rectangle([0, ch - 2, cw, ch], fill=V3_TRACK)
        seg_x = (cw - 90) // 2
        draw.rectangle([seg_x, ch - 2, seg_x + 90, ch], fill=V3_ACCENT)
        return self._fit_panel(img, V3_BG)

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
    def _read_sysfs(path: str) -> Optional[str]:
        """One tolerant sysfs read. Every sensor probe below funnels through
        here so a missing node, an EPERM, or the blank-string reads some
        thermal drivers emit all degrade the same way: to None, never to a
        number we made up."""
        try:
            with open(path) as f:
                raw = f.read().strip()
        except Exception:
            return None
        return raw or None

    @staticmethod
    def _get_cpu_temp() -> Optional[float]:
        """Hottest plausible CPU temperature in °C, or **None** when the host
        exposes no CPU thermal sensor at all.

        ⚠ Returns None, not 0.0 (WARP-1643). A 0 here reaches the panel as a
        confident `0°`, which is a lie a rack panel must never tell; `—` is
        the honest render and `layout_wide._num()` already draws it.

        Two sources, in order:

        1. `/sys/class/thermal` — the ARM path (Jetson, Pi). psutil's
           `sensors_temperatures()` can't be used here: some inference hosts
           expose zones (soc0-thermal, BCPU-therm, PLL-therm) that return
           blank strings, which psutil fails to parse.
        2. `/sys/class/hwmon` — the **x86 path**, and the reason the rack
           panel showed `0°`. On the AMD Raphael mini-rack box there is no
           CPU `thermal_zone` at all: Zen CPU temperature lives behind the
           `k10temp` driver as hwmon `Tctl`/`Tdie`, so step 1 alone finds
           nothing and the old code fell through to its 0.0 floor.
        """
        best: Optional[float] = None

        def _consider(raw: Optional[str]) -> None:
            nonlocal best
            try:
                t = int(raw) / 1000.0            # type: ignore[arg-type]
            except (TypeError, ValueError):
                return
            # Sanity window: rules out the 0 / -273 / 2^31 placeholders that
            # unpopulated sensors report.
            if 10.0 <= t <= 120.0 and (best is None or t > best):
                best = t

        try:
            for zone in sorted(os.listdir(_SYS_THERMAL)):
                if not zone.startswith("thermal_zone"):
                    continue
                base = f"{_SYS_THERMAL}/{zone}"
                zone_type = (TFTDisplay._read_sysfs(f"{base}/type") or "").lower()
                # Skip obviously-not-CPU zones.
                if any(bad in zone_type for bad in ("gpu", "pll", "aux")):
                    continue
                _consider(TFTDisplay._read_sysfs(f"{base}/temp"))
        except Exception:
            pass

        if best is not None:
            return best

        # hwmon fallback. Only drivers that actually report CPU die/package
        # temperature — an unfiltered sweep would happily return the
        # motherboard, NVMe or GPU sensor and label it CPU.
        try:
            for node in sorted(os.listdir(_SYS_HWMON)):
                base = f"{_SYS_HWMON}/{node}"
                name = (TFTDisplay._read_sysfs(f"{base}/name") or "").lower()
                if name not in _CPU_HWMON_DRIVERS:
                    continue
                for entry in sorted(os.listdir(base)):
                    if not (entry.startswith("temp") and entry.endswith("_input")):
                        continue
                    label = (TFTDisplay._read_sysfs(
                        f"{base}/{entry[:-6]}_label") or "").lower()
                    # k10temp also exposes Tccd1..N (per-CCD) — Tctl/Tdie is
                    # the control temperature the rest of the world quotes.
                    # An unlabelled input (temp1_input on coretemp-less
                    # boards) is still worth taking.
                    if label and label not in _CPU_HWMON_LABELS:
                        continue
                    _consider(TFTDisplay._read_sysfs(f"{base}/{entry}"))
        except Exception:
            pass

        return best

    @staticmethod
    def _get_gpu() -> Optional[int]:
        """Primary-GPU utilisation as a whole percent, or **None** on a host
        with no discoverable GPU — which is every PyPortal box, and is why the
        cell renders `—` there rather than an invented 0.

        The amdgpu/i915 DRM path is the verified one (the mini-rack box drives
        the panel itself from an AMD iGPU, with a discrete Radeon alongside).
        `PANEL_GPU_CARD` pins a specific card; otherwise the lowest-numbered
        card exposing `gpu_busy_percent` wins. Lowest-index is deliberate and
        stable: picking "whichever is busiest" would silently swap which GPU
        the cell describes from one render to the next.

        These are plain sysfs attribute reads, not device opens, so they need
        no `device_cgroup_rules` entry; Docker's default read-only /sys mount
        is enough.
        """
        pinned = os.environ.get("PANEL_GPU_CARD", "").strip()
        try:
            cards = sorted(
                # `card1` yes; `card1-HDMI-A-3` (a connector) no.
                (c for c in os.listdir(_SYS_DRM) if _DRM_CARD_RE.fullmatch(c)),
                # Numeric, so card10 sorts after card2 rather than before it.
                key=lambda c: int(c[4:]),
            )
        except Exception:
            cards = []
        if pinned:
            cards = [pinned] if pinned in cards else []

        for card in cards:
            dev = f"{_SYS_DRM}/{card}/device"
            raw = TFTDisplay._read_sysfs(f"{dev}/gpu_busy_percent")
            if raw is None:
                continue
            try:
                busy = int(raw)
            except ValueError:
                continue
            if 0 <= busy <= 100:
                return busy

        # Jetson: the integrated GPU has no DRM `gpu_busy_percent`; its load
        # lives on a devfreq node in **per-mille** (0–1000). Unverified on
        # hardware — the DRM path above is what the rack panel exercises.
        for path in sorted(q for g in _SYS_GPU_LOAD_GLOBS for q in glob.glob(g)):
            raw = TFTDisplay._read_sysfs(path)
            try:
                permille = int(raw)                 # type: ignore[arg-type]
            except (TypeError, ValueError):
                continue
            if 0 <= permille <= 1000:
                return round(permille / 10.0)

        return None

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

    def show_system(self):
        """Navigate the panel to the combined System + Wi-Fi screen (py-v3).

        Sends a BARE {"mode":"system"} nav (no data) so the firmware leaves
        whatever screen it is on — notably the modal claim screen once the box
        is claimed — and renders the live System screen (stats + built-in Wi-Fi
        pairing QR). Distinct from show_stats(), which streams a stats *data*
        frame the firmware only re-renders when already on System; that path
        does NOT navigate off the claim screen.
        """
        with self._lock:
            self._current_mode = self.SYSTEM
            self._pyportal_send("system")
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

    def show_boot(self, stage: str, detail: str = "",
                  pct: Optional[int] = None):
        """Show the boot screen with a stage caption + optional progress.

        Self-driven by the service (the readiness loop and lifespan call
        this); also exposed via POST /display/boot for finer-grained boot
        progress from the host's startup orchestration.
        """
        with self._lock:
            self._current_mode = self.BOOT
            self._boot_stage = stage
            self._boot_detail = detail
            self._boot_pct = pct
            self._pyportal_send("boot", {
                "stage": stage, "detail": detail, "pct": pct,
            })
            self._render_current_locked()

    def show_shutdown(self, reason: str = "", phase: str = "stopping"):
        """Show the shutdown screen and freeze the panel on it.

        Stops the cycle loop first so no periodic re-render or auto-cycle
        tick overwrites the shutdown frame while the host tears the stack
        down. `phase == 'halted'` switches the copy to "Safe to power off".
        """
        # Stop cycling outside the lock — stop_cycle only flips a flag and
        # the loop checks it each tick; doing it first guarantees nothing
        # races the frame we are about to push.
        self.stop_cycle()
        with self._lock:
            self._current_mode = self.SHUTDOWN
            self._shutdown_reason = reason
            self._shutdown_phase = phase
            self._pyportal_send("shutdown", {
                "reason": reason, "phase": phase,
            })
            self._render_current_locked()

    def show_claim(self, code: str, setup_url: str,
                   wifi_ssid: Optional[str] = None,
                   wifi_psk: Optional[str] = None,
                   wifi_qr_matrix: Optional[List[List[int]]] = None):
        """Show the onboarding claim screen (WARP-632 / ADR-017).

        Host-driven: the orchestrator mints the claim code and POSTs it to
        /display/claim while the box is unclaimed. We set the `claim` mode,
        stream a `claim` frame to the firmware (the render path to the PHYSICAL
        panel — NOT the preview-only /display/custom image path), and render a
        sim preview frame so the dashboard preview works too.

        WARP-819: the optional wifi_* args add the box's Wi-Fi-connect QR matrix
        + SSID + PSK so the claim screen also shows how to join the box's Wi-Fi
        (scan, or type the creds on a camera-less PC). They are stored and
        forwarded to the firmware in the same `claim` frame; absent → the
        original claim-only layout renders (graceful degradation). Only the
        wifi_* keys actually present are put on the wire so the firmware merge
        never clobbers prior creds with nulls.
        """
        with self._lock:
            sig = (code, setup_url, wifi_ssid or "", wifi_psk or "",
                   wifi_qr_matrix or None)
            if sig == self._claim_frame_sig and \
                    self._current_mode == self.CLAIM:
                # Unchanged push from the orchestrator's poll tick — no-op.
                # Re-sending an identical frame makes the firmware tear down
                # and rebuild the same ~100-element tree (blanking the panel)
                # and re-encoding the same QR is pure waste. The
                # READY/REQUEST_STATE resync path re-sends explicitly via
                # _resend_claim_locked, so firmware-reload recovery is not
                # gated on this signature.
                return
            self._current_mode = self.CLAIM
            self._claim_code = code
            self._claim_setup_url = setup_url
            self._claim_wifi_ssid = wifi_ssid or ""
            self._claim_wifi_psk = wifi_psk or ""
            self._claim_wifi_qr_matrix = wifi_qr_matrix or None
            has_wifi = bool(wifi_qr_matrix and wifi_ssid)
            # Scan-to-claim deep link (design handoff): encode the setup QR
            # host-side — the firmware paints the matrix verbatim, same
            # contract as the Wi-Fi QR. Only when the Wi-Fi join QR is NOT
            # taking the card: at most one matrix per claim frame so the
            # firmware never holds two QR bitmaps on its ~165 KB heap
            # (WARP-638 posture).
            self._claim_setup_qr_matrix = (
                None if has_wifi
                else _encode_qr_matrix(_setup_qr_payload(setup_url, code)))
            self._claim_frame_sig = sig
            self._resend_claim_locked()
            self._render_current_locked()

    def _resend_claim_locked(self):
        """Send the retained claim frame to the firmware. Assumes _lock held.

        Used by show_claim (fresh or changed push) and by the
        READY/REQUEST_STATE resync: the claim screen is modal + host-driven,
        so after a firmware reload the panel won't show it again until a
        frame arrives — and show_claim's unchanged-push dedup would swallow
        the orchestrator's next tick. Re-sending here makes firmware-reload
        recovery immediate instead of one poll tick late.
        """
        frame = {"code": self._claim_code,
                 "setup_url": self._claim_setup_url}
        if self._claim_wifi_qr_matrix and self._claim_wifi_ssid:
            frame["wifi_qr_matrix"] = self._claim_wifi_qr_matrix
            frame["wifi_ssid"] = self._claim_wifi_ssid
            # Only put wifi_psk on the wire when it is non-empty. The
            # firmware resets the wifi_* keys before merging each claim
            # frame, so OMITTING psk here clears any stale psk rather than
            # re-sending wifi_psk:"" (WARP-819) — matching show_claim's
            # "only the keys actually present are put on the wire" contract.
            if self._claim_wifi_psk:
                frame["wifi_psk"] = self._claim_wifi_psk
        elif self._claim_setup_qr_matrix:
            frame["setup_qr_matrix"] = self._claim_setup_qr_matrix
        self._pyportal_send("claim", frame)

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
                logger.warning("status display brightness write failed: %s", e)
        # Re-render settings page if that's where we are so the number
        # and bar update instantly.
        with self._lock:
            if self._current_mode == self.SETTINGS:
                self._render_current_locked()

    # ----- Navigation helpers (bound to touch regions) ------------------

    def _go_home(self):
        self._console_confirm_until = 0.0
        self._console_last_result = ""
        self._set_mode(self.HOME, pause_cycle=False)

    # --- WARP-1641: the panel's debug / recovery screen ---------------------

    def _go_debug(self):
        self._console_confirm_until = 0.0
        self._console_last_result = ""
        self._set_mode(self.DEBUG)

    def _console_confirm_active(self) -> bool:
        return time.time() < self._console_confirm_until

    def _tap_return_console(self):
        """Two-tap confirm on "return console to panel".

        This swaps what is physically on the rack's front panel, so a single
        stray touch (or a sleeve) must not do it. First tap arms for
        CONSOLE_CONFIRM_SECONDS; a second tap inside that window commits.
        """
        if not self._console_confirm_active():
            self._console_confirm_until = time.time() + CONSOLE_CONFIRM_SECONDS
            return
        self._console_confirm_until = 0.0
        res = self.return_console()
        if res.get("ok"):
            # The console is taking the panel over as we speak; there is
            # nothing left to render to. Say so anyway — the frame may still
            # land before fbcon repaints.
            self._console_last_result = "Console returned. Panel is now a login prompt."
        else:
            self._console_last_result = "Could not return the console: {}".format(
                str(res.get("error", "unknown"))[:60])

    def return_console(self, timeout: float = 30.0) -> dict:
        """Ask device-bridge to hand the panel back to the kernel console.

        The container cannot do this itself — writing
        /sys/class/vtconsole/*/bind and calling chvt both need root, and this
        process has neither. The bridge polkit-starts the root oneshot
        (WARP-1639). Mirrors rotate_wifi_key()'s auth + error handling; never
        raises, because the caller is a person at a rack trying to get a
        prompt and an exception here would just blank the screen.
        """
        headers = {"Content-Type": "application/json"}
        token = (os.environ.get("BRIDGE_AUTH_TOKEN")
                 or os.environ.get("SERVICE_SECRET")
                 or os.environ.get("DEVICE_SECRET_KEY")
                 or "").strip()
        if token:
            headers["X-Droplet-Auth"] = token
        req = urllib.request.Request(
            WIFI_HELPER_URL + "/panel/console",
            data=b"", method="POST", headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode("utf-8"))
            except Exception:                                    # noqa: BLE001
                return {"ok": False, "error": str(e)}
        except Exception as e:                                   # noqa: BLE001
            logger.warning("console handback failed: %s", e)
            return {"ok": False, "error": str(e)}

    def _go_stats(self):
        self._set_mode(self.STATS)

    def _go_chat(self):
        self._set_mode(self.CHAT)

    def _go_devices(self):
        self._set_mode(self.DEVICES)

    def _go_settings(self):
        self._set_mode(self.SETTINGS)

    # --- py-v3 nav + alert actions (bound to the redesigned touch regions) --
    def _go_idle(self):
        self._set_mode(self.IDLE, pause_cycle=False)

    def _go_system(self):
        self._events_open = False
        self._set_mode(self.SYSTEM)

    def _open_drawer(self):
        self._events_open = True
        with self._lock:
            self._render_current_locked()

    def _close_drawer(self):
        self._events_open = False
        with self._lock:
            self._render_current_locked()

    def _clear_alert(self, idx: int):
        if 0 <= idx < len(self._alerts):
            self._alerts[idx]["cleared"] = True
        with self._lock:
            self._render_current_locked()

    def _clear_all_alerts(self):
        self._alerts = []
        self._events_open = False
        with self._lock:
            self._render_current_locked()

    def _rotate_key(self):
        """KEY-pill tap: roll the Wi-Fi key via the bridge + push a fresh QR.

        Reuses the same bridge round-trip as the firmware's ROTATE_KEY line so
        the host behavior is identical whether the tap originates on the device
        or in the sim. Optimistically resets the local TTL so the pill updates
        immediately; the next /openwrt/qr push corrects it.
        """
        self._v3["wifi"]["key_ttl_seconds"] = 60 * 60
        self.push_alert({"type": "sys", "title": "Wi-Fi key rotated",
                         "detail": "Droplet-AI · scan new QR", "time": "just now"})
        try:
            self.rotate_wifi_key()
        except Exception as e:                                  # noqa: BLE001
            logger.debug("rotate_key bridge call failed: %s", e)
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
        if mode == self.BOOT:
            img = self.render_boot(self._boot_stage, self._boot_detail,
                                   self._boot_pct)
        elif mode == self.SHUTDOWN:
            img = self.render_shutdown(self._shutdown_reason,
                                       self._shutdown_phase)
        elif mode == self.CLAIM:
            img = self.render_claim(
                self._claim_code, self._claim_setup_url,
                wifi_ssid=self._claim_wifi_ssid,
                wifi_psk=self._claim_wifi_psk,
                wifi_qr_matrix=self._claim_wifi_qr_matrix,
                setup_qr_matrix=self._claim_setup_qr_matrix,
            )
        elif mode == self.IDLE:
            img = self.render_idle()
        elif mode == self.SYSTEM:
            img = self.render_system()
        elif mode == self.DEBUG:
            img = self.render_debug()
        elif mode == self.STANDBY:
            img = self.render_standby()
        elif mode == self.LOGO:
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

    # ----- Structured-data helpers (used by status display backend) ----------

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
        gpu = self._get_gpu()
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
            # GPU utilisation %. None on a box with no discoverable GPU, which
            # the wide panel renders as an em dash.
            "gpu": gpu,
            "ip": self._get_ip(),
            "hostname": socket.gethostname(),
            "uptime": uptime,
            # Wall-clock for the status display header. The display has no
            # RTC and time.localtime() there counts from boot, so we push
            # local time on every stats update. Container runs UTC so
            # we compute the zoned time explicitly.
            "now": (datetime.now(_TZ) if _TZ else datetime.now()).strftime("%H:%M"),
        }

    def _push_full_state(self) -> None:
        """Send a complete state snapshot to the firmware: stats + wifi +
        drives + cameras + files. Idempotent; bridge fetch failures are
        logged and skipped (the periodic loop will catch up on the next
        tick). Used by the firmware-driven READY/REQUEST_STATE handler
        and by the host-driven probe-success path — both want the same
        burst, and both want it to no-op cleanly when an upstream is
        briefly unreachable."""
        try:
            self._pyportal_send("stats", self._gather_stats())
        except Exception as e:                              # noqa: BLE001
            logger.warning("resync stats failed: %s", e)
        for mode, fetch in (
            ("wifi", self.fetch_wifi),
            ("drives", self.fetch_drives),
            ("cameras", self.fetch_cameras),
            ("services", self.fetch_services),
            ("files", self.fetch_files),
        ):
            try:
                snap = fetch()
                if snap is not None:
                    self._pyportal_send(mode, snap)
            except Exception as e:                          # noqa: BLE001
                logger.warning("resync %s failed: %s", mode, e)
        # The claim screen is modal + host-driven: if it's what we're
        # showing, the resync must restore it too — the periodic stats/wifi
        # pushes won't, and show_claim's unchanged-push dedup would swallow
        # the orchestrator's next identical tick.
        try:
            with self._lock:
                if self._current_mode == self.CLAIM and self._claim_code:
                    self._resend_claim_locked()
        except Exception as e:                              # noqa: BLE001
            logger.warning("resync claim failed: %s", e)

    # ----- Wi-Fi helper -------------------------------------------------

    def _bridge_get(self, path: str, timeout: float = 6.0) -> Optional[dict]:
        # WARP-659: the bridge now gates its credential-bearing reads
        # (/openwrt/qr, /drives) on the shared secret, so send it on every GET
        # (harmless on the still-open /wifi /files /cameras). Same env
        # precedence as the rotate/connect POSTs above.
        token = (os.environ.get("BRIDGE_AUTH_TOKEN")
                 or os.environ.get("SERVICE_SECRET")
                 or os.environ.get("DEVICE_SECRET_KEY")
                 or "").strip()
        headers = {"X-Droplet-Auth": token} if token else {}
        try:
            req = urllib.request.Request(WIFI_HELPER_URL + path, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
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

    def rotate_wifi_key(self, timeout: float = 30.0) -> Optional[dict]:
        """Ask device-bridge to roll the Droplet-AI WPA key. Used by the
        status display's "Rotate now" button on the QR screen — the board
        sends `ROTATE_KEY` over serial, we POST here, then re-push
        /openwrt/qr so the display shows the new QR immediately.

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

    def fetch_services(self, timeout: float = 6.0) -> Optional[dict]:
        """WARP-1645 — component health for the panel's SERVICES cell.

        The bridge normalises the orchestrator's cached health snapshot; see
        services_snapshot() there for why that source and not the docker
        socket. A None here (bridge unreachable) leaves the previous value in
        place rather than blanking the cell — a single dropped poll should not
        make the panel forget what it knew."""
        return self._bridge_get("/services", timeout)

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
            # WARP-1640: the panel's REAL geometry when we own a framebuffer.
            # WIDTH/HEIGHT are what we render at; if a misconfigured
            # LCD_WIDTH/LCD_HEIGHT disagrees with the hardware, fb.py letterboxes
            # rather than stretching — and this is where you see that.
            "resolution": f"{WIDTH}x{HEIGHT}",
            "panel": (None if self._fb is None else {
                "width": self._fb.width,
                "height": self._fb.height,
                "stride": self._fb.stride,
                "device": self._fb.path,
            }),
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

    # ----- Boot readiness ----------------------------------------------

    def _check_pyportal_liveness(self, now: Optional[float] = None) -> bool:
        """Verify the live PyPortal link is still real; drop a stale fd.

        WARP-638: when the PyPortal is reset its USB CDC re-enumerates. The
        kernel renumbers ttyACM* and the old node disappears, but our open fd
        to it doesn't fail — writes silently succeed-with-no-effect and reads
        return zero bytes, so the reconnect-on-IOError path in `_pyportal_send`
        never fires and the device sits on its boot screen forever against a
        dead host fd. The cheapest reliable signal is `os.path.exists()` on the
        node we opened: if it's gone, drop the fd and fall back to sim so the
        cycle loop's promotion block re-probes whatever ttyACM* is now live
        (which sets `_needs_resync`, so the firmware refills on reconnect).

        Returns True if it dropped the link this call (the caller should re-probe
        immediately), else False. Throttled to LIVENESS_CHECK_INTERVAL so it
        doesn't stat /dev on every ~80ms cycle tick. `now` is injectable for
        deterministic tests.
        """
        if self._backend != "pyportal" or not self._pyportal_path:
            return False
        if now is None:
            now = time.time()
        if now - self._last_liveness_check < LIVENESS_CHECK_INTERVAL:
            return False
        self._last_liveness_check = now
        if os.path.exists(self._pyportal_path):
            return False
        logger.warning(
            "status display %s vanished (USB re-enumeration?) — dropping fd "
            "and re-probing", self._pyportal_path)
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
        return True

    def _check_readiness(self) -> bool:
        """Probe the readiness URL; True only on a 2xx.

        Cheap and fail-safe: any connection error / non-2xx reads as "not
        ready yet" (returns False, never raises) so a still-starting stack
        doesn't crash the cycle loop.

        WARP-638: passes an unverified SSL context so urllib can follow nginx's
        :80 -> :443 redirect onto the self-signed loopback cert instead of
        dying on cert verification (the 90s-every-boot root cause). For a
        plain-HTTP URL the context is simply unused.
        """
        try:
            req = urllib.request.Request(BOOT_READINESS_URL, method="GET")
            with urllib.request.urlopen(
                    req, timeout=2.0, context=_READINESS_SSL_CTX) as r:
                return 200 <= getattr(r, "status", 0) < 300
        except Exception as e:                                       # noqa: BLE001
            logger.debug("readiness probe failed: %s", e)
            return False

    def _readiness_tick(self, now: Optional[float] = None) -> None:
        """Advance the boot->live transition. Called from the cycle loop.

        No-op once boot is complete (we never yank the user back, and never
        re-probe). Otherwise, at most once per BOOT_READINESS_INTERVAL,
        probe readiness; flip to the live UI when the probe passes OR when
        BOOT_MAX_SECONDS have elapsed (timeout fallback so a degraded stack
        still surfaces the UI). `now` is injectable for deterministic tests.
        """
        if self._boot_complete:
            return
        if now is None:
            now = time.time()
        # Timeout fallback first so a hung readiness endpoint can't pin the
        # splash past the budget.
        if now - self._boot_started_at >= BOOT_MAX_SECONDS:
            logger.warning(
                "boot readiness timed out after %ss — surfacing live UI",
                BOOT_MAX_SECONDS)
            self._complete_boot()
            return
        # WARP-638 warm-start short-circuit: if the firmware link is live AND a
        # real stats frame has already been ingested, the stack is plainly up —
        # surface the UI now instead of waiting on the HTTP probe (let alone the
        # 90s timeout). This is the common (re)start case: the orchestrator was
        # never down, it's already pushing stats. Cold boot (sim backend / no
        # data yet) falls through to the probe below, preserving the cold path.
        if self._backend == "pyportal" and self._got_live_data:
            logger.info("warm start — live link + fresh stats; surfacing UI")
            self._complete_boot()
            return
        if now - self._last_readiness_check < BOOT_READINESS_INTERVAL:
            return
        self._last_readiness_check = now
        if self._check_readiness():
            logger.info("boot readiness satisfied — surfacing live UI")
            self._complete_boot()

    def _complete_boot(self) -> None:
        """Mark boot done and drop to the live UI (combined System screen).

        Emit a BARE stats frame ({"mode":"stats"}, no data) so the firmware
        navigates off the boot splash: code.py's handle() only calls
        set_screen() on a bare-mode message, while a data-laden push merely
        updates state. The firmware aliases bare "stats" -> the combined
        "system" screen (py-v3), so the WIRE frame stays "stats" — the
        navigation contract is unchanged — while the host's own preview
        renders the new SYSTEM screen. Without the bare frame the real
        PyPortal would stay frozen on the boot sequence forever. (WARP-624/B1)
        """
        self._boot_complete = True
        # Bare nav frame on the wire (firmware aliases stats -> system).
        self._pyportal_send(self.STATS)
        # Host-side preview lands on the combined System+Wi-Fi screen.
        self._set_mode(self.SYSTEM, pause_cycle=False)

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
          3. Pushes stats + wifi scan snapshots to the status display so
             its screens stay current.
          4. Optionally auto-advances if AUTO_CYCLE=1 and we're idle.
        """
        last_press = 0
        last_release = 0
        last_full_render = 0.0
        last_stats_push = 0.0
        last_wifi_push = 0.0
        last_files_push = 0.0
        last_cams_push = 0.0
        last_services_push = 0.0
        last_backend_retry = 0.0
        serial_buf = b""
        while self._cycle_running:
            # Liveness check (WARP-638): detect a stale status display serial fd
            # left behind by a USB re-enumeration (firmware reset / replug / hub
            # reset). If the node we opened has vanished from /dev, the helper
            # drops the fd and falls back to sim; we then force the promotion
            # block below to re-probe immediately (which sets _needs_resync, so
            # the firmware refills on reconnect) instead of waiting out a fresh
            # 5s window. Throttled internally to LIVENESS_CHECK_INTERVAL.
            if self._check_pyportal_liveness():
                last_backend_retry = 0.0

            # If we started on sim because USB enumeration hadn't finished
            # yet, keep probing every 5s and promote to pyportal once it
            # appears. Covers the cold-boot race where the inference host
            # starts the container before /dev/ttyACM* is ready.
            if self._backend != "pyportal":
                if time.time() - last_backend_retry > 5.0:
                    last_backend_retry = time.time()
                    if BACKEND in ("auto", "pyportal") and self._try_pyportal():
                        logger.info("Promoted backend: sim -> pyportal")

            # Probe-driven full-state resync. `_probe_pyportal` sets
            # `_needs_resync` on every successful probe (initial cold
            # boot, cycle-loop promotion, `_pyportal_send` reconnect).
            # Without this burst the firmware's stats / time / wifi /
            # drives / cameras stay on their initial empty values until
            # each individual periodic-push timer fires below — up to
            # 30s for files, which reads as "the screen never auto-fills".
            if self._wants_data() and self._needs_resync:
                self._needs_resync = False
                logger.info("post-probe resync — pushing full state")
                self._push_full_state()
                now_anchor = time.time()
                last_stats_push = now_anchor
                last_wifi_push = now_anchor
                last_files_push = now_anchor
                last_cams_push = now_anchor
                last_services_push = now_anchor
                self._last_drives_push = now_anchor
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

            # Boot -> live transition (WARP-624). Hosted on this managed
            # cycle thread (no separate scheduler). Internally gated to
            # ~every BOOT_READINESS_INTERVAL and a no-op once boot is done.
            self._readiness_tick(now)

            # Return home after a message timeout
            if (self._current_mode == self.MESSAGE and
                    self._message_clear_at and
                    now >= self._message_clear_at):
                self._message_clear_at = 0
                self._go_home()

            # Live re-render of time-sensitive screens (incl. the py-v3 idle
            # clock + combined System screen so the preview stays current).
            # DEBUG is in the list because its confirm button is time-boxed:
            # without a re-render the "TAP AGAIN TO CONFIRM" state would stay
            # on screen after it had already expired, and the next tap would
            # arm rather than commit — which reads as the button not working.
            live = (self._current_mode in (self.HOME, self.STATS, self.SETTINGS,
                                           self.IDLE, self.SYSTEM, self.DEBUG))
            if live and (now - last_full_render) > 1.0:
                with self._lock:
                    self._render_current_locked()
                last_full_render = now

            # Keep the status display's local data snapshot fresh. The
            # display renders locally; we push data every few seconds so
            # every screen has live numbers when the user navigates to it.
            # A longer cadence (8s) keeps perceived flicker low — the
            # firmware re-renders the active screen on each push.
            if self._wants_data() and (now - last_stats_push) > 8.0:
                self._pyportal_send("stats", self._gather_stats())
                last_stats_push = now
            if self._wants_data() and (now - last_wifi_push) > WIFI_REFRESH_SECONDS:
                snap = self.fetch_wifi()
                if snap is not None:
                    self._pyportal_send("wifi", snap)
                last_wifi_push = now
            if self._wants_data() and (now - last_files_push) > FILES_REFRESH_SECONDS:
                fs = self.fetch_files()
                if fs is not None:
                    self._pyportal_send("files", fs)
                last_files_push = now
            if self._wants_data() and (now - last_cams_push) > CAMERAS_REFRESH_SECONDS:
                cams = self.fetch_cameras()
                if cams is not None:
                    self._pyportal_send("cameras", cams)
                last_cams_push = now
            # WARP-1645 — service health. The orchestrator refreshes its own
            # snapshot every 15s, so polling faster than that only costs
            # requests; slower and a container dying takes too long to show.
            if self._wants_data() and (now - last_services_push) > SERVICES_REFRESH_SECONDS:
                svc = self.fetch_services()
                if svc is not None:
                    self._pyportal_send("services", svc)
                last_services_push = now
            # Drives poll — separate, shorter cadence so hot-plug is snappy.
            if self._wants_data():
                if not hasattr(self, "_last_drives_push"):
                    self._last_drives_push = 0.0
                if (now - self._last_drives_push) > 8.0:
                    drv = self.fetch_drives()
                    if drv is not None:
                        self._pyportal_send("drives", drv)
                    self._last_drives_push = now

            # Handle async requests from the status display firmware. The
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
                        # Full-snapshot resync: fired when the firmware boots
                        # (READY) or explicitly asks for state (REQUEST_STATE,
                        # which our firmware sends right after READY). Without
                        # this, a code.py auto-reload would leave the status
                        # display rendering empty screens until each periodic
                        # push cycle ticks over (up to 30s worst-case). The
                        # post-probe resync block above also calls
                        # `_push_full_state` for the host-side path (fresh
                        # probe / re-probe after USB re-enumeration); both
                        # paths converge on the same helper.
                        logger.info("pyportal: %s — resyncing full state", txt)
                        self._push_full_state()
                        # Reset periodic-push anchors so we don't double-send
                        # in the next loop iteration.
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
                        # The status display asked us to roll the Wi-Fi key.
                        # Ask the bridge to do the UCI change on OpenWrt,
                        # then push the fresh QR so the user can scan it.
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
                        # When the user lands on the QR screen, push a
                        # fresh matrix. Firmware also sends REQUEST_QR on
                        # nav, but this is a belt-and-braces catch-all so
                        # older firmware that doesn't auto-request still
                        # works after an upgrade.
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

            # Optional carousel for demo mode
            if AUTO_CYCLE and now >= self._cycle_paused_until:
                # Alternate logo <-> stats every LOGO_DURATION seconds
                t = int(now // LOGO_DURATION) % 2
                desired = self.LOGO if t == 0 else self.STATS
                if self._current_mode != desired:
                    self._set_mode(desired, pause_cycle=False)

            time.sleep(0.08)

