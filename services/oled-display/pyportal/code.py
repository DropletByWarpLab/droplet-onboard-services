"""
code.py — Droplet PyPortal Titano firmware (monitoring + wifi)
==============================================================
Turns a PyPortal Titano into a self-contained touch display for the
Droplet edge AI appliance, focused on monitoring and wifi onboarding.

Matches the web dashboard's dark-mode visual language (indigo accent,
tile-grid home, surface-raised cards) but drops AI chat / settings: the
appliance-side screen is a live status panel you can also use to pick
a wifi network.

Screens
-------
  home     4 tiles: Status, Network, Wi-Fi, Info, plus a status ribbon.
  stats    2x2 metric cards (CPU/MEM/DISK/TEMP) + IP/uptime footer.
  network  Hostname + IP card, LAN / uplink sub-cards.
  wifi     List of nearby SSIDs with signal bars + security; tap to pick.
  info     Device identity + uptime + firmware info.
  logo     Full-screen Droplet mark (ambient).
  message  Title + lines pushed from the Jetson.

Host -> PyPortal commands (one JSON per line)
  {"mode":"home"|"stats"|"network"|"wifi"|"info"|"logo"}
  {"mode":"stats",  "data":{cpu,mem,disk,temp,ip,hostname,uptime}}
  {"mode":"wifi",   "data":{networks:[{ssid,signal,security,connected},...],
                             adapter, connected_to, state, scanned_at}}
  {"mode":"message","data":{title, lines:[...]}}
  {"mode":"brightness","value":0..255}
  {"mode":"ping"}

PyPortal -> host
  OK / ERR:<reason>
  TOUCH:<x>,<y>,<p> / TOUCH:release
  TAP:<screen>:<region>
  NAV:<screen>
  WIFI_SELECT:<ssid>        (user tapped an SSID — host should POST /wifi/connect)
"""

import gc
import time
import json

import board
import displayio
import supervisor
import terminalio
import usb_cdc
import vectorio

from adafruit_display_text import label

# Heap-safe threshold. When gc.mem_free() drops below this after a
# render, we reload the firmware via supervisor.reload() — a fresh VM
# is far cheaper than trying to defragment an MPY heap under load.
_HEAP_PANIC_BYTES = 18 * 1024


# ---------------------------------------------------------------------------
# Palette pool — one Palette per RGB color, shared across every vectorio
# Rectangle that uses that color. Without sharing, each rect allocates its
# own Palette (~200B) and we exhaust the heap after ~40 rects. With the
# pool, a full home-screen render touches maybe 10 unique colors.
# ---------------------------------------------------------------------------
_PALETTES = {}


def _palette(color):
    p = _PALETTES.get(color)
    if p is None:
        p = displayio.Palette(1)
        p[0] = color
        _PALETTES[color] = p
    return p

try:
    import adafruit_touchscreen
except ImportError:
    adafruit_touchscreen = None


# Design tokens (mirror display.py + web dashboard dark mode)
BG            = 0x121214
SURFACE_2     = 0x1C1C1E
SURFACE_R     = 0x18181B
SEPARATOR     = 0x46464C
TEXT          = 0xFFFFFF
LABEL_2       = 0xBEBEC8
LABEL_3       = 0x9191A0
ACCENT        = 0x818CF8
ACCENT_PRI    = 0x6366F1
ACCENT_LIGHT  = 0xA5B4FC
ACCENT_SUBTLE = 0x2D2F55
GREEN         = 0x30D158
ORANGE        = 0xFF9F0A
RED           = 0xFF453A

DISPLAY_W = board.DISPLAY.width
DISPLAY_H = board.DISPLAY.height

serial = usb_cdc.data


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

def _rect(x, y, w, h, color):
    """Return a vectorio.Rectangle — doesn't allocate a Bitmap, so many
    rects can coexist in the same scene without exhausting the heap.

    Shares a single displayio.Palette per color via the _palette pool.
    """
    if w <= 0 or h <= 0:
        return displayio.Group()  # no-op placeholder
    return vectorio.Rectangle(
        pixel_shader=_palette(color),
        width=max(1, int(w)), height=max(1, int(h)),
        x=int(x), y=int(y),
    )


def _stroked_rect(x, y, w, h, color, sw=1):
    # 4 thin rectangles form the border. Each is a vectorio.Rectangle,
    # so the whole border costs <1KB of heap.
    g = displayio.Group()
    g.append(_rect(x, y, w, sw, color))
    g.append(_rect(x, y + h - sw, w, sw, color))
    g.append(_rect(x, y, sw, h, color))
    g.append(_rect(x + w - sw, y, sw, h, color))
    return g


def _text(s, *, x, y, scale=2, color=TEXT, anchor=None):
    lbl = label.Label(terminalio.FONT, text=s, color=color, scale=scale)
    if anchor is not None:
        lbl.anchor_point = anchor
        lbl.anchored_position = (x, y)
    else:
        lbl.x = x
        lbl.y = y
    return lbl


# ---------------------------------------------------------------------------
# Droplet brand mark (scanline-filled polygon, geometry from DropletMark.tsx)
# ---------------------------------------------------------------------------

def _make_mark_bmp(size):
    w = int(size * 52 / 60)
    h = size
    bmp = displayio.Bitmap(w, h, 3)
    pal = displayio.Palette(3)
    pal[0] = BG
    pal[1] = ACCENT_PRI
    pal[2] = ACCENT_LIGHT
    pal.make_transparent(0)

    def sx(px): return int(px / 52 * w)
    def sy(py): return int(py / 60 * h)

    def fill_poly(pts, idx):
        ys = [p[1] for p in pts]
        y0 = max(0, sy(min(ys)))
        y1 = min(h - 1, sy(max(ys)))
        n = len(pts)
        for yy in range(y0, y1 + 1):
            xmin = None
            xmax = None
            for i in range(n):
                ax, ay = pts[i]
                bx, by = pts[(i + 1) % n]
                ax, ay = sx(ax), sy(ay)
                bx, by = sx(bx), sy(by)
                if ay == by:
                    continue
                if min(ay, by) <= yy <= max(ay, by):
                    t = (yy - ay) / (by - ay)
                    x = int(ax + t * (bx - ax))
                    if xmin is None or x < xmin:
                        xmin = x
                    if xmax is None or x > xmax:
                        xmax = x
            if xmin is None:
                continue
            for xx in range(max(0, xmin), min(w - 1, xmax) + 1):
                bmp[xx, yy] = idx

    fill_poly([(26, 0), (44, 28), (36, 48), (16, 48), (8, 28)], 1)
    fill_poly([(26, 0), (44, 28), (26, 36)], 2)
    return bmp, pal


_MARK_SMALL = _make_mark_bmp(32)
_MARK_MED   = _make_mark_bmp(52)
_MARK_LARGE = _make_mark_bmp(140)


def _mark_tg(size, x, y):
    if size >= 120:
        bmp, pal = _MARK_LARGE
    elif size >= 48:
        bmp, pal = _MARK_MED
    else:
        bmp, pal = _MARK_SMALL
    return displayio.TileGrid(bmp, pixel_shader=pal, x=x, y=y)


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

state = {
    "screen": "home",
    "cpu": 0, "mem": 0, "disk": 0, "temp": 0,
    "ip": "-", "uptime": "-", "hostname": "droplet", "now": "--:--",
    "brightness": 255,
    "msg_title": "",
    "msg_lines": [],
    "wifi": {
        "networks": [],
        "adapter": None,
        "connected_to": None,
        "state": "unknown",
        "scanned_at": None,
    },
    "wifi_scroll": 0,
    "wifi_selected": None,
    "wifi_status": "",
    "files": {"count": 0, "size_bytes": 0, "recent": []},
    "cameras": {"online": 0, "total": 0, "events": [], "error": None},
    "drives": {"drives": [], "count": 0},
    "qr": None,  # {"matrix": [[0/1,...],...], "ssid": "...", "payload": "...",
                 #  "security": "...", "version": N, "ok": True}
}

touch_regions = []
# Monotonic timestamp — ignore touches until this time. Set after a
# screen change so a lingering finger doesn't dispatch against the new
# screen's regions.
_nav_debounce_until = 0.0


def _region(name, x, y, w, h, action):
    touch_regions.append({
        "name": name, "x": x, "y": y, "w": w, "h": h, "action": action,
    })


# ---------------------------------------------------------------------------
# Shared chrome
# ---------------------------------------------------------------------------

def _header(g, title="Droplet", show_back=False, show_home=False,
            status_dot=GREEN, status_text="Online"):
    """Top bar: back button (if any) + title + hostname + clock.

    The top-right corner just shows a 24-hour clock now — the previous
    "status chip" was confusing (raw state words like 'unavailable'),
    and the hostname belongs to the left of the clock for context.
    """
    bar_h = 52
    g.append(_rect(0, 0, DISPLAY_W, bar_h, SURFACE_2))
    g.append(_rect(0, bar_h, DISPLAY_W, 1, SEPARATOR))

    x = 10
    if show_back or show_home:
        label_txt = "< Back" if show_back else "Home"
        _button(g, x, 6, 96, 40, label_txt,
                region=("nav_back", lambda: set_screen("home")),
                fill=ACCENT_SUBTLE, border=ACCENT, color=ACCENT)
        # Full header fallback region — catches off-center taps.
        _region("header_back", 106, 0, DISPLAY_W - 120, bar_h,
                lambda: set_screen("home"))
        x += 110

    g.append(_mark_tg(32, x, 10))
    x += 36
    g.append(_text(title, x=x, y=26, scale=2, color=TEXT))

    # Right edge: wall-clock time (pushed from the Jetson since PyPortal
    # has no RTC) + a compact status pill underneath so it's clear
    # whether the device is online.
    clock = state.get("now") or "--:--"
    g.append(_text(clock, x=DISPLAY_W - 14, y=18, scale=3, color=TEXT,
                   anchor=(1.0, 0.5)))

    # Status under the clock: single green dot + hostname short label
    wifi = state.get("wifi") or {}
    online = bool(wifi.get("connected_to")) or (state.get("ip") not in (None, "-", ""))
    dot_col = GREEN if online else ORANGE
    status_txt = "Online" if online else "Offline"
    dot_x = DISPLAY_W - 72
    dot_y = 40
    g.append(_rect(dot_x, dot_y, 6, 6, dot_col))
    g.append(_text(status_txt, x=dot_x + 12, y=dot_y + 3,
                   scale=1, color=LABEL_2))

    return bar_h + 6


def _button(g, x, y, w, h, text_str, region=None, fill=SURFACE_R,
            border=SEPARATOR, color=TEXT):
    g.append(_rect(x, y, w, h, fill))
    g.append(_stroked_rect(x, y, w, h, border, 1))
    g.append(_text(text_str, x=x + w // 2, y=y + h // 2,
                   scale=1, color=color, anchor=(0.5, 0.5)))
    if region is not None:
        _region(region[0], x, y, w, h, region[1])


# ---------------------------------------------------------------------------
# Home
# ---------------------------------------------------------------------------

def _tile(g, x, y, w, h, tag, title, sub, dest):
    g.append(_rect(x, y, w, h, SURFACE_R))
    g.append(_stroked_rect(x, y, w, h, SEPARATOR, 1))
    pad = 12
    pill_w, pill_h = 44, 20
    g.append(_rect(x + pad, y + pad, pill_w, pill_h, ACCENT_SUBTLE))
    g.append(_text(tag, x=x + pad + pill_w // 2, y=y + pad + pill_h // 2,
                   scale=1, color=ACCENT, anchor=(0.5, 0.5)))
    g.append(_text(title, x=x + pad, y=y + pad + pill_h + 22,
                   scale=2, color=TEXT))
    g.append(_text(str(sub)[:26], x=x + pad, y=y + pad + pill_h + 48,
                   scale=1, color=LABEL_3))
    _region("tile_" + tag.lower(), x, y, w, h,
            (lambda d=dest: set_screen(d)))


def _status_ribbon(g, x, y, w, h):
    g.append(_rect(x, y, w, h, SURFACE_R))
    g.append(_stroked_rect(x, y, w, h, SEPARATOR, 1))
    segs = (
        ("{}%".format(state["cpu"]),   "CPU"),
        ("{}%".format(state["mem"]),   "RAM"),
        ("{}%".format(state["disk"]),  "DISK"),
        ("{}C".format(state["temp"]),  "TEMP"),
        (str(state["uptime"])[:6],     "UP"),
    )
    seg_w = w // len(segs)
    for i, (p, s) in enumerate(segs):
        cx = x + i * seg_w
        g.append(_text(p, x=cx + 10, y=y + 12, scale=2, color=TEXT))
        g.append(_text(s, x=cx + 10, y=y + 32, scale=1, color=LABEL_3))
        if i > 0:
            g.append(_rect(cx, y + 8, 1, h - 16, SEPARATOR))


def render_home():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    wifi = state["wifi"] or {}
    y0 = _header(g, str(state.get("hostname") or "Droplet")[:18])

    pad = 10
    gap = 10
    tw = (DISPLAY_W - 2 * pad - gap) // 2
    th = (DISPLAY_H - y0 - 66 - gap) // 2

    files = state.get("files") or {}
    cams = state.get("cameras") or {}
    file_sub = "{} files".format(files.get("count", 0)) \
        if files.get("count") else "No files"
    cam_sub = ("{} events".format(len(cams.get("events") or []))
               if cams.get("events")
               else "{} online".format(cams.get("online") or 0))
    drives = state.get("drives") or {}
    drv_count = drives.get("count") or 0
    drv_sub = ("{} mounted".format(drv_count) if drv_count
               else "Plug a USB drive")
    tiles = (
        ("SYS",   "Status",  "CPU / RAM / TEMP",    "stats"),
        ("WIFI",  "Wi-Fi",   "{} networks".format(len(wifi.get("networks", []))),
                                                    "wifi"),
        ("CAM",   "Cameras", cam_sub,               "cameras"),
        ("DRIVE", "Drives",  drv_sub,               "drives"),
    )
    for i, (tag, title, sub, dest) in enumerate(tiles):
        col = i % 2
        row = i // 2
        tx = pad + col * (tw + gap)
        ty = y0 + row * (th + gap)
        _tile(g, tx, ty, tw, th, tag, title, sub, dest)

    _status_ribbon(g, pad, DISPLAY_H - 56, DISPLAY_W - 2 * pad, 44)
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def _metric(g, x, y, w, h, lbl, value, pct, warn=80, crit=95):
    g.append(_rect(x, y, w, h, SURFACE_R))
    g.append(_text(lbl, x=x + 14, y=y + 14, scale=1, color=LABEL_3))
    g.append(_text(value, x=x + 14, y=y + 34, scale=3, color=TEXT))
    bx, by, bw = x + 14, y + h - 20, w - 28
    g.append(_rect(bx, by, bw, 8, SURFACE_2))
    fw = int(bw * max(0, min(100, pct)) / 100)
    if fw > 0:
        color = ACCENT if pct < warn else (ORANGE if pct < crit else RED)
        g.append(_rect(bx, by, fw, 8, color))


def render_stats():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    y0 = _header(g, "Health", show_back=True)

    pad = 10
    gap = 10
    cw = (DISPLAY_W - 2 * pad - gap) // 2
    ch = (DISPLAY_H - y0 - 56 - gap) // 2

    _metric(g, pad, y0, cw, ch, "CPU",
            "{}%".format(state["cpu"]), state["cpu"])
    _metric(g, pad + cw + gap, y0, cw, ch, "MEMORY",
            "{}%".format(state["mem"]), state["mem"])
    _metric(g, pad, y0 + ch + gap, cw, ch, "DISK",
            "{}%".format(state["disk"]), state["disk"], 85, 95)

    tx = pad + cw + gap
    ty = y0 + ch + gap
    g.append(_rect(tx, ty, cw, ch, SURFACE_R))
    g.append(_text("TEMP", x=tx + 14, y=ty + 14, scale=1, color=LABEL_3))
    t = state["temp"]
    tcolor = TEXT if t < 70 else (ORANGE if t < 85 else RED)
    g.append(_text("{}C".format(t), x=tx + 14, y=ty + 34, scale=3, color=tcolor))
    s = "nominal" if t < 70 else ("warm" if t < 85 else "hot")
    scolor = GREEN if t < 70 else (ORANGE if t < 85 else RED)
    g.append(_text(s, x=tx + 14, y=ty + ch - 24, scale=1, color=scolor))

    fy = DISPLAY_H - 42
    g.append(_text("IP", x=pad, y=fy + 6, scale=1, color=LABEL_3))
    g.append(_text(state["ip"], x=pad + 24, y=fy + 8, scale=1, color=TEXT))
    g.append(_text("UP", x=DISPLAY_W - pad - 70, y=fy + 6, scale=1, color=LABEL_3))
    g.append(_text(str(state["uptime"]), x=DISPLAY_W - pad, y=fy + 8,
                   scale=1, color=TEXT, anchor=(1.0, 0.0)))

    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

def render_network():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    y0 = _header(g, "Network", show_back=True)

    pad = 16
    card_h = 96
    g.append(_rect(pad, y0 + 4, DISPLAY_W - 2 * pad, card_h, SURFACE_R))
    g.append(_mark_tg(52, pad + 16, y0 + 18))
    g.append(_text(str(state["hostname"])[:24],
                   x=pad + 86, y=y0 + 24, scale=2, color=TEXT))
    g.append(_text(str(state["ip"]), x=pad + 86, y=y0 + 52,
                   scale=2, color=ACCENT))
    g.append(_text("This device", x=pad + 86, y=y0 + 78,
                   scale=1, color=LABEL_3))

    sy = y0 + 4 + card_h + 12
    sh = DISPLAY_H - sy - 16
    cw = (DISPLAY_W - 2 * pad - 12) // 2

    wifi = state["wifi"] or {}
    wifi_line = wifi.get("connected_to") or wifi.get("state") or "—"

    cards = (
        ("LAN",    state["ip"],        "Via gateway"),
        ("WIFI",   str(wifi_line)[:14], wifi.get("adapter") or "no adapter"),
    )
    for i, (lb, pm, sc) in enumerate(cards):
        sx = pad + i * (cw + 12)
        g.append(_rect(sx, sy, cw, sh, SURFACE_R))
        g.append(_text(lb, x=sx + 14, y=sy + 14, scale=1, color=LABEL_3))
        g.append(_text(str(pm), x=sx + 14, y=sy + 38, scale=2, color=TEXT))
        g.append(_text(str(sc), x=sx + 14, y=sy + sh - 16, scale=1,
                       color=LABEL_2))
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Wi-Fi
# ---------------------------------------------------------------------------

WIFI_ROWS_VISIBLE = 5


def _signal_bars(g, x, y, signal):
    """Draw 4 stacked bars that fill based on signal %."""
    bars = 4
    gap = 2
    bw = 5
    total_h = 22
    # base y is the bottom of the bars
    for i in range(bars):
        bh = 6 + i * 4
        bx = x + i * (bw + gap)
        by = y + (total_h - bh)
        lit = signal >= (i + 1) * 22
        g.append(_rect(bx, by, bw, bh, ACCENT if lit else SURFACE_2))


def render_wifi():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    y0 = _header(g, "Wi-Fi", show_back=True)

    wifi = state["wifi"] or {}
    networks = wifi.get("networks") or []
    pad = 12

    # Toolbar: current connection + QR + rescan buttons
    toolbar_h = 36
    g.append(_rect(pad, y0 + 2, DISPLAY_W - 2 * pad, toolbar_h, SURFACE_R))
    conn = wifi.get("connected_to")
    conn_text = "Connected: " + conn if conn else "Not connected"
    dot_col = GREEN if conn else LABEL_3
    g.append(_rect(pad + 14, y0 + 2 + toolbar_h // 2 - 3, 6, 6, dot_col))
    g.append(_text(conn_text[:22], x=pad + 28, y=y0 + 2 + toolbar_h // 2,
                   scale=1, color=LABEL_2, anchor=(0.0, 0.5)))
    _button(g, DISPLAY_W - pad - 168, y0 + 5, 80, 28, "Show QR",
            region=("wifi_qr", lambda: set_screen("qr")),
            fill=ACCENT_SUBTLE, border=ACCENT, color=ACCENT)
    _button(g, DISPLAY_W - pad - 80, y0 + 5, 72, 28, "Rescan",
            region=("wifi_rescan", _request_wifi_rescan))

    list_y = y0 + 2 + toolbar_h + 6
    row_h = 38
    list_h = row_h * WIFI_ROWS_VISIBLE
    g.append(_rect(pad, list_y, DISPLAY_W - 2 * pad, list_h, SURFACE_R))

    # Clamp scroll.
    max_scroll = max(0, len(networks) - WIFI_ROWS_VISIBLE)
    if state["wifi_scroll"] > max_scroll:
        state["wifi_scroll"] = max_scroll
    if state["wifi_scroll"] < 0:
        state["wifi_scroll"] = 0
    start = state["wifi_scroll"]
    visible = networks[start:start + WIFI_ROWS_VISIBLE]

    # Modern scrollbar: thin accent track on the right, thumb sized to
    # the visible proportion. Tapping the upper half pages up, lower
    # half pages down — no ugly arrow buttons.
    has_scroll = len(networks) > WIFI_ROWS_VISIBLE
    scroll_track_w = 4
    scroll_inset = 10
    row_w = (DISPLAY_W - 2 * pad -
             (scroll_track_w + scroll_inset + 8 if has_scroll else 0))

    if has_scroll:
        track_x = DISPLAY_W - pad - scroll_track_w - scroll_inset
        track_y = list_y + 8
        track_h = list_h - 16
        # Rail (dim)
        g.append(_rect(track_x, track_y, scroll_track_w, track_h,
                       SURFACE_2))
        # Thumb (accent) — proportional height, positioned by scroll.
        thumb_h = max(24, int(track_h * WIFI_ROWS_VISIBLE / len(networks)))
        thumb_y_range = track_h - thumb_h
        thumb_y = track_y + int(thumb_y_range * start / max_scroll) \
            if max_scroll else track_y
        g.append(_rect(track_x, thumb_y, scroll_track_w, thumb_h, ACCENT))
        # Invisible touch zones for page-up / page-down. Upper half of
        # the list area advances backwards, lower half advances forward.
        zone_w = scroll_track_w + scroll_inset + 8
        _region("wifi_page_up",
                DISPLAY_W - pad - zone_w, list_y,
                zone_w, list_h // 2, _wifi_scroll_up)
        _region("wifi_page_down",
                DISPLAY_W - pad - zone_w, list_y + list_h // 2,
                zone_w, list_h - list_h // 2, _wifi_scroll_down)

    if not networks:
        msg = "No networks found. Tap Rescan."
        if wifi.get("state") in ("unavailable", "unknown", None):
            msg = "Wi-Fi adapter unavailable."
        g.append(_text(msg, x=DISPLAY_W // 2, y=list_y + list_h // 2,
                       scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
    else:
        for i, net in enumerate(visible):
            ry = list_y + i * row_h
            if net.get("connected"):
                g.append(_rect(pad + 1, ry + 1, row_w - 2, row_h - 2,
                               ACCENT_SUBTLE))
            if i < len(visible) - 1:
                g.append(_rect(pad + 12, ry + row_h - 1,
                               row_w - 24, 1, SEPARATOR))
            _signal_bars(g, pad + 14, ry + 8, int(net.get("signal", 0)))
            ssid = str(net.get("ssid") or "(hidden)")[:22]
            g.append(_text(ssid, x=pad + 56, y=ry + row_h // 2 - 4,
                           scale=2,
                           color=ACCENT if net.get("connected") else TEXT,
                           anchor=(0.0, 0.5)))
            sec = str(net.get("security") or "Open")[:10]
            g.append(_text(sec, x=pad + 56, y=ry + row_h // 2 + 10,
                           scale=1, color=LABEL_3, anchor=(0.0, 0.5)))
            g.append(_text("{}%".format(int(net.get("signal", 0))),
                           x=pad + row_w - 14, y=ry + row_h // 2,
                           scale=1, color=LABEL_2, anchor=(1.0, 0.5)))
            _region("ssid_" + str(start + i),
                    pad, ry, row_w, row_h,
                    (lambda s=ssid, sec=sec: _select_ssid(s, sec)))

    # Status line at bottom
    status_y = list_y + list_h + 6
    remaining = max(0, DISPLAY_H - status_y - 4)
    if remaining >= 18:
        msg = state.get("wifi_status") or (
            "Adapter: {} | State: {}".format(
                wifi.get("adapter") or "—", wifi.get("state") or "—")
        )
        g.append(_text(msg[:60], x=pad, y=status_y + 4,
                       scale=1, color=LABEL_3))

    board.DISPLAY.root_group = g


def _request_wifi_rescan():
    state["wifi_status"] = "Scanning..."
    _send("RESCAN_WIFI")
    _render_with_gc("wifi")


def _wifi_scroll_up():
    # Scroll one row at a time — feels snappier + the thumb moves visibly.
    state["wifi_scroll"] = max(0, state["wifi_scroll"] - 1)
    _render_with_gc("wifi")


def _wifi_scroll_down():
    nets = (state["wifi"] or {}).get("networks") or []
    state["wifi_scroll"] = min(
        max(0, len(nets) - WIFI_ROWS_VISIBLE),
        state["wifi_scroll"] + 1,
    )
    _render_with_gc("wifi")


def _select_ssid(ssid, security):
    state["wifi_selected"] = ssid
    state["wifi_status"] = "Tap connect on dashboard to join " + ssid
    _send("WIFI_SELECT:{}:{}".format(ssid, security))
    _render_with_gc("wifi")


# ---------------------------------------------------------------------------
# Info
# ---------------------------------------------------------------------------

def render_info():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    y0 = _header(g, "Device Info", show_back=True)

    pad = 16
    card_h = 140
    g.append(_rect(pad, y0 + 4, DISPLAY_W - 2 * pad, card_h, SURFACE_R))
    g.append(_mark_tg(140, pad + 16, y0 + 8))
    tx = pad + 16 + int(140 * 52 / 60) + 20
    g.append(_text("Droplet", x=tx, y=y0 + 30, scale=4, color=TEXT))
    g.append(_text("Edge AI Appliance", x=tx, y=y0 + 70,
                   scale=1, color=LABEL_3))
    g.append(_text(str(state["hostname"])[:24], x=tx, y=y0 + 96,
                   scale=2, color=ACCENT))

    sy = y0 + 4 + card_h + 12
    sh = DISPLAY_H - sy - 16
    cw = (DISPLAY_W - 2 * pad - 12) // 2

    rows = (
        ("UPTIME",   str(state["uptime"])),
        ("LAN IP",   str(state["ip"])),
    )
    for i, (lbl, val) in enumerate(rows):
        sx = pad + i * (cw + 12)
        g.append(_rect(sx, sy, cw, sh, SURFACE_R))
        g.append(_text(lbl, x=sx + 14, y=sy + 14, scale=1, color=LABEL_3))
        g.append(_text(val[:14], x=sx + 14, y=sy + 38, scale=2, color=TEXT))

    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

def _fmt_bytes(n):
    try:
        n = int(n)
    except Exception:
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return ("{:.1f} ".format(n) + unit) if unit != "B" else (
                "{} B".format(int(n)))
        n /= 1024
    return "{:.1f} PB".format(n)


def render_files():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    y0 = _header(g, "Files", show_back=True)

    files = state.get("files") or {}
    pad = 16
    card_h = 94
    g.append(_rect(pad, y0 + 4, DISPLAY_W - 2 * pad, card_h, SURFACE_R))
    g.append(_text("FILES", x=pad + 16, y=y0 + 18, scale=1, color=LABEL_3))
    g.append(_text(str(files.get("count") or 0),
                   x=pad + 16, y=y0 + 40, scale=4, color=TEXT))
    g.append(_text(_fmt_bytes(files.get("size_bytes") or 0),
                   x=pad + 16, y=y0 + 82, scale=2, color=ACCENT))

    # Recent list
    rec_y = y0 + 4 + card_h + 10
    rec_h = DISPLAY_H - rec_y - 14
    g.append(_rect(pad, rec_y, DISPLAY_W - 2 * pad, rec_h, SURFACE_R))
    g.append(_text("RECENT", x=pad + 14, y=rec_y + 14,
                   scale=1, color=LABEL_3))
    recent = (files.get("recent") or [])[:5]
    if not recent:
        g.append(_text("No recent files indexed.",
                       x=DISPLAY_W // 2, y=rec_y + rec_h // 2,
                       scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
    else:
        row_y = rec_y + 34
        for f in recent:
            name = str(f.get("name", ""))[:36]
            size = _fmt_bytes(f.get("size") or 0)
            g.append(_text(name, x=pad + 14, y=row_y, scale=1, color=TEXT))
            g.append(_text(size, x=DISPLAY_W - pad - 14, y=row_y,
                           scale=1, color=LABEL_3, anchor=(1.0, 0.0)))
            row_y += 22
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Drives (USB auto-mounted)
# ---------------------------------------------------------------------------

def render_drives():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    y0 = _header(g, "Drives", show_back=True)

    drives = state.get("drives") or {}
    items = drives.get("drives") or []
    pad = 16

    # Summary card
    summary_h = 68
    g.append(_rect(pad, y0 + 4, DISPLAY_W - 2 * pad, summary_h, SURFACE_R))
    total_bytes = sum(d.get("size_bytes") or 0 for d in items)
    used_bytes = sum(d.get("used_bytes") or 0 for d in items)
    g.append(_text("MOUNTED", x=pad + 16, y=y0 + 18, scale=1, color=LABEL_3))
    g.append(_text(str(drives.get("count") or 0),
                   x=pad + 16, y=y0 + 44, scale=4, color=TEXT))
    g.append(_text("{} / {}".format(_fmt_bytes(used_bytes),
                                    _fmt_bytes(total_bytes)),
                   x=DISPLAY_W - pad - 16, y=y0 + 44,
                   scale=2, color=ACCENT, anchor=(1.0, 0.0)))
    g.append(_text("used / total", x=DISPLAY_W - pad - 16, y=y0 + 72,
                   scale=1, color=LABEL_3, anchor=(1.0, 0.0)))

    # List
    list_y = y0 + 4 + summary_h + 10
    list_h = DISPLAY_H - list_y - 14
    g.append(_rect(pad, list_y, DISPLAY_W - 2 * pad, list_h, SURFACE_R))
    if not items:
        g.append(_text("No USB drives mounted yet.",
                       x=DISPLAY_W // 2, y=list_y + list_h // 2 - 8,
                       scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
        g.append(_text("Plug one in — it'll auto-mount & appear here.",
                       x=DISPLAY_W // 2, y=list_y + list_h // 2 + 14,
                       scale=1, color=LABEL_3, anchor=(0.5, 0.5)))
    else:
        row_y = list_y + 12
        for d in items[:5]:
            label_ = str(d.get("label") or d.get("mount") or "?")[:24]
            mount = str(d.get("mount") or "")
            tot = d.get("size_bytes") or 0
            usd = d.get("used_bytes") or 0
            pct = int((usd * 100) / tot) if tot else 0
            g.append(_text(label_, x=pad + 14, y=row_y, scale=2, color=TEXT))
            g.append(_text(mount[:38], x=pad + 14, y=row_y + 22,
                           scale=1, color=LABEL_3))
            g.append(_text("{}/{}".format(_fmt_bytes(usd), _fmt_bytes(tot)),
                           x=DISPLAY_W - pad - 14, y=row_y, scale=1,
                           color=LABEL_2, anchor=(1.0, 0.0)))
            # Fill bar
            bar_x = pad + 14
            bar_y = row_y + 42
            bar_w = DISPLAY_W - 2 * pad - 28
            g.append(_rect(bar_x, bar_y, bar_w, 5, SURFACE_2))
            fw = int(bar_w * max(0, min(100, pct)) / 100)
            if fw > 0:
                col = ACCENT if pct < 80 else (ORANGE if pct < 95 else RED)
                g.append(_rect(bar_x, bar_y, fw, 5, col))
            row_y += 58
            if row_y > list_y + list_h - 30:
                break
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Cameras
# ---------------------------------------------------------------------------

def render_cameras():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    y0 = _header(g, "Cameras", show_back=True)

    cams = state.get("cameras") or {}
    pad = 16

    # Top card: online/total
    card_h = 82
    g.append(_rect(pad, y0 + 4, DISPLAY_W - 2 * pad, card_h, SURFACE_R))
    g.append(_text("ONLINE", x=pad + 16, y=y0 + 18, scale=1, color=LABEL_3))
    g.append(_text("{}/{}".format(cams.get("online") or 0,
                                  cams.get("total") or 0),
                   x=pad + 16, y=y0 + 46, scale=4, color=TEXT))
    src = cams.get("source") or "no source"
    g.append(_text("Source: " + str(src), x=pad + 16, y=y0 + 78,
                   scale=1, color=LABEL_3))

    # Events
    ev_y = y0 + 4 + card_h + 10
    ev_h = DISPLAY_H - ev_y - 14
    g.append(_rect(pad, ev_y, DISPLAY_W - 2 * pad, ev_h, SURFACE_R))
    g.append(_text("RECENT EVENTS", x=pad + 14, y=ev_y + 14,
                   scale=1, color=LABEL_3))
    events = (cams.get("events") or [])[:5]
    if not events:
        msg = "No events yet."
        if cams.get("error"):
            msg = "Frigate unreachable."
        g.append(_text(msg, x=DISPLAY_W // 2, y=ev_y + ev_h // 2,
                       scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
    else:
        row_y = ev_y + 34
        for ev in events:
            cam = str(ev.get("camera") or "camera")[:16]
            label_ = str(ev.get("label") or "motion")[:14]
            score = ev.get("score")
            score_s = "{:.0%}".format(score) if isinstance(score, (int, float)) else ""
            g.append(_text(cam, x=pad + 14, y=row_y, scale=1, color=TEXT))
            g.append(_text(label_, x=pad + 160, y=row_y, scale=1, color=ACCENT))
            if score_s:
                g.append(_text(score_s, x=DISPLAY_W - pad - 14, y=row_y,
                               scale=1, color=LABEL_3, anchor=(1.0, 0.0)))
            row_y += 22
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# QR code (join Droplet Wi-Fi)
# ---------------------------------------------------------------------------

def _render_qr_matrix(g, matrix, ox, oy, module_px):
    """Blit the QR matrix by creating one black-bit bitmap per row.

    Using one TileGrid per row (vs per module) keeps displayio Group
    counts sane; 33 rows is fine, 33*33 individual rects would be too
    many children.
    """
    size = len(matrix)
    # White background behind the QR
    pad = module_px * 2
    g.append(_rect(ox - pad, oy - pad,
                   size * module_px + pad * 2,
                   size * module_px + pad * 2, 0xFFFFFF))
    for row_idx, row in enumerate(matrix):
        # Build a 1-bpp bitmap the width of the QR for this row
        bmp = displayio.Bitmap(size * module_px, module_px, 2)
        pal = displayio.Palette(2)
        pal[0] = 0xFFFFFF
        pal[1] = 0x000000
        for col_idx, v in enumerate(row):
            if v:
                for dx in range(module_px):
                    for dy in range(module_px):
                        bmp[col_idx * module_px + dx, dy] = 1
        tg = displayio.TileGrid(bmp, pixel_shader=pal,
                                x=ox, y=oy + row_idx * module_px)
        g.append(tg)


def render_qr():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    y0 = _header(g, "Join Droplet Wi-Fi", show_back=True)

    qr = state.get("qr")
    pad = 16
    if not qr or not qr.get("ok") or not qr.get("matrix"):
        msg = "Waiting for router..."
        if qr and qr.get("error"):
            msg = str(qr["error"])[:50]
        g.append(_text(msg, x=DISPLAY_W // 2, y=DISPLAY_H // 2,
                       scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
        _button(g, (DISPLAY_W - 120) // 2, DISPLAY_H - 60, 120, 40,
                "Retry", region=("qr_retry", _request_qr))
        board.DISPLAY.root_group = g
        return

    matrix = qr["matrix"]
    size = len(matrix)
    # Module size: fit the QR in the available vertical space, max 7
    avail = DISPLAY_H - y0 - 70
    module_px = max(2, min(7, avail // size))
    qr_px = size * module_px
    ox = 20
    oy = y0 + (avail - qr_px) // 2 + 10
    _render_qr_matrix(g, matrix, ox, oy, module_px)

    # Sidebar: SSID + payload + hint
    side_x = ox + qr_px + 28
    side_w = DISPLAY_W - side_x - pad
    g.append(_text("SSID", x=side_x, y=y0 + 14,
                   scale=1, color=LABEL_3))
    g.append(_text(str(qr.get("ssid") or "")[:20],
                   x=side_x, y=y0 + 36, scale=2, color=TEXT))
    sec = qr.get("security") or "open"
    g.append(_text("SECURITY", x=side_x, y=y0 + 72,
                   scale=1, color=LABEL_3))
    g.append(_text(str(sec)[:20], x=side_x, y=y0 + 94,
                   scale=2, color=ACCENT))
    g.append(_text("Scan with your phone's",
                   x=side_x, y=y0 + 136, scale=1, color=LABEL_2))
    g.append(_text("camera to join.",
                   x=side_x, y=y0 + 152, scale=1, color=LABEL_2))

    # Footer: big rescan button
    _button(g, side_x, DISPLAY_H - 54, side_w - 4, 40,
            "Refresh from Router",
            region=("qr_refresh", _request_qr),
            fill=ACCENT_SUBTLE, border=ACCENT, color=ACCENT)
    board.DISPLAY.root_group = g


def _request_qr():
    _send("REQUEST_QR")


# ---------------------------------------------------------------------------
# Logo + Message
# ---------------------------------------------------------------------------

def render_logo():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    size = 140
    mx = (DISPLAY_W - size) // 2
    my = DISPLAY_H // 2 - size // 2 - 30
    g.append(_rect(mx - 28, my - 22, size + 56, size + 44, SURFACE_R))
    g.append(_mark_tg(size, mx, my))
    g.append(_text("Droplet", x=DISPLAY_W // 2, y=my + size + 52,
                   scale=4, color=TEXT, anchor=(0.5, 0.5)))
    g.append(_text("Edge AI Appliance", x=DISPLAY_W // 2, y=my + size + 92,
                   scale=1, color=LABEL_3, anchor=(0.5, 0.5)))
    _region("logo_home", 0, 0, DISPLAY_W, DISPLAY_H,
            lambda: set_screen("home"))
    board.DISPLAY.root_group = g


def render_message():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    title = state.get("msg_title") or "Message"
    y0 = _header(g, title[:24], show_home=True)
    g.append(_rect(16, y0 + 6, DISPLAY_W - 32, DISPLAY_H - y0 - 22,
                   SURFACE_R))
    yy = y0 + 18
    for line in (state.get("msg_lines") or [])[:8]:
        g.append(_text(str(line)[:52], x=28, y=yy, scale=2, color=TEXT))
        yy += 28
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

RENDERERS = {
    "home":    render_home,
    "stats":   render_stats,
    "network": render_network,
    "wifi":    render_wifi,
    "info":    render_info,
    "files":   render_files,
    "cameras": render_cameras,
    "drives":  render_drives,
    "qr":      render_qr,
    "logo":    render_logo,
    "message": render_message,
}


def _render_with_gc(screen_name):
    """Render a screen, then reclaim the old scene's memory.

    Renderers finish by assigning a new Group to board.DISPLAY.root_group,
    which atomically swaps what's shown — no blank frame. After the swap,
    the old Group has no references and gc.collect() can reclaim all of
    its bitmaps. This keeps the PyPortal's small heap from accumulating
    stale displayio objects across navs + data pushes.

    If a render throws MemoryError or leaves the heap dangerously low
    (fragmented past repair), we reload the firmware. A fresh VM gets
    back a clean heap in ~1 second; the Jetson's push loop will
    re-populate data immediately afterwards.
    """
    gc.collect()
    try:
        RENDERERS[screen_name]()
    except MemoryError:
        _send("ERR:oom:{}".format(screen_name))
        gc.collect()
        supervisor.reload()
        return
    gc.collect()
    if gc.mem_free() < _HEAP_PANIC_BYTES:
        _send("ERR:heap_panic:{}".format(gc.mem_free()))
        supervisor.reload()


def set_screen(name):
    if name not in RENDERERS:
        return
    state["screen"] = name
    _render_with_gc(name)
    _send("NAV:" + name)
    # Tell the main loop to ignore the next few touch samples — the
    # user's finger is almost certainly still pressed from the tap
    # that triggered this navigation, and the in-flight release event
    # would otherwise get dispatched against fresh regions and
    # misfire a tile it was never supposed to hit.
    global _nav_debounce_until
    _nav_debounce_until = time.monotonic() + 0.35


def set_brightness(v):
    v = max(0, min(255, int(v)))
    state["brightness"] = v
    try:
        board.DISPLAY.brightness = v / 255.0
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Touch
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


SLOP = 8  # px tolerance for finger landing near a region edge


def dispatch_touch(x, y):
    # First pass: exact-match the smallest region containing the tap
    # (so a small button inside a big card wins over the card).
    best = None
    best_area = None
    for r in touch_regions:
        if r["x"] <= x <= r["x"] + r["w"] and r["y"] <= y <= r["y"] + r["h"]:
            area = r["w"] * r["h"]
            if best_area is None or area < best_area:
                best = r
                best_area = area
    # Second pass: slop — catch near-misses on small buttons (common on
    # the Titano's resistive touch near the top/edges).
    if best is None:
        for r in touch_regions:
            if (r["x"] - SLOP <= x <= r["x"] + r["w"] + SLOP and
                    r["y"] - SLOP <= y <= r["y"] + r["h"] + SLOP):
                area = r["w"] * r["h"]
                if best_area is None or area < best_area:
                    best = r
                    best_area = area
    if best is not None:
        _send("TAP:{}:{}".format(state["screen"], best["name"]))
        try:
            best["action"]()
        except Exception as exc:                              # noqa: BLE001
            _send("ERR:tap:{}".format(exc))
        return True
    return False


# ---------------------------------------------------------------------------
# Serial protocol
# ---------------------------------------------------------------------------

def _send(line):
    if serial is None:
        return
    if isinstance(line, str):
        line = line.encode("utf-8")
    try:
        serial.write(line + b"\n")
    except Exception:
        pass


def handle(msg):
    mode = msg.get("mode", "")
    data = msg.get("data") or {}
    # A bare-mode message (no data) = navigation.
    if mode in RENDERERS and not data:
        set_screen(mode)
        return "OK"
    if mode == "stats":
        for k in ("cpu", "mem", "disk", "temp", "ip", "uptime", "hostname", "now"):
            if k in data and data[k] is not None:
                state[k] = data[k]
        if state["screen"] in ("home", "stats", "network", "info"):
            _render_with_gc(state["screen"])
    elif mode == "wifi":
        state["wifi"] = data
        state["wifi_status"] = ""
        if state["screen"] in ("home", "wifi", "network"):
            _render_with_gc(state["screen"])
    elif mode == "files":
        state["files"] = data
        if state["screen"] in ("home", "files"):
            _render_with_gc(state["screen"])
    elif mode == "cameras":
        state["cameras"] = data
        if state["screen"] in ("home", "cameras"):
            _render_with_gc(state["screen"])
    elif mode == "drives":
        state["drives"] = data
        if state["screen"] in ("home", "drives"):
            _render_with_gc(state["screen"])
    elif mode == "qr":
        state["qr"] = data
        if state["screen"] == "qr":
            _render_with_gc("qr")
    elif mode == "message":
        state["msg_title"] = data.get("title", "")
        state["msg_lines"] = data.get("lines", []) or []
        set_screen("message")
    elif mode == "brightness":
        set_brightness(msg.get("value", 255))
    elif mode == "ping":
        pass
    else:
        return "ERR:unknown_mode:{}".format(mode)
    return "OK"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    set_screen("home")
    _send("READY")
    buf = b""
    last_touch = None
    release_pending = None

    while True:
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
                except Exception as exc:                      # noqa: BLE001
                    resp = "ERR:{}".format(exc)
                _send(resp)

        if touch is not None:
            p = None
            try:
                p = touch.touch_point
            except Exception:
                p = None

            # If we just navigated, ignore any touches while the user's
            # finger is still down from the tap that caused the nav.
            # Only start accepting new input once the finger has lifted
            # AND the debounce window has expired.
            in_debounce = time.monotonic() < _nav_debounce_until
            if in_debounce:
                # Drop any pending state so the first real tap after
                # the window is clean.
                release_pending = None
                last_touch = p  # track presence so we notice the release
                time.sleep(0.03)
                continue

            if p is not None:
                if last_touch is None:
                    _send("TOUCH:{},{},{}".format(p[0], p[1], p[2]))
                release_pending = (p[0], p[1])
                last_touch = p
            elif p is None and last_touch is not None:
                _send("TOUCH:release")
                if release_pending is not None:
                    rx, ry = release_pending
                    dispatch_touch(rx, ry)
                release_pending = None
                last_touch = None

        time.sleep(0.03)


if __name__ == "__main__":
    main()
