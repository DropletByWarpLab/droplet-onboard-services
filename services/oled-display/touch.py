"""
XPT2046 Resistive Touch Reader
===============================
Reads touch events from the XPT2046 controller found on the Inland/Waveshare
3.5" Pi-form-factor TFT shields.

Two input paths are supported:
  1. Linux evdev (/dev/input/event*) - preferred when the `ads7846` /
     `xpt2046` kernel driver is loaded (ships with the fbtft overlay).
  2. Direct SPI via `spidev` - used when no kernel driver is present.
  3. Simulated - no-op, reports (-1, -1).

This module runs a background poller and exposes the most recent touch
coordinates (mapped to display pixel space) plus a touched/released event
counter. The display service surfaces this over HTTP.
"""

import os
import time
import glob
import logging
import threading
from typing import Optional, Tuple

logger = logging.getLogger("droplet.touch")

TOUCH_CS = int(os.environ.get("TOUCH_CS", "1"))       # SPI CE1 on the shield
TOUCH_IRQ_PIN = int(os.environ.get("TOUCH_IRQ_PIN", "11"))
TOUCH_EVENT_DEVICE = os.environ.get("TOUCH_EVENT_DEVICE", "")  # e.g. /dev/input/event0
TOUCH_BACKEND = os.environ.get("TOUCH_BACKEND", "auto").lower()  # auto|evdev|spi|sim

# Calibration: raw XPT2046 12-bit values -> screen pixels.
# These are sensible defaults for 480x320 landscape; tune with `ts_calibrate`.
CAL_X_MIN = int(os.environ.get("TOUCH_CAL_X_MIN", "200"))
CAL_X_MAX = int(os.environ.get("TOUCH_CAL_X_MAX", "3900"))
CAL_Y_MIN = int(os.environ.get("TOUCH_CAL_Y_MIN", "200"))
CAL_Y_MAX = int(os.environ.get("TOUCH_CAL_Y_MAX", "3900"))
TOUCH_SWAP_XY = os.environ.get("TOUCH_SWAP_XY", "1") == "1"
TOUCH_INVERT_X = os.environ.get("TOUCH_INVERT_X", "0") == "1"
TOUCH_INVERT_Y = os.environ.get("TOUCH_INVERT_Y", "1") == "1"


class TouchReader:
    def __init__(self, width: int = 480, height: int = 320):
        self.width = width
        self.height = height
        self._backend = "sim"
        self._last: Optional[Tuple[int, int]] = None
        self._pressed = False
        self._press_count = 0
        self._release_count = 0
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._evdev = None
        self._spi = None

        self._init_backend()

    # ----- Backend init ------------------------------------------------

    def _init_backend(self):
        order = (
            ["evdev", "spi", "sim"] if TOUCH_BACKEND == "auto"
            else [TOUCH_BACKEND]
        )
        for name in order:
            if name == "evdev" and self._try_evdev():
                return
            if name == "spi" and self._try_spi():
                return
            if name == "sim":
                self._backend = "sim"
                logger.info("Touch running in simulated mode")
                return

    def _try_evdev(self) -> bool:
        try:
            import evdev  # type: ignore

            path = TOUCH_EVENT_DEVICE
            if not path:
                # Heuristic: pick the first device whose name contains ads7846/xpt2046
                for candidate in glob.glob("/dev/input/event*"):
                    try:
                        dev = evdev.InputDevice(candidate)
                        name = dev.name.lower()
                        if "ads7846" in name or "xpt2046" in name or "touch" in name:
                            path = candidate
                            dev.close()
                            break
                        dev.close()
                    except Exception:
                        continue
            if not path:
                return False
            self._evdev = evdev.InputDevice(path)
            self._backend = "evdev"
            logger.info("Touch initialised via evdev %s (%s)", path, self._evdev.name)
            return True
        except Exception as e:
            logger.debug("evdev backend unavailable: %s", e)
            return False

    def _try_spi(self) -> bool:
        try:
            import spidev  # type: ignore

            self._spi = spidev.SpiDev()
            self._spi.open(0, TOUCH_CS)
            self._spi.max_speed_hz = 1_000_000  # XPT2046 max safe rate
            self._spi.mode = 0
            self._backend = "spi"
            logger.info("Touch initialised via direct SPI (CE%d)", TOUCH_CS)
            return True
        except Exception as e:
            logger.debug("spidev backend unavailable: %s", e)
            return False

    # ----- Raw -> pixel mapping ---------------------------------------

    def _map(self, raw_x: int, raw_y: int) -> Tuple[int, int]:
        rx, ry = raw_x, raw_y
        if TOUCH_SWAP_XY:
            rx, ry = ry, rx
        x_norm = (rx - CAL_X_MIN) / max(CAL_X_MAX - CAL_X_MIN, 1)
        y_norm = (ry - CAL_Y_MIN) / max(CAL_Y_MAX - CAL_Y_MIN, 1)
        if TOUCH_INVERT_X:
            x_norm = 1.0 - x_norm
        if TOUCH_INVERT_Y:
            y_norm = 1.0 - y_norm
        x = max(0, min(self.width - 1, int(x_norm * self.width)))
        y = max(0, min(self.height - 1, int(y_norm * self.height)))
        return x, y

    # ----- Pollers -----------------------------------------------------

    def _poll_spi_once(self) -> Optional[Tuple[int, int, int]]:
        """Read one sample from XPT2046. Returns (x, y, z) or None."""
        try:
            # Commands: 0xD0 = read X, 0x90 = read Y, 0xB0 = read Z1
            def read(cmd: int) -> int:
                r = self._spi.xfer2([cmd, 0x00, 0x00])
                return ((r[1] << 8) | r[2]) >> 3  # 12-bit result
            z = read(0xB0)
            if z < 100:  # not touched
                return None
            x = read(0xD0)
            y = read(0x90)
            return x, y, z
        except Exception as e:
            logger.debug("SPI read failed: %s", e)
            return None

    def _loop(self):
        if self._backend == "evdev":
            self._loop_evdev()
        elif self._backend == "spi":
            self._loop_spi()

    def _loop_evdev(self):
        try:
            import evdev  # type: ignore
            from evdev import ecodes
            ax, ay, pressed = 0, 0, False
            for ev in self._evdev.read_loop():
                if not self._running:
                    break
                if ev.type == ecodes.EV_ABS:
                    if ev.code == ecodes.ABS_X:
                        ax = ev.value
                    elif ev.code == ecodes.ABS_Y:
                        ay = ev.value
                elif ev.type == ecodes.EV_KEY and ev.code == ecodes.BTN_TOUCH:
                    pressed = bool(ev.value)
                    with self._lock:
                        if pressed:
                            self._pressed = True
                            self._press_count += 1
                        else:
                            self._pressed = False
                            self._release_count += 1
                elif ev.type == ecodes.SYN_REPORT and pressed:
                    with self._lock:
                        self._last = self._map(ax, ay)
        except Exception as e:
            logger.error("evdev loop ended: %s", e)

    def _loop_spi(self):
        while self._running:
            sample = self._poll_spi_once()
            if sample is None:
                if self._pressed:
                    with self._lock:
                        self._pressed = False
                        self._release_count += 1
                time.sleep(0.02)
                continue
            x, y, _ = sample
            with self._lock:
                if not self._pressed:
                    self._press_count += 1
                self._pressed = True
                self._last = self._map(x, y)
            time.sleep(0.02)

    # ----- Public API --------------------------------------------------

    def start(self):
        if self._running or self._backend == "sim":
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False

    def get_state(self) -> dict:
        with self._lock:
            return {
                "backend": self._backend,
                "pressed": self._pressed,
                "x": self._last[0] if self._last else None,
                "y": self._last[1] if self._last else None,
                "press_count": self._press_count,
                "release_count": self._release_count,
            }
