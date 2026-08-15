"""
code.py — Droplet front-panel firmware (py-v3 editorial UI)
=============================================================
Two live states + host-driven power sequences. This is the on-device port of
the design handoff in
``services/oled-display/design`` (README.md + preview.html) — every
coordinate/color below maps 1:1 to that 480x320 reference.

  idle    Editorial hero clock (132px, weight ~800, -6 tracking) with a
          blinking colon, a tappable 12/24 segmented toggle (top-right,
          PERSISTED on-device), the droplet mark + DROPLET eyebrow
          (top-left), a 56x3 accent rule under the clock, date bottom-left,
          green-dot + SSID bottom-right, and a full-width seconds progress
          hairline along the very bottom edge. Default screensaver after
          30 s of no touch; any tap wakes → system.
  system  ONE combined System + Wi-Fi screen (replaces the old separate
          stats + QR screens). Header band (SYSTEM eyebrow left; clock +
          status pill / alert badge right). Vertical divider at x=288.
          LEFT = system: CPU hero + 48-sample sparkline + MEM/DISK/TEMP/CAM
          tabular row + detail line + hostname·ip strip. RIGHT = Wi-Fi:
          PAIR·WI-FI eyebrow + white QR card with the droplet mark inset +
          NETWORK/SSID + PASSWORD + a full-width KEY rotate pill.
          Open alerts surface as a red "!" badge in the header — tap to open
          the Alerts drawer (per-row dismiss + Clear all). The QR matrix is
          supplied by the host (mode:qr); the firmware never encodes on-device.

Navigation
----------
  swipe        idle ⇄ system only (one non-idle screen; swipes on system
               rubber-band). swipe left wakes idle → system.
  tap          activates whatever region the finger landed on; on the idle
               screen any tap (except the toggle) wakes to system.
  30 s idle    auto-drop back to idle and close any open drawer.

Lifecycle screens (host-driven, modal — not in the swipe nav):
  boot      Opened by main() on cold power-on: the droplet "vessel" fills
            with accent liquid (eased) + DROPLET wordmark + a 4-stage status
            line + a 184px progress bar + a "Droplet OS · v2.4" footer. The
            host moves the panel to the live UI once it's ready (or after its
            readiness timeout). A bare-mode {"mode":"boot"} just navigates;
            {"mode":"boot","data":{stage,detail,pct}} drives the fill/status.
  shutdown  The liquid drains + a status line, then a CRT collapse (content
            thins to a phosphor line → dot → black). phase=="halted" shows
            the fully-collapsed safe-to-power-off frame. Pushed by the host's
            systemd ExecStop.
  standby   Dim mark + STANDBY + "tap to power on" (host-pushed; tap wakes).
  claim     Onboarding claim screen (WARP-632 / ADR-017), design-handoff
            two-column layout: header band (mark + FIRST-TIME SETUP), the
            claim code as dash-separated groups with accent dash bars + the
            numbered link steps on the left, a white scan QR card on the
            right, WAITING TO BE CLAIMED dots over a 2px scan track at the
            foot. The QR is the host-encoded setup deep link
            (setup_qr_matrix) or, when Wi-Fi creds are pushed (WARP-819),
            the Wi-Fi join QR + readable SSID/PSK. Host-driven by the
            orchestrator while the box is unclaimed; cleared (host
            navigates away) once claimed.

Host → display (one JSON per line, contract UNCHANGED for back-compat)
  {"mode":"idle"|"stats"|"qr"|"logo"|"home"|"system"}  # see _ALIASES below;
        # stats/qr/wifi/cameras/drives/home all land on the combined "system"
        # screen now, logo→idle. Bare-mode (no data) = navigation.
  {"mode":"boot",   "data":{stage,detail,pct}}     # pct optional (indeterminate)
  {"mode":"shutdown","data":{reason,phase}}        # phase: stopping|halted
  {"mode":"claim",  "data":{code, setup_url, setup_qr_matrix,
                             wifi_qr_matrix, wifi_ssid, wifi_psk}}
        # onboarding claim code; matrices host-encoded, at most one per frame
  {"mode":"stats",  "data":{cpu,mem,disk,temp,ip,hostname,uptime,now,date}}
  {"mode":"wifi",   "data":{networks, connected_to, adapter, state, ssid,
                             clients, channel, band, key_ttl_seconds, password}}
  {"mode":"cameras","data":{online, total, events:[...], source, error}}
  {"mode":"drives", "data":{drives:[...], count}}
  {"mode":"files",  "data":{count, size_bytes, recent:[...]}}
  {"mode":"qr",     "data":{matrix, ssid, security, payload, version, ok,
                             ttl_seconds}}    # matrix supplied by the host
  {"mode":"alert",  "data":{type:"cam"|"sys", title, detail, time}}
  {"mode":"message","data":{title, lines:[...]}}
  {"mode":"brightness","value":0..255}
  {"mode":"ping"}

Display → Host  (lines UNCHANGED, plus MEM: added in WARP-638)
  READY / OK / ERR:<reason> / REQUEST_STATE / REQUEST_QR
  TOUCH:<x>,<y>,<p> / TOUCH:release
  TAP:<screen>:<region>
  SWIPE:<left|right>:<from-screen>
  NAV:<screen>
  ROTATE_KEY
  MEM:<free-bytes>            # emitted on {"mode":"ping"} — free heap after a
                             # gc.collect(), so on-device headroom is
                             # verifiable from the host after flashing.
"""

import gc
import os
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

# Hero numeral font (digits/colon/AM-PM/°/% subset) — loaded best-effort from
# /lib/fonts/. terminalio scaled to 132px is too blocky for the editorial
# clock (design_handoff §"Hero font"), so we bundle a heavy bitmap face and
# load it via adafruit_bitmap_font. If the library or the asset is missing —
# or the FS is in a state where it can't be read — we fall back to
# terminalio-scaled heroes so a font problem never bricks the panel.
try:
    from adafruit_bitmap_font import bitmap_font
except ImportError:
    bitmap_font = None


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
# Design tokens — py-v3 palette (design_handoff README "Design Tokens").
# Every value maps 1:1 to a row in the handoff token table; the rgba tokens
# (accentSubtle, the orange KEY-pill fill, the sparkline fill) are flattened
# to the nearest solid over the #050507 background.
# ---------------------------------------------------------------------------
BG            = 0x050507   # screen background
PANEL         = 0x0D0D12   # alerts drawer background
SURFACE       = 0x141420   # chips, inactive pills
SURFACE_2     = 0x1D1D2E   # alert rows, "Clear all"
SEPARATOR     = 0x2A2A38   # hairline dividers
SEPARATOR_2   = 0x3A3A4A   # stronger borders
TEXT          = 0xFFFFFF   # primary numerics & values
LABEL_2       = 0xC8C8D4   # clock time, button labels
LABEL_3       = 0x8B8B9C   # eyebrows / captions
LABEL_4       = 0x545466   # faint / standby text
ACCENT        = 0x818CF8   # sparkline, rule, SSID, mark
ACCENT_DIM    = 0x5B62C7   # seconds hairline
ACCENT_INK    = 0xB4BAFF   # mark highlight, password text
# accentSubtle rgba(129,140,248,0.18) over bg -> nearest solid (active toggle).
ACCENT_SUBTLE = 0x1B1D32
# Claim-screen waiting dots at rest — accent @ 30% over bg, flattened.
ACCENT_FAINT  = 0x2B2F52
# rgba(255,159,10,0.18) over bg -> KEY-pill fill when <60s.
ORANGE_SUBTLE = 0x322108
# sparkline fill #818cf822 over bg -> nearest solid.
SPARK_FILL    = 0x161727
TRACK         = 0x1F1F30   # progress / seconds track
GREEN         = 0x30D158   # OK status, cameras online
ORANGE        = 0xFF9F0A   # warnings, key-expiring
RED           = 0xFF453A   # alerts, critical
WHITE         = 0xFFFFFF   # QR card
PHOSPHOR      = 0xEAEAFF   # CRT-collapse line on shutdown

# Accent aliases for the vector droplet mark (_mark_poly). ACCENT_PRI is the
# body fill, ACCENT_LIGHT the inner highlight — both point at the py-v3 indigo
# so the mark reads on every screen.
ACCENT_PRI    = ACCENT
ACCENT_LIGHT  = ACCENT_INK

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


def _text(s, *, x, y, scale=2, color=TEXT, anchor=None, font=None):
    lbl = label.Label(font or terminalio.FONT, text=s, color=color, scale=scale)
    if anchor is not None:
        lbl.anchor_point = anchor
        lbl.anchored_position = (x, y)
    else:
        lbl.x = x
        lbl.y = y
    return lbl


def _tracked(g, s, *, x, y, scale=2, color=TEXT, anchor_y=0, tracking=0,
             align="left", font=None):
    """Draw a string with manual per-character letter-spacing (tracking).

    terminalio/label has no tracking, and the editorial look leans on it
    (eyebrows +1.2..+2, the hero clock -6). We lay out each glyph as its own
    Label so the spacing matches the design_handoff reference. Coordinates are
    in device px; `tracking` is added between glyphs (terminalio glyph cell is
    6px wide * scale). `align` left/center/right positions the whole run at x.
    Returns the total advance width (px) so callers can re-center lockups.
    """
    use_font = font or terminalio.FONT
    # Per-glyph advance: terminalio is a fixed 6px cell; for the bitmap hero
    # font we measure via a throwaway Label bounding box.
    def adv(ch):
        if use_font is terminalio.FONT:
            return 6 * scale
        try:
            lbl = label.Label(use_font, text=ch, scale=scale)
            return lbl.bounding_box[2] * scale
        except Exception:
            return 6 * scale
    widths = [adv(ch) for ch in s]
    total = sum(widths) + tracking * (len(s) - 1) if s else 0
    if align == "center":
        cx = x - total / 2
    elif align == "right":
        cx = x - total
    else:
        cx = x
    for ch, w in zip(s, widths):
        lbl = label.Label(use_font, text=ch, color=color, scale=scale)
        lbl.anchor_point = (0.0, anchor_y)
        lbl.anchored_position = (int(cx), y)
        g.append(lbl)
        cx += w + tracking
    return int(total)


def _circle(cx, cy, r, color):
    return vectorio.Circle(
        pixel_shader=_palette(color),
        radius=max(1, int(r)),
        x=int(cx), y=int(cy),
    )


def _rounded_rect(g, x, y, w, h, r, color):
    """Filled rounded rect via a cross of two rects + 4 corner circles.

    vectorio has no rounded primitive, but this composition is cheap
    (6 primitives per rect) and the seams line up perfectly because the
    circles sit at the corners of the inset region.
    """
    r = max(0, min(r, min(w, h) // 2))
    # Horizontal band (full width, shorter height)
    g.append(_rect(x, y + r, w, h - 2 * r, color))
    # Vertical band (full height, shorter width)
    g.append(_rect(x + r, y, w - 2 * r, h, color))
    # Corner circles
    g.append(_circle(x + r, y + r, r, color))
    g.append(_circle(x + w - r, y + r, r, color))
    g.append(_circle(x + r, y + h - r, r, color))
    g.append(_circle(x + w - r, y + h - r, r, color))


# ---------------------------------------------------------------------------
# Droplet mark (vectorio polygon, geometry from DropletMark.tsx)
# ---------------------------------------------------------------------------

# The mark is drawn as two vectorio Polygons (body + inner highlight) at any
# size — cheap heap-wise (vectorio stores just the vertex list). The old
# bitmap path (_make_mark_bmp / the _MARK_SMALL/_MARK_MED/_MARK_LARGE caches /
# _mark_tg) was removed in WARP-638: the 160px _MARK_LARGE alone pinned several
# KB of bitmap for the whole process lifetime, and every mark on every screen
# now goes through this vector path (52x60 source coordinate space).
def _mark_poly(g, size, x, y):
    w = int(size * 52 / 60)
    h = size
    sx = lambda px: x + int(px / 52 * w)  # noqa: E731
    sy = lambda py: y + int(py / 60 * h)  # noqa: E731
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
# Hero numeral font (lazy, best-effort). Loaded once on first use; cached.
# ---------------------------------------------------------------------------
_HERO_FONT = None
_HERO_FONT_TRIED = False
_HERO_FONT_PATH = "/lib/fonts/Inter-Hero-66.bdf"


# Glyphs actually drawn in the hero face, so load_glyphs preloads ONLY what
# renders (WARP-638). Hero draw sites:
#   * idle clock  — digits + ":" + " " (the colon blinks to a space)
#   * CPU hero    — digits + "%"
# The redesigned claim screen is terminalio-only (its 248px column can't fit
# the 66px face), so A-Z and "-" are no longer hero glyphs — preloading them
# pinned ~27 dead 66px bitmaps (~8-10 KB) in the cache for nothing. AM/PM
# and the TEMP "°" are drawn in terminalio, NOT the hero face, so they are
# intentionally NOT preloaded either. The bundled BDF (tools/
# make_hero_font.py) still carries every glyph; this just narrows what gets
# rasterised into the live glyph cache.
_HERO_GLYPHS = b"0123456789: %"


def _hero_font():
    """Return the bundled hero bitmap font, or None to fall back to terminalio.

    Loaded ONCE on first use and cached in the module-level ``_HERO_FONT``;
    every subsequent call (and every render) returns the same object — the
    BDF is never re-read or re-rasterised. ``_HERO_FONT_TRIED`` guards the
    load so a missing/corrupt asset is probed at most once and never raises
    into a render path. ``load_glyphs`` runs exactly once here over
    ``_HERO_GLYPHS`` so the first idle/claim/CPU frame doesn't pay per-glyph
    rasterisation cost mid-draw.
    """
    global _HERO_FONT, _HERO_FONT_TRIED
    if _HERO_FONT_TRIED:
        return _HERO_FONT
    _HERO_FONT_TRIED = True
    if bitmap_font is None:
        return None
    try:
        f = bitmap_font.load_font(_HERO_FONT_PATH)
        try:
            f.load_glyphs(_HERO_GLYPHS)
        except Exception:
            pass
        _HERO_FONT = f
    except Exception:
        _HERO_FONT = None
    return _HERO_FONT


# ---------------------------------------------------------------------------
# 12/24 clock mode — PERSISTED on-device (design_handoff §1).
# The CIRCUITPY FS is read-only-to-CircuitPython when the host has it mounted
# over USB-MSC, so writes can fail with OSError(EROFS). We persist to
# /clock_mode.txt when we can and ALWAYS keep an in-RAM copy, defaulting to
# '24', so a read-only FS never crashes the panel — it just doesn't survive a
# reboot in that state.
# ---------------------------------------------------------------------------
_CLOCK_MODE_PATH = "/clock_mode.txt"
_clock_mode = {"value": "24"}


def _load_clock_mode():
    try:
        with open(_CLOCK_MODE_PATH, "r") as fh:
            v = fh.read().strip()
        if v in ("12", "24"):
            _clock_mode["value"] = v
    except Exception:
        # No file yet / unreadable FS — keep the default.
        pass


def _set_clock_mode(mode):
    if mode not in ("12", "24"):
        return
    _clock_mode["value"] = mode
    try:
        with open(_CLOCK_MODE_PATH, "w") as fh:
            fh.write(mode)
    except OSError:
        # Read-only FS (USB-mounted) — the in-RAM value still took effect.
        _send("ERR:clock_persist:readonly_fs")
    except Exception as exc:                                    # noqa: BLE001
        _send("ERR:clock_persist:{}".format(exc))


def _fmt_clock_parts():
    """12/24 split of the local clock (idle hero + system header reuse this).

    Mirrors the sim/preview fmtClock(): 12h drops the leading hour zero and
    carries an AM/PM suffix; 24h pads the hour. Built off the same monotonic
    anchor as _local_hhmm so seconds tick between host pushes.
    """
    hhmm = _local_hhmm()
    try:
        hh24 = int(hhmm.split(":")[0])
        mm = hhmm.split(":")[1]
    except (ValueError, IndexError):
        return {"hh": "--", "mm": "--", "suffix": "", "is12": False,
                "str": hhmm}
    is12 = _clock_mode["value"] == "12"
    if is12:
        suffix = "PM" if hh24 >= 12 else "AM"
        h = ((hh24 + 11) % 12) + 1
        hh = str(h)
    else:
        suffix = ""
        hh = "{:02d}".format(hh24)
    return {"hh": hh, "mm": mm, "suffix": suffix, "is12": is12,
            "str": hh + ":" + mm + ((" " + suffix) if is12 else "")}


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

# Awake nav order — idle is NOT in this list. The redesign collapses the old
# stats + qr screens into ONE combined "system" screen, so there is a single
# non-idle screen. Tapping/swiping out of idle drops to it; swipes on it
# rubber-band (no lateral neighbours). Host pushes for stats/qr/wifi/cameras/
# drives all render onto "system" (see _ALIASES).
SCREENS = ("system",)
# Lifecycle screens (WARP-624) — host-driven, NOT user-navigable. They stay up
# until the host pushes another mode, so the idle-timeout below skips them
# (otherwise a >30 s cold boot would self-drop boot -> idle while the host
# still believes it's showing the boot splash). They aren't in SCREENS, so
# swipe is already a no-op on them. NB: "message" is intentionally NOT here —
# it keeps its existing behaviour of dropping back to idle after the timeout.
# "claim" (WARP-632) IS modal too: while the box is unclaimed the host wants
# the code on the lid continuously, so it must not self-drop to idle either.
LIFECYCLE_SCREENS = ("boot", "shutdown", "standby", "claim")
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
    # Detail-line fields for the combined system screen.
    "wan_latency_ms": 0, "lan_clients": 0,
    "brightness": ACTIVE_BRIGHTNESS,
    "msg_title": "",
    "msg_lines": [],
    "wifi": {
        "networks": [],
        "adapter": None,
        "connected_to": None,
        "state": "unknown",
        "scanned_at": None,
        # WARP-2047: no placeholder. An unknown SSID must read as unknown, not
        # as a plausible network name the panel invented before any feed lands.
        "ssid": None,
        "clients": 0,
        "channel": 0,
        "band": "",
        "key_ttl_seconds": 0,
        "password": "",
    },
    "files": {"count": 0, "size_bytes": 0, "recent": []},
    "cameras": {"online": 0, "total": 0, "events": [], "error": None, "source": None},
    "drives": {"drives": [], "count": 0},
    "qr": None,   # {matrix, ssid, security, payload, version, ok, ttl_seconds}
    "alerts": [],  # [{type, title, detail, time, cleared}]
    "events_open": False,
    # Power sequences (modal — not in SCREENS). _frac/_t0 drive the self-running
    # liquid fill/drain animation; pct (boot) overrides _frac when host-pushed.
    "boot": {"stage": None, "detail": "", "pct": None, "_frac": 0.0, "_t0": 0.0},
    "shutdown": {"reason": "", "phase": "stopping", "_frac": 0.0, "_t0": 0.0},
    # Onboarding claim screen (WARP-632 / ADR-017). Modal, host-driven.
    # WARP-819: optional Wi-Fi-connect creds (matrix/ssid/psk) so the claim
    # screen can also show how to join the box's Wi-Fi. Absent => claim-only,
    # whose scan QR is the host-encoded setup deep link (setup_qr_matrix).
    # The host sends at most ONE matrix per claim frame (heap posture).
    "claim": {"code": "", "setup_url": "", "setup_qr_matrix": None,
              "wifi_qr_matrix": None, "wifi_ssid": "", "wifi_psk": ""},
    # Rolling sparkline history for the gauges. Each list is a ring buffer
    # capped at _SPARK_LEN; _record_sparks appends on every stats push.
    "sparks": {"cpu": [], "mem": [], "disk": [], "temp": []},
}

_SPARK_LEN = 48  # design_handoff §2: 48-sample CPU sparkline

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
    # Mark cleared (not pop) so the row greys out in place — matches the
    # design_handoff drawer behavior and the sim.
    if 0 <= idx < len(state["alerts"]):
        state["alerts"][idx]["cleared"] = True
    _render_with_gc(state["screen"])


# ---------------------------------------------------------------------------
# Shared helpers for the redesigned screens
# ---------------------------------------------------------------------------

def _hairline(g, x, y, w, color=SEPARATOR):
    g.append(_rect(x, y, w, 1, color))


def _fmt_short_ttl(s):
    try:
        s = int(s)
    except Exception:
        return "--:--"
    return "{}:{:02d}".format(s // 60, s % 60)


def _v3_sparkline(g, x, y, w, h, series, color, fill_color):
    """Polyline sparkline with a filled area below (design_handoff §2).

    vectorio has no polyline; we approximate the accent line with a thin rect
    per segment (the segments are near-vertical between adjacent samples so a
    1.5px rect reads as a connected line at 48 samples across ~246px). The
    fill below is one Polygon (the sample points + the two baseline corners),
    which is cheap heap-wise (vertex list only). Baseline hairline always
    drawn so a flat series still reads.
    """
    g.append(_rect(x, y + h - 1, w, 1, SEPARATOR))
    n = len(series)
    if n < 2:
        return
    lo = min(series)
    hi = max(series)
    span = hi - lo
    if span < 1:
        span = 1

    def pt(i):
        px = x + int((i / (n - 1)) * w)
        py = y + h - int(((series[i] - lo) / span) * h)
        return px, py

    pts = [pt(i) for i in range(n)]
    # Filled area below the line.
    poly = list(pts) + [(x + w, y + h), (x, y + h)]
    g.append(vectorio.Polygon(pixel_shader=_palette(fill_color),
                              points=poly, x=0, y=0))
    # Accent line as connected segments (thin rects).
    for i in range(n - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        seg_x = min(x0, x1)
        seg_w = max(1, abs(x1 - x0))
        seg_y = min(y0, y1)
        seg_h = max(2, abs(y1 - y0) + 2)
        g.append(_rect(seg_x, seg_y, seg_w, seg_h, color))


def _v3_header(g, now=None):
    """System screen header band (design_handoff §2 header).

    SYSTEM eyebrow left; clock right; status pill (green OK) or alert badge
    (red ! + count, opens the drawer) just left of the clock; hairline at
    y=32. Returns nothing — the caller draws the columns below.
    """
    _tracked(g, "SYSTEM", x=20, y=12, scale=1, color=LABEL_3, tracking=2)
    clk = _fmt_clock_parts()["str"]
    g.append(_text(clk, x=DISPLAY_W - 20, y=15, scale=2, color=LABEL_2,
                   anchor=(1.0, 0.5)))
    # terminalio scale=2 cell is 12px wide; estimate the clock width to place
    # the status to its left.
    time_w = len(clk) * 12
    n = _open_alerts_count()
    if n > 0:
        r = 11
        cx = DISPLAY_W - 20 - time_w - 20 - r
        cy = 15
        g.append(_circle(cx, cy, r, RED))
        g.append(_text("!", x=cx, y=cy, scale=2, color=WHITE,
                       anchor=(0.5, 0.5)))
        if n > 1:
            g.append(_circle(cx + r - 2, cy - r + 2, 7, WHITE))
            g.append(_text(str(n)[:2], x=cx + r - 2, y=cy - r + 2,
                           scale=1, color=RED, anchor=(0.5, 0.5)))
        _region("alert_badge", cx - r - 6, cy - r - 6,
                (r + 6) * 2, (r + 6) * 2, _open_alerts_drawer)
    else:
        sxs = DISPLAY_W - 20 - time_w - 14
        g.append(_circle(sxs, 15, 4, GREEN))
        g.append(_text("OK", x=sxs - 8, y=15, scale=1, color=GREEN,
                       anchor=(1.0, 0.5)))
    _hairline(g, 20, 32, DISPLAY_W - 40, SEPARATOR)


def _household_ssid():
    """The name of the household network, or "" when it isn't known.

    WARP-2047. Mirrors the host renderer's `household_ssid()`. Reads
    state["qr"] FIRST — the bridge's /openwrt/qr snapshot, which resolves the
    household SSID across all three box shapes and, since WARP-2047, refuses
    to vouch for hostapd config creds that no radio is actually beaconing —
    and only then the client-scan `wifi` feed, which carries an ssid on the
    single-box shape and nothing on the others.

    Returns "" rather than a placeholder. Callers render their own "—" or draw
    nothing; inventing a name here would put a confident wrong SSID on the
    glass, which is the defect this exists to close. `_v3_qr_card` already
    gates the matrix on the same `ok` flag — this keeps the label beside it
    honest too, instead of captioning a blank card with a made-up network.
    """
    qr = state.get("qr") or {}
    # `ok` false means the bridge told us it could not vouch for these creds.
    if qr.get("ok") is not False:
        ssid = str(qr.get("ssid") or "").strip()
        if ssid:
            return ssid
    wifi = state.get("wifi") or {}
    return str(wifi.get("ssid") or "").strip()


def _v3_qr_card(g, x, y, size, matrix=None):
    """White QR card + the host-supplied matrix + droplet mark inset.

    The matrix is ALWAYS host-supplied (NOT encoded on-device — contract) and
    rendered by _render_qr_matrix_plain. If no matrix has arrived yet, the card
    shows just the mark on white so the layout still reads while we wait for the
    host's push.

    By default the matrix is sourced from the System screen's {"mode":"qr"}
    push (state["qr"]). WARP-819: callers may pass an explicit `matrix` instead
    — the claim screen carries its OWN Wi-Fi QR in state["claim"], so it passes
    that directly rather than depending on the System screen's qr state.
    """
    _rounded_rect(g, x, y, size, size, 12, WHITE)
    if matrix is None:
        qr = state.get("qr") or {}
        matrix = qr.get("matrix") if (qr and qr.get("ok")) else None
    inset = 9
    inner = size - inset * 2
    if matrix:
        n = len(matrix)
        module_px = max(1, inner // n)
        qpx = module_px * n
        ox = x + (size - qpx) // 2
        oy = y + (size - qpx) // 2
        _render_qr_matrix_plain(g, matrix, ox, oy, module_px)
    # Droplet mark on a white pad, dead-centre.
    mc = 26
    mcx = x + size // 2 - mc // 2
    mcy = y + size // 2 - mc // 2
    _rounded_rect(g, mcx - 3, mcy - 3, mc + 6, mc + 6, 6, WHITE)
    _mark_poly(g, 26, mcx, mcy)


# ---------------------------------------------------------------------------
# System + Wi-Fi (combined primary screen — replaces stats + qr)
# ---------------------------------------------------------------------------

def render_system():
    global touch_regions
    touch_regions = []
    # Release the previous frame's display tree (which holds the prior QR
    # bitmap) BEFORE building the new one, then gc — so we never hold two
    # full-matrix QR bitmaps alive at once. This is the peak that OOMed on the
    # rotate / REQUEST_QR re-render (WARP-638): without it, the old root_group
    # stays referenced until the new `g` is assigned at the end of this
    # function, doubling the QR heap for the duration of the build.
    board.DISPLAY.root_group = None
    gc.collect()
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    _v3_header(g)

    DIV = 288
    INW = DIV - 20 - 22
    g.append(_rect(DIV, 46, 1, DISPLAY_H - 46 - 24, SEPARATOR))

    # ===== LEFT: system =====
    _tracked(g, "CPU LOAD", x=20, y=46, scale=1, color=LABEL_3, tracking=2)
    # CPU hero — bitmap hero font if available, else terminalio scaled up.
    hero = _hero_font()
    cpu_str = "{}%".format(int(state.get("cpu") or 0))
    if hero is not None:
        g.append(_text(cpu_str, x=20, y=84, scale=1, color=TEXT, anchor=(0.0, 0.5),
                       font=hero))
    else:
        g.append(_text(cpu_str, x=20, y=84, scale=5, color=TEXT,
                       anchor=(0.0, 0.5)))

    # sparkline (48-sample CPU history).
    sp = state.get("sparks", {}).get("cpu") or []
    _v3_sparkline(g, 20, 120, INW, 40, sp, ACCENT, SPARK_FILL)

    _hairline(g, 20, 172, INW, SEPARATOR)

    # tabular metrics row.
    cams = state.get("cameras") or {}
    cols = (
        ("MEM", "{}%".format(int(state.get("mem") or 0)), TEXT),
        ("DISK", "{}%".format(int(state.get("disk") or 0)), TEXT),
        ("TEMP", "{}".format(int(state.get("temp") or 0)) + "°", TEXT),
        ("CAM", "{}/{}".format(cams.get("online") or 0,
                               cams.get("total") or 0), GREEN),
    )
    col_w = INW // 4
    for i, (lbl, val, col) in enumerate(cols):
        cxx = 20 + i * col_w
        _tracked(g, lbl, x=cxx, y=182, scale=1, color=LABEL_3, tracking=1)
        g.append(_text(val, x=cxx, y=200, scale=2, color=col))

    # detail line.
    g.append(_text("WAN {}ms  ·  UP {}  ·  LAN {}".format(
                       state.get("wan_latency_ms") or 0,
                       state.get("uptime") or "-",
                       state.get("lan_clients") or 0),
                   x=20, y=244, scale=1, color=LABEL_3))

    # bottom strip.
    g.append(_text("{} · {}".format(state.get("hostname") or "-",
                                          state.get("ip") or "-")[:42],
                   x=20, y=DISPLAY_H - 24, scale=1, color=LABEL_3))

    # ===== RIGHT: Wi-Fi pairing =====
    RX = 300
    RW = DISPLAY_W - 20 - RX  # 160
    _tracked(g, "PAIR · WI-FI", x=RX, y=46, scale=1, color=ACCENT,
             tracking=1)

    wifi = state.get("wifi") or {}
    card_w = 132
    card_x = RX + (RW - card_w) // 2
    card_y = 60
    _v3_qr_card(g, card_x, card_y, card_w)

    yy = card_y + card_w + 14
    _tracked(g, "NETWORK", x=RX, y=yy, scale=1, color=LABEL_3, tracking=1)
    g.append(_text((_household_ssid() or "—")[:18], x=RX, y=yy + 18,
                   scale=2, color=TEXT))
    _tracked(g, "PASSWORD", x=RX, y=yy + 34, scale=1, color=LABEL_3, tracking=1)
    g.append(_text(str(wifi.get("password") or "")[:20], x=RX, y=yy + 50,
                   scale=1, color=ACCENT_INK))

    # KEY rotate pill + TTL chip — ONLY when key rotation is enabled.
    # WARP-638: the box default is rotation OFF (the bridge's qr_snapshot
    # returns rotation_enabled=False; a rotate attempt comes back
    # "rotation_disabled"). Tapping the pill in that state fired ROTATE_KEY ->
    # a fresh-QR re-render that OOMed the SAMD51. So when rotation is disabled
    # we draw NO pill and register NO tap region — there is simply no way to
    # trigger the rotate path. The TTL is meaningless without rotation too, so
    # the whole chip is gated together. rotation_enabled is sourced from the
    # host-supplied QR data (state["qr"]); absent/false => hidden.
    qr = state.get("qr") or {}
    rotation_enabled = bool(qr.get("rotation_enabled"))
    if rotation_enabled:
        secs = wifi.get("key_ttl_seconds")
        if secs is None:
            secs = qr.get("ttl_seconds") or 0
        try:
            secs = int(secs)
        except (TypeError, ValueError):
            secs = 0
        warn = secs < 60
        pill_y = yy + 68
        pill_h = 26
        g.append(_rect(RX, pill_y, RW, pill_h,
                       ORANGE_SUBTLE if warn else SURFACE))
        g.append(_stroked_rect(RX, pill_y, RW, pill_h,
                               ORANGE if warn else SEPARATOR_2, 1))
        # ASCII-safe rotate marker on the bitmap-less terminalio font.
        g.append(_text("KEY {}".format(_fmt_short_ttl(secs)),
                       x=RX + RW // 2, y=pill_y + pill_h // 2, scale=1,
                       color=ORANGE if warn else LABEL_2, anchor=(0.5, 0.5)))
        _region("key_rotate", RX, pill_y - 3, RW, pill_h + 6, _rotate_key)

    # Alerts drawer overlay.
    if state.get("events_open"):
        _render_alerts_drawer(g)

    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Alerts drawer (overlay on stats)
# ---------------------------------------------------------------------------

def _render_alerts_drawer(g):
    """300px right drawer over the system screen (design_handoff §3)."""
    # Dim the screen behind the drawer (flat near-black; vectorio has no
    # alpha, so a solid wash is the device-faithful path).
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, 0x020203))
    dw = 300
    dx = DISPLAY_W - dw
    g.append(_rect(dx, 0, dw, DISPLAY_H, PANEL))
    g.append(_rect(dx, 0, 1, DISPLAY_H, SEPARATOR))

    _tracked(g, "ALERTS", x=dx + 14, y=16, scale=1, color=LABEL_2, tracking=1)
    n = _open_alerts_count()
    # Close control far right; count right-aligned just left of it.
    g.append(_text("x", x=dx + dw - 16, y=16, scale=2, color=LABEL_2,
                   anchor=(0.5, 0.5)))
    g.append(_text("{} open".format(n), x=dx + dw - 34, y=16,
                   scale=1, color=LABEL_3, anchor=(1.0, 0.5)))
    _region("drawer_close", dx + dw - 32, 2, 30, 30, _close_alerts_drawer)

    alerts = state.get("alerts") or []
    list_y = 44
    row_h = 58
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
            ic_col = LABEL_3 if cleared else (
                RED if a.get("type") == "cam" else ORANGE)
            g.append(_circle(dx + 24, ry + 24, 5, ic_col))
            g.append(_text(str(a.get("title") or "")[:26], x=dx + 40, y=ry + 12,
                           scale=1, color=LABEL_3 if cleared else TEXT))
            g.append(_text(str(a.get("detail") or "")[:30], x=dx + 40,
                           y=ry + 26, scale=1, color=LABEL_3))
            tm = str(a.get("time") or "")[:16]
            if tm:
                g.append(_text(tm, x=dx + 40, y=ry + 40, scale=1, color=LABEL_4))
            if not cleared:
                g.append(_text("x", x=dx + dw - 24, y=ry + 26,
                               scale=2, color=LABEL_3, anchor=(0.5, 0.5)))
                _region("drawer_clear_{}".format(i),
                        dx + dw - 36, ry + 4, 30, row_h - 12,
                        (lambda ii=i: _clear_alert(ii)))

    # Clear all (full-width, 40px, radius 12).
    bh = 40
    by = DISPLAY_H - 52
    g.append(_rect(dx + 14, by, dw - 28, bh, SURFACE_2))
    g.append(_stroked_rect(dx + 14, by, dw - 28, bh, SEPARATOR_2, 1))
    g.append(_text("Clear all", x=dx + dw // 2, y=by + bh // 2,
                   scale=1, color=LABEL_2, anchor=(0.5, 0.5)))
    _region("drawer_clear_all", dx + 14, by, dw - 28, bh, _clear_all_alerts)


def _open_alerts_drawer():
    state["events_open"] = True
    _render_with_gc("system")


def _close_alerts_drawer():
    state["events_open"] = False
    _render_with_gc("system")


# ---------------------------------------------------------------------------
# Idle (screensaver)
# ---------------------------------------------------------------------------

# Refs for the idle tick loop so the clock/colon update cheaply without
# rebuilding the entire display tree every second.
_idle_refs = {"clock": None, "colon_on": True}


def _hero_clock_string(parts, colon_on=True):
    """HH<sep>MM for the idle hero, colon blinking per second."""
    return parts["hh"] + (":" if colon_on else " ") + parts["mm"]


def render_idle():
    """Editorial hero clock (design_handoff §1 / preview.html drawIdle).

    Brand bug + DROPLET eyebrow top-left; tappable 12/24 toggle top-right;
    132px hero clock (colon blink, 12h AM/PM suffix in accent); 56x3 accent
    rule; date bottom-left; green-dot + SSID bottom-right; seconds progress
    hairline along the bottom edge.

    The hero numerals use the bundled bitmap hero font when available (a
    single Label so the per-second idle tick can cheaply rewrite `.text`),
    falling back to terminalio scaled x6 if the font is missing.
    """
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    # Brand bug top-left.
    _mark_poly(g, 26, 20, 14)
    _tracked(g, "DROPLET", x=50, y=24, scale=1, color=LABEL_3, tracking=2)

    # 12/24 segmented toggle top-right (two 38px cells, h26).
    seg_w, seg_h, tg_y = 38, 26, 17
    tg_x = DISPLAY_W - 20 - seg_w * 2
    g.append(_rect(tg_x, tg_y, seg_w * 2, seg_h, SURFACE))
    g.append(_stroked_rect(tg_x, tg_y, seg_w * 2, seg_h, SEPARATOR, 1))
    for i, opt in enumerate(("12", "24")):
        cx0 = tg_x + i * seg_w
        on = _clock_mode["value"] == opt
        if on:
            g.append(_rect(cx0, tg_y, seg_w, seg_h, ACCENT_SUBTLE))
        g.append(_text(opt, x=cx0 + seg_w // 2, y=tg_y + seg_h // 2, scale=2,
                       color=ACCENT_INK if on else LABEL_4, anchor=(0.5, 0.5)))
        _region("toggle_" + opt, cx0, tg_y - 4, seg_w, seg_h + 8,
                (lambda o=opt: _toggle_clock(o)))
    g.append(_rect(tg_x + seg_w, tg_y + 5, 1, seg_h - 10, SEPARATOR))

    # Hero clock.
    parts = _fmt_clock_parts()
    colon_on = (_local_ss() % 2) == 0
    _idle_refs["colon_on"] = colon_on
    time_str = _hero_clock_string(parts, colon_on)
    clock_y = 150
    hero = _hero_font()
    if hero is not None:
        # Single Label, scale=2 toward the 132px hero (base font is 66px).
        clk = _text(time_str, x=DISPLAY_W // 2, y=clock_y, scale=2, color=TEXT,
                    anchor=(0.5, 0.5), font=hero)
        if parts["is12"]:
            # Nudge the time lockup left to make room for the AM/PM suffix and
            # keep the whole thing optically centred.
            try:
                lock_w = clk.bounding_box[2] * 2
            except Exception:
                lock_w = len(time_str) * 70
            suffix_w = 48
            clk.anchored_position = (DISPLAY_W // 2 - suffix_w // 2, clock_y)
            g.append(clk)
            g.append(_text(parts["suffix"],
                           x=DISPLAY_W // 2 - suffix_w // 2 + lock_w // 2 + 14,
                           y=clock_y, scale=3, color=ACCENT, anchor=(0.0, 0.5)))
        else:
            g.append(clk)
    else:
        # Fallback: terminalio scaled x6 (~48px). Clearly the deviation path.
        clk = _text(time_str, x=DISPLAY_W // 2, y=clock_y, scale=6, color=TEXT,
                    anchor=(0.5, 0.5))
        g.append(clk)
        if parts["is12"]:
            g.append(_text(parts["suffix"], x=DISPLAY_W // 2 + len(time_str) * 18,
                           y=clock_y, scale=3, color=ACCENT, anchor=(0.0, 0.5)))
    _idle_refs["clock"] = clk

    # 56x3 accent rule under the clock at y=220.
    rule_w = 56
    g.append(_rect(DISPLAY_W // 2 - rule_w // 2, clock_y + 70, rule_w, 3,
                   ACCENT))

    # Bottom-left date.
    date_str = (_clock.get("date_str") or "").upper()
    if date_str:
        _tracked(g, date_str[:32], x=20, y=DISPLAY_H - 23, scale=1,
                 color=LABEL_3, anchor_y=0.5, tracking=2)

    # Bottom-right green dot + SSID. WARP-2047: draw NOTHING when the network
    # isn't known — the dot asserts "connected to this", so pairing it with an
    # invented name is the exact false-confidence this ticket closes. Mirrors
    # the host renderer's `if ssid:` gate. `connected_to` stays as a fallback
    # because it is an observed association, not a config read.
    wifi = state.get("wifi") or {}
    ssid = _household_ssid() or str(wifi.get("connected_to") or "").strip()
    if ssid:
        ssid_w = len(ssid) * 12  # scale=2 terminalio cell ~12px
        g.append(_circle(DISPLAY_W - 20 - ssid_w - 12, DISPLAY_H - 22, 3, GREEN))
        g.append(_text(ssid[:18], x=DISPLAY_W - 20, y=DISPLAY_H - 22, scale=2,
                       color=ACCENT, anchor=(1.0, 0.5)))

    # Seconds progress hairline along the bottom edge.
    sec = _local_ss()
    g.append(_rect(0, DISPLAY_H - 2, DISPLAY_W, 2, TRACK))
    g.append(_rect(0, DISPLAY_H - 2, max(2, int(DISPLAY_W * sec / 60)), 2,
                   ACCENT_DIM))

    # Tap anywhere (except the toggle) wakes to the system screen.
    _region("idle_wake", 0, 0, DISPLAY_W, DISPLAY_H,
            lambda: set_screen("system"))
    board.DISPLAY.root_group = g


def _toggle_clock(mode):
    _set_clock_mode(mode)
    _render_with_gc("idle")


# ---------------------------------------------------------------------------
# QR matrix (host-supplied; rendered into the system screen's white card)
# ---------------------------------------------------------------------------

def _render_qr_matrix_plain(g, matrix, ox, oy, module_px):
    """Paint the host-supplied QR matrix as black modules — NO card/frame.

    The white card + droplet-mark inset are drawn by _v3_qr_card; this just
    fills the dark modules. The matrix is ALWAYS host-supplied (the firmware
    never encodes a QR on-device — contract).

    WARP-638 (the main OOM fix): the whole matrix is drawn into a SINGLE
    ``displayio.Bitmap`` (size*module_px square) backed by one 2-colour
    palette and carried by one TileGrid. The previous renderer allocated one
    Bitmap + one Palette + one TileGrid PER ROW (3*N objects for an N-row
    matrix, e.g. ~75+ objects for a 25-row v2 QR) — the re-render on rotate /
    REQUEST_QR is exactly the path that OOMed the SAMD51 (`ERR:oom:system`).
    One contiguous bitmap is both far fewer heap objects and a single
    allocation the GC can place/track cheaply.
    """
    size = len(matrix)
    if size <= 0:
        return
    module_color = 0x0A0A1E   # very dark indigo; ~19:1 on white, scans as black
    dim = size * module_px
    bmp = displayio.Bitmap(dim, dim, 2)
    pal = displayio.Palette(2)
    pal[0] = WHITE
    pal[1] = module_color
    for row_idx, row in enumerate(matrix):
        y0 = row_idx * module_px
        for col_idx, v in enumerate(row):
            if v:
                x0 = col_idx * module_px
                for dy in range(module_px):
                    yy = y0 + dy
                    for dx in range(module_px):
                        bmp[x0 + dx, yy] = 1
    g.append(displayio.TileGrid(bmp, pixel_shader=pal, x=ox, y=oy))


def _request_qr():
    _send("REQUEST_QR")


def _rotate_key():
    # Contract: tell the host to roll the key; bridge does the UCI change and
    # pushes a fresh {"mode":"qr"} matrix back. Optimistically reset the local
    # TTL so the pill updates immediately; the next push corrects it.
    _send("ROTATE_KEY")
    state["wifi"]["key_ttl_seconds"] = 60 * 60
    if state.get("qr"):
        state["qr"]["ttl_seconds"] = 60 * 60
    _render_with_gc("system")


# ---------------------------------------------------------------------------
# Message (host-pushed notification — still supported)
# ---------------------------------------------------------------------------

def render_message():
    """Host-pushed notification card (mode:message — still supported)."""
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    # Minimal py-v3 header: mark + title eyebrow + hairline.
    _mark_poly(g, 26, 20, 12)
    title = str(state.get("msg_title") or "Message")[:24]
    g.append(_text(title, x=52, y=20, scale=2, color=TEXT, anchor=(0.0, 0.5)))
    _hairline(g, 20, 44, DISPLAY_W - 40, SEPARATOR)
    g.append(_rect(20, 54, DISPLAY_W - 40, DISPLAY_H - 54 - 16, SURFACE))
    yy = 66
    for line in (state.get("msg_lines") or [])[:8]:
        g.append(_text(str(line)[:52], x=32, y=yy, scale=2, color=TEXT))
        yy += 26
    _region("message_home", 0, 0, DISPLAY_W, DISPLAY_H,
            lambda: set_screen("system"))
    board.DISPLAY.root_group = g


# ---------------------------------------------------------------------------
# Power sequences (boot / shutdown / standby) — host-driven, modal.
# The vessel fills (boot) / drains (shutdown) with accent liquid; shutdown
# ends in a CRT collapse. The main loop advances state[...]["_frac"] each tick
# so the fill animates even on a bare {"mode":"boot"}; a host-pushed pct (boot)
# overrides the self-driven fraction. Geometry from design_handoff §4.
# ---------------------------------------------------------------------------

def _mark_vessel(g, x, y, size, frac):
    """Mark drawn as a vessel filled to `frac` (0..1) with accent liquid.

    vectorio has no clip; we approximate the liquid by painting the body
    polygon dim, then overlaying a SECOND body polygon whose vertices are
    clamped to at/below the liquid level (so only the filled portion shows in
    accent). Cheap: 2 polygons. Mirrors preview.html drawMarkLiquid intent.
    """
    mw = int(size * 52 / 60)
    xo = x + (size - mw) // 2

    def sx(px):
        return xo + int(px / 52 * mw)

    def sy(py):
        return y + int(py / 60 * size)

    body = [(26, 0), (44, 28), (36, 48), (16, 48), (8, 28)]
    # Empty shell (dim).
    g.append(vectorio.Polygon(pixel_shader=_palette(0x181828),
                              points=[(sx(px), sy(py)) for px, py in body],
                              x=0, y=0))
    frac = max(0.0, min(1.0, frac))
    if frac <= 0.01:
        return
    bottom_v = 48
    top_v = 0
    level_v = bottom_v - (bottom_v - top_v) * frac
    # Clamp each body vertex's y up to the liquid level (in viewbox space) so
    # the overlay only covers the filled lower portion.
    filled = [(px, py if py >= level_v else level_v) for px, py in body]
    g.append(vectorio.Polygon(pixel_shader=_palette(ACCENT),
                              points=[(sx(px), sy(py)) for px, py in filled],
                              x=0, y=0))


def render_boot():
    """Boot power sequence (design_handoff §4 boot).

    Vessel fills with accent liquid (fraction = host pct, else the self-driven
    state["boot"]["_frac"]); DROPLET wordmark; 4-stage status line; 184px
    progress bar; "Droplet OS · v2.4" footer. A host stage string overrides
    the derived stage label.
    """
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    boot = state.get("boot") or {}
    pct = boot.get("pct")
    if pct is not None:
        try:
            frac = max(0, min(100, int(pct))) / 100.0
        except (TypeError, ValueError):
            frac = boot.get("_frac", 0.0)
    else:
        frac = boot.get("_frac", 0.0)

    size = 116
    mx = (DISPLAY_W - size) // 2
    my = 44
    mb = my + int(size * 48 / 60)
    if frac >= 0.999:
        _mark_poly(g, size, mx, my)   # full accent mark
    else:
        _mark_vessel(g, mx, my, size, frac)

    _tracked(g, "DROPLET", x=DISPLAY_W // 2, y=mb + 22, scale=2, color=TEXT,
             anchor_y=0.5, tracking=5, align="center")

    stages = ("Mounting storage", "Starting network", "Loading models", "Ready")
    host_stage = boot.get("stage")
    if host_stage:
        status = str(host_stage)[:34]
        done = (pct is not None and pct >= 100) or status == "Ready"
    else:
        si = min(len(stages) - 1, int(frac * len(stages)))
        status = stages[si]
        done = si == len(stages) - 1
    g.append(_text(status, x=DISPLAY_W // 2, y=mb + 46, scale=1,
                   color=GREEN if done else LABEL_3, anchor=(0.5, 0.5)))
    detail = str(boot.get("detail") or "")[:40]
    if detail and not done:
        g.append(_text(detail, x=DISPLAY_W // 2, y=mb + 62, scale=1,
                       color=LABEL_4, anchor=(0.5, 0.5)))

    bw = 184
    bx = (DISPLAY_W - bw) // 2
    byy = mb + 70
    g.append(_rect(bx, byy, bw, 3, TRACK))
    fw = max(3, int(bw * frac))
    g.append(_rect(bx, byy, fw, 3, GREEN if done else ACCENT))

    g.append(_text("Droplet OS · v2.4", x=DISPLAY_W // 2, y=DISPLAY_H - 22,
                   scale=1, color=LABEL_4, anchor=(0.5, 0.5)))
    board.DISPLAY.root_group = g


def render_shutdown():
    """Shutdown power sequence (design_handoff §4 shutdown).

    Drains the vessel + a status line; once phase == 'halted' (or the
    self-driven _frac completes), a CRT collapse — content thins to a phosphor
    line, then a dot, then black. _frac runs 0..1 across the sequence.
    """
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    sd = state.get("shutdown") or {}
    halted = sd.get("phase") == "halted"
    frac = 1.0 if halted else sd.get("_frac", 0.0)

    size = 116
    mx = (DISPLAY_W - size) // 2
    my = 44
    mb = my + int(size * 48 / 60)
    collapse_start = 0.80
    if frac < collapse_start:
        drain = 1.0 - (frac / collapse_start)
        _mark_vessel(g, mx, my, size, drain)
        _tracked(g, "DROPLET", x=DISPLAY_W // 2, y=mb + 22, scale=2,
                 color=LABEL_2, anchor_y=0.5, tracking=5, align="center")
        stages = ("Stopping services", "Unmounting storage", "Powering off")
        reason = str(sd.get("reason") or "")
        if reason:
            status = reason[:34]
        else:
            si = min(len(stages) - 1, int((frac / collapse_start) * len(stages)))
            status = stages[si]
        g.append(_text(status, x=DISPLAY_W // 2, y=mb + 46, scale=1,
                       color=LABEL_3, anchor=(0.5, 0.5)))
    else:
        cp = (frac - collapse_start) / (1.0 - collapse_start)
        if cp < 0.55:
            h = int((1 - cp / 0.55) * 9 + 2)
            g.append(_rect(0, DISPLAY_H // 2 - h // 2, DISPLAY_W, h, PHOSPHOR))
        elif cp < 0.93:
            w = max(3, int((1 - (cp - 0.55) / 0.38) * DISPLAY_W + 3))
            g.append(_rect(DISPLAY_W // 2 - w // 2, DISPLAY_H // 2 - 1, w, 2,
                           PHOSPHOR))
        # else: black (frame already BG).
    board.DISPLAY.root_group = g


def render_standby():
    """Powered-off standby (design_handoff §4 standby): dim mark + STANDBY +
    'tap to power on'. A tap wakes via the existing boot path."""
    global touch_regions
    touch_regions = []
    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))
    size = 78
    mw = int(size * 52 / 60)
    mx = (DISPLAY_W - mw) // 2
    my = DISPLAY_H // 2 - int(size * 0.55)
    mb = my + int(size * 48 / 60)

    def sx(px):
        return mx + int(px / 52 * mw)

    def sy(py):
        return my + int(py / 60 * size)

    outer = [(sx(26), sy(0)), (sx(44), sy(28)), (sx(36), sy(48)),
             (sx(16), sy(48)), (sx(8), sy(28))]
    inner = [(sx(26), sy(0)), (sx(44), sy(28)), (sx(26), sy(36))]
    g.append(vectorio.Polygon(pixel_shader=_palette(0x141422),
                              points=outer, x=0, y=0))
    g.append(vectorio.Polygon(pixel_shader=_palette(0x1A1A30),
                              points=inner, x=0, y=0))
    _tracked(g, "STANDBY", x=DISPLAY_W // 2, y=mb + 20, scale=1, color=LABEL_4,
             anchor_y=0.5, tracking=3, align="center")
    g.append(_text("tap to power on", x=DISPLAY_W // 2, y=mb + 38, scale=1,
                   color=LABEL_3, anchor=(0.5, 0.5)))
    # Tapping standby asks the host to power on (mirrors the preview's
    # tap-to-boot); the host owns the actual power state.
    _region("standby_wake", 0, 0, DISPLAY_W, DISPLAY_H, _request_power_on)
    board.DISPLAY.root_group = g


def _request_power_on():
    _send("NAV:power_on")


def _valid_matrix(m):
    """Return `m` if it is a well-formed QR bit-matrix, else None.

    The host encodes and caps the matrices, but the serial wire is still
    just JSON: a malformed value (non-list, ragged rows) would raise
    mid-render — AFTER render_claim has released the live display tree —
    stranding the panel black on a modal screen (_render_with_gc only
    catches MemoryError, and the claim screen is exempt from the idle
    timeout). Validate up front; the 64-row cap mirrors the host-side
    firmware-tolerance contract (main.py ClaimRequest).
    """
    try:
        if not m or not isinstance(m, list) or len(m) > 64:
            return None
        n = len(m[0])
        if n == 0:
            return None
        for row in m:
            if not isinstance(row, list) or len(row) != n:
                return None
        return m
    except Exception:
        return None


def render_claim():
    """Onboarding claim screen (WARP-632 / ADR-017), design-handoff
    two-column layout ("PyPortal First Boot — Claim Code").

    Header band (mark + DROPLET wordmark, FIRST-TIME SETUP status), then two
    columns split by a hairline: LEFT is the hero — the claim code drawn as
    its dash-separated groups with accent dash bars between them, an accent
    rule and the numbered link steps; RIGHT is a white scan QR card. The foot
    carries the WAITING TO BE CLAIMED dots (animated by _claim_dots_tick —
    palette mutation only, no rebuild) over a 2px scan track. Tokens, mark and
    spacing match the boot/idle/system screens. Mirrors host display.py
    render_claim() 1:1.

    The QR is whichever single matrix the host pushed: the setup deep-link
    (claim["setup_qr_matrix"], `<setup_url>?c=<CODE>`) in the claim-only
    layout, or — when the Wi-Fi creds are supplied (WARP-819) — the Wi-Fi
    join QR with readable SSID/PSK under the card (camera-less manual join)
    and a leading "Join Wi-Fi" step. The firmware never encodes on-device;
    with no matrix at all the card degrades to the mark on white. A partial
    Wi-Fi block degrades to the claim-only layout.

    Modal + host-driven (not in the SCREENS carousel); the host navigates
    away once the box is claimed. Terminalio-only text — the 66px hero face
    doesn't fit the column, and a fixed bitmap face can't scale down.

    Deliberate descopes from the handoff card (revisit knowingly, not by
    accident): the bottom-left DEVICE id line (no device identity exists in
    the claim-frame contract), the claimed-success confirm screen
    (drawClaimed — needs a new orchestrator-pushed mode), and the header-dot
    pulse + scan-track shimmer (static; the WAITING dots are this screen's
    only motion — heap discipline).
    """
    global touch_regions
    touch_regions = []
    _claim_refs["dots"] = []
    _claim_refs["active"] = 0

    claim = state.get("claim") or {}
    code = str(claim.get("code") or "").strip().upper()
    setup_url = str(claim.get("setup_url") or "").strip()
    setup_matrix = _valid_matrix(claim.get("setup_qr_matrix"))
    wifi_matrix = _valid_matrix(claim.get("wifi_qr_matrix"))
    wifi_ssid = str(claim.get("wifi_ssid") or "").strip()
    wifi_psk = str(claim.get("wifi_psk") or "")
    has_wifi = bool(wifi_matrix and wifi_ssid)
    qr_matrix = wifi_matrix if has_wifi else setup_matrix
    has_qr = bool(qr_matrix)

    # OOM safety (WARP-638 pattern): release the prior frame's display tree
    # + gc BEFORE building this one — ALWAYS, not just on matrix frames. The
    # redesigned tree is the heaviest in the firmware (~100 elements), so a
    # matrix-less re-push holding two trees alive would be its own OOM risk
    # on the ~165 KB Titano heap. The matrix shape is validated above, so
    # nothing after this release can raise on malformed wire data and strand
    # the panel black (render errors on a modal screen never self-recover).
    board.DISPLAY.root_group = None
    gc.collect()

    g = displayio.Group()
    g.append(_rect(0, 0, DISPLAY_W, DISPLAY_H, BG))

    # ---- Header band: mark + wordmark, first-time-setup status -------------
    _mark_poly(g, 20, 20, 17)
    _tracked(g, "DROPLET", x=50, y=21, scale=1, color=LABEL_3, tracking=2)
    slw = _tracked(g, "FIRST-TIME SETUP", x=DISPLAY_W - 20, y=21, scale=1,
                   color=ACCENT, tracking=1, align="right")
    g.append(_circle(DISPLAY_W - 20 - slw - 12, 26, 3, ACCENT))
    g.append(_rect(20, 44, DISPLAY_W - 40, 1, SEPARATOR))

    # ---- Column divider -----------------------------------------------------
    div_x = 284
    g.append(_rect(div_x, 58, 1, DISPLAY_H - 58 - 26, SEPARATOR))

    # ================= LEFT — claim code hero + steps ========================
    _tracked(g, "CLAIM CODE", x=20, y=56, scale=1, color=ACCENT, tracking=2)

    # Hero code — dash-separated groups with accent dash bars between them.
    # terminalio is a fixed 6px cell, so the run is measured arithmetically;
    # drop the scale until the run fits the column (a CLAIM_CODE env override
    # can be longer than DRPL-XXXX-XXXX).
    code_y = 76
    left_max = div_x - 20 - 16
    groups = [grp for grp in code.split("-") if grp]
    if groups:
        gap, dash_w = 3, 8
        scale = 3
        while scale > 1:
            total = (sum(len(grp) * 6 * scale for grp in groups)
                     + (len(groups) - 1) * (gap * 2 + dash_w))
            if total <= left_max:
                break
            scale -= 1
        code_h = 12 * scale
        code_cy = code_y + code_h // 2
        cx = 20
        for i, grp in enumerate(groups):
            g.append(_text(grp, x=cx, y=code_cy, scale=scale, color=TEXT,
                           anchor=(0.0, 0.5)))
            cx += len(grp) * 6 * scale
            if i < len(groups) - 1:
                cx += gap
                _rounded_rect(g, cx, code_cy - 2, dash_w, 4, 2, ACCENT)
                cx += dash_w + gap
    else:
        # Host hasn't pushed a code yet — defensive placeholder.
        code_h = 36
        g.append(_text("----  ----", x=20, y=code_y + code_h // 2, scale=3,
                       color=LABEL_4, anchor=(0.0, 0.5)))

    # Accent rule under the code.
    _rounded_rect(g, 20, code_y + code_h + 14, 56, 3, 1, ACCENT)

    # Numbered link steps. With Wi-Fi creds the join step leads — a fresh
    # phone can't reach the setup URL before it's on the box's network.
    host = setup_url
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
            break
    host = host.rstrip("/")

    _tracked(g, "TO LINK THIS DEVICE", x=20, y=148, scale=1, color=LABEL_3,
             tracking=1)
    steps = []
    if has_wifi:
        steps.append(("Join Wi-Fi ", wifi_ssid[:18]))
    if host:
        # A long named-address hostname overflows the inline slot — wrap the
        # address onto its own line rather than truncating the /setup path
        # away (in the Wi-Fi layout this text is the only typed setup
        # pointer; the setup QR is deliberately off that card).
        steps.append(("Go to ", host[:37]))
    steps.append(("Enter the code above", ""))

    sy = 168
    for i, (lead, em) in enumerate(steps):
        _rounded_rect(g, 20, sy, 18, 18, 5, ACCENT_SUBTLE)
        g.append(_text(str(i + 1), x=29, y=sy + 9, scale=1, color=ACCENT_INK,
                       anchor=(0.5, 0.5)))
        g.append(_text(lead, x=46, y=sy + 9, scale=1, color=LABEL_2,
                       anchor=(0.0, 0.5)))
        if em and len(em) > 26:
            g.append(_text(em, x=46, y=sy + 23, scale=1,
                           color=ACCENT_INK, anchor=(0.0, 0.5)))
            sy += 14
        elif em:
            g.append(_text(em, x=46 + len(lead) * 6, y=sy + 9, scale=1,
                           color=ACCENT_INK, anchor=(0.0, 0.5)))
        sy += 28

    # ================= RIGHT — scan QR card ==================================
    rx = div_x + 16
    rw = DISPLAY_W - 20 - rx
    # The eyebrow stays honest: a card with no scannable matrix (older host
    # that doesn't send setup_qr_matrix, or the host's encode degrading)
    # must never instruct a scan that cannot work.
    if has_wifi:
        eyebrow_r = "SCAN TO JOIN WI-FI"
    elif has_qr:
        eyebrow_r = "SCAN TO CLAIM"
    else:
        eyebrow_r = "SETUP"
    _tracked(g, eyebrow_r, x=rx, y=56, scale=1, color=ACCENT, tracking=1)

    card_w = 128
    card_x = rx + (rw - card_w) // 2
    card_y = 72
    # The System screen's QR-card renderer, fed the claim's OWN matrix so the
    # claim screen never depends on a {"mode":"qr"} push. No matrix yet ->
    # mark-on-white placeholder (the layout still reads).
    _v3_qr_card(g, card_x, card_y, card_w, matrix=qr_matrix or [])

    cap_y = card_y + card_w + 12
    if has_wifi:
        g.append(_text("Joins this Droplet's Wi-Fi", x=rx + rw // 2, y=cap_y,
                       scale=1, color=LABEL_3, anchor=(0.5, 0.0)))
        # Readable creds — camera-less manual join (WARP-819). The PSK is the
        # thing a camera-less user types by hand, so it must be shown in FULL:
        # truncating a longer passphrase silently breaks the join. terminalio
        # is a fixed 6px cell at scale=1, so the card holds rw//6 chars per
        # line — wrap the PSK across as many lines as it needs.
        g.append(_text(wifi_ssid[:18], x=rx + rw // 2, y=cap_y + 17, scale=1,
                       color=TEXT, anchor=(0.5, 0.0)))
        psk_cpl = max(1, rw // 6)
        psk_y = cap_y + 34
        for i in range(0, len(wifi_psk), psk_cpl):
            g.append(_text(wifi_psk[i:i + psk_cpl], x=rx + rw // 2, y=psk_y,
                           scale=1, color=ACCENT_INK, anchor=(0.5, 0.0)))
            psk_y += 12
    else:
        g.append(_text("Opens setup on your phone" if has_qr
                       else "Use the address above",
                       x=rx + rw // 2, y=cap_y,
                       scale=1, color=LABEL_3, anchor=(0.5, 0.0)))

    # ---- Foot: waiting status + scan track ----------------------------------
    wlw = _tracked(g, "WAITING TO BE CLAIMED", x=DISPLAY_W - 20,
                   y=DISPLAY_H - 27, scale=1, color=ACCENT, tracking=1,
                   align="right")
    for i in range(3):
        # Dedicated palette per dot — _palette() caches by colour, and the
        # ticker mutates these in place (a shared palette would tint every
        # same-colour shape on screen).
        pal = displayio.Palette(1)
        pal[0] = ACCENT if i == 0 else ACCENT_FAINT
        dot = vectorio.Circle(pixel_shader=pal, radius=2,
                              x=int(DISPLAY_W - 20 - wlw - 22 + i * 7),
                              y=DISPLAY_H - 23)
        _claim_refs["dots"].append(dot)
        g.append(dot)

    # 2px scan track with a static accent segment (the waiting affordance).
    g.append(_rect(0, DISPLAY_H - 2, DISPLAY_W, 2, TRACK))
    g.append(_rect((DISPLAY_W - 90) // 2, DISPLAY_H - 2, 90, 2, ACCENT))

    board.DISPLAY.root_group = g


# WAITING TO BE CLAIMED dot ticker — the claim screen's only motion. Same
# cheap-update discipline as the idle colon: mutate the three dots' dedicated
# palettes in place, never rebuild the frame (a rebuild would churn the QR
# bitmap on the ~165 KB heap). Armed by render_claim, advanced from the main
# loop while on the claim screen, disarmed by set_screen on nav-away.
_claim_refs = {"dots": [], "active": 0, "last": 0.0}
_CLAIM_DOT_PERIOD_S = 0.4


def _claim_dots_tick(now_mono):
    if state.get("screen") != "claim" or not _claim_refs["dots"]:
        return
    if now_mono - _claim_refs["last"] < _CLAIM_DOT_PERIOD_S:
        return
    _claim_refs["last"] = now_mono
    _claim_refs["active"] = (_claim_refs["active"] + 1) % len(
        _claim_refs["dots"])
    for i, dot in enumerate(_claim_refs["dots"]):
        try:
            dot.pixel_shader[0] = (ACCENT if i == _claim_refs["active"]
                                   else ACCENT_FAINT)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

RENDERERS = {
    "system":   render_system,
    "idle":     render_idle,
    "message":  render_message,
    "boot":     render_boot,
    "shutdown": render_shutdown,
    "standby":  render_standby,
    "claim":    render_claim,
}

# Back-compat aliases — the host's existing bare-mode pushes still route. The
# old separate stats + qr screens are folded into "system", so stats/qr/wifi/
# cameras/drives/network/files/home all land there; logo → idle. This keeps
# the serial contract intact: device-bridge/display.py push {"mode":"stats"},
# {"mode":"qr"}, etc. unchanged and the firmware renders the combined screen.
_ALIASES = {
    "home": "system", "logo": "idle",
    "stats": "system", "qr": "system", "wifi": "system",
    "network": "system", "info": "system",
    "files": "system", "cameras": "system", "drives": "system",
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
    if name != "claim":
        # Disarm the claim dot ticker on nav-away (drops the refs so the old
        # frame's dots can be collected; render_claim re-arms on entry).
        _claim_refs["dots"] = []
    state["screen"] = name
    # Brightness: dim on idle, full elsewhere
    set_brightness(IDLE_BRIGHTNESS if name == "idle" else ACTIVE_BRIGHTNESS)
    _render_with_gc(name)
    _send("NAV:" + name)
    # The combined system screen carries the Wi-Fi QR card, so pull a fresh
    # matrix from the host on entry (the host encodes the QR; the firmware
    # never does — contract). Cheap round-trip via the existing REQUEST_QR.
    if name == "system":
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
        for k in ("cpu", "mem", "disk", "temp", "ip", "uptime", "hostname",
                  "now", "wan_latency_ms", "lan_clients"):
            if k in data and data[k] is not None:
                state[k] = data[k]
        # Append latest cpu/mem/disk/temp values to the sparkline rings (the
        # combined screen draws the 48-sample CPU history).
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
        if state["screen"] == "system":
            _render_with_gc("system")
        elif state["screen"] == "idle" and _idle_refs.get("clock") is not None:
            # Keep the idle hero clock in sync with the latest push without a
            # full re-render (uses the 12/24 formatter + current colon state).
            _idle_refs["clock"].text = _hero_clock_string(
                _fmt_clock_parts(), _idle_refs.get("colon_on", True))
    elif mode == "wifi":
        # Merge — the old fields (networks, adapter, etc.) live alongside
        # new ones (ssid, clients, channel, band, key_ttl_seconds, password).
        for k, v in data.items():
            state["wifi"][k] = v
        if state["screen"] == "system":
            _render_with_gc("system")
    elif mode == "files":
        state["files"] = data
        if state["screen"] == "system":
            _render_with_gc("system")
    elif mode == "cameras":
        state["cameras"] = data
        _sync_alerts_from_cameras()
        if state["screen"] == "system":
            _render_with_gc("system")
    elif mode == "drives":
        state["drives"] = data
        if state["screen"] == "system":
            _render_with_gc("system")
    elif mode == "qr":
        state["qr"] = data
        if state["screen"] == "system":
            _render_with_gc("system")
    elif mode == "alert":
        _push_alert(data)
        if state["screen"] == "system":
            _render_with_gc("system")
    elif mode == "message":
        state["msg_title"] = data.get("title", "")
        state["msg_lines"] = data.get("lines", []) or []
        set_screen("message")
    elif mode == "boot":
        # Merge so a {stage} update keeps a previously-pushed pct, etc. Reset
        # the self-driven fill anchor when a boot is (re)started so the vessel
        # animates from empty unless the host is driving pct directly.
        if state["screen"] != "boot":
            state["boot"]["_frac"] = 0.0
            state["boot"]["_t0"] = time.monotonic()
        for k in ("stage", "detail", "pct"):
            if k in data:
                state["boot"][k] = data[k]
        set_screen("boot")
    elif mode == "shutdown":
        if state["screen"] != "shutdown":
            state["shutdown"]["_frac"] = 0.0
            state["shutdown"]["_t0"] = time.monotonic()
        for k in ("reason", "phase"):
            if k in data:
                state["shutdown"][k] = data[k]
        set_screen("shutdown")
    elif mode == "claim":
        # WARP-632: merge so a partial push (e.g. just the code) keeps the URL.
        # WARP-819: the host may also send the Wi-Fi-connect QR matrix + ssid +
        # psk so the claim screen shows how to join the box's Wi-Fi. Unlike
        # code/setup_url, the Wi-Fi creds must NOT persist across a push that
        # omits them: when the bridge is down the host sends a {code,setup_url}-
        # only frame, and a kept-over stale QR/password could no longer match
        # the live AP. So RESET the wifi_* keys BEFORE the merge — absent keys
        # then clear, present keys land. (The host already only puts a wifi_*
        # key on the wire when it is non-empty.)
        # The setup deep-link matrix embeds the claim code in its payload, so
        # like the wifi_* keys it must not survive a push that omits it — a
        # stale matrix would deep-link a code that no longer matches the hero.
        state["claim"]["setup_qr_matrix"] = None
        state["claim"]["wifi_qr_matrix"] = None
        state["claim"]["wifi_ssid"] = ""
        state["claim"]["wifi_psk"] = ""
        for k in ("code", "setup_url", "setup_qr_matrix",
                  "wifi_qr_matrix", "wifi_ssid", "wifi_psk"):
            if k in data:
                state["claim"][k] = data[k]
        set_screen("claim")
    elif mode == "brightness":
        set_brightness(msg.get("value", ACTIVE_BRIGHTNESS))
    elif mode == "ping":
        # WARP-638: report free heap so on-device headroom is verifiable from
        # the host after flashing (you can't read gc.mem_free() off the
        # SAMD51 otherwise). gc.collect() first so the number is reclaimed-
        # free, i.e. the real ceiling a render has to fit under vs the 18 KB
        # _HEAP_PANIC_BYTES floor. Emitted as a side-channel line in addition
        # to the OK ack so the existing ping liveness check is unaffected.
        gc.collect()
        _send("MEM:{}".format(gc.mem_free()))
    else:
        return "ERR:unknown_mode:{}".format(mode)
    return "OK"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Restore the persisted 12/24 mode before the first render (best-effort;
    # a read-only/USB-mounted FS just leaves the '24' default).
    _load_clock_mode()
    # Open on the boot screen so a cold power-on reads the boot sequence
    # immediately. The host moves us off boot once it's ready (or after its
    # readiness timeout). boot/shutdown/standby are modal — not in SCREENS —
    # so the idle-timeout + swipe logic below treats them as no-ops until the
    # host navigates away.
    state["boot"]["_t0"] = time.monotonic()
    set_screen("boot")
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
    last_anim_tick = 0.0

    last_idle_colon = None
    # Self-driven power-sequence durations (ms). A host-pushed boot pct
    # overrides the boot fill; otherwise the vessel fills/drains on these.
    boot_fill_ms = 3000.0
    shut_seq_ms = 2350.0
    while True:
        now_mono = time.monotonic()

        # Idle clock tick — per-second colon blink on the hero (design_handoff
        # §1). Cheap: rewrite the single hero Label's .text; skip when nothing
        # changed. The minute itself comes from the monotonic clock anchor.
        if (state["screen"] == "idle"
                and _idle_refs.get("clock") is not None
                and now_mono - last_idle_tick >= 0.5):
            last_idle_tick = now_mono
            try:
                colon_on = (_local_ss() % 2) == 0
                if colon_on != last_idle_colon:
                    _idle_refs["colon_on"] = colon_on
                    _idle_refs["clock"].text = _hero_clock_string(
                        _fmt_clock_parts(), colon_on)
                    last_idle_colon = colon_on
            except Exception:
                pass

        # Claim-screen waiting dots — palette mutation only (see
        # _claim_dots_tick); interval-gated internally.
        if state["screen"] == "claim":
            _claim_dots_tick(now_mono)

        # Power-sequence self-animation. Advance the fill/drain fraction and
        # re-render at ~12.5fps while a boot/shutdown is up and not host-driven
        # by pct. A bare {"mode":"boot"} thus still shows the liquid fill.
        if (state["screen"] in ("boot", "shutdown")
                and now_mono - last_anim_tick >= 0.08):
            last_anim_tick = now_mono
            try:
                if state["screen"] == "boot" and state["boot"].get("pct") is None:
                    el = (now_mono - state["boot"].get("_t0", now_mono)) * 1000
                    state["boot"]["_frac"] = min(1.0, el / boot_fill_ms)
                    _render_with_gc("boot")
                elif state["screen"] == "shutdown" \
                        and state["shutdown"].get("phase") != "halted":
                    el = (now_mono - state["shutdown"].get("_t0", now_mono)) * 1000
                    state["shutdown"]["_frac"] = min(1.0, el / shut_seq_ms)
                    _render_with_gc("shutdown")
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
        # Skip the host-driven lifecycle screens (boot/shutdown): they stay up
        # until the host navigates away, so we don't self-drop to idle while a
        # cold boot or a shutdown is in progress.
        if (state["screen"] != "idle" and
                state["screen"] not in LIFECYCLE_SCREENS and
                (time.monotonic() - last_activity) >= IDLE_TIMEOUT_S):
            state["events_open"] = False
            set_screen("idle")

        time.sleep(0.03)


if __name__ == "__main__":
    main()
