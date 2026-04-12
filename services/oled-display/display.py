"""
Droplet OLED Display Driver
============================
Drives a Waveshare 1.5" SSD1351 128x128 RGB OLED via SPI using luma.oled.
Falls back to simulated file output when no hardware is detected.
"""

import os
import time
import socket
import logging
import threading
from pathlib import Path
from typing import Optional, List

import psutil
from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger("droplet.oled")

# Display dimensions
WIDTH = 128
HEIGHT = 128

# Pin configuration (Jetson GPIO numbering)
DC_PIN = int(os.environ.get("DC_PIN", "18"))
RST_PIN = int(os.environ.get("RST_PIN", "22"))
SPI_DEVICE = os.environ.get("SPI_DEVICE", "/dev/spidev0.0")

# Colors (RGB)
BG_COLOR = (0, 0, 0)
TEXT_COLOR = (255, 255, 255)
ACCENT_COLOR = (99, 102, 241)       # indigo-500 (#6366f1)
ACCENT_LIGHT = (129, 140, 248)      # indigo-400 (#818cf8)
DIM_COLOR = (140, 140, 160)
BAR_BG = (40, 40, 50)
TEMP_WARN = (255, 180, 0)
TEMP_CRIT = (255, 60, 60)

# Assets
ASSETS_DIR = Path(__file__).parent / "assets"
LOGO_PATH = ASSETS_DIR / "logo_128.png"
SIM_OUTPUT = Path(os.environ.get("SIM_OUTPUT", "/tmp/oled_preview.png"))

# Cycle timing
LOGO_DURATION = 5       # seconds to show logo
STATS_DURATION = 10     # seconds to show stats
MESSAGE_HOLD = 30       # seconds to hold LLM message before resuming cycle


def _get_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    """Load a built-in font at the given size."""
    try:
        # Try DejaVu (common on Linux/Docker)
        variant = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
        for search in ["/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/"]:
            path = Path(search) / variant
            if path.exists():
                return ImageFont.truetype(str(path), size)
    except Exception:
        pass
    return ImageFont.load_default()


class OLEDDisplay:
    """SSD1351 128x128 OLED display controller with auto-cycle support."""

    def __init__(self):
        self._device = None
        self._simulated = False
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

    def _init_device(self):
        """Try to initialize real SPI hardware, fall back to simulated."""
        try:
            from luma.core.interface.serial import spi
            from luma.oled.device import ssd1351

            serial = spi(device=0, port=0, gpio_DC=DC_PIN, gpio_RST=RST_PIN)
            self._device = ssd1351(serial, width=WIDTH, height=HEIGHT)
            self._device.contrast(self._brightness)
            logger.info("SSD1351 OLED initialized on SPI")
        except Exception as e:
            logger.warning("No SPI hardware detected (%s), using simulated display", e)
            self._simulated = True

    def _load_logo(self):
        """Load the 128x128 logo asset."""
        if LOGO_PATH.exists():
            self._logo_image = Image.open(LOGO_PATH).convert("RGB").resize((WIDTH, HEIGHT))
        else:
            # Generate a placeholder logo from the SVG design
            self._logo_image = self._render_logo_fallback()

    def _render_logo_fallback(self) -> Image.Image:
        """Render the Droplet logo programmatically when PNG asset is missing."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)

        # Draw the faceted drop mark (scaled to 128x128)
        cx, cy_top = 64, 20
        scale = 1.8
        points_left = [
            (cx, cy_top),
            (cx + int(18 * scale), cy_top + int(28 * scale)),
            (cx + int(10 * scale), cy_top + int(48 * scale)),
            (cx - int(10 * scale), cy_top + int(48 * scale)),
            (cx - int(18 * scale), cy_top + int(28 * scale)),
        ]
        draw.polygon(points_left, fill=ACCENT_COLOR)

        # Right highlight face
        points_right = [
            (cx, cy_top),
            (cx + int(18 * scale), cy_top + int(28 * scale)),
            (cx, cy_top + int(36 * scale)),
        ]
        draw.polygon(points_right, fill=ACCENT_LIGHT)

        # Wordmark
        font = _get_font(14, bold=True)
        text = "Droplet"
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        draw.text(((WIDTH - tw) // 2, 112), text, fill=TEXT_COLOR, font=font)

        return img

    def _push(self, image: Image.Image):
        """Send image to the physical display or write to file."""
        self._current_image = image
        if self._simulated:
            SIM_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
            image.save(str(SIM_OUTPUT))
            logger.debug("Simulated frame saved to %s", SIM_OUTPUT)
        else:
            self._device.display(image)

    # ----- Screen Renderers -----

    def render_logo(self) -> Image.Image:
        """Full-screen Droplet logo."""
        return self._logo_image.copy()

    def render_stats(self) -> Image.Image:
        """Device stats screen with mini logo header."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)

        font_sm = _get_font(9)
        font_md = _get_font(10, bold=True)
        font_title = _get_font(9, bold=True)

        # Mini logo at top (32x32)
        if self._logo_image:
            mini = self._logo_image.resize((28, 28))
            img.paste(mini, (50, 2))

        # Title
        draw.text((4, 4), "Droplet Edge", fill=ACCENT_LIGHT, font=font_title)

        y = 34
        draw.line([(4, y), (124, y)], fill=(60, 60, 80), width=1)
        y += 4

        # CPU
        cpu_pct = psutil.cpu_percent(interval=0.1)
        draw.text((4, y), "CPU", fill=DIM_COLOR, font=font_sm)
        draw.text((36, y), f"{cpu_pct:.0f}%", fill=TEXT_COLOR, font=font_md)
        bar_x = 68
        bar_w = 56
        draw.rectangle([(bar_x, y + 2), (bar_x + bar_w, y + 8)], fill=BAR_BG)
        fill_w = int(bar_w * min(cpu_pct, 100) / 100)
        if fill_w > 0:
            color = ACCENT_COLOR if cpu_pct < 80 else TEMP_WARN if cpu_pct < 95 else TEMP_CRIT
            draw.rectangle([(bar_x, y + 2), (bar_x + fill_w, y + 8)], fill=color)
        y += 16

        # RAM
        mem = psutil.virtual_memory()
        used_gb = mem.used / (1024 ** 3)
        total_gb = mem.total / (1024 ** 3)
        draw.text((4, y), "RAM", fill=DIM_COLOR, font=font_sm)
        draw.text((36, y), f"{used_gb:.1f}/{total_gb:.0f}G", fill=TEXT_COLOR, font=font_md)
        bar_x = 90
        bar_w = 34
        draw.rectangle([(bar_x, y + 2), (bar_x + bar_w, y + 8)], fill=BAR_BG)
        fill_w = int(bar_w * mem.percent / 100)
        if fill_w > 0:
            color = ACCENT_COLOR if mem.percent < 80 else TEMP_WARN
            draw.rectangle([(bar_x, y + 2), (bar_x + fill_w, y + 8)], fill=color)
        y += 16

        # Temperature
        temp = self._get_cpu_temp()
        temp_color = TEXT_COLOR if temp < 70 else TEMP_WARN if temp < 85 else TEMP_CRIT
        draw.text((4, y), "Temp", fill=DIM_COLOR, font=font_sm)
        draw.text((36, y), f"{temp:.0f}C", fill=temp_color, font=font_md)
        y += 16

        # IP
        ip = self._get_ip()
        draw.text((4, y), "IP", fill=DIM_COLOR, font=font_sm)
        draw.text((36, y), ip, fill=TEXT_COLOR, font=font_sm)
        y += 16

        # Uptime
        up = time.time() - psutil.boot_time()
        days = int(up // 86400)
        hours = int((up % 86400) // 3600)
        up_str = f"{days}d {hours}h" if days else f"{hours}h {int((up % 3600) // 60)}m"
        draw.text((4, y), "Up", fill=DIM_COLOR, font=font_sm)
        draw.text((36, y), up_str, fill=TEXT_COLOR, font=font_sm)

        return img

    def render_message(self, title: str, lines: List[str]) -> Image.Image:
        """Custom message screen for LLM tool output."""
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)

        font_title = _get_font(11, bold=True)
        font_body = _get_font(10)

        # Title bar
        draw.rectangle([(0, 0), (WIDTH, 18)], fill=ACCENT_COLOR)
        draw.text((4, 3), title[:20], fill=(255, 255, 255), font=font_title)

        # Body lines
        y = 24
        for line in lines[:7]:
            draw.text((4, y), line[:22], fill=TEXT_COLOR, font=font_body)
            y += 15

        return img

    # ----- Helpers -----

    @staticmethod
    def _get_cpu_temp() -> float:
        """Read CPU temperature, platform-aware."""
        try:
            temps = psutil.sensors_temperatures()
            for name in ["thermal_zone0", "cpu_thermal", "coretemp", "cpu-thermal"]:
                if name in temps and temps[name]:
                    return temps[name][0].current
        except Exception:
            pass
        # Jetson fallback
        try:
            with open("/sys/devices/virtual/thermal/thermal_zone0/temp") as f:
                return int(f.read().strip()) / 1000.0
        except Exception:
            return 0.0

    @staticmethod
    def _get_ip() -> str:
        """Get primary IP address."""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except Exception:
            return "unknown"

    # ----- Display Control -----

    def show_logo(self):
        with self._lock:
            self._current_mode = "logo"
            self._push(self.render_logo())

    def show_stats(self):
        with self._lock:
            self._current_mode = "stats"
            self._push(self.render_stats())

    def show_message(self, title: str, lines: List[str]):
        with self._lock:
            self._current_mode = "message"
            self._custom_title = title
            self._custom_lines = lines
            self._cycle_paused_until = time.time() + MESSAGE_HOLD
            self._push(self.render_message(title, lines))

    def show_custom_image(self, image: Image.Image):
        with self._lock:
            self._current_mode = "custom"
            self._cycle_paused_until = time.time() + MESSAGE_HOLD
            resized = image.convert("RGB").resize((WIDTH, HEIGHT))
            self._push(resized)

    def set_brightness(self, value: int):
        self._brightness = max(0, min(255, value))
        if self._device and not self._simulated:
            self._device.contrast(self._brightness)

    def get_status(self) -> dict:
        return {
            "mode": self._current_mode,
            "simulated": self._simulated,
            "brightness": self._brightness,
            "cycling": self._cycle_running and time.time() >= self._cycle_paused_until,
        }

    # ----- Auto-Cycle -----

    def start_cycle(self):
        """Start the auto-cycle background thread."""
        if self._cycle_running:
            return
        self._cycle_running = True
        self._cycle_thread = threading.Thread(target=self._cycle_loop, daemon=True)
        self._cycle_thread.start()
        logger.info("Display auto-cycle started")

    def stop_cycle(self):
        self._cycle_running = False

    def resume_cycle(self):
        """Resume cycling immediately (cancel any message hold)."""
        self._cycle_paused_until = 0.0

    def _cycle_loop(self):
        """Background loop: logo (5s) -> stats (10s) -> repeat."""
        while self._cycle_running:
            if time.time() < self._cycle_paused_until:
                time.sleep(1)
                continue

            # Logo phase
            self.show_logo()
            for _ in range(LOGO_DURATION * 2):
                if not self._cycle_running or time.time() < self._cycle_paused_until:
                    break
                time.sleep(0.5)

            if not self._cycle_running or time.time() < self._cycle_paused_until:
                continue

            # Stats phase (refresh every 2s for live data)
            for _ in range(STATS_DURATION // 2):
                if not self._cycle_running or time.time() < self._cycle_paused_until:
                    break
                self.show_stats()
                time.sleep(2)
