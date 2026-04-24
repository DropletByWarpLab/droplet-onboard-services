"""
code.py — Droplet PyPortal Titano firmware (swipe dashboard)
=============================================================
Three-screen swipe carousel: Stats ← Idle (logo) → QR.

  idle   Full-screen Droplet mark, dimmed. Default screensaver after
         30 s of no touch. Any tap wakes → Stats.
  stats  Ubiquiti-style overview (CPU / MEM / DISK / TEMP dials,
         rolled-up Network / Storage / Cameras / Wi-Fi cards).
         Red "!" bubble in the top-right if there are open alerts
         (Frigate parameter hits or system errors) — tap opens the
         alerts drawer with per-row clear + Clear-all.
  qr     "Join Droplet-AI" QR with a rotation TTL chip + "Rotate
         now" button that kicks a ROTATE_KEY serial line back at
         the host (device-bridge handles the actual UCI change).

Navigation
----------
  swipe left   next screen in carousel (stats → idle → qr → [edge])
  swipe right  previous screen
  tap          activates whatever region the finger landed on; on
               the idle screen any tap = wake to stats
  30 s idle    auto-drop back to idle + dim brightness to ~38 %

Host → PyPortal (one JSON per line, unchanged for back-compat)
  {"mode":"idle"|"stats"|"qr"|"logo"|"home"}    # logo/home map to idle/stats
  {"mode":"stats",  "data":{cpu,mem,disk,temp,ip,hostname,uptime,now}}
  {"mode":"wifi",   "data":{networks, connected_to, adapter, state, ssid,
                             clients, channel, band, key_ttl_seconds}}
  {"mode":"cameras","data":{online, total, events:[...], source, error}}
  {"mode":"drives", "data":{drives:[...], count}}
  {"mode":"files",  "data":{count, size_bytes, recent:[...]}}
  {"mode":"qr",     "data":{matrix, ssid, security, payload, version, ok,
                             ttl_seconds}}
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
import math
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
# Design tokens (mirror web-dashboard dark mode + preview.html)
# Deeper near-black background + indigo-tinted surfaces + punchier accents
# for a modern OLED-style look that matches the web dashboard.
# ---------------------------------------------------------------------------
BG            = 0x050507
PANEL         = 0x0D0D12
SURFACE       = 0x141420
SURFACE_2     = 0x1D1D2E
SEPARATOR     = 0x2A2A38
SEPARATOR_2   = 0x3A3A4A
TEXT          = 0xFFFFFF
LABEL_2       = 0xC8C8D4
LABEL_3       = 0x8B8B9C
LABEL_4       = 0x545466
ACCENT        = 0x8B93FF
ACCENT_PRI    = 0x7C7FFF
ACCENT_LIGHT  = 0xB4BAFF
ACCENT_SUBTLE = 0x1E1E3E
GAUGE_TRACK   = 0x24243A
GREEN         = 0x3DFF9F
ORANGE        = 0xFFB347
RED           = 0xFF5C7A
WHITE         = 0xFFFFFF

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


# vectorio has no arc primitive, so half-donuts are drawn as a 2*N-vertex
# Polygon (outer sweep + inner sweep back). Circle end-caps round the tips
# for the "rounded half donut" look requested — cheap heap-wise because
# vectorio stores just the vertex list, not a rasterised bitmap.
def _half_donut(g, cx, cy, r_outer, thickness, pct, fill_color,
                track_color=GAUGE_TRACK, segments=28):
    """Draw a 180° half-donut gauge, flat edge facing down.

    Args:
        cx, cy: center of the flat edge (the donut curves *up* from here)
        r_outer: outer radius
        thickness: band thickness; inner radius = r_outer - thickness
        pct: 0..100 fill percentage (fills left-to-right along the arc)
        fill_color, track_color: palette entries
        segments: polygon tessellation — 28 reads smooth at r=40
    """
    r_inner = max(2, r_outer - thickness)
    pct = max(0.0, min(100.0, float(pct)))

    def arc_ring(start_frac, end_frac):
        # Build a polygon ring between start_frac..end_frac of the 180° sweep.
        # 0 = left (angle pi), 1 = right (angle 0).
        pts = []
        n = max(2, int(segments * abs(end_frac - start_frac) + 0.5))
        # Outer: start -> end
        for i in range(n + 1):
            frac = start_frac + (end_frac - start_frac) * (i / n)
            a = math.pi * (1.0 - frac)
            pts.append((int(cx + r_outer * math.cos(a)),
                        int(cy - r_outer * math.sin(a))))
        # Inner: end -> start (reverse)
        for i in range(n + 1):
            frac = end_frac - (end_frac - start_frac) * (i / n)
            a = math.pi * (1.0 - frac)
            pts.append((int(cx + r_inner * math.cos(a)),
                        int(cy - r_inner * math.sin(a))))
        return pts

    # Track (full 180°)
    g.append(vectorio.Polygon(
        pixel_shader=_palette(track_color),
        points=arc_ring(0.0, 1.0),
        x=0, y=0,
    ))
    # Rounded caps on the track ends
    cap_r = thickness // 2
    g.append(_circle(cx - (r_outer + r_inner) // 2, cy, cap_r, track_color))
    g.append(_circle(cx + (r_outer + r_inner) // 2, cy, cap_r, track_color))

    if pct <= 0.5:
        return

    # Fill (0..pct of 180°)
    end_frac = pct / 100.0
    g.append(vectorio.Polygon(
        pixel_shader=_palette(fill_color),
        points=arc_ring(0.0, end_frac),
        x=0, y=0,
    ))
    # Rounded caps on fill: left start + head of the fill arc
    g.append(_circle(cx - (r_outer + r_inner) // 2, cy, cap_r, fill_color))
    ang = math.pi * (1.0 - end_frac)
    head_r = (r_outer + r_inner) // 2
    g.append(_circle(int(cx + head_r * math.cos(ang)),
                     int(cy - head_r * math.sin(ang)),
                     cap_r, fill_color))


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


_MARK_SMALL = _make_mark_bmp(26)
_MARK_MED   = _make_mark_bmp(52)
_MARK_LARGE = _make_mark_bmp(160)


def _mark_tg(size, x, y):
    if size >= 140:
        bmp, pal = _MARK_LARGE
    elif size >= 48:
        bmp, pal = _MARK_MED
    else:
        bmp, pal = _MARK_SMALL
    return displayio.TileGrid(bmp, pixel_shader=pal, x=x, y=y)


# ---------------------------------------------------------------------------
# Local clock — anchor the host-pushed HH:MM against monotonic time so the
# idle screen can tick seconds between pushes instead of sitting on a stale
# minute until the next stats frame arrives. The host typically pushes every
# few seconds, but each push resets the anchor so drift stays bounded.
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

# Carousel order while the device is awake — logo idle is NOT part of this
# list. Tapping / swiping out of idle drops straight to the first active
# screen (stats); from there left-swipe → qr, right-swipe → stats.
SCREENS = ("stats", "qr")
IDLE_TIMEOUT_S = 30.0
# Brightness holds steady at 70 % whether the logo screensaver is up or a
# live screen is — the panel is already pretty dim at 70 %, dropping it
# further made the logo invisible in a normally-lit room.
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
    },
    "files": {"count": 0, "size_bytes": 0, "recent": []},
    "cameras": {"online": 0, "total": 0, "events": [], "error": None, "source": None},
    "drives": {"drives": [], "count": 0},
    "qr": None,   # {matrix, ssid, security, payload, version, ok, ttl_seconds}
    "alerts": [],  # [{type, title, detail, time, cleared}]
    "events_open": False,
    # Rolling sparkline history for the gauges. Each list is a ring buffer
    # capped at _SPARK_LEN; _record_sparks appends on every stats push.
    "sparks": {"cpu": [], "mem": [], "disk": [], "temp": []},
}

_SPARK_LEN = 24  # ~3 min of history at the host's 8s stats cadence

touch_regions = []
_nav_debounce_until = 0.0


def _region(name, x, y, w, h, action):
    touch_regions.append({
        "name": name, "x": x, "y": y, "w": w, "h": h, "action": action,
    })


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------

def _alert_id(a):
    # Dedup key — use camera+label+start from Frigate events so the same
    # event isn't added twice on polling.
    return "{}|{}|{}".format(
        a.get("camera") or "", a.get("label") or "", a.get("start") or a.get("time") or ""
    )


def _sync_alerts_from_cameras():
    """Turn Frigate events into alerts, dedup, mark new ones uncleared."""
    evs = (state.get("cameras") or {}).get("events") or []
    existing_ids = {x.get("_id") for x in state["alerts"]}
    for ev in evs:
        a = {
            "type": "cam",
            "title": "{}: {}".format(ev.get("camera") or "cam", ev.get("label") or "event"),
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
    # Cap at 20 alerts to keep heap bounded
    if len(state["alerts"]) > 20:
        state["alerts"] = state["alerts"][:20]


def _open_alerts_count():
    return sum(1 for a in state["alerts"] if not a.get("cleared"))


def _push_alert(a):
    """Accept a host-pushed system alert (mode:alert)."""
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
# Shared chrome
# ---------------------------------------------------------------------------

def _header(g, title, sub=None, show_bubble=True):
    """Compact 42 px header: mark + title/sub on the left, clock + status/alert on the right."""
    bar_h = 42
    g.append(_rect(0, 0, DISPLAY_W, bar_h, PANEL))
    g.append(_rect(0, bar_h, DISPLAY_W, 1, SEPARATOR))
    g.append(_mark_tg(26, 12, 8))
    g.append(_text(title[:22], x=44, y=12, scale=2, color=TEXT))
    if sub:
        g.append(_text(str(sub)[:40], x=44, y=28, scale=1, color=LABEL_3))

    clock = _local_hhmm()
    g.append(_text(clock, x=DISPLAY_W - 52, y=21, scale=2, color=LABEL_2,
                   anchor=(1.0, 0.5)))

    if show_bubble:
        n = _open_alerts_count()
        if n > 0:
            cx, cy, r = DISPLAY_W - 22, 21, 11
            g.append(_circle(cx, cy, r, RED))
            g.append(_text("!", x=cx, y=cy, scale=2, color=WHITE,
                           anchor=(0.5, 0.5)))
            if n > 1:
                g.append(_circle(cx + r - 2, cy - r + 2, 7, WHITE))
                g.append(_text(str(n)[:2], x=cx + r - 2, y=cy - r + 2,
                               scale=1, color=RED, anchor=(0.5, 0.5)))
            _region("alert_bubble", cx - r - 6, cy - r - 6,
                    (r + 6) * 2, (r + 6) * 2, _open_alerts_drawer)
        else:
            # All clear — small green dot + "OK"
            g.append(_circle(DISPLAY_W - 34, 21, 3, GREEN))
            g.append(_text("OK", x=DISPLAY_W - 24, y=21, scale=1,
                           color=GREEN, anchor=(0.0, 0.5)))

    return bar_h + 4


def _card(g, x, y, w, h):
    g.append(_rect(x, y, w, h, SURFACE))
    g.append(_stroked_rect(x, y, w, h, SEPARATOR, 1))


def _status_dot(g, x, y, color):
    g.append(_rect(x - 3, y - 3, 6, 6, color))


# Labels + icons for the bottom nav — keep order in sync with SCREENS.
_NAV_LABELS = {
    "stats": "System",
    "qr":    "Join Wi-Fi",
}


def _nav_bar(g):
    """Bottom nav — big rounded pills, one per active screen, current one
    highlighted. Comfortable finger targets (~50 px tall) and soft round
    endcaps so it reads modern instead of dated."""
    h = 44
    y = DISPLAY_H - h
    # No hard separator — the pills float on BG for a cleaner look.
    g.append(_rect(0, y, DISPLAY_W, h, BG))

    pills = len(SCREENS)
    pad = 14
    gap = 12
    pw = (DISPLAY_W - pad * 2 - gap * (pills - 1)) // pills
    ph = h - 16  # pill height (~28)
    pr = ph // 2  # end-cap radius

    current = state.get("screen")
    for i, name in enumerate(SCREENS):
        px = pad + i * (pw + gap)
        py = y + (h - ph) // 2
        is_cur = (name == current)
        fill = ACCENT_SUBTLE if is_cur else SURFACE
        color = ACCENT_LIGHT if is_cur else LABEL_2
        # Rounded pill: center rect + two circles for the endcaps.
        g.append(_rect(px, py, pw, ph, fill))
        g.append(_circle(px, py + ph // 2, pr, fill))
        g.append(_circle(px + pw, py + ph // 2, pr, fill))
        if is_cur:
            # Soft indigo halo dot below the active pill (the "you are here"
            # indicator — takes the place of an underline on sharp-corner
            # designs).
            g.append(_circle(px + pw // 2, py + ph + 4, 2, ACCENT))
        g.append(_text(_NAV_LABELS.get(name, name.upper()),
                       x=px + pw // 2, y=py + ph // 2,
                       scale=2, color=color, anchor=(0.5, 0.5)))
        # Tappable target extends to the pill caps.
        _region("nav_{}".format(name), px - pr, py, pw + pr * 2, ph,
                (lambda n=name: set_screen(n)))


# ---------------------------------------------------------------------------
# Stats (overview)
# ---------------------------------------------------------------------------

def _sparkline(g, x, y, w, h, series, color, baseline=None):
    """Tiny bar-chart sparkline — one thin vertical rect per datapoint.

    vectorio has no line primitive, so we fake a sparkline with narrow
    rectangles. Reads as a dense bar chart at this resolution and keeps
    heap bounded (one rect per point, no polygon). Points are drawn from
    right → left so the newest value sits on the right edge.
    """
    if not series:
        return
    n = len(series)
    lo = min(series)
    hi = max(series)
    span = max(1, hi - lo)
    # Reserve a 1px base strip so a flat series still reads
    base = baseline if baseline is not None else SEPARATOR
    g.append(_rect(x, y + h - 1, w, 1, base))
    bar_w = max(1, w // max(n, 1))
    for i, v in enumerate(series[-n:]):
        bh = max(1, int((v - lo) / span * (h - 1)))
        bx = x + i * bar_w
        by = y + h - bh
        g.append(_rect(bx, by, max(1, bar_w - 1), bh, color))


def _dial(g, cx, cy, w, h, lbl, value_str, pct, warn=80, crit=95, spark_key=None):
    """Half-donut gauge: rounded 180° arc with track + colored fill, value
    text inside the arc, label underneath, and an optional sparkline band
    below showing recent history.

    Reads sleeker than a flat bar at normal viewing distance and matches
    the modern dashboard aesthetic the user asked for.
    """
    color = ACCENT if pct < warn else (ORANGE if pct < crit else RED)
    r_outer = min(w // 2 - 6, 40)
    thickness = max(8, r_outer // 4)
    # The donut is anchored so its flat edge sits just below the value
    # text; bump the center down slightly so the arc visually frames
    # rather than floats above the number.
    arc_cy = cy + 12
    _half_donut(g, cx, arc_cy, r_outer, thickness, pct, color)
    # Big value centered inside the arc
    g.append(_text(value_str, x=cx, y=arc_cy - r_outer // 2 + 4, scale=2,
                   color=TEXT, anchor=(0.5, 0.5)))
    # Sparkline band under the arc (if a history series is available),
    # then the label sits just under the sparkline.
    spark_drawn = False
    if spark_key:
        series = state.get("sparks", {}).get(spark_key) or []
        if len(series) >= 2:
            spark_w = min(70, r_outer * 2 - 4)
            _sparkline(g, cx - spark_w // 2, arc_cy + 3, spark_w, 8,
                       series, color)
            spark_drawn = True
    label_y = arc_cy + (18 if spark_drawn else 10)
    g.append(_text(lbl, x=cx, y=label_y, scale=1, color=LABEL_3,
                   anchor=(0.5, 0.5)))


def _network_card(g, x, y, w, h):
    _card(g, x, y, w, h)
    g.append(_text("NETWORK", x=x + 12, y=y + 12, scale=1, color=LABEL_3))
    wifi = state.get("wifi") or {}
    up = bool(wifi.get("connected_to")) or (state.get("ip") not in (None, "-", ""))
    _status_dot(g, x + w - 16, y + 15, GREEN if up else RED)
    g.append(_text("UP" if up else "DOWN", x=x + w - 24, y=y + 15, scale=1,
                   color=GREEN if up else RED, anchor=(1.0, 0.5)))
    # IP is the hero — full scale=2
    g.append(_text(str(state.get("ip") or "-")[:16], x=x + 12, y=y + 34,
                   scale=2, color=TEXT))
    # Wi-Fi row — ssid + client count + band/channel chip, compact
    ssid = str(wifi.get("ssid") or wifi.get("connected_to") or "-")[:14]
    clients = wifi.get("clients") or 0
    band = wifi.get("band") or ""
    g.append(_text("Wi-Fi " + ssid, x=x + 12, y=y + 58,
                   scale=1, color=LABEL_2))
    g.append(_text("{} client{} · {}".format(
                       clients, "" if clients == 1 else "s", band or "-"),
                   x=x + 12, y=y + 72, scale=1, color=LABEL_3))
    g.append(_text("up " + str(state.get("uptime") or "-")[:14],
                   x=x + 12, y=y + 86, scale=1, color=LABEL_3))


def _fmt_bytes(n):
    try:
        n = int(n)
    except Exception:
        return "-"
    for unit in ("B", "K", "M", "G", "T"):
        if n < 1024:
            return "{}{}".format(int(n), unit) if unit == "B" else "{:.0f}{}".format(n, unit)
        n /= 1024
    return "{:.0f}P".format(n)


def _storage_card(g, x, y, w, h):
    _card(g, x, y, w, h)
    g.append(_text("STORAGE", x=x + 10, y=y + 10, scale=1, color=LABEL_3))
    drives = state.get("drives") or {}
    items = drives.get("drives") or []
    count = drives.get("count") or 0
    total = sum(d.get("size_bytes") or 0 for d in items)
    used = sum(d.get("used_bytes") or 0 for d in items)
    pct = int((used * 100) / total) if total else 0
    color = ACCENT if pct < 80 else (ORANGE if pct < 95 else RED)
    _status_dot(g, x + w - 14, y + 13, color)
    g.append(_text("{} drive{}".format(count, "" if count == 1 else "s"),
                   x=x + w - 22, y=y + 13, scale=1,
                   color=color, anchor=(1.0, 0.5)))
    g.append(_text(_fmt_bytes(used), x=x + 10, y=y + 30, scale=2, color=TEXT))
    g.append(_text("of " + _fmt_bytes(total), x=x + 10, y=y + 52,
                   scale=1, color=LABEL_3))
    bar_x = x + 10
    bar_y = y + h - 14
    bar_w = w - 20
    g.append(_rect(bar_x, bar_y, bar_w, 5, SURFACE_2))
    fw = int(bar_w * max(0, min(100, pct)) / 100)
    if fw > 0:
        g.append(_rect(bar_x, bar_y, fw, 5, color))
    g.append(_text("{}%".format(pct), x=x + w - 10, y=bar_y - 4,
                   scale=1, color=color, anchor=(1.0, 1.0)))


def _cameras_card(g, x, y, w, h):
    _card(g, x, y, w, h)
    g.append(_text("CAMERAS", x=x + 10, y=y + 10, scale=1, color=LABEL_3))
    cams = state.get("cameras") or {}
    online = cams.get("online") or 0
    total = cams.get("total") or 0
    if total == 0:
        col = LABEL_3
    elif online == total:
        col = GREEN
    elif online == 0:
        col = RED
    else:
        col = ORANGE
    _status_dot(g, x + w - 14, y + 13, col)
    g.append(_text("{}/{} online".format(online, total),
                   x=x + w - 22, y=y + 13, scale=1,
                   color=col, anchor=(1.0, 0.5)))
    evs = cams.get("events") or []
    if evs:
        ev = evs[0]
        g.append(_text(str(ev.get("camera") or "")[:14], x=x + 10, y=y + 30,
                       scale=2, color=TEXT))
        score = ev.get("score")
        score_s = " " + "{:.0%}".format(score) if isinstance(score, (int, float)) else ""
        g.append(_text(str(ev.get("label") or "event")[:10] + score_s,
                       x=x + 10, y=y + 54, scale=1, color=ACCENT))
    else:
        g.append(_text("No events", x=x + 10, y=y + 34, scale=2, color=LABEL_3))
        if cams.get("error"):
            g.append(_text("Frigate unreachable", x=x + 10, y=y + 58,
                           scale=1, color=LABEL_3))


def _wifi_card(g, x, y, w, h):
    _card(g, x, y, w, h)
    g.append(_text("WI-FI", x=x + 10, y=y + 10, scale=1, color=LABEL_3))
    wifi = state.get("wifi") or {}
    _status_dot(g, x + w - 14, y + 13, ACCENT)
    band = wifi.get("band") or ""
    ch = wifi.get("channel") or 0
    chip = "ch {} {}".format(ch, band) if ch else (band or "ready")
    g.append(_text(chip[:14], x=x + w - 22, y=y + 13,
                   scale=1, color=ACCENT, anchor=(1.0, 0.5)))
    ssid = wifi.get("ssid") or (wifi.get("connected_to") or "Droplet-AI")
    g.append(_text(str(ssid)[:14], x=x + 10, y=y + 30, scale=2, color=TEXT))
    clients = wifi.get("clients") or 0
    g.append(_text("{} client{}".format(clients, "" if clients == 1 else "s"),
                   x=x + 10, y=y + 54, scale=1, color=LABEL_2))
    ttl = wifi.get("key_ttl_seconds") or 0
    if ttl > 0:
        g.append(_text("key {}".format(_fmt_short_ttl(ttl)),
                       x=x + 10, y=y + 68, scale=1, color=LABEL_3))


def _fmt_short_ttl(s):
    try:
        s = int(s)
    except Exception:
        return "--"
    if s >= 3600:
        return "{}h{:02d}".format(s // 3600, (s % 3600) // 60)
    return "{}:{:02d}".format(s // 60, s % 60)


def render_stats():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    y0 = _header(g,
                 str(state.get("hostname") or "droplet")[:18],
                 sub="{} · {}".format(state.get("ip") or "-",
                                      state.get("uptime") or "-"))

    # Row 1: 4 half-donut gauges with sparkline history bands under each.
    # Gauges span the full width, generous breathing room above and below.
    row1_y = y0 + 28
    col_w = DISPLAY_W // 4
    dials = (
        ("CPU",  state["cpu"],  "{}%".format(int(state["cpu"])),  "cpu"),
        ("MEM",  state["mem"],  "{}%".format(int(state["mem"])),  "mem"),
        ("DISK", state["disk"], "{}%".format(int(state["disk"])), "disk"),
        ("TEMP", state["temp"], "{}C".format(int(state["temp"])), "temp"),
    )
    for i, (lbl, pct, val, key) in enumerate(dials):
        cx = col_w * i + col_w // 2
        _dial(g, cx, row1_y, col_w, 72, lbl, val, pct, spark_key=key)

    # Row 2: single row of two wider cards — less busy than the old 2x2.
    # Storage (left) + Network/Wi-Fi combined (right). Cameras info is
    # surfaced via the red alert bubble in the header so it doesn't need
    # a permanent card here.
    pad = 10
    cw = (DISPLAY_W - 3 * pad) // 2
    nav_h = 44
    top = row1_y + 60
    ch = DISPLAY_H - nav_h - top - 12
    _storage_card(g, pad, top, cw, ch)
    _network_card(g, 2 * pad + cw, top, cw, ch)

    # Bottom nav
    _nav_bar(g)

    # If the alerts drawer is open, stack it on top
    if state.get("events_open"):
        _render_alerts_drawer(g)

    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Alerts drawer (overlay on stats)
# ---------------------------------------------------------------------------

def _render_alerts_drawer(g):
    # Dim background
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, 0x000000))
    # Drawer from the right
    dw = 300
    dx = DISPLAY_W - dw
    g.append(_rect(dx, 0, dw, DISPLAY_H, PANEL))
    g.append(_rect(dx, 0, 1, DISPLAY_H, SEPARATOR))

    g.append(_text("ALERTS", x=dx + 14, y=16, scale=1, color=LABEL_2))
    n = _open_alerts_count()
    g.append(_text("{} open".format(n), x=dx + dw - 60, y=16,
                   scale=1, color=LABEL_3))
    # Close X
    g.append(_text("x", x=dx + dw - 16, y=16, scale=2, color=LABEL_2,
                   anchor=(1.0, 0.5)))
    _region("drawer_close", dx + dw - 34, 2, 30, 30, _close_alerts_drawer)

    alerts = state.get("alerts") or []
    list_y = 34
    row_h = 54
    visible = alerts[:4]
    if not visible:
        g.append(_text("No alerts.", x=dx + dw // 2, y=DISPLAY_H // 2,
                       scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
    else:
        for i, a in enumerate(visible):
            ry = list_y + i * row_h
            cleared = a.get("cleared")
            g.append(_rect(dx + 10, ry, dw - 20, row_h - 6,
                           SURFACE if cleared else SURFACE_2))
            g.append(_stroked_rect(dx + 10, ry, dw - 20, row_h - 6,
                                   SEPARATOR, 1))
            icon = "!" if a.get("type") == "cam" else "*"
            ic_col = LABEL_3 if cleared else (RED if a.get("type") == "cam" else ORANGE)
            g.append(_text(icon, x=dx + 22, y=ry + (row_h - 6) // 2,
                           scale=2, color=ic_col, anchor=(0.5, 0.5)))
            title = str(a.get("title") or "")[:28]
            detail = str(a.get("detail") or "")[:32]
            tm = str(a.get("time") or "")[:16]
            g.append(_text(title, x=dx + 38, y=ry + 10, scale=1,
                           color=LABEL_3 if cleared else TEXT))
            g.append(_text(detail, x=dx + 38, y=ry + 24, scale=1,
                           color=LABEL_3))
            if tm:
                g.append(_text(tm, x=dx + 38, y=ry + 36, scale=1, color=LABEL_4))
            if not cleared:
                g.append(_text("x", x=dx + dw - 26, y=ry + (row_h - 6) // 2,
                               scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
                _region("drawer_clear_{}".format(i),
                        dx + dw - 44, ry, 32, row_h - 6,
                        (lambda ii=i: _clear_alert(ii)))

    # Clear all
    bh = 32
    by = DISPLAY_H - bh - 10
    g.append(_rect(dx + 14, by, dw - 28, bh, SURFACE_2))
    g.append(_stroked_rect(dx + 14, by, dw - 28, bh, SEPARATOR_2, 1))
    g.append(_text("Clear all", x=dx + dw // 2, y=by + bh // 2,
                   scale=1, color=LABEL_2, anchor=(0.5, 0.5)))
    _region("drawer_clear_all", dx + 14, by, dw - 28, bh, _clear_all_alerts)


def _open_alerts_drawer():
    state["events_open"] = True
    _render_with_gc("stats")


def _close_alerts_drawer():
    state["events_open"] = False
    _render_with_gc("stats")


# ---------------------------------------------------------------------------
# Idle (screensaver)
# ---------------------------------------------------------------------------

# Refs for the idle tick loop so the clock/colon update cheaply without
# rebuilding the entire display tree every second.
_idle_refs = {"clock": None, "colon_on": True}


def render_idle():
    """Logo-first sleep screen: big droplet mark front and center, tiny
    clock tucked in the top-right, subtle footer metadata. Static HH:MM
    (no colon blink) — the minute rolls over via the idle tick loop.
    """
    global touch_regions
    touch_regions = []
    g = displayio.Group()

    # Soft indigo panel band behind the mark — gives the logo a subtle
    # stage without drawing attention away from it.
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    band_h = 220
    band_y = (DISPLAY_H - band_h) // 2
    g.append(_rect(0, band_y, DISPLAY_W, band_h, PANEL))

    # Top-right clock — small, muted, static colon. No tick-driven blink.
    clock_lbl = _text(_local_hhmm(),
                      x=DISPLAY_W - 16, y=20, scale=2, color=LABEL_2,
                      anchor=(1.0, 0.5))
    g.append(clock_lbl)
    _idle_refs["clock"] = clock_lbl

    # Top-left date, same restraint as the clock
    date_str = _clock.get("date_str") or ""
    if date_str:
        g.append(_text(date_str, x=16, y=20, scale=1, color=LABEL_3,
                       anchor=(0.0, 0.5)))

    # Hero: big centered droplet mark. _MARK_LARGE is pre-baked at 160 px
    # in _make_mark_bmp — reusing the cached bitmap keeps heap quiet.
    mark_size = 160
    mark_w = int(mark_size * 52 / 60)
    mx = (DISPLAY_W - mark_w) // 2
    my = (DISPLAY_H - mark_size) // 2 - 14
    g.append(_mark_tg(mark_size, mx, my))

    # Footer: single line of info, centered. Degrades gracefully when the
    # host hasn't pushed state yet.
    host = str(state.get("hostname") or "").strip()
    ip = str(state.get("ip") or "").strip()
    wifi = state.get("wifi") or {}
    ssid = str(wifi.get("ssid") or wifi.get("connected_to") or "").strip()
    parts = [p for p in (host, ip, ssid) if p and p != "-"]
    footer = "  ·  ".join(parts) if parts else "syncing..."
    g.append(_text(footer[:60], x=DISPLAY_W // 2, y=DISPLAY_H - 22,
                   scale=1, color=LABEL_3, anchor=(0.5, 0.5)))

    # Tap anywhere wakes to stats.
    _region("idle_wake", 0, 0, DISPLAY_W, DISPLAY_H,
            lambda: set_screen("stats"))
    board.DISPLAY.root_group = g


def _fmt_clock(hhmm, colon_on=True):
    """HH:MM with a soft-blinking colon — the colon toggles every second
    on the idle tick, giving the clock a subtle sign of life without a
    full re-render."""
    if not hhmm or len(hhmm) < 4:
        return hhmm or "--:--"
    if ":" not in hhmm:
        return hhmm
    a, b = hhmm.split(":", 1)
    sep = ":" if colon_on else " "
    return a + sep + b


def _chip(g, x, y, text_str, color, anchor_right=False):
    """Low-key rounded info chip for the idle screen footer."""
    # Approximate chip width from char count — terminalio scale=1 is ~6 px/char.
    pad_x = 10
    tw = len(text_str) * 6 + pad_x * 2
    th = 18
    cx = x - tw if anchor_right else x
    g.append(_rect(cx, y, tw, th, SURFACE))
    g.append(_circle(cx, y + th // 2, th // 2, SURFACE))
    g.append(_circle(cx + tw, y + th // 2, th // 2, SURFACE))
    g.append(_text(text_str, x=cx + tw // 2, y=y + th // 2,
                   scale=1, color=color, anchor=(0.5, 0.5)))


# ---------------------------------------------------------------------------
# QR (Join Droplet-AI)
# ---------------------------------------------------------------------------

def _render_qr_matrix(g, matrix, ox, oy, module_px):
    size = len(matrix)
    pad = module_px * 2
    g.append(_rect(ox - pad, oy - pad,
                   size * module_px + pad * 2,
                   size * module_px + pad * 2, WHITE))
    for row_idx, row in enumerate(matrix):
        bmp = displayio.Bitmap(size * module_px, module_px, 2)
        pal = displayio.Palette(2)
        pal[0] = WHITE
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

    y0 = _header(g, "Join Wi-Fi", sub="Scan with your phone camera",
                 show_bubble=False)

    qr = state.get("qr") or {}
    wifi = state.get("wifi") or {}
    ssid = (qr.get("ssid") if qr else None) or wifi.get("ssid") or "Droplet-AI"
    # Rotation TTL chip only shows up when the bridge reports the key
    # rotates. In the default static-password deployment rotation is off
    # and the chip disappears — no misleading "--:--" countdown.
    rotation_on = bool(qr.get("rotation_enabled"))
    ttl = (qr.get("ttl_seconds") or 0) if rotation_on else 0
    if rotation_on:
        chip_w = 92
        chip_x = DISPLAY_W - chip_w - 10
        chip_y = 8
        chip_col = ORANGE if ttl and ttl < 60 else ACCENT
        g.append(_rect(chip_x, chip_y, chip_w, 22, ACCENT_SUBTLE))
        g.append(_stroked_rect(chip_x, chip_y, chip_w, 22, chip_col, 1))
        ttl_str = _fmt_short_ttl(ttl) if ttl else "--:--"
        g.append(_text("KEY " + ttl_str, x=chip_x + chip_w // 2,
                       y=chip_y + 11, scale=1, color=chip_col,
                       anchor=(0.5, 0.5)))

    if not qr or not qr.get("ok") or not qr.get("matrix"):
        msg = "Waiting for router..."
        if qr and qr.get("error"):
            msg = str(qr["error"])[:50]
        g.append(_text(msg, x=DISPLAY_W // 2, y=(DISPLAY_H - 28) // 2,
                       scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
        bw, bh = 160, 36
        bx = (DISPLAY_W - bw) // 2
        by = DISPLAY_H - 28 - bh - 10
        g.append(_rect(bx, by, bw, bh, ACCENT_SUBTLE))
        g.append(_stroked_rect(bx, by, bw, bh, ACCENT, 1))
        g.append(_text("Retry", x=bx + bw // 2, y=by + bh // 2,
                       scale=2, color=ACCENT, anchor=(0.5, 0.5)))
        _region("qr_retry", bx, by, bw, bh, _request_qr)
        _nav_bar(g)
        board.DISPLAY.root_group = g
        return

    matrix = qr["matrix"]
    size = len(matrix)
    # Reserve 44 px at the bottom for the new taller nav bar.
    nav_h = 44
    avail_h = DISPLAY_H - y0 - nav_h - 10
    module_px = max(2, min(7, avail_h // size))
    qr_px = size * module_px
    ox = 24
    oy = y0 + (avail_h - qr_px) // 2 + 2
    _render_qr_matrix(g, matrix, ox, oy, module_px)

    # Right sidebar: SSID / security / password / rotate. Same info density
    # as before but with tighter label pairs and the new ACCENT_LIGHT for
    # the SSID value to match the refreshed palette.
    side_x = ox + qr_px + 30
    side_w = DISPLAY_W - side_x - 18
    g.append(_text("NETWORK", x=side_x, y=y0 + 10, scale=1, color=LABEL_3))
    g.append(_text(str(ssid)[:20], x=side_x, y=y0 + 30, scale=2, color=ACCENT_LIGHT))

    sec = (qr.get("security") or "WPA2")
    g.append(_text("SECURITY", x=side_x, y=y0 + 58, scale=1, color=LABEL_3))
    g.append(_text(str(sec)[:20], x=side_x, y=y0 + 76, scale=2, color=TEXT))

    # Cleartext password for users whose phone won't scan the QR (or who
    # just want to type it into a laptop / a second device).
    key = qr.get("key") or ""
    if key:
        g.append(_text("PASSWORD", x=side_x, y=y0 + 104, scale=1,
                       color=LABEL_3))
        half = len(key) // 2 + (len(key) % 2)
        g.append(_text(key[:half], x=side_x, y=y0 + 124, scale=2, color=TEXT))
        if len(key) > half:
            g.append(_text(key[half:], x=side_x, y=y0 + 146, scale=2, color=TEXT))
        g.append(_text("all lowercase", x=side_x, y=y0 + 168, scale=1,
                       color=LABEL_3))

    # Rotate button only shows when the bridge has rotation enabled.
    # Pill-shaped to match the new nav-bar language.
    if rotation_on:
        bw = side_w
        bh = 30
        bx = side_x
        by = DISPLAY_H - nav_h - bh - 8
        pr = bh // 2
        g.append(_rect(bx, by, bw, bh, ACCENT_SUBTLE))
        g.append(_circle(bx, by + pr, pr, ACCENT_SUBTLE))
        g.append(_circle(bx + bw, by + pr, pr, ACCENT_SUBTLE))
        g.append(_text("Rotate now", x=bx + bw // 2, y=by + bh // 2,
                       scale=1, color=ACCENT_LIGHT, anchor=(0.5, 0.5)))
        _region("qr_rotate", bx - pr, by, bw + 2 * pr, bh, _rotate_key)

    _nav_bar(g)

    board.DISPLAY.root_group = g


def _request_qr():
    _send("REQUEST_QR")


def _rotate_key():
    _send("ROTATE_KEY")
    state["wifi"]["key_ttl_seconds"] = 60 * 60  # optimistic; bridge will correct
    if state.get("qr"):
        state["qr"]["ttl_seconds"] = 60 * 60
    _render_with_gc("qr")


# ---------------------------------------------------------------------------
# Message (host-pushed notification — still supported)
# ---------------------------------------------------------------------------

def render_message():
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    title = state.get("msg_title") or "Message"
    y0 = _header(g, title[:24], show_bubble=False)
    g.append(_rect(16, y0 + 6, DISPLAY_W - 32, DISPLAY_H - y0 - 22,
                   SURFACE))
    yy = y0 + 18
    for line in (state.get("msg_lines") or [])[:8]:
        g.append(_text(str(line)[:52], x=28, y=yy, scale=2, color=TEXT))
        yy += 28
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

# Back-compat aliases so the old bridge's bare-mode pushes still route.
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
    # Brightness: dim on idle, full elsewhere
    set_brightness(IDLE_BRIGHTNESS if name == "idle" else ACTIVE_BRIGHTNESS)
    _render_with_gc(name)
    _send("NAV:" + name)
    # When entering the QR screen, always pull a fresh matrix from the
    # host — otherwise the first visit sits on "Waiting for router..."
    # until the user manually taps Retry. Cheap round-trip via the
    # existing REQUEST_QR handler.
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
    _send("SWIPE:{}:{}".format("left" if direction > 0 else "right", state["screen"]))
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
SWIPE_THRESHOLD_X = 60   # px — horizontal delta required for a swipe
SWIPE_MAX_Y = 40         # px — max vertical drift; above this it's a drag, not a swipe


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
    # A bare-mode message (no data) = navigation.
    if not data and (mode in RENDERERS or mode in _ALIASES):
        set_screen(mode)
        return "OK"

    if mode == "stats":
        for k in ("cpu", "mem", "disk", "temp", "ip", "uptime", "hostname", "now"):
            if k in data and data[k] is not None:
                state[k] = data[k]
        # Append latest cpu/mem/disk/temp values to the sparkline rings so
        # the dashboard can draw tiny history bars under each gauge.
        sparks = state["sparks"]
        for k in ("cpu", "mem", "disk", "temp"):
            try:
                v = float(state.get(k) or 0)
            except (TypeError, ValueError):
                continue
            sparks[k].append(v)
            if len(sparks[k]) > _SPARK_LEN:
                del sparks[k][0:len(sparks[k]) - _SPARK_LEN]
        # Re-anchor the local clock whenever the host pushes a fresh "now"
        # so idle-screen seconds can tick between pushes without drift.
        # Optional "date" field feeds the idle-screen date line.
        if data.get("now"):
            _set_clock(data.get("now"), data.get("date"))
        if state["screen"] == "stats":
            _render_with_gc("stats")
        elif state["screen"] == "idle" and _idle_refs.get("clock") is not None:
            # Keep the idle clock in sync with the latest push without a
            # full re-render.
            _idle_refs["clock"].text = _fmt_clock(
                _local_hhmm(), _idle_refs.get("colon_on", True))
    elif mode == "wifi":
        # Merge — the old fields (networks, adapter, etc.) live alongside
        # new ones (ssid, clients, channel, band, key_ttl_seconds).
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
    # Ask the host to (re-)push its full state. Host may or may not honour
    # it — if it doesn't, we just fall through to normal steady-state pushes.
    # Critical for firmware-reload recovery: without this, the device sits
    # with empty stats/wifi/drives until something upstream changes.
    _send("REQUEST_STATE")
    buf = b""
    last_touch = None
    press_start = None          # (x, y) — where the finger first landed
    last_activity = time.monotonic()
    last_idle_tick = 0.0

    last_idle_hhmm = ""
    while True:
        # Idle clock tick — only runs while the idle screen is up. Updates
        # the HH:MM label *only when the minute changes* (no per-second
        # colon blink — too distracting for a sleep screen). Checks once
        # a second but the label.text write is skipped unless the digits
        # actually moved.
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
                # Resolve: was this a swipe or a tap?
                if press_start is not None:
                    rx, ry = last_touch[0], last_touch[1]
                    sx, sy = press_start
                    dx = rx - sx
                    dy = ry - sy
                    if (abs(dx) >= SWIPE_THRESHOLD_X and
                            abs(dy) <= SWIPE_MAX_Y and
                            state["screen"] in SCREENS):
                        # Swipe left (finger moves left → dx<0) = next screen
                        swipe_screen(1 if dx < 0 else -1)
                    else:
                        dispatch_tap(sx, sy)
                press_start = None
                last_touch = None
                last_activity = time.monotonic()

        # Idle timer — drop back to idle after IDLE_TIMEOUT_S with no touch.
        if (state["screen"] != "idle" and
                (time.monotonic() - last_activity) >= IDLE_TIMEOUT_S):
            state["events_open"] = False
            set_screen("idle")

        time.sleep(0.03)


if __name__ == "__main__":
    main()
