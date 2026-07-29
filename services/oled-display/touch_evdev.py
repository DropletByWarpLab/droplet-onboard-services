"""
evdev touch reader for the rack panel's USB touchscreen.

The PyPortal sent `TOUCH:x,y,pressure` back up the serial link, so `touch.py`
was reduced to a no-op shim. This panel's touch is a separate USB HID device
(`wch.cn TouchScreen`, VID:PID 27c0:0859) exposing an absolute-position node,
so we read `/dev/input/eventN` directly.

Deliberately dependency-free: `python-evdev` would add a C build step to a
slim image for ~60 lines of struct parsing. `input_event` is a stable ABI.

Contract is byte-identical to `touch.TouchReader` — start/stop/get_state — so
`main.py`'s lifespan hook and `display.py`'s cycle loop are unchanged. The
`TouchRegion` / `handle_touch` dispatch is already source-agnostic.

Container needs `device_cgroup_rules: ["c 13:* rmw"]` (input devices, major 13).
Without it `open()` fails EPERM — a cgroup denial, not file permissions.
"""

from __future__ import annotations

import logging
import os
import select
import struct
import threading
from pathlib import Path
from typing import Iterator, Optional, Tuple

# Linux-only; see the same guard in fb.py. Discovery returns None without it,
# so the reader reports backend "none" and the panel is display-only.
try:
    import fcntl
except ImportError:                                             # pragma: no cover
    fcntl = None                                                # type: ignore

logger = logging.getLogger("droplet.tft.touch")

# The installed panel. Note the VID belongs to Cadwell Laboratories while the
# manufacturer string says wch.cn — a borrowed/cloned VID. Flagged against the
# NDAA-889 posture; see the design brief §8.
DEFAULT_VID, DEFAULT_PID = 0x27C0, 0x0859

# <linux/input.h>
EV_SYN, EV_KEY, EV_ABS = 0x00, 0x01, 0x03
SYN_REPORT = 0x00
BTN_TOUCH = 0x14A
ABS_X, ABS_Y = 0x00, 0x01
ABS_MT_POSITION_X, ABS_MT_POSITION_Y = 0x35, 0x36

# struct input_event { struct timeval time; __u16 type, code; __s32 value; }
_EVENT_FMT = "llHHi"
_EVENT_SIZE = struct.calcsize(_EVENT_FMT)

# struct input_id { __u16 bustype, vendor, product, version; }
EVIOCGID = 0x80084502


def _eviocgabs(axis: int) -> int:
    """_IOR('E', 0x40 + axis, sizeof(struct input_absinfo) == 24)"""
    return 0x80000000 | (24 << 16) | (0x45 << 8) | (0x40 + axis)


class TouchReader:
    """Absolute-position touch reader with the same shape as touch.TouchReader."""

    def __init__(self, width: int = 1424, height: int = 280,
                 device: Optional[str] = None):
        self.width = width
        self.height = height
        self._backend = "none"
        self._path = device or os.environ.get("TOUCH_DEVICE") or None
        self._swap = os.environ.get("TOUCH_SWAP_XY", "0") == "1"
        self._inv_x = os.environ.get("TOUCH_INVERT_X", "0") == "1"
        self._inv_y = os.environ.get("TOUCH_INVERT_Y", "0") == "1"

        self._fd: Optional[int] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.Lock()

        self._range = {"x": (0, 4095), "y": (0, 4095)}
        self._raw = {"x": None, "y": None}
        self._pressed = False
        self._x: Optional[int] = None
        self._y: Optional[int] = None
        self._press_count = 0
        self._release_count = 0

    # ----- discovery ----------------------------------------------------

    @staticmethod
    def _device_id(path: str) -> Optional[Tuple[int, int, int, int]]:
        if fcntl is None:
            return None
        try:
            buf = bytearray(8)
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            try:
                fcntl.ioctl(fd, EVIOCGID, buf, True)
            finally:
                os.close(fd)
            return struct.unpack("<4H", buf)          # bus, vendor, product, ver
        except Exception:
            return None

    @staticmethod
    def _absinfo(fd: int, axis: int) -> Optional[Tuple[int, int]]:
        """(minimum, maximum) for `axis`, or None if the axis is absent."""
        if fcntl is None:
            return None
        try:
            buf = bytearray(24)
            fcntl.ioctl(fd, _eviocgabs(axis), buf, True)
            _value, lo, hi, _fuzz, _flat, _res = struct.unpack("<6i", buf)
            return (lo, hi) if hi > lo else None
        except Exception:
            return None

    @classmethod
    def discover(cls, vid: int = DEFAULT_VID,
                 pid: int = DEFAULT_PID) -> Optional[str]:
        """Find the touchscreen node.

        Never hardcode event9 — the number moves across reboots and replugs.
        The device exposes a second, mouse-emulation node; requiring a usable
        ABS_X range is what excludes it (the mouse node reports REL).
        """
        candidates = sorted(Path("/dev/input").glob("event*"),
                            key=lambda p: int(p.name[5:] or 0))
        by_id, by_caps = [], []
        for p in candidates:
            ident = cls._device_id(str(p))
            try:
                fd = os.open(str(p), os.O_RDONLY | os.O_NONBLOCK)
            except Exception:
                continue
            try:
                has_abs = (cls._absinfo(fd, ABS_X) is not None or
                           cls._absinfo(fd, ABS_MT_POSITION_X) is not None)
            finally:
                os.close(fd)
            if not has_abs:
                continue
            if ident and ident[1] == vid and ident[2] == pid:
                by_id.append(str(p))
            else:
                by_caps.append(str(p))

        if by_id:
            logger.info("touch: matched %04x:%04x on %s", vid, pid, by_id[0])
            return by_id[0]
        if by_caps:
            logger.warning("touch: no %04x:%04x match; falling back to the "
                           "first absolute-position node %s", vid, pid,
                           by_caps[0])
            return by_caps[0]
        logger.warning("touch: no absolute-position input device found")
        return None

    # ----- lifecycle ----------------------------------------------------

    def start(self) -> None:
        path = self._path or self.discover()
        if not path:
            self._backend = "none"
            return
        try:
            self._fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        except PermissionError:
            logger.error("EPERM opening %s — device-cgroup denial, not file "
                         "permissions. Add 'c 13:* rmw' to the oled-display "
                         "device_cgroup_rules.", path)
            self._backend = "none"
            return
        except Exception as e:                                  # noqa: BLE001
            logger.error("touch open %s failed: %s", path, e)
            self._backend = "none"
            return

        for axis_name, axis, mt in (("x", ABS_X, ABS_MT_POSITION_X),
                                    ("y", ABS_Y, ABS_MT_POSITION_Y)):
            rng = self._absinfo(self._fd, axis) or self._absinfo(self._fd, mt)
            if rng:
                self._range[axis_name] = rng
        logger.info("touch: %s ranges x=%s y=%s -> %dx%d (swap=%s invx=%s "
                    "invy=%s)", path, self._range["x"], self._range["y"],
                    self.width, self.height, self._swap, self._inv_x,
                    self._inv_y)

        self._path, self._backend, self._running = path, "evdev", True
        self._thread = threading.Thread(target=self._loop, name="touch-evdev",
                                        daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        t, self._thread = self._thread, None
        if t is not None:
            t.join(timeout=2.0)
        if self._fd is not None:
            try:
                os.close(self._fd)
            except Exception:
                pass
            self._fd = None

    def get_state(self) -> dict:
        with self._lock:
            return {
                "backend": self._backend,
                "pressed": self._pressed,
                "x": self._x,
                "y": self._y,
                "press_count": self._press_count,
                "release_count": self._release_count,
            }

    # ----- read loop ----------------------------------------------------

    def _loop(self) -> None:
        while self._running and self._fd is not None:
            try:
                # select rather than a blocking read so stop() is responsive.
                r, _, _ = select.select([self._fd], [], [], 0.25)
                if not r:
                    continue
                data = os.read(self._fd, _EVENT_SIZE * 64)
            except (BlockingIOError, InterruptedError):
                continue
            except OSError as e:
                logger.warning("touch read failed (%s) — stopping", e)
                self._backend = "none"
                return
            for ev_type, code, value in self._decode(data):
                self._handle(ev_type, code, value)

    @staticmethod
    def _decode(data: bytes) -> Iterator[Tuple[int, int, int]]:
        for off in range(0, len(data) - _EVENT_SIZE + 1, _EVENT_SIZE):
            _sec, _usec, ev_type, code, value = struct.unpack_from(
                _EVENT_FMT, data, off)
            yield ev_type, code, value

    def _handle(self, ev_type: int, code: int, value: int) -> None:
        if ev_type == EV_ABS:
            if code in (ABS_X, ABS_MT_POSITION_X):
                self._raw["x"] = value
            elif code in (ABS_Y, ABS_MT_POSITION_Y):
                self._raw["y"] = value
        elif ev_type == EV_KEY and code == BTN_TOUCH:
            with self._lock:
                if value:
                    self._pressed = True
                    self._press_count += 1
                else:
                    self._pressed = False
                    self._release_count += 1
        elif ev_type == EV_SYN and code == SYN_REPORT:
            self._commit()

    def _commit(self) -> None:
        rx, ry = self._raw["x"], self._raw["y"]
        if rx is None or ry is None:
            return
        x = self._scale(rx, self._range["x"], self.width, self._inv_x)
        y = self._scale(ry, self._range["y"], self.height, self._inv_y)
        if self._swap:
            x, y = y, x
        with self._lock:
            self._x, self._y = x, y

    @staticmethod
    def _scale(raw: int, rng: Tuple[int, int], size: int, invert: bool) -> int:
        lo, hi = rng
        span = max(1, hi - lo)
        frac = (raw - lo) / span
        if invert:
            frac = 1.0 - frac
        return max(0, min(size - 1, int(frac * size)))
