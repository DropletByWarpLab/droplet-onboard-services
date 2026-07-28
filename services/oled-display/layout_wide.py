"""
Wide-panel layout for the rack status bar (1424x280, 5.09:1).

Implements RACK-STATUS-PANEL-DESIGN-BRIEF.md §2-§6. The 480x320 renderers in
display.py are NOT touched: they are authored against hardcoded 480-wide
coordinates (render_system's divider at x=288, footers at y=244 AND
HEIGHT-24 — which collide at height 280), so this is a parallel layout
selected by geometry, not a rewrite.

Dispatch, from display.py's render_* methods:

    if layout_wide.is_wide():
        return layout_wide.render_status(self, now=now)

Keying on aspect ratio rather than a global flag means a box with two panels
of different shapes still works.

Tokens, fonts and primitives are reused verbatim from display.py — no new
colours, no new font face. See the design brief §4 for why.
"""

from __future__ import annotations

import logging
import os
from typing import Any, List, Optional, Tuple

from PIL import Image, ImageDraw

logger = logging.getLogger("droplet.tft.wide")

# Lazy handle on display.py. It imports us (inside its render methods), so a
# module-level `from display import ...` would be circular.
_D: Any = None


def _d():
    global _D
    if _D is None:
        import display as _mod
        _D = _mod
    return _D


WIDE_ASPECT_THRESHOLD = 3.0


def is_wide() -> bool:
    d = _d()
    return d.HEIGHT > 0 and (d.WIDTH / d.HEIGHT) >= WIDE_ASPECT_THRESHOLD


# ---------------------------------------------------------------------------
# Grid — design brief §2
# ---------------------------------------------------------------------------
# WARP-1644 — THE SAFE AREA.
#
# The grid used to be literals derived from a 1424px framebuffer (MARGIN=28,
# RAIL_X=1204, CONTENT_R=1180, COL_PITCH=98, DIVIDERS=(408,800,996)). That
# quietly assumed every framebuffer pixel reaches the viewer's eye. On this
# panel it does not — the bezel/driver board eats a strip on each side, and
# the founder's first look at the real hardware was content running off both
# edges.
#
# Nudging MARGIN would not have fixed it: the action rail was pinned to the
# right edge (RAIL_X + RAIL_W == WIDTH), so the QR card and its caption were
# exactly what got clipped, and MARGIN does not move them.
#
# So the whole grid now derives from a safe area. Two consequences worth
# knowing:
#   * the inset is ENV-TUNABLE, because the right value is a property of this
#     panel + bezel, not of the software — a second unit with a different
#     bezel should not need a rebuild.
#   * geometry is computed PER RENDER, not at import. The layout already
#     claims to be geometry-keyed so a box with two differently-shaped panels
#     works; import-time constants silently broke that promise (and stopped
#     tests being able to monkeypatch WIDTH).
SAFE_INSET_X = int(os.environ.get("PANEL_SAFE_INSET_X", "30"))
# Nothing has reported vertical clipping, so this defaults off — but it is
# plumbed, because the next bezel probably will.
SAFE_INSET_Y = int(os.environ.get("PANEL_SAFE_INSET_Y", "0"))

DESIGN_MARGIN = 28          # breathing room INSIDE the safe area
GUTTER = 24
RAIL_W = 220                # fixed action rail
COLUMNS = 12


class _Geom:
    """Resolved layout geometry for the current panel + inset."""

    __slots__ = ("left", "content_r", "rail_x", "rail_w", "right",
                 "pitch", "band_a_rule", "band_b_top", "band_b_bot",
                 "band_c_rule", "band_c_y", "eyebrow_y", "top", "bottom",
                 "cells", "dividers")

    def col_x(self, n: int) -> int:
        """Left edge of column n (1-based)."""
        return int(round(self.left + (n - 1) * self.pitch))

    def span(self, cols: int) -> int:
        """Width of a `cols`-wide span."""
        return int(round(cols * self.pitch - GUTTER))


_GEOM_CACHE: dict = {}


def geom() -> "_Geom":
    d = _d()
    key = (d.WIDTH, d.HEIGHT, SAFE_INSET_X, SAFE_INSET_Y)
    hit = _GEOM_CACHE.get(key)
    if hit is not None:
        return hit

    g = _Geom()
    g.left = SAFE_INSET_X + DESIGN_MARGIN
    g.right = d.WIDTH - SAFE_INSET_X - DESIGN_MARGIN
    g.rail_w = RAIL_W
    g.rail_x = g.right - g.rail_w
    g.content_r = g.rail_x - GUTTER
    # Float pitch over the usable width: the column grid stretches to fit the
    # safe area instead of overflowing it.
    g.pitch = (g.content_r - g.left + GUTTER) / COLUMNS

    g.top = SAFE_INSET_Y
    g.bottom = d.HEIGHT - SAFE_INSET_Y
    g.band_a_rule = g.top + 46
    g.band_b_top = g.top + 62
    g.band_b_bot = g.bottom - 52
    g.band_c_rule = g.bottom - 40
    g.band_c_y = g.bottom - 32
    g.eyebrow_y = g.band_b_top

    # Cells, in the design's priority order, left to right.
    g.cells = {
        "reach":    (g.col_x(1), g.span(4)),
        "health":   (g.col_x(5), g.span(4)),
        "services": (g.col_x(9), g.span(2)),
        "netstore": (g.col_x(11), g.span(2)),
    }
    # Dividers sit in the gutter between adjacent cells.
    order = ("reach", "health", "services", "netstore")
    g.dividers = tuple(
        (g.cells[a][0] + g.cells[a][1] + g.cells[b][0]) // 2
        for a, b in zip(order, order[1:])
    )
    _GEOM_CACHE[key] = g
    return g


# ---------------------------------------------------------------------------
# State pill — design brief §3 Band A
# ---------------------------------------------------------------------------
def _pill_style(state: str) -> Tuple[str, tuple, tuple]:
    d = _d()
    return {
        "live":     ("LIVE",     d.V3_ACCENT_SUBTLE, d.V3_ACCENT),
        "setup":    ("SETUP",    d.V3_ACCENT_SUBTLE, d.V3_ACCENT_INK),
        "degraded": ("DEGRADED", d.V3_ORANGE_SUBTLE, d.V3_ORANGE),
        "alert":    ("ALERT",    (0x2E, 0x0F, 0x0E), d.V3_RED),
        "updating": ("UPDATING", d.V3_ACCENT_SUBTLE, d.V3_ACCENT),
    }.get(state, ("LIVE", d.V3_ACCENT_SUBTLE, d.V3_ACCENT))


def _eyebrow(draw, text: str, x: int, y: Optional[int] = None,
             fill=None) -> None:
    d = _d()
    if y is None:
        y = geom().eyebrow_y
    d._v3_text(draw, text, x, y, font=d._get_font(9, weight="bold"),
               fill=fill or d.V3_LABEL3, tracking=1.6)


def _wrap(draw, text: str, font, max_w: int) -> List[str]:
    """Greedy word wrap. PIL has none, and an unwrapped sentence on this panel
    does not just look bad — it runs straight off the content area and under
    the QR rail."""
    d = _d()
    words, lines, cur = str(text).split(), [], ""
    for word in words:
        candidate = f"{cur} {word}".strip()
        if cur and d._v3_text_width(draw, candidate, font) > max_w:
            lines.append(cur)
            cur = word
        else:
            cur = candidate
    if cur:
        lines.append(cur)
    return lines


def _fit_font(draw, text: str, max_w: int, start: int, floor: int = 14,
              weight: str = "heavy", tracking: float = 0.0):
    """Step a face down until `text` fits `max_w`. Same approach render_claim
    already uses for the claim code — hostnames vary in length by 3x."""
    d = _d()
    size = start
    while size > floor:
        f = d._get_font(size, weight=weight)
        if d._v3_text_width(draw, text, f, tracking) <= max_w:
            return f
        size -= 1
    return d._get_font(floor, weight=weight)


# ---------------------------------------------------------------------------
# QR — design brief §5
# ---------------------------------------------------------------------------
QR_CARD = 176
QR_MIN_MODULE_PX = 4          # hard floor; below this it stops scanning reliably
QR_MAX_VERSION = 4            # version 4 + 8 quiet modules = 41 -> 4px = 164px

# Measured against the `qrcode` encoder, ECC M, at the 4px floor:
#   version 2 -> 26 bytes | 38 alnum
#   version 3 -> 42 bytes | 61 alnum
#   version 4 -> 62 bytes | 90 alnum   <- the cap
# So the default claim link (~56 bytes) fits comfortably; a long *named
# address* host is what pushes past it. Uppercase-only payloads switch the
# encoder to alphanumeric mode and buy ~45% more room.
QR_BYTE_BUDGET = 62


def render_qr(payload: str, card: int = QR_CARD,
              ecc: str = "M") -> Tuple[Optional[Image.Image], int]:
    """Render `payload` as a QR bitmap sized for the rail.

    Returns (image, module_px). module_px of 0 means we refused — the payload
    is too long to render at >= QR_MIN_MODULE_PX and would produce a code
    nobody can scan. Callers should surface the fallback text and log, never
    paint an unscannable card.
    """
    try:
        import qrcode
        from qrcode.constants import (ERROR_CORRECT_L, ERROR_CORRECT_M,
                                      ERROR_CORRECT_Q)
    except ImportError:
        logger.warning("qrcode unavailable — no QR")
        return None, 0

    level = {"L": ERROR_CORRECT_L, "M": ERROR_CORRECT_M,
             "Q": ERROR_CORRECT_Q}.get(ecc, ERROR_CORRECT_M)
    qr = qrcode.QRCode(version=None, error_correction=level,
                       box_size=1, border=0)
    qr.add_data(payload)
    qr.make(fit=True)

    modules = qr.get_matrix()
    n = len(modules)
    quiet = 4
    total = n + quiet * 2
    module_px = card // total

    if module_px < QR_MIN_MODULE_PX:
        logger.error(
            "QR payload is %d bytes -> version %s (%d modules); at a %dpx card "
            "that is %dpx/module, below the %dpx floor. Budget is ~%d bytes "
            "(more if the payload is uppercase-only). Shorten it at the source "
            "— NOT by shrinking the quiet zone.",
            len(payload), qr.version, n, card, module_px, QR_MIN_MODULE_PX,
            QR_BYTE_BUDGET)
        return None, 0
    if qr.version > QR_MAX_VERSION:
        logger.warning("QR version %s exceeds the design cap of %d",
                       qr.version, QR_MAX_VERSION)

    size = total * module_px
    img = Image.new("RGB", (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    off = quiet * module_px
    for ry, row in enumerate(modules):
        for rx, on in enumerate(row):
            if on:
                x0 = off + rx * module_px
                y0 = off + ry * module_px
                draw.rectangle([x0, y0, x0 + module_px - 1,
                                y0 + module_px - 1], fill=(0, 0, 0))
    return img, module_px


def render_rail(disp, draw: ImageDraw.ImageDraw, img: Image.Image, *,
                payload: str, caption: str, headline: str,
                fallback: str, ecc: str = "M") -> None:
    """The fixed right-hand action rail: QR card + caption + typed fallback."""
    d = _d()
    g = geom()
    draw.rectangle([g.rail_x, 0, d.WIDTH, d.HEIGHT], fill=d.V3_PANEL)
    draw.rectangle([g.rail_x, 0, g.rail_x, d.HEIGHT], fill=d.V3_SEP)

    card_x = g.rail_x + (g.rail_w - QR_CARD) // 2
    card_y = 30
    d._rrect(draw, card_x, card_y, QR_CARD, QR_CARD, 14, fill=d.V3_WHITE)

    qr_img, module_px = render_qr(payload, ecc=ecc)
    if qr_img is not None:
        px = card_x + (QR_CARD - qr_img.width) // 2
        py = card_y + (QR_CARD - qr_img.height) // 2
        img.paste(qr_img, (px, py))
        # A 22px mark over a ~164px code occludes <2% of the area; ECC M
        # tolerates ~15%. ECC L has no headroom to spare, so skip it there.
        if ecc != "L":
            d.draw_droplet_mark(draw, card_x + QR_CARD // 2 - 11,
                                card_y + QR_CARD // 2 - 11, 22,
                                primary=d.V3_ACCENT, highlight=d.V3_ACCENT_INK)
    else:
        d._v3_text(draw, "SEE ADDRESS BELOW", card_x + QR_CARD // 2,
                   card_y + QR_CARD // 2, font=d._get_font(11, weight="bold"),
                   fill=(0x40, 0x40, 0x48), anchor="mm")

    cx = g.rail_x + g.rail_w // 2
    d._v3_text(draw, caption, cx, 216, font=d._get_font(9, weight="bold"),
               fill=d.V3_ACCENT, anchor="ma", tracking=1.6)
    d._v3_text(draw, headline, cx, 232, font=d._get_font(13, weight="bold"),
               fill=d.V3_LABEL2, anchor="ma")
    # The typed path must never disappear: glare, bad angle, camera-less phone.
    d._v3_text(draw, fallback, cx, 250, font=d._get_font(11),
               fill=d.V3_LABEL4, anchor="ma")


# ---------------------------------------------------------------------------
# Chrome + foot rails
# ---------------------------------------------------------------------------
def _render_chrome(disp, draw, now, state: str) -> None:
    d = _d()
    g = geom()
    d.draw_droplet_mark(draw, g.left, 12, 22,
                        primary=d.V3_ACCENT, highlight=d.V3_ACCENT_INK)
    d._v3_text(draw, "DROPLET", g.left + 30, 16, font=d._get_font(9, weight="bold"),
               fill=d.V3_LABEL3, tracking=2)
    # The device label doubles as the way into the DEBUG/recovery screen.
    # Deliberately a small, unlabelled target rather than a visible button:
    # the LIVE screen is what belongs on a rack front, and the people who need
    # the recovery path are the people who have been told where it is.
    d._v3_text(draw, "WARP LAB · MINI-RACK", g.left + 104, 16,
               font=d._get_font(9), fill=d.V3_LABEL4, tracking=1.2)
    with disp._touch_regions_lock:
        disp._touch_regions.append(
            d.TouchRegion("debug_enter", g.left + 96, g.top, 160, 46, disp._go_debug))

    label, fill, ink = _pill_style(state)
    pf = d._get_font(10, weight="bold")
    pw = int(d._v3_text_width(draw, label, pf, 1.2)) + 24
    d._rrect(draw, g.left + 312, 12, pw, 22, 11, fill=fill)
    d._v3_text(draw, label, g.left + 312 + pw // 2, 17, font=pf, fill=ink,
               anchor="ma", tracking=1.2)

    clk = disp._fmt_clock_parts(now)["str"]
    cf = d._get_font(20, weight="heavy")
    d._v3_text(draw, clk, g.content_r, 10, font=cf, fill=d.V3_LABEL2, anchor="ra")
    clk_w = d._v3_text_width(draw, clk, cf)

    date = (now.strftime("%a %d %b") if now else "").upper()
    date_x = int(g.content_r - clk_w - 16)
    d._v3_text(draw, date, date_x, 18, font=d._get_font(9, weight="bold"),
               fill=d.V3_LABEL4, anchor="ra", tracking=1.4)

    open_count = disp._open_alerts_count()
    if open_count:
        date_w = d._v3_text_width(draw, date, d._get_font(9, weight="bold"), 1.4)
        bx, by, br = int(date_x - date_w - 24), 23, 11
        draw.ellipse([bx - br, by - br, bx + br, by + br], fill=d.V3_RED)
        d._v3_text(draw, "!", bx, by, font=d._get_font(15, weight="heavy"),
                   fill=d.V3_WHITE, anchor="mm")
        with disp._touch_regions_lock:
            disp._touch_regions.append(d.TouchRegion(
                "alert_badge", bx - br - 6, by - br - 6, br * 2 + 12,
                br * 2 + 12, disp._open_drawer))

    draw.rectangle([g.left, g.band_a_rule, g.content_r, g.band_a_rule], fill=d.V3_SEP)


def _render_foot(disp, draw, v: dict) -> None:
    d = _d()
    g = geom()
    draw.rectangle([g.left, g.band_c_rule, g.content_r, g.band_c_rule], fill=d.V3_SEP)
    left = " · ".join(str(p) for p in (
        v.get("hostname", "-"),
        v.get("ip", "-"),
        "up " + str(v.get("uptime", "-")),
        v.get("version", "—"),
    ))
    d._v3_text(draw, left, g.left, g.band_c_y, font=d._get_font(11),
               fill=d.V3_LABEL4)
    event = v.get("last_event")
    if event:
        d._v3_text(draw, str(event), g.content_r, g.band_c_y,
                   font=d._get_font(11), fill=d.V3_LABEL3, anchor="ra")


# ---------------------------------------------------------------------------
# Cells — design brief §3
# ---------------------------------------------------------------------------
def _num(v, suffix: str = "") -> str:
    """Missing data renders as an em dash, NEVER as 0. A fake zero on a status
    panel is worse than an obvious gap — see build plan PR-5."""
    return "—" if v is None else f"{int(v)}{suffix}"


def _cell_reach(disp, draw, v: dict) -> None:
    d = _d()
    g = geom()
    x, w = g.cells["reach"]
    _eyebrow(draw, "REACH", x)

    host = str(v.get("public_host") or v.get("hostname") or "-")
    d._v3_text(draw, host, x, 80, font=_fit_font(draw, host, w, 30),
               fill=d.V3_TEXT)
    d._v3_text(draw, str(v.get("ip", "-")), x, 124,
               font=d._get_font(22, weight="bold"), fill=d.V3_LABEL2)

    # WAN chip. WARP-1643: `wan_latency_ms` is SEEDED as 0 in _v3 and never
    # emitted by _gather_stats, so `.get()` hands back a 0 that was never
    # measured — and the panel printed "ONLINE 0 ms" as though it were a
    # reading. `or None` collapses that seeded zero to "unknown".
    #
    # A real sub-millisecond WAN RTT does not exist, so treating 0 as "no
    # measurement" costs nothing and cannot hide a true value. Fixed here
    # rather than by re-seeding _v3 to None: the 480x320 render_system does
    # `v.get("wan_latency_ms", 0)` and would start printing "None".
    lat = v.get("wan_latency_ms") or None
    online = v.get("wan_online")
    if online is False:
        cw = _chip(draw, x, 164, "NO INTERNET", d.V3_RED, (0x2E, 0x0F, 0x0E))
    else:
        txt = "ONLINE" if lat is None else f"ONLINE {int(lat)} ms"
        cw = _chip(draw, x, 164, txt, d.V3_GREEN, (0x08, 0x24, 0x12))

    tls_days = v.get("tls_days")
    if tls_days is not None:
        warn = tls_days < 14
        _chip(draw, x + cw + 10, 164, f"TLS {int(tls_days)} d",
              d.V3_ORANGE if warn else d.V3_ACCENT,
              d.V3_ORANGE_SUBTLE if warn else d.V3_ACCENT_SUBTLE)

    d._v3_text(draw, "/dashboard", x, 200, font=d._get_font(12),
               fill=d.V3_LABEL3)


def _chip(draw, x: int, y: int, text: str, ink, fill) -> int:
    d = _d()
    f = d._get_font(10, weight="bold")
    w = int(d._v3_text_width(draw, text, f, 1.2)) + 22
    d._rrect(draw, x, y, w, 22, 11, fill=fill)
    d._v3_text(draw, text, x + 11, y + 5, font=f, fill=ink, tracking=1.2)
    return w


def _cell_health(disp, draw, v: dict) -> None:
    d = _d()
    g = geom()
    x, w = g.cells["health"]
    _eyebrow(draw, "LOAD", x)
    d._v3_text(draw, _num(v.get("cpu"), "%"), x, 74,
               font=d._get_font(60, weight="heavy"), fill=d.V3_TEXT,
               tracking=-2)

    sp = v.get("sparks_cpu") or []
    sx, sy, sh = x, 146, 36
    draw.rectangle([sx, sy + sh, sx + w, sy + sh], fill=d.V3_SEP)
    if len(sp) >= 2:
        lo, hi = min(sp), max(sp)
        rng = max(1.0, hi - lo)
        pts = [(sx + (i / (len(sp) - 1)) * w,
                sy + sh - ((val - lo) / rng) * sh)
               for i, val in enumerate(sp)]
        draw.polygon(pts + [(sx + w, sy + sh), (sx, sy + sh)],
                     fill=d.V3_SPARK_FILL)
        draw.line(pts, fill=d.V3_ACCENT, width=2, joint="curve")

    cols = (("MEM", _num(v.get("mem"), "%")),
            ("DISK", _num(v.get("disk"), "%")),
            ("TEMP", _num(v.get("temp"), "°")),
            ("GPU", _num(v.get("gpu"), "%")))
    cw = w / 4
    for i, (label, val) in enumerate(cols):
        cx = int(x + i * cw)
        _eyebrow(draw, label, cx, 190)
        d._v3_text(draw, val, cx, 202, font=d._get_font(24, weight="heavy"),
                   fill=d.V3_TEXT)


def _cell_services(disp, draw, v: dict) -> None:
    """The highest-value cell: nothing on the panel today says a container is
    down. Data source lands in build-plan PR-5."""
    d = _d()
    g = geom()
    x, w = g.cells["services"]
    _eyebrow(draw, "SERVICES", x)

    svc = v.get("services") or {}
    up, total = svc.get("up"), svc.get("total")
    degraded: List[dict] = list(svc.get("degraded") or [])
    core_down = any(s.get("core") for s in degraded)

    if up is None or total is None:
        hero, ink, summary = "—", d.V3_LABEL4, "no data"
    else:
        hero = f"{up}/{total}"
        ink = (d.V3_RED if core_down else
               d.V3_ORANGE if up < total else d.V3_GREEN)
        summary = ("all healthy" if not degraded else
                   f"{len(degraded)} degraded")
    d._v3_text(draw, hero, x, 76, font=d._get_font(40, weight="heavy"), fill=ink)
    d._v3_text(draw, summary, x, 124, font=d._get_font(12), fill=d.V3_LABEL3)

    # Core-first, then alphabetical. Never truncate silently — 4+ collapses to
    # two rows and an explicit "+N more".
    degraded.sort(key=lambda s: (not s.get("core"), str(s.get("name", ""))))
    rows = degraded[:3]
    overflow = 0
    if len(degraded) > 3:
        rows, overflow = degraded[:2], len(degraded) - 2

    for i, s in enumerate(rows):
        y = 146 + i * 26
        dot = d.V3_RED if s.get("core") else d.V3_ORANGE
        draw.ellipse([x, y + 4, x + 6, y + 10], fill=dot)
        d._v3_text(draw, str(s.get("name", "?"))[:14], x + 14, y,
                   font=d._get_font(13, weight="bold"), fill=d.V3_TEXT)
        d._v3_text(draw, str(s.get("state", ""))[:16], x + 14, y + 14,
                   font=d._get_font(11), fill=d.V3_LABEL3)
    if overflow:
        d._v3_text(draw, f"+{overflow} more", x, 194, font=d._get_font(11),
                   fill=d.V3_LABEL3)


def _cell_netstore(disp, draw, v: dict) -> None:
    d = _d()
    g = geom()
    x, w = g.cells["netstore"]
    wifi = v.get("wifi") or {}
    cams = v.get("cameras") or {}
    store = v.get("storage") or {}

    _eyebrow(draw, "NETWORK", x)
    d._v3_text(draw, str(wifi.get("ssid") or "—")[:14], x, 76,
               font=d._get_font(18, weight="bold"), fill=d.V3_TEXT)
    detail = " · ".join(p for p in (
        wifi.get("band") or None,
        f"ch {wifi['channel']}" if wifi.get("channel") else None,
        f"{wifi['clients']} clients" if wifi.get("clients") is not None else None,
    ) if p)
    d._v3_text(draw, detail or "—", x, 100, font=d._get_font(11),
               fill=d.V3_LABEL3)
    draw.rectangle([x, 120, x + w, 120], fill=d.V3_SEP)

    _eyebrow(draw, "STORAGE", x, 130)
    used, cap = store.get("used_tb"), store.get("total_tb")
    d._v3_text(draw, "—" if cap is None else f"{used:.1f} / {cap:.1f} TB",
               x, 144, font=d._get_font(20, weight="bold"), fill=d.V3_TEXT)
    d._rrect(draw, x, 172, w, 6, 3, fill=d.V3_TRACK)
    if cap:
        frac = max(0.0, min(1.0, (used or 0) / cap))
        bar = d.V3_RED if frac >= 0.92 else d.V3_ORANGE if frac >= 0.80 \
            else d.V3_ACCENT
        d._rrect(draw, x, 172, max(6, int(w * frac)), 6, 3, fill=bar)

    _eyebrow(draw, "CAMERAS", x, 190)
    online, total = cams.get("online"), cams.get("total")
    # WARP-1643: `total == 0` is not None, so this used to render a GREEN
    # "0/0 online" — which reads as "all cameras up" when it means "there are
    # no cameras". No cameras configured is an absence, not a healthy state.
    if not total:
        cam_txt, cam_ink = "—", d.V3_LABEL4
    else:
        cam_txt = f"{online}/{total} online"
        cam_ink = d.V3_GREEN if online == total else d.V3_ORANGE
    d._v3_text(draw, cam_txt, x, 204, font=d._get_font(16, weight="bold"),
               fill=cam_ink)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def render_status(disp, now=None, state: str = "live") -> Image.Image:
    """LIVE state — design brief §2.4. Called from display.render_system()."""
    d = _d()
    g = geom()
    if now is None:
        now = d._dt_datetime.now(d._TZ) if d._TZ else d._dt_datetime.now()

    img = Image.new("RGB", (d.WIDTH, d.HEIGHT), d.V3_BG)
    draw = ImageDraw.Draw(img)
    with disp._touch_regions_lock:
        disp._touch_regions = []

    v = disp._v3
    degraded = (v.get("services") or {}).get("degraded") or []
    # Brief §6: a CORE service being down is an ALERT, not a DEGRADED — the
    # box is not doing its job. Non-core is DEGRADED.
    # TODO(PR-5): ALERT should also replace C2+C3 with the incident block.
    if disp._open_alerts_count() or any(s.get("core") for s in degraded):
        state = "alert"
    elif degraded:
        state = "degraded"

    _render_chrome(disp, draw, now, state)

    for dx in g.dividers:
        draw.rectangle([dx, g.band_b_top, dx, g.band_b_bot], fill=d.V3_SEP)

    _cell_reach(disp, draw, v)
    _cell_health(disp, draw, v)
    _cell_services(disp, draw, v)
    _cell_netstore(disp, draw, v)
    _render_foot(disp, draw, v)

    host = str(v.get("public_host") or v.get("hostname") or "droplet")
    render_rail(disp, draw, img,
                payload=f"https://{host}/dashboard",
                caption="SCAN TO OPEN",
                headline="Dashboard",
                fallback=host)

    _bind_cell_regions(disp)
    return img


def _bind_cell_regions(disp) -> None:
    """Each cell taps through to a full-bar detail screen (brief §7).

    TODO(PR-2): point these at the detail renderers once they exist; today
    they no-op so the regions are wired and testable ahead of the screens.
    """
    d = _d()
    g = geom()
    cells = (("cell_reach", g.cells["reach"]), ("cell_health", g.cells["health"]),
             ("cell_services", g.cells["services"]), ("cell_netstore", g.cells["netstore"]))
    with disp._touch_regions_lock:
        for name, (x, w) in cells:
            disp._touch_regions.append(d.TouchRegion(
                name, x, g.band_b_top, w, g.band_b_bot - g.band_b_top,
                lambda: None))
        disp._touch_regions.append(d.TouchRegion(
            "rail_qr", g.rail_x, 0, g.rail_w, d.HEIGHT, lambda: None))


# ---------------------------------------------------------------------------
# DEBUG / RECOVERY screen
# ---------------------------------------------------------------------------
# Claiming the panel takes the operator's physical console away, so the panel
# owes them a way back. This screen is that way back, and it is deliberately
# useful even when you never press the button: most of the time what you
# actually need is the address and the state, not a shell.
#
# Reached by tapping the device label in the chrome rail — a small, deliberate
# target rather than a prominent button, because the LIVE screen is what
# belongs on a rack front.
def render_debug(disp, now=None) -> Image.Image:
    d = _d()
    g = geom()
    if now is None:
        now = d._dt_datetime.now(d._TZ) if d._TZ else d._dt_datetime.now()

    img = Image.new("RGB", (d.WIDTH, d.HEIGHT), d.V3_BG)
    draw = ImageDraw.Draw(img)
    with disp._touch_regions_lock:
        disp._touch_regions = []

    v = disp._v3
    status = disp.get_status()

    # ---- chrome ----
    d.draw_droplet_mark(draw, g.left, 12, 22,
                        primary=d.V3_ORANGE, highlight=d.V3_ACCENT_INK)
    d._v3_text(draw, "DEBUG · RECOVERY", g.left + 30, 16,
               font=d._get_font(9, weight="bold"), fill=d.V3_ORANGE, tracking=2)
    _back_button(disp, draw)
    clk = disp._fmt_clock_parts(now)["str"]
    d._v3_text(draw, clk, g.content_r, 10, font=d._get_font(20, weight="heavy"),
               fill=d.V3_LABEL2, anchor="ra")
    draw.rectangle([g.left, g.band_a_rule, g.content_r, g.band_a_rule], fill=d.V3_SEP)
    for dx in g.dividers[:2]:
        draw.rectangle([dx, g.band_b_top, dx, g.band_b_bot], fill=d.V3_SEP)

    # ---- C1: how to reach this box ----
    x, w = g.cells["reach"]
    _eyebrow(draw, "GET IN", x)
    ip = str(v.get("ip", "-"))
    d._v3_text(draw, f"ssh droplet@{ip}", x, 78,
               font=_fit_font(draw, f"ssh droplet@{ip}", w, 26, weight="bold"),
               fill=d.V3_TEXT)
    rows = (
        ("HOST", str(v.get("hostname", "-"))),
        ("PANEL", "{}×{}".format(*(
            (status["panel"]["width"], status["panel"]["height"])
            if status.get("panel") else (d.WIDTH, d.HEIGHT)))),
        ("KEYBOARD", "Ctrl+Alt+F2 for a clean VT"),
    )
    for i, (k, val) in enumerate(rows):
        y = 122 + i * 34
        _eyebrow(draw, k, x, y)
        d._v3_text(draw, val, x, y + 12, font=d._get_font(14), fill=d.V3_LABEL2)

    # ---- C2: what the service thinks it is doing ----
    x2, _ = g.cells["health"]
    _eyebrow(draw, "SERVICE STATE", x2)
    state_rows = (
        ("BACKEND", str(status.get("backend", "?"))),
        ("TOUCH", str(getattr(getattr(disp, "_touch_source", None),
                              "_backend", "none"))),
        ("MODE", str(status.get("mode", "?"))),
        ("UPTIME", str(v.get("uptime", "-"))),
    )
    for i, (k, val) in enumerate(state_rows):
        # Start BELOW the section eyebrow — sharing y=62 with it stacks two
        # tracked labels on the same baseline and both become unreadable.
        y = 84 + i * 36
        _eyebrow(draw, k, x2, y)
        d._v3_text(draw, val, x2, y + 12, font=d._get_font(18, weight="bold"),
                   fill=d.V3_TEXT)

    # ---- C3+C4: the button ----
    x3, _ = g.cells["services"]
    bw = g.content_r - x3
    _eyebrow(draw, "CONSOLE", x3, fill=d.V3_ORANGE)

    armed = disp._console_confirm_active()
    if armed:
        label, sub = "TAP AGAIN TO CONFIRM", "the status screen will be replaced"
        fill, ink = d.V3_ORANGE_SUBTLE, d.V3_ORANGE
    else:
        label, sub = "RETURN CONSOLE TO PANEL", "shows a login prompt here"
        fill, ink = d.V3_SURFACE2, d.V3_LABEL2
    # Two-tap confirm, not a single press: this swaps what is on the rack's
    # front panel, and a stray touch (or a sleeve) should not do that.
    d._rrect(draw, x3, 74, bw, 64, 12, fill=fill, outline=d.V3_SEP2, width=1)
    d._v3_text(draw, label, x3 + bw // 2, 92,
               font=d._get_font(15, weight="heavy"), fill=ink, anchor="ma")
    d._v3_text(draw, sub, x3 + bw // 2, 114, font=d._get_font(11),
               fill=d.V3_LABEL3, anchor="ma")
    with disp._touch_regions_lock:
        disp._touch_regions.append(d.TouchRegion(
            "console_return", x3, 74, bw, 64, disp._tap_return_console))

    note = disp._console_last_result or (
        "The panel's touchscreen cannot type — it is HID with no keyboard "
        "keys. You still need a USB keyboard to use the prompt.")
    note_font = d._get_font(11)
    lines = _wrap(draw, note, note_font, bw)
    for i, line in enumerate(lines[:3]):
        d._v3_text(draw, line, x3, 150 + i * 15, font=note_font,
                   fill=d.V3_LABEL3)
    d._v3_text(draw, "Returns automatically if this service stops answering.",
               x3, 150 + min(len(lines), 3) * 15 + 6, font=note_font,
               fill=d.V3_LABEL4)

    _render_foot(disp, draw, v)
    render_rail(disp, draw, img,
                payload=f"https://{v.get('public_host') or v.get('hostname') or 'droplet'}/dashboard",
                caption="DASHBOARD",
                headline="Full detail",
                fallback=str(v.get("ip", "-")))
    return img


def _back_button(disp, draw) -> None:
    d = _d()
    g = geom()
    x, y, w, h = g.left + 172, 12, 74, 22
    d._rrect(draw, x, y, w, h, 11, fill=d.V3_SURFACE, outline=d.V3_SEP, width=1)
    d._v3_text(draw, "‹ BACK", x + w // 2, y + 5,
               font=d._get_font(10, weight="bold"), fill=d.V3_LABEL2,
               anchor="ma", tracking=1)
    with disp._touch_regions_lock:
        disp._touch_regions.append(
            d.TouchRegion("debug_back", x - 6, y - 6, w + 12, h + 24,
                          disp._go_home))


def render_claim(disp, code: str, setup_url: str,
                 wifi_ssid: Optional[str] = None,
                 wifi_psk: Optional[str] = None) -> Image.Image:
    """CLAIM state — brief §6. C1+C2 merge into the code hero, C3 carries the
    Wi-Fi join creds, C4 is hidden, the rail holds the claim QR.

    TODO(PR-4): full implementation. The default deep link
    (`https://d-<hmac>.droplet-us.com/setup?c=DRPL-XXXX-XXXX`, ~56 bytes) fits
    at version 4 with room to spare. The failure case is a long *named
    address* host, which pushes past the ~62-byte budget — assert before
    painting and fall back to the typed path rather than shipping a code
    nobody can scan.

    Security (brief §8): this is the ONLY state permitted to render the PSK or
    the claim code. Both must disappear the moment the box is claimed — this
    panel lives on a rack front in a shared room.
    """
    raise NotImplementedError("PR-4")
