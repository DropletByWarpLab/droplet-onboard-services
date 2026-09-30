"""
Linux framebuffer backend for the rack status panel (1424x280 HDMI bar).

The PyPortal was a computer: we streamed it JSON and its firmware drew the
pixels. This panel is a dumb monitor on the box's own iGPU, so the host renders
and blits. `TFTDisplay._push()` is the single choke point that calls in here.

Three things this module exists to get right:

1. **Stride.** The panel reports 1424px @ 32bpp but its line length is
   5888 bytes, NOT 1424*4 (=5696) — a 192-byte pad per row. Computing
   `offset = y * width * 4` shears the image progressively down the panel.
   We always read the real stride from sysfs and seek `y * stride`.

2. **Pixel order.** amdgpu presents XRGB8888 little-endian, i.e. B,G,R,X in
   memory order. We derive it from FBIOGET_VSCREENINFO's bitfields rather
   than assuming, and fall back to BGRX.

3. **Failing soft.** A display backend must never take the service down. Every
   failure path here degrades to "no panel" and lets the caller stay on `sim`.

Not handled here (deliberately): who *owns* the console. If getty or the
openwrt container still hold the framebuffer, our pixels land and are then
overwritten. That is a host-side fix — see the build plan, phase 0.
"""

from __future__ import annotations

import logging
import mmap
import os
import struct
from pathlib import Path
from typing import Optional, Tuple

from PIL import Image

# Linux-only. The service ships on Linux, but the test suite also runs on
# Windows dev laptops (see tests/conftest.py) — a hard import here would red
# the whole oled-display suite there. Everything that needs it degrades.
try:
    import fcntl
except ImportError:                                             # pragma: no cover
    fcntl = None                                                # type: ignore

logger = logging.getLogger("droplet.tft.fb")

FB_DEVICE = os.environ.get("FB_DEVICE", "/dev/fb0")

# <linux/fb.h>
FBIOGET_VSCREENINFO = 0x4600

# fb_var_screeninfo: 8 x __u32, then 4 x fb_bitfield (3 x __u32 each).
_VAR_PREFIX = "8I"           # xres..grayscale
_VAR_BITFIELDS = "12I"       # red, green, blue, transp

# Memory-order rawmodes PIL can pack from an RGBA source. ARGB has no packer,
# so an X-first framebuffer takes the slow path.
_PIL_RGBA_RAWMODES = ("BGRA", "RGBA", "ABGR")


class FramebufferError(RuntimeError):
    """Raised only inside `open()`; callers get None and fall back to sim."""


class FramebufferBackend:
    """Owns /dev/fb0 for the lifetime of the display service.

    Usage:
        fb = FramebufferBackend.open()      # None if unavailable
        if fb:
            fb.blit(pil_image)
    """

    def __init__(self, path: str, width: int, height: int, stride: int,
                 bpp: int, rawmode: str, phys_mm: Optional[Tuple[int, int]]):
        self.path = path
        self.width = width
        self.height = height
        self.stride = stride
        self.bpp = bpp
        self.rawmode = rawmode
        # From EDID via the ioctl. On this panel EDID lies (claims 432x243mm
        # for a bar), so treat as advisory only — see design brief §0.
        self.phys_mm = phys_mm

        self._row_bytes = width * (bpp // 8)
        self._fd = os.open(path, os.O_RDWR)
        try:
            self._mm = mmap.mmap(self._fd, stride * height,
                                 mmap.MAP_SHARED,
                                 mmap.PROT_READ | mmap.PROT_WRITE)
        except Exception:
            os.close(self._fd)
            raise
        # Clear once on open so console text left in the buffer (and any
        # garbage in the per-row pad) doesn't show through a letterboxed frame.
        self._mm[:] = b"\x00" * (stride * height)
        self._jitter = 0
        # WARP-2128: geometry mismatches are reported ONCE per distinct
        # (frame, panel) pair, not once per frame — see _blit().
        self._reported_mismatches: set[Tuple[int, int, int, int]] = set()

    # ----- construction -------------------------------------------------

    @classmethod
    def open(cls, path: str = FB_DEVICE) -> Optional["FramebufferBackend"]:
        """Best-effort open. Returns None (never raises) if unusable."""
        try:
            return cls._open_or_raise(path)
        except FileNotFoundError:
            logger.warning("framebuffer %s not present — staying on sim", path)
        except PermissionError:
            # The one that costs an hour: /dev is already bind-mounted rw and
            # the container runs root, so this is almost always the DEVICE
            # CGROUP, not file permissions. Needs `c 29:* rmw` in compose.
            logger.error(
                "EPERM opening %s. /dev is mounted rw and we are root, so this "
                "is a device-cgroup denial, not file permissions — add "
                "'c 29:* rmw' to the oled-display device_cgroup_rules.", path)
        except Exception as e:                                  # noqa: BLE001
            logger.error("framebuffer init failed (%s) — staying on sim", e)
        return None

    @classmethod
    def _open_or_raise(cls, path: str) -> "FramebufferBackend":
        node = Path(path).name                       # "fb0"
        sysfs = Path("/sys/class/graphics") / node

        width, height = cls._read_geometry(sysfs)
        bpp = cls._read_int(sysfs / "bits_per_pixel", 32)
        if bpp != 32:
            raise FramebufferError(f"unsupported bpp {bpp} (need 32)")

        stride = cls._read_stride(sysfs, width, bpp)
        rawmode, phys_mm = cls._probe_var_screeninfo(path)

        logger.info("framebuffer %s: %dx%d @ %dbpp stride=%d rawmode=%s "
                    "(unpadded row would be %d)",
                    path, width, height, bpp, stride, rawmode,
                    width * (bpp // 8))
        return cls(path, width, height, stride, bpp, rawmode, phys_mm)

    @staticmethod
    def _read_int(p: Path, default: Optional[int] = None) -> int:
        try:
            return int(p.read_text().strip())
        except Exception:
            if default is None:
                raise
            return default

    @staticmethod
    def _read_geometry(sysfs: Path) -> Tuple[int, int]:
        # virtual_size is "1424,280"
        raw = (sysfs / "virtual_size").read_text().strip()
        w, h = (int(v) for v in raw.split(","))
        return w, h

    @classmethod
    def _read_stride(cls, sysfs: Path, width: int, bpp: int) -> int:
        """Real line length in bytes. NEVER assume width * bpp/8."""
        try:
            stride = cls._read_int(sysfs / "stride")
            if stride >= width * (bpp // 8):
                return stride
            logger.warning("sysfs stride %d < row %d — ignoring",
                           stride, width * (bpp // 8))
        except Exception as e:                                  # noqa: BLE001
            logger.warning("could not read sysfs stride (%s)", e)
        fallback = width * (bpp // 8)
        logger.error("falling back to unpadded stride %d — if the panel shears "
                     "diagonally, this is why", fallback)
        return fallback

    @staticmethod
    def _probe_var_screeninfo(path: str) -> Tuple[str, Optional[Tuple[int, int]]]:
        """Derive PIL rawmode + physical size from FBIOGET_VSCREENINFO.

        Falls back to BGRX, which is what amdgpu's XRGB8888 looks like in
        memory-order on little-endian.
        """
        try:
            if fcntl is None:
                raise FramebufferError("fcntl unavailable on this platform")
            buf = bytearray(160)
            with open(path, "rb") as f:
                fcntl.ioctl(f.fileno(), FBIOGET_VSCREENINFO, buf, True)
            prefix = struct.unpack_from("<" + _VAR_PREFIX, buf, 0)
            fields = struct.unpack_from("<" + _VAR_BITFIELDS, buf, 32)
            r_off, g_off, b_off = fields[0], fields[3], fields[6]
            # height/width in mm sit after nonstd + activate (offsets 80, 84).
            h_mm, w_mm = struct.unpack_from("<2I", buf, 80)
            phys = (w_mm, h_mm) if w_mm and h_mm else None
            if phys:
                logger.info("EDID claims %dx%dmm — ADVISORY ONLY, this panel's "
                            "EDID physical-size fields are known bad", w_mm, h_mm)
            # Memory-order bytes for a 32bpp little-endian word: byte n holds
            # the channel whose bitfield offset is n*8. The remaining byte is
            # the unused/alpha slot.
            slots = {r_off // 8: "R", g_off // 8: "G", b_off // 8: "B"}
            if len(slots) != 3 or max(slots) > 3:
                raise FramebufferError(f"odd bitfields r={r_off} g={g_off} "
                                       f"b={b_off}")
            free = (set(range(4)) - set(slots)).pop()
            slots[free] = "A"
            mode = "".join(slots[i] for i in range(4))
            # PIL has no RGBA->ARGB packer; that ordering falls to _slow_pack.
            if mode not in _PIL_RGBA_RAWMODES:
                raise FramebufferError(f"no PIL packer for {mode}")
            logger.debug("var_screeninfo xres=%d yres=%d bpp=%d -> rawmode %s",
                         prefix[0], prefix[1], prefix[6], mode)
            return mode, phys
        except Exception as e:                                  # noqa: BLE001
            logger.warning("FBIOGET_VSCREENINFO failed (%s) — assuming BGRX", e)
            return "BGRA", None

    # ----- blit ---------------------------------------------------------

    def blit(self, image: Image.Image, *, jitter: bool = False) -> None:
        """Push a PIL image to the panel. Never raises."""
        try:
            self._blit(image, jitter=jitter)
        except Exception as e:                                  # noqa: BLE001
            logger.warning("framebuffer blit failed: %s", e)

    def _blit(self, image: Image.Image, *, jitter: bool) -> None:
        if image.mode != "RGB":
            image = image.convert("RGB")

        # Geometry mismatch: letterbox, never stretch. A stretched status
        # panel is worse than a centred one with margins, and silently
        # rescaling hides a misconfigured LCD_WIDTH/LCD_HEIGHT.
        ox = oy = 0
        if image.size != (self.width, self.height):
            oversized = image.width > self.width or image.height > self.height
            # WARP-2128: say this ONCE per distinct mismatch. It used to log
            # every frame, which at the cycle rate buries the one line that
            # explains the panel in scrollback — so the operator reads a
            # cropped screen as broken hardware rather than a wrong setting.
            key = (image.width, image.height, self.width, self.height)
            if key not in self._reported_mismatches:
                self._reported_mismatches.add(key)
                if oversized:
                    # Loud: this one CROPS. The operator is looking at the
                    # top-left corner of a render built for a screen that is
                    # not attached, which is never what anyone wanted.
                    logger.error(
                        "CONFIG ERROR: rendering %dx%d into a %dx%d panel — "
                        "the frame is LARGER than the screen and will be "
                        "CROPPED to its top-left corner. This is a wrong "
                        "setting, not broken hardware: set LCD_WIDTH=%d and "
                        "LCD_HEIGHT=%d in .env and recreate the container "
                        "(docker restart does NOT re-read env_file). Re-running "
                        "scripts/setup.sh re-detects this automatically.",
                        image.width, image.height, self.width, self.height,
                        self.width, self.height)
                else:
                    logger.warning(
                        "frame %dx%d < panel %dx%d — centring with margins. "
                        "Check LCD_WIDTH/LCD_HEIGHT.",
                        image.width, image.height, self.width, self.height)
            else:
                logger.debug("frame %dx%d != panel %dx%d (already reported)",
                             image.width, image.height, self.width, self.height)
            if oversized:
                image = image.crop((0, 0, min(image.width, self.width),
                                    min(image.height, self.height)))
            ox = (self.width - image.width) // 2
            oy = (self.height - image.height) // 2

        if jitter:
            # Image-persistence insurance: shift by a pixel on a slow cycle.
            # Free, invisible, and the chrome rail is static 24/7.
            self._jitter = (self._jitter + 1) % 4
            ox += (self._jitter % 2)
            oy += (self._jitter // 2)
            ox = min(ox, self.width - image.width)
            oy = min(oy, self.height - image.height)

        buf = self._pack(image)
        row = image.width * 4
        px = ox * 4

        if ox == 0 and oy == 0 and row == self.stride:
            # Unpadded and full-bleed — one memcpy.
            self._mm[0:len(buf)] = buf
            return

        for y in range(image.height):
            base = (oy + y) * self.stride + px
            self._mm[base:base + row] = buf[y * row:(y + 1) * row]

    def _pack(self, image: Image.Image) -> bytes:
        """Pack to the panel's byte order with an OPAQUE fourth byte.

        The fourth byte is nominally "don't care" on XRGB8888, but if the
        plane is actually ARGB8888 and honours alpha, a 0x00 there renders the
        whole panel black while we cheerfully write correct colour — a
        miserable bug to chase. PIL's RGB packers disagree about the pad
        (BGRX yields 0x00, RGBX yields 0xff), so we go via RGBA where every
        packer writes 0xff.
        """
        try:
            return image.convert("RGBA").tobytes("raw", self.rawmode)
        except (ValueError, SystemError):
            logger.warning("PIL rawmode %s unsupported — using slow pack",
                           self.rawmode)
            return self._slow_pack(image)

    def _slow_pack(self, image: Image.Image) -> bytes:
        src = image.convert("RGB").tobytes("raw", "RGB")
        out = bytearray(len(src) // 3 * 4)
        idx = {c: i for i, c in enumerate(self.rawmode)}
        r, g, b = idx.get("R", 2), idx.get("G", 1), idx.get("B", 0)
        a = idx.get("A", 3)
        for i in range(len(src) // 3):
            o = i * 4
            out[o + r] = src[i * 3]
            out[o + g] = src[i * 3 + 1]
            out[o + b] = src[i * 3 + 2]
            out[o + a] = 0xFF
        return bytes(out)

    # ----- power --------------------------------------------------------

    def set_blank(self, blank: bool) -> None:
        """FB_BLANK_POWERDOWN (4) / FB_BLANK_UNBLANK (0) — used by STANDBY."""
        node = Path(self.path).name
        p = Path("/sys/class/graphics") / node / "blank"
        try:
            p.write_text("4" if blank else "0")
        except Exception as e:                                  # noqa: BLE001
            logger.debug("blank %s failed: %s", blank, e)

    def close(self) -> None:
        try:
            self._mm.close()
        except Exception:
            pass
        try:
            os.close(self._fd)
        except Exception:
            pass


def try_release_console(vtcon: str = "vtcon1") -> bool:
    """Best-effort: unbind fbcon so the kernel console stops painting.

    Belt-and-braces only. The real fix is host-side (build plan PR-0b) — the
    container usually can't write /sys, and this does nothing about the
    openwrt container's inittab holding the host's /dev/tty1.
    """
    p = Path("/sys/class/vtconsole") / vtcon / "bind"
    try:
        if p.read_text().strip() == "0":
            return True
        p.write_text("0")
        logger.info("unbound %s — fbcon released", vtcon)
        return True
    except Exception as e:                                      # noqa: BLE001
        logger.info("could not unbind %s (%s) — expected inside the "
                    "container; host must own this", vtcon, e)
        return False
