"""
code.py — Droplet PyPortal Titano firmware (swipe dashboard)
=============================================================
Three-screen swipe carousel: Stats ← Idle → QR.

  idle   Editorial-numeric clock — small brand mark + DROPLET eyebrow
         top-left, "on-prem AI" tagline top-right, hero HH:MM at the
         center, all-caps date bottom-left, SSID bottom-right in accent.
         Default screensaver after 30 s of no touch. Any tap wakes →
         Stats.
  stats  Sparkline-hero overview — "CPU LOAD" eyebrow + big CPU number
         top-left, clock + alert bubble (or "OK" dot) top-right,
         full-width CPU sparkline, hairline separator, then 4 tabular
         columns (MEM / DISK / TEMP / CAMERAS), and a hostname·IP +
         all-good/N-alerts bottom strip. Red "!" bubble opens the
         alerts drawer.
  qr     Pair-Wi-Fi screen — PAIR eyebrow + "Join Wi-Fi" h1 top-left,
         NETWORK + SSID + PASSWORD + plaintext password on the left,
         optional key-TTL chip, "Rotate password" pill, 200x200 QR
         card on the right with a Droplet mark inset at the center.

Navigation
----------
  swipe left   next screen in carousel (stats → qr → [edge])
  swipe right  previous screen
  tap          activates whatever region the finger landed on; on
               the idle screen any tap = wake to stats
  30 s idle    auto-drop back to idle

Host → PyPortal (one JSON per line, unchanged for back-compat)
  {"mode":"idle"|"stats"|"qr"|"logo"|"home"}    # logo/home map to idle/stats
  {"mode":"stats",  "data":{cpu,mem,disk,temp,ip,hostname,uptime,now}}
  {"mode":"wifi",   "data":{networks, connected_to, adapter, state, ssid,
                             clients, channel, band, key_ttl_seconds,
                             password}}
  {"mode":"cameras","data":{online, total, events:[...], source, error}}
  {"mode":"drives", "data":{drives:[...], count}}
  {"mode":"files",  "data":{count, size_bytes, recent:[...]}}
  {"mode":"qr",     "data":{matrix, ssid, security, payload, version, ok,
                             key, ttl_seconds, rotation_enabled, error}}
  {"mode":"alert",  "data":{type:"cam"|"sys", title, detail, time}}
  {"mode":"message","data":{title, lines:[...]}}
  {"mode":"brightness","value":0..255}
  {"mode":"ping"}

PyPortal → Host
  READY / OK / ERR:<reason>
  TOUCH:<x>,<y>,<p> / TOUCH:release
  TAP:<screen>:<region>
  SWIPE:<left|right>:<from-screen>
  NAV:<screen>
  ROTATE_KEY
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

try:
    import adafruit_touchscreen
except ImportError:
    adafruit_touchscreen = None


_HEAP_PANIC_BYTES = 18 * 1024
_PALETTES = {}


def _palette(color):
    p = _PALETTES.get(color)
    if p is None:
        p = displayio.Palette(1)
        p[0] = color
        _PALETTES[color] = p
    return p


# ---------------------------------------------------------------------------
# Design tokens — preview.html `T` object (modernized dark/indigo palette).
# Keep names stable; ACCENT_PRI aliases ACCENT so the brand mark stays the
# new indigo without touching _mark_poly.
# ---------------------------------------------------------------------------
BG          = 0x050507
PANEL       = 0x0D0D12
SURFACE     = 0x141420
SURFACE_2   = 0x1D1D2E
SEPARATOR   = 0x2A2A38
SEPARATOR_2 = 0x3A3A4A
TEXT        = 0xFFFFFF
LABEL_2     = 0xC8C8D4
LABEL_3     = 0x8B8B9C
LABEL_4     = 0x545466
ACCENT      = 0x818CF8
ACCENT_INK  = 0xB4BAFF
ACCENT_DIM  = 0x5B62C7
TRACK       = 0x1F1F30
GREEN       = 0x30D158
ORANGE      = 0xFF9F0A
RED         = 0xFF453A
WHITE       = 0xFFFFFF

# Back-compat aliases — the mark renderers reference these.
ACCENT_PRI   = ACCENT
ACCENT_LIGHT = ACCENT_INK

DISPLAY_W = board.DISPLAY.width
DISPLAY_H = board.DISPLAY.height

serial = usb_cdc.data


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

def _rect(x, y, w, h, color):
    if w <= 0 or h <= 0:
        return displayio.Group()
    return vectorio.Rectangle(
        pixel_shader=_palette(color),
        width=max(1, int(w)), height=max(1, int(h)),
        x=int(x), y=int(y),
    )


def _stroked_rect(x, y, w, h, color, sw=1):
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


def _circle(cx, cy, r, color):
    return vectorio.Circle(
        pixel_shader=_palette(color),
        radius=max(1, int(r)),
        x=int(cx), y=int(cy),
    )


def _rounded_rect(g, x, y, w, h, r, color):
    """Filled rounded rect via a cross of two rects + 4 corner circles."""
    r = max(0, min(r, min(w, h) // 2))
    g.append(_rect(x, y + r, w, h - 2 * r, color))
    g.append(_rect(x + r, y, w - 2 * r, h, color))
    g.append(_circle(x + r, y + r, r, color))
    g.append(_circle(x + w - r, y + r, r, color))
    g.append(_circle(x + r, y + h - r, r, color))
    g.append(_circle(x + w - r, y + h - r, r, color))


def _stroked_rounded_rect(g, x, y, w, h, r, color, sw=1):
    """1-px outline of a rounded rect — four straight edges + 4 corner
    rings (drawn as a slightly-larger filled circle then a same-color BG
    circle on top). For sw=1 we just draw the four edges as 1-px rects
    and accept that the corners are square; the inset is invisible at
    this resolution against the panel background."""
    r = max(0, min(r, min(w, h) // 2))
    # Top + bottom edges (skip the corner arcs)
    g.append(_rect(x + r, y, w - 2 * r, sw, color))
    g.append(_rect(x + r, y + h - sw, w - 2 * r, sw, color))
    # Left + right edges
    g.append(_rect(x, y + r, sw, h - 2 * r, color))
    g.append(_rect(x + w - sw, y + r, sw, h - 2 * r, color))


# ---------------------------------------------------------------------------
# Droplet mark (scanline-filled polygon, geometry from DropletMark.tsx)
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
            xmin = xmax = None
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


# Pre-rasterised sizes used across screens. 20 px = idle/stats eyebrow,
# 30 px = QR center inset, 26 px = legacy compatibility (no longer used
# in the new layout but cheap to keep).
_MARK_TINY  = _make_mark_bmp(20)
_MARK_SMALL = _make_mark_bmp(26)
_MARK_QR    = _make_mark_bmp(30)


def _mark_tg(size, x, y):
    if size <= 22:
        bmp, pal = _MARK_TINY
    elif size <= 28:
        bmp, pal = _MARK_SMALL
    else:
        bmp, pal = _MARK_QR
    return displayio.TileGrid(bmp, pixel_shader=pal, x=int(x), y=int(y))


def _mark_poly(g, size, x, y):
    """Vector mark for arbitrary sizes — geometry mirrors _make_mark_bmp."""
    w = int(size * 52 / 60)
    h = size

    def sx(px):
        return x + int(px / 52 * w)

    def sy(py):
        return y + int(py / 60 * h)

    outer = [(sx(26), sy(0)), (sx(44), sy(28)), (sx(36), sy(48)),
             (sx(16), sy(48)), (sx(8), sy(28))]
    inner = [(sx(26), sy(0)), (sx(44), sy(28)), (sx(26), sy(36))]
    g.append(vectorio.Polygon(pixel_shader=_palette(ACCENT_PRI),
                              points=outer, x=0, y=0))
    g.append(vectorio.Polygon(pixel_shader=_palette(ACCENT_LIGHT),
                              points=inner, x=0, y=0))


# ---------------------------------------------------------------------------
# Local clock — anchor the host-pushed HH:MM against monotonic time so the
# idle screen can tick seconds between pushes instead of sitting on a stale
# minute until the next stats frame arrives.
# ---------------------------------------------------------------------------
_clock = {"mono": None, "total_sec": 0, "date_str": ""}


def _set_clock(now_str, date_str=None):
    if not now_str or ":" not in now_str:
        return
    try:
        parts = now_str.split(":")
        hh = int(parts[0]); mm = int(parts[1])
        ss = int(parts[2]) if len(parts) > 2 else 0
    except (ValueError, IndexError):
        return
    _clock["total_sec"] = (hh * 3600 + mm * 60 + ss) % 86400
    _clock["mono"] = time.monotonic()
    if date_str:
        _clock["date_str"] = date_str


def _local_hhmm():
    if _clock["mono"] is None:
        return state.get("now") or "--:--"
    elapsed = int(time.monotonic() - _clock["mono"])
    t = (_clock["total_sec"] + elapsed) % 86400
    return "{:02d}:{:02d}".format(t // 3600, (t % 3600) // 60)


def _local_ss():
    if _clock["mono"] is None:
        return 0
    elapsed = int(time.monotonic() - _clock["mono"])
    return (_clock["total_sec"] + elapsed) % 60


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

SCREENS = ("stats", "qr")
IDLE_TIMEOUT_S = 30.0
IDLE_BRIGHTNESS = 178                # 0..255 — 70 %
ACTIVE_BRIGHTNESS = 178              # 0..255 — 70 %

state = {
    "screen": "idle",
    "cpu": 0, "mem": 0, "disk": 0, "temp": 0,
    "ip": "-", "uptime": "-", "hostname": "droplet", "now": "--:--",
    "brightness": ACTIVE_BRIGHTNESS,
    "msg_title": "",
    "msg_lines": [],
    "wifi": {
        "networks": [],
        "adapter": None,
        "connected_to": None,
        "state": "unknown",
        "scanned_at": None,
        "ssid": "Droplet-AI",
        "clients": 0,
        "channel": 0,
        "band": "",
        "key_ttl_seconds": 0,
        "password": "",
    },
    "files": {"count": 0, "size_bytes": 0, "recent": []},
    "cameras": {"online": 0, "total": 0, "events": [], "error": None, "source": None},
    "drives": {"drives": [], "count": 0},
    "qr": None,
    "alerts": [],
    "events_open": False,
    "sparks": {"cpu": [], "mem": [], "disk": [], "temp": []},
}

# Sparkline ring buffer length — width of the hero sparkline is 440 px,
# so 48 samples gives ~9 px per point which reads well as a polyline.
_SPARK_LEN = 48

touch_regions = []
_nav_debounce_until = 0.0


def _region(name, x, y, w, h, action):
    touch_regions.append({
        "name": name, "x": int(x), "y": int(y),
        "w": int(w), "h": int(h), "action": action,
    })


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------

def _alert_id(a):
    return "{}|{}|{}".format(
        a.get("camera") or "", a.get("label") or "",
        a.get("start") or a.get("time") or "",
    )


def _sync_alerts_from_cameras():
    """Turn Frigate events into alerts, dedup, mark new ones uncleared."""
    evs = (state.get("cameras") or {}).get("events") or []
    existing_ids = {x.get("_id") for x in state["alerts"]}
    for ev in evs:
        a = {
            "type": "cam",
            "title": "{}: {}".format(ev.get("camera") or "cam",
                                     ev.get("label") or "event"),
            "detail": "confidence {}%".format(
                int((ev.get("score") or 0) * 100)) if ev.get("score") else "",
            "time": "",
            "cleared": False,
            "_id": _alert_id({
                "camera": ev.get("camera"), "label": ev.get("label"),
                "start": ev.get("start"),
            }),
        }
        if a["_id"] not in existing_ids:
            state["alerts"].insert(0, a)
    if len(state["alerts"]) > 20:
        state["alerts"] = state["alerts"][:20]


def _open_alerts_count():
    return sum(1 for a in state["alerts"] if not a.get("cleared"))


def _push_alert(a):
    a.setdefault("type", "sys")
    a.setdefault("cleared", False)
    a.setdefault("time", "")
    a["_id"] = "sys:{}:{}".format(a.get("title"), a.get("time") or time.monotonic())
    state["alerts"].insert(0, a)
    if len(state["alerts"]) > 20:
        state["alerts"] = state["alerts"][:20]


def _clear_all_alerts():
    state["alerts"] = []
    state["events_open"] = False
    _render_with_gc(state["screen"])


def _clear_alert(idx):
    if 0 <= idx < len(state["alerts"]):
        state["alerts"].pop(idx)
    _render_with_gc(state["screen"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Three-letter weekday + month abbreviations — terminalio has no locale
# layer, so we hand-roll uppercase strings to match the preview's
# "MONDAY, MAY 18" all-caps date.
_WEEKDAYS = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")
_WEEKDAYS_LONG = ("MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY",
                  "FRIDAY", "SATURDAY", "SUNDAY")
_MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN",
           "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def _fmt_short_ttl(s):
    try:
        s = int(s)
    except (TypeError, ValueError):
        return "--"
    if s >= 3600:
        return "{}h{:02d}".format(s // 3600, (s % 3600) // 60)
    return "{}:{:02d}".format(s // 60, s % 60)


def _idle_date_str():
    """Prefer host-pushed date (already formatted) — falls back to a stub."""
    ds = _clock.get("date_str") or ""
    if ds:
        return ds.upper()
    return ""


# ---------------------------------------------------------------------------
# Sparkline
# ---------------------------------------------------------------------------

def _sparkline(g, x, y, w, h, series, color, fill_color=None):
    """Approximate a polyline sparkline using a single vectorio Polygon.

    The polygon traces top of the line right-to-left along the data
    points, then closes along the bottom of the band — giving a filled
    silhouette without alpha. A second Polygon traces just the top edge
    as a 2px ribbon for the line itself.
    """
    n = len(series)
    if n < 2:
        return
    lo = min(series)
    hi = max(series)
    span = hi - lo
    if span < 1:
        span = 1

    def px(i):
        return x + int(i * (w - 1) / (n - 1))

    def py(v):
        return y + h - 1 - int((v - lo) * (h - 1) / span)

    # Fill polygon (top edge of the line → bottom-right → bottom-left)
    if fill_color is not None:
        pts = [(px(i), py(series[i])) for i in range(n)]
        pts.append((px(n - 1), y + h - 1))
        pts.append((px(0), y + h - 1))
        try:
            g.append(vectorio.Polygon(pixel_shader=_palette(fill_color),
                                      points=pts, x=0, y=0))
        except Exception:                                       # noqa: BLE001
            # Polygons with co-linear or duplicate points can raise on
            # vectorio — fall back to skipping the fill silently.
            pass

    # Line ribbon — top edge offset down by 2 px to make a 2-px-thick
    # stroke. Same trick as the fill, just thinner.
    pts = [(px(i), py(series[i])) for i in range(n)]
    pts_back = [(px(i), py(series[i]) + 2) for i in range(n - 1, -1, -1)]
    pts.extend(pts_back)
    try:
        g.append(vectorio.Polygon(pixel_shader=_palette(color),
                                  points=pts, x=0, y=0))
    except Exception:                                           # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# Page indicator (replaces the old nav-bar pill row)
# ---------------------------------------------------------------------------

def _page_indicator(g, screen_name):
    """Two 4 px dots centered at the bottom — active = ACCENT, inactive
    = SEPARATOR_2. Purely visual hint that the user can swipe; not a
    tap target."""
    if screen_name not in SCREENS:
        return
    cy = DISPLAY_H - 12
    gap = 14
    cx_left = DISPLAY_W // 2 - gap // 2
    cx_right = DISPLAY_W // 2 + gap // 2
    idx = SCREENS.index(screen_name)
    g.append(_circle(cx_left, cy, 4,
                     ACCENT if idx == 0 else SEPARATOR_2))
    g.append(_circle(cx_right, cy, 4,
                     ACCENT if idx == 1 else SEPARATOR_2))


# ---------------------------------------------------------------------------
# IDLE screen — editorial-numeric clock
# ---------------------------------------------------------------------------

def _idle_refs_clear():
    _idle_refs["clock"] = None


_idle_refs = {"clock": None}


def render_idle():
    """Big clock, brand mark + DROPLET eyebrow top-left, "on-prem AI"
    tagline top-right, all-caps date bottom-left, SSID bottom-right.

    The clock at scale=12 (terminalio bitmap font, ~6x12 native) renders
    at roughly 72 px tall — blocky but legible from across the room.
    True 140-px-tall numerics will land in Phase 2 with a BDF/PCF font;
    this is the documented Phase 1 compromise.
    """
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    # Top-left: 20 px brand mark + DROPLET eyebrow
    g.append(_mark_tg(20, 20, 18))
    # 20 px mark is ~17 px wide; leave 12 px of gap to the eyebrow text.
    g.append(_text("DROPLET", x=50, y=24, scale=1, color=LABEL_3))

    # Top-right: "on-prem AI" tagline, anchored right
    g.append(_text("on-prem AI", x=DISPLAY_W - 20, y=24, scale=1,
                   color=LABEL_4, anchor=(1.0, 0.0)))

    # Hero clock — center y=168. scale=12 on terminalio ~ 72 px tall.
    clock_lbl = _text(_local_hhmm(), x=DISPLAY_W // 2, y=168, scale=12,
                      color=TEXT, anchor=(0.5, 0.5))
    g.append(clock_lbl)
    _idle_refs["clock"] = clock_lbl

    # Bottom-left: all-caps date (e.g. "MONDAY, MAY 18")
    date_str = _idle_date_str()
    if date_str:
        g.append(_text(date_str[:32], x=20, y=DISPLAY_H - 28,
                       scale=1, color=LABEL_3))

    # Bottom-right: SSID in accent
    wifi = state.get("wifi") or {}
    ssid = str(wifi.get("ssid") or wifi.get("connected_to") or "Droplet-AI")
    g.append(_text(ssid[:18], x=DISPLAY_W - 20, y=DISPLAY_H - 28,
                   scale=1, color=ACCENT, anchor=(1.0, 0.0)))

    # Tap anywhere wakes to stats.
    _region("idle_wake", 0, 0, DISPLAY_W, DISPLAY_H,
            lambda: set_screen("stats"))
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# STATS screen — sparkline-hero CPU + tabular columns
# ---------------------------------------------------------------------------

def render_stats():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    # Hero metric — "CPU LOAD" eyebrow + big CPU number
    g.append(_text("CPU LOAD", x=20, y=18, scale=1, color=LABEL_3))
    cpu_val = "{}%".format(int(state.get("cpu") or 0))
    # scale=5 = ~60 px tall, the closest terminalio gets to the 64 px target.
    g.append(_text(cpu_val, x=20, y=64, scale=5, color=TEXT))

    # Top-right: clock + alert bubble (or OK dot)
    open_count = _open_alerts_count()
    if open_count > 0:
        # Red bubble at (W-28, 24), radius 13 — visual.
        bx, by, br = DISPLAY_W - 28, 24, 13
        g.append(_circle(bx, by, br, RED))
        g.append(_text("!", x=bx, y=by, scale=2, color=WHITE,
                       anchor=(0.5, 0.5)))
        if open_count > 1:
            # Small white badge with count
            g.append(_circle(bx + br - 2, by - br + 4, 7, WHITE))
            g.append(_text(str(min(open_count, 99)),
                           x=bx + br - 2, y=by - br + 4,
                           scale=1, color=RED, anchor=(0.5, 0.5)))
        # Hit target is at least 44x44 px centered on the bubble.
        _region("alert_bubble", bx - 22, by - 22, 44, 44,
                _open_alerts_drawer)
    else:
        g.append(_circle(DISPLAY_W - 26, 28, 4, GREEN))
        g.append(_text("OK", x=DISPLAY_W - 36, y=28, scale=1, color=GREEN,
                       anchor=(1.0, 0.5)))

    # Clock just under the bubble/OK strip
    g.append(_text(_local_hhmm(), x=DISPLAY_W - 20, y=50, scale=1,
                   color=LABEL_2, anchor=(1.0, 0.0)))

    # Full-width sparkline — x=20, y=100, w=W-40, h=32
    sx, sy, sw, sh = 20, 100, DISPLAY_W - 40, 32
    g.append(_rect(sx, sy + sh - 1, sw, 1, SEPARATOR))
    series = state.get("sparks", {}).get("cpu") or []
    if len(series) >= 2:
        # ACCENT_SUBTLE-ish fill: approximate the preview's #818cf822 with
        # a flat fill — closest palette match is SURFACE_2.
        _sparkline(g, sx, sy, sw, sh, series, ACCENT,
                   fill_color=SURFACE_2)

    # 1px separator at y=152
    g.append(_rect(20, 152, DISPLAY_W - 40, 1, SEPARATOR))

    # 4 tabular columns (MEM / DISK / TEMP / CAMERAS) at y=170 / y=188
    cams = state.get("cameras") or {}
    cam_online = int(cams.get("online") or 0)
    cam_total = int(cams.get("total") or 0)
    cam_color = LABEL_2
    if cam_total > 0 and cam_online == cam_total:
        cam_color = GREEN
    elif cam_total > 0 and cam_online == 0:
        cam_color = RED
    elif cam_total > 0:
        cam_color = ORANGE
    cols = (
        ("MEM",     "{}%".format(int(state.get("mem") or 0)),  LABEL_2),
        ("DISK",    "{}%".format(int(state.get("disk") or 0)), LABEL_2),
        ("TEMP",    "{}C".format(int(state.get("temp") or 0)), LABEL_2),
        ("CAMERAS", "{}/{}".format(cam_online, cam_total),     cam_color),
    )
    col_w = (DISPLAY_W - 40) // 4
    for i, (lbl, val, col) in enumerate(cols):
        cx = 20 + i * col_w
        g.append(_text(lbl, x=cx, y=170, scale=1, color=LABEL_3))
        # Values at scale=3 (~36 px tall). scale=4 would crowd the row.
        g.append(_text(val, x=cx, y=188, scale=3, color=col))

    # Bottom strip — hostname·IP (left) + all-good/N-alerts (right)
    host = str(state.get("hostname") or "droplet")[:16]
    ip = str(state.get("ip") or "-")[:16]
    g.append(_text("{} . {}".format(host, ip), x=20, y=DISPLAY_H - 26,
                   scale=1, color=LABEL_3))
    if open_count > 0:
        dot_color = RED
        msg = "{} alert{}".format(open_count, "" if open_count == 1 else "s")
    else:
        dot_color = GREEN
        msg = "All good"
    g.append(_circle(DISPLAY_W - 96, DISPLAY_H - 21, 3, dot_color))
    g.append(_text(msg, x=DISPLAY_W - 20, y=DISPLAY_H - 26, scale=1,
                   color=dot_color, anchor=(1.0, 0.0)))

    # Page indicator dots at the very bottom
    _page_indicator(g, "stats")

    # Alerts drawer overlay
    if state.get("events_open"):
        _render_alerts_drawer(g)

    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# QR screen — Pair Wi-Fi
# ---------------------------------------------------------------------------

def _render_qr_matrix(g, matrix, ox, oy, module_px):
    """Render the QR matrix as a single bitmap (much cheaper than
    one TileGrid per row). Modules use indigo-tinted black for brand
    consistency — phone scanners read it identically to pure black.
    """
    size = len(matrix)
    bmp_w = size * module_px
    bmp_h = size * module_px
    bmp = displayio.Bitmap(bmp_w, bmp_h, 2)
    pal = displayio.Palette(2)
    pal[0] = WHITE
    pal[1] = 0x0A0A1E
    for row_idx, row in enumerate(matrix):
        for col_idx, v in enumerate(row):
            if v:
                bx0 = col_idx * module_px
                by0 = row_idx * module_px
                for dy in range(module_px):
                    for dx in range(module_px):
                        bmp[bx0 + dx, by0 + dy] = 1
    g.append(displayio.TileGrid(bmp, pixel_shader=pal,
                                x=int(ox), y=int(oy)))


def render_qr():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    qr = state.get("qr") or {}
    wifi = state.get("wifi") or {}
    ssid = (qr.get("ssid") if qr else None) or wifi.get("ssid") or "Droplet-AI"

    # Cleartext password: prefer wifi.password (new field), fall back to
    # qr.key (existing device-bridge.py field).
    password = wifi.get("password") or qr.get("key") or ""

    rotation_on = bool(qr.get("rotation_enabled"))
    ttl = (qr.get("ttl_seconds") or 0) if rotation_on else 0

    # Eyebrow + h1
    g.append(_text("PAIR", x=20, y=22, scale=1, color=ACCENT))
    g.append(_text("Join Wi-Fi", x=20, y=38, scale=2, color=TEXT))

    # QR card — 200x200, white background w/ 10 px pad → 220x220 outer
    qr_size = 200
    qx = DISPLAY_W - qr_size - 30
    qy = 60
    _rounded_rect(g, qx - 10, qy - 10, qr_size + 20, qr_size + 20, 14, WHITE)

    if qr and qr.get("ok") and qr.get("matrix"):
        matrix = qr["matrix"]
        m_count = len(matrix)
        module_px = max(2, qr_size // max(m_count, 1))
        # Center the rendered matrix inside the 200x200 card area
        rendered = m_count * module_px
        ox = qx + (qr_size - rendered) // 2
        oy = qy + (qr_size - rendered) // 2
        _render_qr_matrix(g, matrix, ox, oy, module_px)

        # Droplet mark inset at QR center. White rounded pad behind it so
        # the mark doesn't clash with the QR modules. Mark is 30 px; pad
        # is 36 px square (gives 3 px of white halo on each side).
        mc = 30
        mx = qx + qr_size // 2 - mc // 2
        my = qy + qr_size // 2 - mc // 2
        _rounded_rect(g, mx - 3, my - 3, mc + 6, mc + 6, 6, WHITE)
        g.append(_mark_tg(mc, mx, my))
    else:
        # Empty / error state — show a "Waiting..." line over the white
        # card so the layout doesn't collapse.
        msg = "Waiting for router..."
        err = qr.get("error") if qr else None
        if err:
            msg = str(err)[:22]
        g.append(_text(msg,
                       x=qx + qr_size // 2, y=qy + qr_size // 2,
                       scale=1, color=LABEL_4, anchor=(0.5, 0.5)))

    # Left column — NETWORK / SSID / PASSWORD / plaintext password
    g.append(_text("NETWORK", x=20, y=92, scale=1, color=LABEL_3))
    g.append(_text(str(ssid)[:14], x=20, y=108, scale=2, color=TEXT))

    g.append(_text("PASSWORD", x=20, y=142, scale=1, color=LABEL_3))
    if password:
        # scale=2 terminalio ~ 12 px per char wide. The QR card eats the
        # right side at x ≈ 240; keep the password column to <= 200 px
        # wide. Scale=2 fits ~16 chars cleanly; longer keys drop to
        # scale=1 to stay on one line.
        max_x = qx - 20
        col_w = max_x - 20
        if len(password) * 12 <= col_w:
            g.append(_text(password, x=20, y=158, scale=2,
                           color=ACCENT_INK))
        else:
            g.append(_text(password[:34], x=20, y=160, scale=1,
                           color=ACCENT_INK))

    # Optional TTL chip — only when rotation is enabled
    if rotation_on:
        ttl_str = "KEY " + _fmt_short_ttl(ttl)
        # Approx chip width: 6 px per char (scale=1 terminalio) + 20 px pad
        chip_w = len(ttl_str) * 6 + 20
        chip_h = 20
        # Orange-tinted background when rotation is imminent (< 60 s)
        soon = ttl > 0 and ttl < 60
        fill = SURFACE if not soon else SURFACE_2
        edge = ORANGE if soon else SEPARATOR
        text_col = ORANGE if soon else LABEL_2
        _rounded_rect(g, 20, 184, chip_w, chip_h, 10, fill)
        _stroked_rounded_rect(g, 20, 184, chip_w, chip_h, 10, edge, 1)
        g.append(_text(ttl_str, x=20 + chip_w // 2, y=194,
                       scale=1, color=text_col, anchor=(0.5, 0.5)))

    # "Rotate password" pill — 200x44, primary tap target
    pill_y = 224
    pill_w = 200
    pill_h = 44
    _rounded_rect(g, 20, pill_y, pill_w, pill_h, 12, SURFACE)
    _stroked_rounded_rect(g, 20, pill_y, pill_w, pill_h, 12,
                          SEPARATOR_2, 1)
    # The ⟳ glyph isn't in terminalio's bitmap font — use a plain "R" prefix.
    g.append(_text("Rotate password", x=20 + pill_w // 2, y=pill_y + pill_h // 2,
                   scale=1, color=LABEL_2, anchor=(0.5, 0.5)))
    _region("qr_rotate", 20, pill_y, pill_w, pill_h, _rotate_key)

    # Page indicator
    _page_indicator(g, "qr")

    board.DISPLAY.root_group = g


def _request_qr():
    _send("REQUEST_QR")


def _rotate_key():
    _send("ROTATE_KEY")
    state["wifi"]["key_ttl_seconds"] = 60 * 60
    if state.get("qr"):
        state["qr"]["ttl_seconds"] = 60 * 60
    _render_with_gc("qr")


# ---------------------------------------------------------------------------
# Alerts drawer (overlay on stats) — restyle to new palette
# ---------------------------------------------------------------------------

def _render_alerts_drawer(g):
    # Dimmed backdrop — solid panel-darker rectangle over the area NOT
    # occupied by the drawer. vectorio has no alpha so we approximate
    # the preview's rgba(0,0,0,0.55) with a near-black fill on the left
    # ~180 px. Reads as "this area is suppressed" while the drawer is up.
    dw = 300
    dx = DISPLAY_W - dw
    g.append(_rect(0, 0, dx, DISPLAY_H, 0x000000))

    # Drawer body
    g.append(_rect(dx, 0, dw, DISPLAY_H, PANEL))
    g.append(_rect(dx, 0, 1, DISPLAY_H, SEPARATOR))

    # Header row — ALERTS label, "N open" count, close ✕
    g.append(_text("ALERTS", x=dx + 14, y=16, scale=1, color=LABEL_2))
    n = _open_alerts_count()
    g.append(_text("{} open".format(n), x=dx + dw - 50, y=16,
                   scale=1, color=LABEL_3, anchor=(1.0, 0.0)))
    g.append(_text("x", x=dx + dw - 16, y=16, scale=2, color=LABEL_2,
                   anchor=(1.0, 0.0)))
    # Close hit target: 44x44 px centered around the visual ×.
    _region("drawer_close", dx + dw - 44, 0, 44, 44, _close_alerts_drawer)

    alerts = state.get("alerts") or []
    visible = alerts[:4]
    row_h = 58
    list_y = 44

    if not visible:
        g.append(_text("No alerts.", x=dx + dw // 2, y=DISPLAY_H // 2,
                       scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
    else:
        for i, a in enumerate(visible):
            ry = list_y + i * row_h
            cleared = a.get("cleared")
            # Row card
            row_fill = SURFACE if cleared else SURFACE_2
            _rounded_rect(g, dx + 10, ry, dw - 20, row_h - 6, 8, row_fill)
            _stroked_rounded_rect(g, dx + 10, ry, dw - 20, row_h - 6, 8,
                                  SEPARATOR, 1)
            # Status dot at the left (preview uses the dot in place of an icon char)
            dot_color = LABEL_3 if cleared else (
                RED if a.get("type") == "cam" else ORANGE)
            g.append(_circle(dx + 24, ry + 24, 5, dot_color))
            # Title / detail / time stacked
            title = str(a.get("title") or "")[:24]
            detail = str(a.get("detail") or "")[:28]
            tm = str(a.get("time") or "")[:14]
            g.append(_text(title, x=dx + 40, y=ry + 10, scale=1,
                           color=LABEL_3 if cleared else TEXT))
            g.append(_text(detail, x=dx + 40, y=ry + 26, scale=1,
                           color=LABEL_3))
            if tm:
                g.append(_text(tm, x=dx + 40, y=ry + 40, scale=1,
                               color=LABEL_4))
            if not cleared:
                # Per-row clear × — visual at right, hit target 44 px wide.
                g.append(_text("x", x=dx + dw - 22, y=ry + 26,
                               scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
                _region("drawer_clear_{}".format(i),
                        dx + dw - 50, ry, 44, row_h - 6,
                        (lambda ii=i: _clear_alert(ii)))

    # Clear-all button — 44 px tall to meet the tap-target minimum.
    bh = 44
    by = DISPLAY_H - bh - 12
    _rounded_rect(g, dx + 14, by, dw - 28, bh, 12, SURFACE_2)
    _stroked_rounded_rect(g, dx + 14, by, dw - 28, bh, 12, SEPARATOR_2, 1)
    g.append(_text("Clear all", x=dx + dw // 2, y=by + bh // 2,
                   scale=1, color=LABEL_2, anchor=(0.5, 0.5)))
    _region("drawer_clear_all", dx + 14, by, dw - 28, bh,
            _clear_all_alerts)


def _open_alerts_drawer():
    state["events_open"] = True
    _render_with_gc("stats")


def _close_alerts_drawer():
    state["events_open"] = False
    _render_with_gc("stats")


# ---------------------------------------------------------------------------
# Message (host-pushed notification — still supported)
# ---------------------------------------------------------------------------

def render_message():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    title = state.get("msg_title") or "Message"
    g.append(_text(str(title)[:28], x=20, y=22, scale=2, color=TEXT))
    g.append(_rect(20, 56, DISPLAY_W - 40, 1, SEPARATOR))
    yy = 72
    for line in (state.get("msg_lines") or [])[:8]:
        g.append(_text(str(line)[:52], x=20, y=yy, scale=1, color=LABEL_2))
        yy += 16
    _region("message_home", 0, 0, DISPLAY_W, DISPLAY_H,
            lambda: set_screen("stats"))
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

RENDERERS = {
    "stats":   render_stats,
    "idle":    render_idle,
    "qr":      render_qr,
    "message": render_message,
}

_ALIASES = {
    "home": "stats", "logo": "idle",
    "network": "stats", "info": "stats",
    "files": "stats", "cameras": "stats", "drives": "stats", "wifi": "stats",
}


def _render_with_gc(screen_name):
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
    name = _ALIASES.get(name, name)
    if name not in RENDERERS:
        return
    state["screen"] = name
    set_brightness(IDLE_BRIGHTNESS if name == "idle" else ACTIVE_BRIGHTNESS)
    _render_with_gc(name)
    _send("NAV:" + name)
    if name == "qr":
        _send("REQUEST_QR")
    global _nav_debounce_until
    _nav_debounce_until = time.monotonic() + 0.35


def swipe_screen(direction):
    """direction: +1 = next (swipe left), -1 = previous (swipe right)."""
    if state["screen"] not in SCREENS:
        return
    idx = SCREENS.index(state["screen"])
    nxt = idx + direction
    if nxt < 0 or nxt >= len(SCREENS):
        return
    _send("SWIPE:{}:{}".format("left" if direction > 0 else "right",
                                state["screen"]))
    set_screen(SCREENS[nxt])


def set_brightness(v):
    v = max(0, min(255, int(v)))
    state["brightness"] = v
    try:
        board.DISPLAY.brightness = v / 255.0
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Touch (tap + swipe)
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


SLOP = 8
SWIPE_THRESHOLD_X = 60
SWIPE_MAX_Y = 40


def dispatch_tap(x, y):
    best = None
    best_area = None
    for r in touch_regions:
        if r["x"] <= x <= r["x"] + r["w"] and r["y"] <= y <= r["y"] + r["h"]:
            area = r["w"] * r["h"]
            if best_area is None or area < best_area:
                best = r
                best_area = area
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
    if not data and (mode in RENDERERS or mode in _ALIASES):
        set_screen(mode)
        return "OK"

    if mode == "stats":
        for k in ("cpu", "mem", "disk", "temp", "ip", "uptime", "hostname", "now"):
            if k in data and data[k] is not None:
                state[k] = data[k]
        # Append latest cpu/mem/disk/temp to the sparkline rings.
        sparks = state["sparks"]
        for k in ("cpu", "mem", "disk", "temp"):
            try:
                v = float(state.get(k) or 0)
            except (TypeError, ValueError):
                continue
            sparks[k].append(v)
            if len(sparks[k]) > _SPARK_LEN:
                del sparks[k][0:len(sparks[k]) - _SPARK_LEN]
        if data.get("now"):
            _set_clock(data.get("now"), data.get("date"))
        if state["screen"] == "stats":
            _render_with_gc("stats")
        elif state["screen"] == "idle" and _idle_refs.get("clock") is not None:
            try:
                _idle_refs["clock"].text = _local_hhmm()
            except Exception:
                pass
    elif mode == "wifi":
        for k, v in data.items():
            state["wifi"][k] = v
        if state["screen"] in ("stats", "qr"):
            _render_with_gc(state["screen"])
    elif mode == "files":
        state["files"] = data
        if state["screen"] == "stats":
            _render_with_gc("stats")
    elif mode == "cameras":
        state["cameras"] = data
        _sync_alerts_from_cameras()
        if state["screen"] == "stats":
            _render_with_gc("stats")
    elif mode == "drives":
        state["drives"] = data
        if state["screen"] == "stats":
            _render_with_gc("stats")
    elif mode == "qr":
        state["qr"] = data
        if state["screen"] == "qr":
            _render_with_gc("qr")
    elif mode == "alert":
        _push_alert(data)
        if state["screen"] == "stats":
            _render_with_gc("stats")
    elif mode == "message":
        state["msg_title"] = data.get("title", "")
        state["msg_lines"] = data.get("lines", []) or []
        set_screen("message")
    elif mode == "brightness":
        set_brightness(msg.get("value", ACTIVE_BRIGHTNESS))
    elif mode == "cycle":
        # Carousel "cycle" — host asks us to advance to the next screen
        # in SCREENS, wrapping. Preserved for back-compat with older
        # bridges that drove the demo loop.
        if state["screen"] in SCREENS:
            idx = SCREENS.index(state["screen"])
            set_screen(SCREENS[(idx + 1) % len(SCREENS)])
        else:
            set_screen(SCREENS[0])
    elif mode == "ping":
        pass
    else:
        return "ERR:unknown_mode:{}".format(mode)
    return "OK"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    set_screen("idle")
    _send("READY")
    # Ask the host to (re-)push its full state. Cuts post-reboot resync.
    _send("REQUEST_STATE")
    buf = b""
    last_touch = None
    press_start = None
    last_activity = time.monotonic()
    last_idle_tick = 0.0
    last_idle_hhmm = ""

    while True:
        # Idle clock tick — only runs while idle is up; writes the label
        # only when the minute changes.
        now_mono = time.monotonic()
        if (state["screen"] == "idle"
                and _idle_refs.get("clock") is not None
                and now_mono - last_idle_tick >= 1.0):
            last_idle_tick = now_mono
            try:
                cur = _local_hhmm()
                if cur != last_idle_hhmm:
                    _idle_refs["clock"].text = cur
                    last_idle_hhmm = cur
            except Exception:
                pass

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

            in_debounce = time.monotonic() < _nav_debounce_until
            if in_debounce:
                press_start = None
                last_touch = p
                time.sleep(0.03)
                continue

            if p is not None:
                if last_touch is None:
                    press_start = (p[0], p[1])
                    _send("TOUCH:{},{},{}".format(p[0], p[1], p[2]))
                last_touch = p
                last_activity = time.monotonic()
            elif p is None and last_touch is not None:
                _send("TOUCH:release")
                if press_start is not None:
                    rx, ry = last_touch[0], last_touch[1]
                    sx, sy = press_start
                    dx = rx - sx
                    dy = ry - sy
                    if (abs(dx) >= SWIPE_THRESHOLD_X and
                            abs(dy) <= SWIPE_MAX_Y and
                            state["screen"] in SCREENS):
                        swipe_screen(1 if dx < 0 else -1)
                    else:
                        dispatch_tap(sx, sy)
                press_start = None
                last_touch = None
                last_activity = time.monotonic()

        if (state["screen"] != "idle" and
                (time.monotonic() - last_activity) >= IDLE_TIMEOUT_S):
            state["events_open"] = False
            set_screen("idle")

        time.sleep(0.03)


if __name__ == "__main__":
    main()
