"""
code.py — Droplet PyPortal Titano firmware

Purpose
-------
Turn a PyPortal Titano into a USB-serial-driven display for the Droplet
oled-display service. The service (running on the Jetson Orin Nano) sends
newline-delimited JSON commands over /dev/ttyACM1; this firmware renders
them using `displayio` + `adafruit_display_text`, and reports touch events
back over the same serial link.

Command protocol (host → PyPortal)
----------------------------------
Each command is one line of JSON terminated by '\n':

  {"mode": "logo"}
  {"mode": "stats", "data": {"cpu": 42, "mem": 68, "ip": "...",
                             "temp": 55, "uptime": "3d 4h"}}
  {"mode": "message", "data": {"title": "HELLO",
                               "lines": ["line one", "line two", ...]}}
  {"mode": "brightness", "value": 0..255}
  {"mode": "ping"}

Response protocol (PyPortal → host)
-----------------------------------
Every command gets exactly one response line:

  OK
  ERR:<reason>

Unsolicited touch events are emitted as:

  TOUCH:<x>,<y>,<pressure>
  TOUCH:release

Design notes
------------
* Uses `usb_cdc.data` (not the console) so REPL stays free at /dev/ttyACM0.
* Rendering is done with built-in `terminalio.FONT` to avoid shipping
  font files. Swap for a larger font later if needed.
* Colors match the Droplet brand (indigo #6366F1).
"""

import time
import json
import board
import displayio
import terminalio
import usb_cdc

from adafruit_display_text import label

try:
    import adafruit_touchscreen  # PyPortal Titano uses resistive touch on analog pins
except ImportError:
    adafruit_touchscreen = None

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BG_DARK = 0x0C0C12        # near-black background
BG_LOGO = 0x6366F1        # indigo accent
TEXT = 0xFFFFFF
DIM = 0x9696A4
GOOD = 0x34C759
WARN = 0xFFB400
CRIT = 0xFF3C3C

DISPLAY_W = board.DISPLAY.width    # 480
DISPLAY_H = board.DISPLAY.height   # 320

# ---------------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------------


def _solid_bg(color):
    """Return a displayio.Group that paints the whole screen a single color."""
    bmp = displayio.Bitmap(DISPLAY_W, DISPLAY_H, 1)
    pal = displayio.Palette(1)
    pal[0] = color
    return displayio.TileGrid(bmp, pixel_shader=pal)


def _text(text, *, x, y, scale=2, color=TEXT, anchor=None):
    lbl = label.Label(terminalio.FONT, text=text, color=color, scale=scale)
    if anchor is not None:
        lbl.anchor_point = anchor
        lbl.anchored_position = (x, y)
    else:
        lbl.x = x
        lbl.y = y
    return lbl


def render_logo():
    g = displayio.Group()
    g.append(_solid_bg(BG_LOGO))
    g.append(_text("DROPLET", x=DISPLAY_W // 2, y=DISPLAY_H // 2 - 10,
                   scale=6, color=TEXT, anchor=(0.5, 0.5)))
    g.append(_text("edge ai appliance",
                   x=DISPLAY_W // 2, y=DISPLAY_H // 2 + 50,
                   scale=2, color=TEXT, anchor=(0.5, 0.5)))
    board.DISPLAY.root_group = g


def render_stats(data):
    """Render a stats screen. `data` is a dict with string/number values."""
    g = displayio.Group()
    g.append(_solid_bg(BG_DARK))
    g.append(_text("SYSTEM STATUS", x=20, y=25, scale=2, color=BG_LOGO))

    order = [
        ("CPU  ", data.get("cpu"), "%"),
        ("MEM  ", data.get("mem"), "%"),
        ("TEMP ", data.get("temp"), "C"),
        ("IP   ", data.get("ip"), ""),
        ("UP   ", data.get("uptime"), ""),
    ]
    y = 70
    for lbl_text, value, unit in order:
        if value is None:
            continue
        color = TEXT
        if lbl_text.strip() == "CPU" and isinstance(value, (int, float)):
            color = CRIT if value > 90 else (WARN if value > 70 else TEXT)
        if lbl_text.strip() == "TEMP" and isinstance(value, (int, float)):
            color = CRIT if value > 80 else (WARN if value > 65 else TEXT)
        line = "{}{}{}".format(lbl_text, value, unit)
        g.append(_text(line, x=20, y=y, scale=3, color=color))
        y += 42

    board.DISPLAY.root_group = g


def render_message(data):
    g = displayio.Group()
    g.append(_solid_bg(BG_DARK))
    title = data.get("title", "")
    if title:
        g.append(_text(title, x=20, y=35, scale=4, color=BG_LOGO))
    y = 105
    for line in data.get("lines", []):
        g.append(_text(str(line), x=20, y=y, scale=2, color=TEXT))
        y += 34
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Touch (resistive on PyPortal Titano)
# ---------------------------------------------------------------------------

touch = None
if adafruit_touchscreen is not None:
    try:
        touch = adafruit_touchscreen.Touchscreen(
            board.TOUCH_XL,
            board.TOUCH_XR,
            board.TOUCH_YD,
            board.TOUCH_YU,
            calibration=((5200, 59000), (5800, 57000)),
            size=(DISPLAY_W, DISPLAY_H),
        )
    except Exception:
        touch = None


# ---------------------------------------------------------------------------
# Serial command loop
# ---------------------------------------------------------------------------

serial = usb_cdc.data  # None if boot.py didn't enable the data endpoint


def _send(line):
    if serial is None:
        return
    if isinstance(line, str):
        line = line.encode("utf-8")
    serial.write(line + b"\n")


def handle(msg):
    mode = msg.get("mode", "")
    if mode == "logo":
        render_logo()
    elif mode == "stats":
        render_stats(msg.get("data") or {})
    elif mode == "message":
        render_message(msg.get("data") or {})
    elif mode == "brightness":
        value = max(0, min(255, int(msg.get("value", 255))))
        board.DISPLAY.brightness = value / 255.0
    elif mode == "ping":
        pass  # just reply OK
    else:
        return "ERR:unknown_mode:{}".format(mode)
    return "OK"


def main():
    render_logo()
    _send("READY")
    buf = b""
    last_touch = None

    while True:
        # --- incoming commands ---
        if serial is not None and serial.in_waiting:
            chunk = serial.read(serial.in_waiting)
            buf += chunk
            while b"\n" in buf:
                raw, _, buf = buf.partition(b"\n")
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    msg = json.loads(raw.decode("utf-8"))
                    resp = handle(msg)
                except Exception as exc:       # noqa: BLE001
                    resp = "ERR:{}".format(exc)
                _send(resp)

        # --- touch events ---
        if touch is not None:
            p = None
            try:
                p = touch.touch_point
            except Exception:
                p = None
            if p is not None and last_touch != p:
                _send("TOUCH:{},{},{}".format(p[0], p[1], p[2]))
                last_touch = p
            elif p is None and last_touch is not None:
                _send("TOUCH:release")
                last_touch = None

        time.sleep(0.03)


if __name__ == "__main__":
    main()
