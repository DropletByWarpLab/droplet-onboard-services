"""
Droplet TFT Display Driver
===========================
Drives a 3.5" Inland/Waveshare-compatible TFT LCD (ILI9481, 480x320) with
XPT2046 resistive touch over SPI on the Jetson 40-pin header.

Supports three backends, chosen automatically:
  1. framebuffer  - writes RGB565 into /dev/fb1 (fbtft kernel module path)
  2. luma.lcd     - direct SPI via luma.lcd ILI9486 driver (9481-compatible)
  3. simulated    - writes a PNG to SIM_OUTPUT (dev/CI fallback)

The class is exposed as both TFTDisplay (preferred) and OLEDDisplay (legacy
alias) so existing orchestrator clients keep working.
"""

import os
import time
import json
import socket
import logging
import struct
import threading
from pathlib import Path
from typing import Optional, List, Any

import psutil
from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger("droplet.tft")

# ---------------------------------------------------------------------------
# Display geometry
# ---------------------------------------------------------------------------
WIDTH = int(os.environ.get("LCD_WIDTH", "480"))
HEIGHT = int(os.environ.get("LCD_HEIGHT", "320"))

# ---------------------------------------------------------------------------
# Hardware config (Jetson 40-pin header, Pi-shield compatible pinout)
# ---------------------------------------------------------------------------
DC_PIN = int(os.environ.get("DC_PIN", "18"))       # Data/Command
RST_PIN = int(os.environ.get("RST_PIN", "22"))     # Reset
SPI_DEVICE = os.environ.get("SPI_DEVICE", "/dev/spidev0.0")
FB_DEVICE = os.environ.get("FB_DEVICE", "/dev/fb1")
LCD_DRIVER = os.environ.get("LCD_DRIVER", "ili9486").lower()  # ili9486 speaks 9481
# Supported DISPLAY_BACKEND values: auto | framebuffer | spi | pyportal | sim
BACKEND = os.environ.get("DISPLAY_BACKEND", "auto").lower()
SPI_HZ = int(os.environ.get("SPI_HZ", "32000000"))            # 32 MHz per panel spec

# Backlight (optional PWM on GPIO18/pin 12 on the shield)
BACKLIGHT_PIN = int(os.environ.get("BACKLIGHT_PIN", "12"))

# PyPortal backend (USB-serial-connected Adafruit PyPortal Titano).
# When this backend is active, the service stops pushing pixels and sends
# newline-delimited JSON commands over /dev/ttyACM1; the PyPortal renders
# screens locally with its own MCU. See services/oled-display/pyportal/.
PYPORTAL_TTY = os.environ.get("PYPORTAL_TTY", "/dev/ttyACM1")
PYPORTAL_BAUD = int(os.environ.get("PYPORTAL_BAUD", "115200"))

# ---------------------------------------------------------------------------
# Colours - Droplet design system (RGB)
# ---------------------------------------------------------------------------
BG_COLOR = (12, 12, 18)
CARD_COLOR = (24, 24, 32)
TEXT_COLOR = (255, 255, 255)
ACCENT_COLOR = (99, 102, 241)     # indigo-500
ACCENT_LIGHT = (129, 140, 248)    # indigo-400
DIM_COLOR = (150, 150, 170)
BAR_BG = (40, 40, 55)
TEMP_WARN = (255, 180, 0)
TEMP_CRIT = (255, 60, 60)
GOOD_COLOR = (52, 199, 89)

# ---------------------------------------------------------------------------
# Assets + cycle timing
# ---------------------------------------------------------------------------
ASSETS_DIR = Path(__file__).parent / "assets"
LOGO_PATH_PRIMARY = ASSETS_DIR / "logo_480.png"
LOGO_PATH_FALLBACK = ASSETS_DIR / "logo_128.png"
SIM_OUTPUT = Path(os.environ.get("SIM_OUTPUT", "/tmp/tft_preview.png"))

LOGO_DURATION = 5
STATS_DURATION = 10
MESSAGE_HOLD = 30


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


def _rgb888_to_rgb565_bytes(image: Image.Image) -> bytes:
    """Convert a PIL RGB image to a packed RGB565 little-endian byte buffer."""
    # PIL has a built-in BGR;16 mode but coverage is spotty - do it manually.
    arr = image.tobytes("raw", "RGB")
    out = bytearray(len(arr) // 3 * 2)
    for i in range(0, len(arr), 3):
        r, g, b = arr[i], arr[i + 1], arr[i + 2]
        v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
        out[(i // 3) * 2] = v & 0xFF
        out[(i // 3) * 2 + 1] = (v >> 8) & 0xFF
    return bytes(out)


class TFTDisplay:
    """ILI9481 480x320 TFT controller with auto-cycling status screens."""

    def __init__(self):
        self._device = None                     # luma.lcd device (SPI backend)
        self._fb_path: Optional[str] = None     # framebuffer path (fb backend)
        self._pyportal = None                   # serial.Serial (PyPortal backend)
        self._pyportal_lock = threading.Lock()  # serial writes are not reentrant
        self._backend = "sim"                   # resolved backend
        self._current_mode = "logo"
        self._current_image: Optional[Image.Image] = None
        self._custom_title: Optional[str] = None
        self._custom_lines: Optional[List[str]] = None
        self._cycle_thread: Optional[threading.Thread] = None
        self._cycle_running = False
        self._cycle_paused_until = 0.0
        self._lock = threading.Lock()
        self._brightness = 255
        self._logo_image: Optional[Image.Image] = None

        self._init_device()
        self._load_logo()

    # ----- Backend init -------------------------------------------------

    def _init_device(self):
        """Resolve the best available backend for this host.

        `auto` prefers pyportal > framebuffer > spi > sim. pyportal is first
        because it's a USB-attached self-contained device — if it's plugged in
        it is the intended display, and we shouldn't confuse the state by also
        driving an SPI panel we may have left wired up from an earlier build.
        """
        order = (
            ["pyportal", "framebuffer", "spi", "sim"] if BACKEND == "auto"
            else [BACKEND]
        )
        for name in order:
            if name == "pyportal" and self._try_pyportal():
                return
            if name == "framebuffer" and self._try_framebuffer():
                return
            if name == "spi" and self._try_spi():
                return
            if name == "sim":
                self._backend = "sim"
                logger.warning("Using simulated display (no hardware detected)")
                return

    def _try_pyportal(self) -> bool:
        """Serial-connected Adafruit PyPortal Titano.

        Opens /dev/ttyACM1 (or whatever $PYPORTAL_TTY points at), sends a
        ping, and accepts the backend if the port opens cleanly. We don't
        hard-fail on a missing ping response — the firmware may need a moment
        after USB enumeration to start its main loop.
        """
        try:
            import serial  # pyserial, added to requirements.txt
        except ImportError:
            logger.debug("pyportal backend unavailable: pyserial not installed")
            return False
        if not Path(PYPORTAL_TTY).exists():
            logger.debug("pyportal backend unavailable: %s not present", PYPORTAL_TTY)
            return False
        try:
            s = serial.Serial(PYPORTAL_TTY, PYPORTAL_BAUD, timeout=1)
            s.reset_input_buffer()
            s.write(b'{"mode":"ping"}\n')
            s.flush()
            # Drain a couple of lines — expect OK or READY within 500 ms
            deadline = time.time() + 0.5
            while time.time() < deadline:
                line = s.readline()
                if not line:
                    break
                if b"OK" in line or b"READY" in line:
                    break
            self._pyportal = s
            self._backend = "pyportal"
            logger.info("TFT initialised via PyPortal on %s @ %d baud",
                        PYPORTAL_TTY, PYPORTAL_BAUD)
            return True
        except Exception as e:                                     # noqa: BLE001
            logger.warning("PyPortal backend unavailable: %s", e, exc_info=False)
            return False

    def _pyportal_send(self, mode: str, data: Optional[dict] = None):
        """Send one JSON command to the PyPortal. Silent on no-backend."""
        if self._pyportal is None:
            return
        payload: dict[str, Any] = {"mode": mode}
        if data is not None:
            payload["data"] = data
        try:
            with self._pyportal_lock:
                self._pyportal.write(
                    json.dumps(payload).encode("utf-8") + b"\n"
                )
                self._pyportal.flush()
        except Exception as e:                                     # noqa: BLE001
            logger.warning("PyPortal write failed (mode=%s): %s", mode, e)

    def _try_framebuffer(self) -> bool:
        """fbtft kernel driver exposes the panel as /dev/fb1."""
        try:
            if not Path(FB_DEVICE).exists():
                return False
            # Sanity check: fb must be writable
            with open(FB_DEVICE, "r+b"):
                pass
            self._fb_path = FB_DEVICE
            self._backend = "framebuffer"
            logger.info("TFT initialised via framebuffer %s (%dx%d)", FB_DEVICE, WIDTH, HEIGHT)
            return True
        except Exception as e:
            logger.debug("Framebuffer backend unavailable: %s", e)
            return False

    def _try_spi(self) -> bool:
        """Direct SPI via luma.lcd - ILI9486 driver is register-compatible with ILI9481."""
        try:
            from luma.core.interface.serial import spi
            from luma.lcd.device import ili9486

            # Pass our pre-configured GPIO module (Jetson.GPIO or RPi.GPIO,
            # aliased as RPi.GPIO by gpio_shim and already set to BOARD mode)
            # so luma.core doesn't try to GPIO.setmode(BCM) itself — which
            # fails on Jetson once BOARD mode is set.
            import RPi.GPIO as _GPIO

            serial = spi(
                device=0, port=0,
                gpio=_GPIO,
                gpio_DC=DC_PIN, gpio_RST=RST_PIN,
                bus_speed_hz=SPI_HZ,
            )
            # luma.lcd's ili9486 constructor validates `width x height`
            # against the *panel-native* portrait dimensions 320x480 and
            # rejects anything else. Rotation (0=portrait, 1=landscape CW,
            # 2=portrait flipped, 3=landscape CCW) is applied on top.
            # We always pass the native 320x480 to luma; the rest of the
            # service continues to use logical landscape WIDTH x HEIGHT
            # (480x320) for drawing, which luma rotates on its way out.
            # Also pass gpio=_GPIO so ili9486 (which inherits backlit_device)
            # doesn't try its own GPIO.setmode(BCM) and blow up on Jetson.
            native_w, native_h = 320, 480
            rotate = int(os.environ.get("LCD_ROTATE", "1"))  # 1 = landscape
            self._device = ili9486(
                serial,
                width=native_w, height=native_h,
                rotate=rotate,
                gpio=_GPIO,
            )
            self._backend = "spi"
            logger.info("TFT initialised via luma.lcd %s over SPI (%dx%d @ %dHz)",
                        LCD_DRIVER, WIDTH, HEIGHT, SPI_HZ)
            return True
        except Exception as e:
            # Log at WARNING so deploy-time diagnostics are visible without
            # having to bump the root log level. The service still falls back
            # to the simulated backend, so this is non-fatal.
            logger.warning("SPI backend unavailable (falling back to sim): %s", e, exc_info=True)
            # Make sure we don't leak GPIO line claims from a partial init.
            try:
                import RPi.GPIO as _GPIO
                _GPIO.cleanup()
            except Exception:
                pass
            return False

    # ----- Assets -------------------------------------------------------

    def _load_logo(self):
        """Load a logo asset sized for this display."""
        for candidate in (LOGO_PATH_PRIMARY, LOGO_PATH_FALLBACK):
            if candidate.exists():
                self._logo_image = (
                    Image.open(candidate).convert("RGB").resize((WIDTH, HEIGHT))
                )
                return
        self._logo_image = self._render_logo_fallback()

    def _render_logo_fallback(self) -> Image.Image:
        """Vector-style fallback logo scaled to full 480x320 canvas."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)

        # Faceted water-drop mark, centred
        cx = WIDTH // 2
        cy_top = HEIGHT // 2 - 90
        s = 2.6  # scale factor for 480x320
        left = [
            (cx, cy_top),
            (cx + int(18 * s), cy_top + int(28 * s)),
            (cx + int(10 * s), cy_top + int(48 * s)),
            (cx - int(10 * s), cy_top + int(48 * s)),
            (cx - int(18 * s), cy_top + int(28 * s)),
        ]
        draw.polygon(left, fill=ACCENT_COLOR)
        right = [
            (cx, cy_top),
            (cx + int(18 * s), cy_top + int(28 * s)),
            (cx, cy_top + int(36 * s)),
        ]
        draw.polygon(right, fill=ACCENT_LIGHT)

        font = _get_font(48, bold=True)
        text = "Droplet"
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        draw.text(((WIDTH - tw) // 2, HEIGHT - 70), text, fill=TEXT_COLOR, font=font)

        sub = _get_font(16)
        draw.text((cx - 70, HEIGHT - 22), "edge ai appliance", fill=DIM_COLOR, font=sub)

        return img

    # ----- Push to display ---------------------------------------------

    def _push(self, image: Image.Image):
        self._current_image = image
        # PyPortal renders its own content locally — the structured-data
        # send happened in the show_*() method. We still save a preview PNG
        # so /display/preview works for dashboards.
        if self._backend == "pyportal":
            SIM_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
            try:
                image.save(str(SIM_OUTPUT))
            except Exception as e:                                 # noqa: BLE001
                logger.debug("preview save failed: %s", e)
            return
        if self._backend == "framebuffer":
            self._push_framebuffer(image)
        elif self._backend == "spi" and self._device is not None:
            # DIAGNOSTIC: log a fingerprint of each frame pushed to SPI so
            # wiring problems can be distinguished from no-data-sent
            # problems. When this log ticks but the panel stays white, the
            # bytes are leaving the Jetson and the issue is on the cable
            # side (CS, DC, RST, MOSI, SCLK, or 3V3 logic not connected).
            import hashlib
            b = image.tobytes()
            digest = hashlib.md5(b).hexdigest()[:8]
            logger.info(
                "SPI frame -> panel: mode=%s bytes=%d md5=%s",
                self._current_mode, len(b), digest,
            )
            self._device.display(image)
        else:
            SIM_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
            image.save(str(SIM_OUTPUT))
            logger.debug("Simulated frame saved to %s", SIM_OUTPUT)

    def _push_framebuffer(self, image: Image.Image):
        """Pack to RGB565 and write into /dev/fb1."""
        try:
            rgb = image if image.size == (WIDTH, HEIGHT) else image.resize((WIDTH, HEIGHT))
            buf = _rgb888_to_rgb565_bytes(rgb)
            with open(self._fb_path, "wb") as fb:
                fb.write(buf)
        except Exception as e:
            logger.error("Framebuffer write failed: %s", e)

    # ----- Screen renderers --------------------------------------------

    def render_logo(self) -> Image.Image:
        return self._logo_image.copy()

    def render_stats(self) -> Image.Image:
        """480x320 status dashboard - CPU, RAM, disk, temp, IP, uptime, clock."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)

        font_xl = _get_font(28, bold=True)
        font_lg = _get_font(20, bold=True)
        font_md = _get_font(16)
        font_sm = _get_font(13)
        font_label = _get_font(12, bold=True)

        # --- Header bar ---
        draw.rectangle([(0, 0), (WIDTH, 46)], fill=ACCENT_COLOR)
        if self._logo_image:
            mini = self._logo_image.resize((38, 38))
            img.paste(mini, (6, 4))
        draw.text((52, 4), "Droplet Edge", fill=(255, 255, 255), font=font_lg)
        clock = time.strftime("%H:%M")
        bbox = draw.textbbox((0, 0), clock, font=font_xl)
        draw.text((WIDTH - (bbox[2] - bbox[0]) - 10, 6), clock,
                  fill=(255, 255, 255), font=font_xl)

        # --- Metric cards (2x2 grid) ---
        card_w = (WIDTH - 30) // 2
        card_h = 100
        y0 = 58
        gap = 10

        cpu_pct = psutil.cpu_percent(interval=0.1)
        mem = psutil.virtual_memory()
        try:
            disk = psutil.disk_usage("/")
        except Exception:
            disk = None
        temp = self._get_cpu_temp()

        self._draw_metric_card(
            draw, 10, y0, card_w, card_h,
            "CPU", f"{cpu_pct:.0f}%", cpu_pct,
            font_label, font_xl, font_sm,
            danger_thresh=(80, 95),
        )
        self._draw_metric_card(
            draw, 20 + card_w, y0, card_w, card_h,
            "RAM", f"{mem.used / (1024**3):.1f}/{mem.total / (1024**3):.0f} GB",
            mem.percent,
            font_label, font_xl, font_sm,
            danger_thresh=(80, 95),
        )
        self._draw_metric_card(
            draw, 10, y0 + card_h + gap, card_w, card_h,
            "DISK",
            f"{(disk.used / (1024**3)):.0f}/{(disk.total / (1024**3)):.0f} GB" if disk else "n/a",
            disk.percent if disk else 0,
            font_label, font_xl, font_sm,
            danger_thresh=(85, 95),
        )
        self._draw_temp_card(
            draw, 20 + card_w, y0 + card_h + gap, card_w, card_h,
            temp, font_label, font_xl, font_sm,
        )

        # --- Footer: IP + uptime ---
        foot_y = HEIGHT - 28
        draw.line([(10, foot_y - 6), (WIDTH - 10, foot_y - 6)],
                  fill=(60, 60, 80), width=1)
        draw.text((10, foot_y), "IP", fill=DIM_COLOR, font=font_label)
        draw.text((36, foot_y - 2), self._get_ip(), fill=TEXT_COLOR, font=font_md)

        up = time.time() - psutil.boot_time()
        days = int(up // 86400)
        hours = int((up % 86400) // 3600)
        mins = int((up % 3600) // 60)
        up_str = f"{days}d {hours}h" if days else f"{hours}h {mins}m"
        bbox = draw.textbbox((0, 0), up_str, font=font_md)
        draw.text((WIDTH - (bbox[2] - bbox[0]) - 10, foot_y - 2),
                  up_str, fill=TEXT_COLOR, font=font_md)
        draw.text((WIDTH - (bbox[2] - bbox[0]) - 40, foot_y),
                  "UP", fill=DIM_COLOR, font=font_label)

        return img

    @staticmethod
    def _draw_metric_card(draw, x, y, w, h, label, value, pct,
                          font_label, font_value, font_sm, danger_thresh=(80, 95)):
        draw.rounded_rectangle([(x, y), (x + w, y + h)], radius=10, fill=CARD_COLOR)
        draw.text((x + 10, y + 8), label, fill=DIM_COLOR, font=font_label)
        draw.text((x + 10, y + 26), value, fill=TEXT_COLOR, font=font_value)
        # Progress bar
        bar_x = x + 10
        bar_y = y + h - 18
        bar_w = w - 20
        draw.rounded_rectangle([(bar_x, bar_y), (bar_x + bar_w, bar_y + 8)],
                               radius=4, fill=BAR_BG)
        fill_w = int(bar_w * min(max(pct, 0), 100) / 100)
        if fill_w > 0:
            warn, crit = danger_thresh
            color = (ACCENT_COLOR if pct < warn
                     else TEMP_WARN if pct < crit
                     else TEMP_CRIT)
            draw.rounded_rectangle([(bar_x, bar_y), (bar_x + fill_w, bar_y + 8)],
                                   radius=4, fill=color)

    @staticmethod
    def _draw_temp_card(draw, x, y, w, h, temp,
                        font_label, font_value, font_sm):
        draw.rounded_rectangle([(x, y), (x + w, y + h)], radius=10, fill=CARD_COLOR)
        draw.text((x + 10, y + 8), "TEMP", fill=DIM_COLOR, font=font_label)
        color = (TEXT_COLOR if temp < 70
                 else TEMP_WARN if temp < 85
                 else TEMP_CRIT)
        draw.text((x + 10, y + 26), f"{temp:.0f}\u00b0C", fill=color, font=font_value)
        status_text = ("nominal" if temp < 70
                       else "warm" if temp < 85
                       else "hot")
        status_color = (GOOD_COLOR if temp < 70
                        else TEMP_WARN if temp < 85
                        else TEMP_CRIT)
        draw.text((x + 10, y + h - 22), status_text, fill=status_color, font=font_sm)

    def render_message(self, title: str, lines: List[str]) -> Image.Image:
        """Full-screen message view for LLM tool output."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)

        font_title = _get_font(22, bold=True)
        font_body = _get_font(18)

        # Title bar
        draw.rectangle([(0, 0), (WIDTH, 50)], fill=ACCENT_COLOR)
        draw.text((14, 12), title[:40], fill=(255, 255, 255), font=font_title)

        y = 68
        for line in lines[:10]:
            draw.text((16, y), line[:52], fill=TEXT_COLOR, font=font_body)
            y += 24

        return img

    # ----- Sensor helpers ----------------------------------------------

    @staticmethod
    def _get_cpu_temp() -> float:
        try:
            temps = psutil.sensors_temperatures()
            for name in ["thermal_zone0", "cpu_thermal", "coretemp", "cpu-thermal"]:
                if name in temps and temps[name]:
                    return temps[name][0].current
        except Exception:
            pass
        try:
            with open("/sys/devices/virtual/thermal/thermal_zone0/temp") as f:
                return int(f.read().strip()) / 1000.0
        except Exception:
            return 0.0

    @staticmethod
    def _get_ip() -> str:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except Exception:
            return "unknown"

    # ----- Display control ---------------------------------------------

    def show_logo(self):
        with self._lock:
            self._current_mode = "logo"
            self._pyportal_send("logo")
            self._push(self.render_logo())

    def show_stats(self):
        with self._lock:
            self._current_mode = "stats"
            # Send compact JSON to the PyPortal (it renders locally) and also
            # produce the full pixel image for sim / SPI / preview consumers.
            self._pyportal_send("stats", self._gather_stats())
            self._push(self.render_stats())

    def show_message(self, title: str, lines: List[str]):
        with self._lock:
            self._current_mode = "message"
            self._custom_title = title
            self._custom_lines = lines
            self._cycle_paused_until = time.time() + MESSAGE_HOLD
            self._pyportal_send("message", {"title": title, "lines": list(lines)})
            self._push(self.render_message(title, lines))

    def show_custom_image(self, image: Image.Image):
        with self._lock:
            self._current_mode = "custom"
            self._cycle_paused_until = time.time() + MESSAGE_HOLD
            resized = image.convert("RGB").resize((WIDTH, HEIGHT))
            # PyPortal can't decode arbitrary PIL images over serial without
            # writing a base64/binary transfer path — for v1, fall back to
            # the "custom" logo placeholder on the PyPortal side. Pixel sinks
            # (SPI, framebuffer, sim) still get the full image.
            self._pyportal_send("message", {
                "title": "Custom",
                "lines": ["image from orchestrator"],
            })
            self._push(resized)

    def set_brightness(self, value: int):
        self._brightness = max(0, min(255, value))
        if self._backend == "pyportal":
            self._pyportal_send("brightness", None)
            # PyPortal expects the value on the top-level key, not inside data
            try:
                with self._pyportal_lock:
                    if self._pyportal is not None:
                        self._pyportal.write(
                            json.dumps({"mode": "brightness",
                                        "value": self._brightness}).encode()
                            + b"\n"
                        )
                        self._pyportal.flush()
            except Exception as e:                                 # noqa: BLE001
                logger.warning("PyPortal brightness write failed: %s", e)
        if self._backend == "spi" and self._device is not None:
            try:
                self._device.contrast(self._brightness)
            except Exception as e:
                logger.debug("contrast() not supported on this driver: %s", e)

    # ----- Structured-data helpers (used by PyPortal backend) ----------

    def _gather_stats(self) -> dict:
        """Collect the same numbers render_stats() uses, in a compact form
        suitable for transmission to the PyPortal as JSON."""
        try:
            cpu_pct = psutil.cpu_percent(interval=0.1)
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
            "uptime": uptime,
        }

    def get_status(self) -> dict:
        return {
            "mode": self._current_mode,
            "backend": self._backend,
            "simulated": self._backend == "sim",
            "resolution": f"{WIDTH}x{HEIGHT}",
            "driver": LCD_DRIVER,
            "brightness": self._brightness,
            "cycling": self._cycle_running and time.time() >= self._cycle_paused_until,
        }

    # Backwards-compat property for legacy callers checking _simulated
    @property
    def _simulated(self) -> bool:
        return self._backend == "sim"

    # ----- Auto-cycle ---------------------------------------------------

    def start_cycle(self):
        if self._cycle_running:
            return
        self._cycle_running = True
        self._cycle_thread = threading.Thread(target=self._cycle_loop, daemon=True)
        self._cycle_thread.start()
        logger.info("Display auto-cycle started")

    def stop_cycle(self):
        self._cycle_running = False

    def resume_cycle(self):
        self._cycle_paused_until = 0.0

    def _cycle_loop(self):
        while self._cycle_running:
            if time.time() < self._cycle_paused_until:
                time.sleep(1)
                continue
            self.show_logo()
            for _ in range(LOGO_DURATION * 2):
                if not self._cycle_running or time.time() < self._cycle_paused_until:
                    break
                time.sleep(0.5)
            if not self._cycle_running or time.time() < self._cycle_paused_until:
                continue
            for _ in range(STATS_DURATION // 2):
                if not self._cycle_running or time.time() < self._cycle_paused_until:
                    break
                self.show_stats()
                time.sleep(2)


# Legacy alias so existing callers keep working without changes.
OLEDDisplay = TFTDisplay
