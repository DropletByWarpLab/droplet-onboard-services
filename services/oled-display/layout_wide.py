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
# 5px top and bottom, off the founder's read of the real panel: the bezel
# crops far less vertically than horizontally (hence 30 on X), but the chrome
# still sat right on the glass edge.
#
# What moves: the top rail (mark, device label, state pill, clock, date, alert
# badge), the foot rule + footer text, and the rail's QR card and typed
# address — everything that lives near an edge. What deliberately does NOT
# move is band-B cell content (the hero numbers at y≈74–226): it is nowhere
# near an edge, and shifting it too would cost 10px of the tightest gap on the
# panel — the one between the metric row and the foot rule — for no visible
# gain. The band rules absorb the inset instead.
SAFE_INSET_Y = int(os.environ.get("PANEL_SAFE_INSET_Y", "5"))

DESIGN_MARGIN = 28          # breathing room INSIDE the safe area
GUTTER = 24
RAIL_W = 220                # fixed action rail
COLUMNS = 12

# --- Vertical scale: how a taller panel gets used -------------------------
# Every y in the band-B renderers below was authored against ONE panel, the
# 1424x280 rack bar, whose content band runs y=67..223. That was fine while
# one panel existed. The second unit is 1280x400 (read off the box itself:
# the display service reports its own framebuffer geometry on /health), and
# on it those literals leave the bottom ~110px of the content band painting
# nothing. A third of the glass, dark, on a screen whose entire job is to be
# readable from across the room.
#
# Two mechanisms, because "the panel got bigger" has two different answers:
#
#   * `_Geom.by()` re-anchors an authored y to the LIVE band, so the primary
#     row travels with its band instead of floating at a 280-panel offset.
#     At the reference panel the offset is zero and the rack bar renders
#     exactly as before — that is the point of anchoring rather than scaling.
#
#   * a DENSITY tier. Stretching four cells to cover 110 spare pixels only
#     makes the whitespace bigger; a status panel earns its height by SAYING
#     more. So surplus height becomes band D: a second row carrying data the
#     compact tier has to drop on the floor — the alerts you can otherwise
#     only reach by tapping the chrome badge, the degraded services past the
#     third, the MEM/DISK trend hiding behind two bare percentages, and the
#     LAN client count, which the bridge already streams and which until now
#     was rendered nowhere at all.
#
# Nothing in band D is invented to fill space. A block with no data says so.
REF_BAND_B_TOP = 67    # band_b_top on the 1424x280 reference panel
REF_ROW_H = 166        # authored primary row: eyebrow at 67 down to the
                       # deepest glyph, health's 24px MEM/DISK/TEMP/GPU
                       # numerals drawn at y=202
EXTRA_GAP = 20         # rule + breathing room between the primary row and D
EXTRA_ROW_H = 24       # one band-D list row
EXTRA_HEAD_H = 18      # band-D eyebrow to its first row
EXTRA_MIN_H = 84       # an eyebrow plus three rows. Below this band D would
                       # be a cramped strip rather than a second row, so the
                       # tier stays compact and the slack stays as margin —
                       # a half-height band reads as a rendering fault.


class _Geom:
    """Resolved layout geometry for the current panel + inset."""

    __slots__ = ("left", "content_r", "rail_x", "rail_w", "right",
                 "pitch", "band_a_rule", "band_b_top", "band_b_bot",
                 "band_c_rule", "band_c_y", "eyebrow_y", "top", "bottom",
                 "cells", "dividers",
                 "band_b_h", "density", "row_bot", "extra_top", "extra_bot")

    def by(self, y: int) -> int:
        """Re-anchor an authored band-B y onto the live band.

        The cell renderers hold absolute coordinates from the 1424x280 panel.
        Routing them through here leaves that panel byte-identical (the offset
        is zero) while any other geometry moves the whole row with its band
        instead of stranding it near the top."""
        return int(y + self.band_b_top - REF_BAND_B_TOP)

    @property
    def is_tall(self) -> bool:
        """True when the panel has room under the primary row for band D."""
        return self.density == "tall"

    @property
    def extra_rows(self) -> int:
        """How many band-D list rows fit. Zero on a compact panel."""
        if not self.is_tall:
            return 0
        return max(0, (self.extra_bot - self.extra_top - EXTRA_HEAD_H)
                   // EXTRA_ROW_H)

    def col_x(self, n: int) -> int:
        """Left edge of column n (1-based)."""
        return int(round(self.left + (n - 1) * self.pitch))

    def span(self, cols: int) -> int:
        """Width of a `cols`-wide span."""
        return int(round(cols * self.pitch - GUTTER))


_GEOM_CACHE: dict = {}
# Panels we have already complained about. A per-render warning would emit
# ~5760 lines an hour on a panel nobody can fix from the log anyway.
_SHORT_PANEL_WARNED: set = set()


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

    # Density. The question is not "is the panel big" but "is there room for
    # a whole second row under the one we already draw" — a 60px surplus is
    # margin, not a band, and pretending otherwise is how you get a clipped
    # half-row that reads as a bug.
    g.band_b_h = g.band_b_bot - g.band_b_top
    g.row_bot = g.by(REF_BAND_B_TOP + REF_ROW_H)
    surplus = g.band_b_bot - g.row_bot - EXTRA_GAP
    g.density = "tall" if surplus >= EXTRA_MIN_H else "compact"
    g.extra_top = g.row_bot + EXTRA_GAP if g.density == "tall" else g.band_b_bot
    g.extra_bot = g.band_b_bot

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
    # A panel SHORTER than the authored row is the mirror image of the bug
    # this file was changed to fix, and it is the worse direction: content
    # runs down through the foot rule instead of leaving a gap above it.
    # There is no compressed tier - the layout anchors and adds, it does not
    # shrink type - so the honest thing is to say so once, out loud, rather
    # than ship an overlap nobody can explain from the glass.
    if g.row_bot > g.band_c_rule and key not in _SHORT_PANEL_WARNED:
        _SHORT_PANEL_WARNED.add(key)
        logger.warning(
            "panel %dx%d is %dpx too short for the wide layout's content row "
            "- band B will run into the foot rule. The layout has a tall tier "
            "but no compressed one; this panel needs a design, not a scale "
            "factor.", d.WIDTH, d.HEIGHT, g.row_bot - g.band_c_rule)

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


def _clip(text: str, n: int) -> str:
    """Truncate with an ellipsis so a shortened string never masquerades as a
    complete one."""
    return text if len(text) <= n else text[:n - 1] + "…"


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
    already uses for the claim code — hostnames vary in length by 3x.

    ⚠ Returns the FLOOR face when nothing fits, which may still overflow. Use
    `_fit_text` unless you have separately guaranteed the text fits."""
    d = _d()
    size = start
    while size > floor:
        f = d._get_font(size, weight=weight)
        if d._v3_text_width(draw, text, f, tracking) <= max_w:
            return f
        size -= 1
    return d._get_font(floor, weight=weight)


def _fit_text(draw, text: str, max_w: int, start: int, floor: int = 14,
              weight: str = "heavy", tracking: float = 0.0):
    """Fit `text` into `max_w`, shortening it if even the floor face overflows.

    Returns (font, text). `_fit_font` alone stops shrinking at the floor and
    hands back a face that STILL overflows — which on this layout means the
    address running straight through the divider into the next cell. Latent
    until the safe-area inset narrowed the column; CI caught it immediately.

    Shortening an address is not great, but the IP sits directly underneath and
    the ellipsis says "there is more" — both better than spilling into HEALTH.
    """
    d = _d()
    font = _fit_font(draw, text, max_w, start, floor, weight, tracking)
    if d._v3_text_width(draw, text, font, tracking) <= max_w:
        return font, text
    shortened = text
    while len(shortened) > 4 and             d._v3_text_width(draw, shortened + "…", font, tracking) > max_w:
        shortened = shortened[:-1]
    return font, shortened + "…"


# ---------------------------------------------------------------------------
# QR — design brief §5
# ---------------------------------------------------------------------------
QR_CARD = 176                 # nominal; render_rail shrinks it to fit the rail
QR_CARD_GAP = 6               # clear space between the card and the caption
# The rail's text stack, as measured gaps rather than three y literals hung
# off g.bottom. Naming them is what lets the block be centred as a unit.
RAIL_CAP_TO_HL = 18           # caption baseline to headline baseline
RAIL_HL_TO_FB = 26            # headline baseline to typed-address baseline
RAIL_TEXT_TAIL = 19           # the 15px address face plus its descender
RAIL_BOTTOM_PAD = 11          # glass under the last line of the address
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


def _render_rail_pager(draw, cx: int, y: int, faces: int, active: int) -> None:
    """Two dots in the rail's empty top strip: the rail has another face.

    The debug entry point is deliberately unlabelled because operators are
    told where it is. This one is the opposite — it is for a visitor holding a
    phone, who has no reason to suspect a status panel is tappable — so it
    needs a visible affordance. Dots, because they are the one "there is more
    here" signal that needs no words and no room.

    It goes ABOVE the card, in the 24px of rail that was already empty. The
    text block below is anchored to the safe area's bottom and the card fills
    every pixel between the two, so anything added down there comes straight
    out of the QR's edge — and the QR's scan distance is the tightest budget
    on this panel.
    """
    d = _d()
    r, gap = 3, 14
    x0 = cx - ((faces - 1) * gap) // 2
    for i in range(faces):
        x = x0 + i * gap
        draw.ellipse([x - r, y - r, x + r, y + r],
                     fill=d.V3_ACCENT if i == active else d.V3_LABEL4)


def render_rail(disp, draw: ImageDraw.ImageDraw, img: Image.Image, *,
                payload: str, caption: str, headline: str,
                fallback: str, ecc: str = "M",
                faces: int = 0, face_index: int = 0) -> None:
    """The fixed right-hand action rail: QR card + caption + typed fallback.

    `faces` > 1 draws the pager dots; 0 or 1 leaves the top strip empty, which
    is what the screens with a single, non-tappable rail want.
    """
    d = _d()
    g = geom()
    draw.rectangle([g.rail_x, 0, d.WIDTH, d.HEIGHT], fill=d.V3_PANEL)
    draw.rectangle([g.rail_x, 0, g.rail_x, d.HEIGHT], fill=d.V3_SEP)

    cx = g.rail_x + g.rail_w // 2
    if faces > 1:
        _render_rail_pager(draw, cx, g.top + 12, faces, face_index)
    # Everything in the rail is centred, so an over-wide string spills out
    # BOTH sides of it. The fallback is a hostname, and hostnames vary in
    # length by 3x — clip all three to the rail rather than trusting them.
    inner = g.rail_w - 16

    # WARP-1647 — sized up after reading them on the actual panel. The original
    # 9/13/11 came from the design brief, i.e. from before anyone had stood at
    # the rack. The block is laid out from the safe area's BOTTOM rather than
    # from absolute y literals: the rail spans the full framebuffer height and
    # so did not previously respect PANEL_SAFE_INSET_Y, which would have pushed
    # the typed address off the panel the moment that inset went non-zero.
    # The card is sized AFTER the text block, because a vertical inset
    # squeezes the rail from both sides and so costs twice the inset. At a
    # hard-coded 176 the card had exactly 6px of slack, and the 5px default
    # inset overran it: the "SCAN TO OPEN" caption printed through the card's
    # bottom edge. Fit the card to the gap that is actually left. render_qr()
    # re-fits the code to whatever it is given, and returns None (→ the
    # typed-address fallback) if it can no longer make the modules big enough
    # to scan, so shrinking degrades honestly instead of lying.
    #
    # ⚠ The block is CENTRED, not anchored at both ends. It used to be the
    # latter — card down from g.top, typed address up from g.bottom — which is
    # invisible at 280px tall because the two meet in the middle anyway, and
    # unmissable at 400px: the card sat at the top with 110px of black under
    # it and the caption stranded near the floor, so card and caption stopped
    # reading as one object. Sizing first and centring second keeps them a
    # unit at any height. Note the card is bounded by the rail's WIDTH, so
    # spare height becomes even margins rather than an ever-bigger QR.
    pad_top = g.top + 24
    pad_bot = g.bottom - RAIL_BOTTOM_PAD
    avail = max(0, pad_bot - pad_top)
    text_h = RAIL_CAP_TO_HL + RAIL_HL_TO_FB + RAIL_TEXT_TAIL
    card = max(0, min(QR_CARD, g.rail_w - 32, avail - QR_CARD_GAP - text_h))
    block_h = (card + QR_CARD_GAP if card else 0) + text_h
    block_top = pad_top + max(0, (avail - block_h) // 2)

    card_x = g.rail_x + (g.rail_w - QR_CARD) // 2
    card_y = block_top
    cap_y = block_top + ((card + QR_CARD_GAP) if card else 0)
    hl_y = cap_y + RAIL_CAP_TO_HL
    fb_y = hl_y + RAIL_HL_TO_FB
    if card:
        card_x = g.rail_x + (g.rail_w - card) // 2
        d._rrect(draw, card_x, card_y, card, card, 14, fill=d.V3_WHITE)

        qr_img, module_px = render_qr(payload, card=card, ecc=ecc)
        if qr_img is not None:
            px = card_x + (card - qr_img.width) // 2
            py = card_y + (card - qr_img.height) // 2
            img.paste(qr_img, (px, py))
            # A 22px mark over a ~164px code occludes <2% of the area; ECC M
            # tolerates ~15%. ECC L has no headroom to spare, so skip it there.
            if ecc != "L":
                d.draw_droplet_mark(draw, card_x + card // 2 - 11,
                                    card_y + card // 2 - 11, 22,
                                    primary=d.V3_ACCENT,
                                    highlight=d.V3_ACCENT_INK)
        else:
            d._v3_text(draw, "SEE ADDRESS BELOW", card_x + card // 2,
                       card_y + card // 2, font=d._get_font(11, weight="bold"),
                       fill=(0x40, 0x40, 0x48), anchor="mm")

    d._v3_text(draw, caption, cx, cap_y, font=d._get_font(11, weight="bold"),
               fill=d.V3_ACCENT, anchor="ma", tracking=1.6)
    hl_font, hl_text = _fit_text(draw, headline, inner, 17, floor=12,
                                 weight="bold")
    d._v3_text(draw, hl_text, cx, hl_y, font=hl_font, fill=d.V3_LABEL2,
               anchor="ma")
    # The typed path must never disappear: glare, bad angle, camera-less phone.
    # It gets the biggest bump of the three — it is the one you READ AND TYPE,
    # and an address you cannot make out is the same as no address at all. The
    # floor rises with it so a long hostname shrinks but never back to
    # unreadable; past that it ellipsises (see _fit_text).
    fb_font, fb_text = _fit_text(draw, fallback, inner, 15, floor=10,
                                 weight="regular")
    d._v3_text(draw, fb_text, cx, fb_y, font=fb_font, fill=d.V3_LABEL2,
               anchor="ma")


# ---------------------------------------------------------------------------
# Chrome + foot rails
# ---------------------------------------------------------------------------
# WARP-1784 / WARP-1801 — the top-left brand lockup, as a hit box.
#
# It is the way INTO the debug screen (from LIVE) and the way OUT of it, and
# those two have to be the SAME span. WARP-1784 widened the way in to the whole
# lockup, because the droplet mark is the element up here that reads as a
# button and is what people actually aim at. The way out was left as the 74px
# "‹ BACK" chip alone — so 170 of the 256px a user had just been taught to tap
# did nothing on the debug screen, and a miss is not even a visible no-op:
# there is no auto-cycle off DEBUG and the touchscreen cannot type, so that
# chip was the only exit from a screen people reach precisely when something
# is already wrong.
#
# Sharing one definition is the fix, not a tidy-up: two hardcoded spans is
# exactly how the gap opened, twice (WARP-1641's x=124, then WARP-1644's
# g.left + 96). Anchoring to g.left keeps a future inset change from
# reopening it.
LOCKUP_W, LOCKUP_H = 256, 46


def _lockup_region(disp, name: str, action) -> None:
    """Register the brand-lockup hit box under `name`, firing `action`."""
    d = _d()
    g = geom()
    with disp._touch_regions_lock:
        disp._touch_regions.append(
            d.TouchRegion(name, g.left, g.top, LOCKUP_W, LOCKUP_H, action))


def _render_chrome(disp, draw, now, state: str) -> None:
    d = _d()
    g = geom()
    d.draw_droplet_mark(draw, g.left, g.top + 12, 22,
                        primary=d.V3_ACCENT, highlight=d.V3_ACCENT_INK)
    d._v3_text(draw, "DROPLET", g.left + 30, g.top + 16,
               font=d._get_font(9, weight="bold"),
               fill=d.V3_LABEL3, tracking=2)
    # The top-left brand lockup doubles as the way into the DEBUG/recovery
    # screen. Deliberately unlabelled rather than a visible button: the LIVE
    # screen is what belongs on a rack front, and the people who need the
    # recovery path are the people who have been told where it is.
    d._v3_text(draw, "WARP LAB · MINI-RACK", g.left + 104, g.top + 16,
               font=d._get_font(9), fill=d.V3_LABEL4, tracking=1.2)
    # WARP-1784 — the target is the WHOLE lockup: mark, wordmark and device
    # label. It used to start 96px in, at the label alone, which left the
    # droplet mark in a dead zone — and the mark is the one element up here
    # that reads as a button, so it is what people actually aim at.
    #
    # Unlabelled is the design intent. Smaller than the thing you aim at is
    # not. WARP-1801 moved the span into _lockup_region so the way out of the
    # debug screen is the same physical place as the way in.
    _lockup_region(disp, "debug_enter", disp._go_debug)

    label, fill, ink = _pill_style(state)
    pf = d._get_font(10, weight="bold")
    pw = int(d._v3_text_width(draw, label, pf, 1.2)) + 24
    d._rrect(draw, g.left + 312, g.top + 12, pw, 22, 11, fill=fill)
    d._v3_text(draw, label, g.left + 312 + pw // 2, g.top + 17, font=pf, fill=ink,
               anchor="ma", tracking=1.2)

    clk = disp._fmt_clock_parts(now)["str"]
    cf = d._get_font(20, weight="heavy")
    d._v3_text(draw, clk, g.content_r, g.top + 10, font=cf, fill=d.V3_LABEL2,
               anchor="ra")
    clk_w = d._v3_text_width(draw, clk, cf)

    date = (now.strftime("%a %d %b") if now else "").upper()
    date_x = int(g.content_r - clk_w - 16)
    d._v3_text(draw, date, date_x, g.top + 18, font=d._get_font(9, weight="bold"),
               fill=d.V3_LABEL4, anchor="ra", tracking=1.4)

    open_count = disp._open_alerts_count()
    if open_count:
        date_w = d._v3_text_width(draw, date, d._get_font(9, weight="bold"), 1.4)
        bx, by, br = int(date_x - date_w - 24), g.top + 23, 11
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
    host_font, host_text = _fit_text(draw, host, w, 30)
    d._v3_text(draw, host_text, x, g.by(80), font=host_font, fill=d.V3_TEXT)
    d._v3_text(draw, str(v.get("ip", "-")), x, g.by(124),
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
        cw = _chip(draw, x, g.by(164), "NO INTERNET", d.V3_RED, (0x2E, 0x0F, 0x0E))
    else:
        txt = "ONLINE" if lat is None else f"ONLINE {int(lat)} ms"
        cw = _chip(draw, x, g.by(164), txt, d.V3_GREEN, (0x08, 0x24, 0x12))

    tls_days = v.get("tls_days")
    if tls_days is not None:
        warn = tls_days < 14
        _chip(draw, x + cw + 10, g.by(164), f"TLS {int(tls_days)} d",
              d.V3_ORANGE if warn else d.V3_ACCENT,
              d.V3_ORANGE_SUBTLE if warn else d.V3_ACCENT_SUBTLE)

    d._v3_text(draw, "/dashboard", x, g.by(200), font=d._get_font(12),
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
    d._v3_text(draw, _num(v.get("cpu"), "%"), x, g.by(74),
               font=d._get_font(60, weight="heavy"), fill=d.V3_TEXT,
               tracking=-2)

    sp = v.get("sparks_cpu") or []
    sx, sy, sh = x, g.by(146), 36
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
        _eyebrow(draw, label, cx, g.by(190))
        d._v3_text(draw, val, cx, g.by(202), font=d._get_font(24, weight="heavy"),
                   fill=d.V3_TEXT)


def _cell_services(disp, draw, v: dict, *, carry: int = 0) -> List[dict]:
    """The highest-value cell: it is the only thing on the panel that says a
    container is down, which is the most common reason to walk to the rack.

    Fed by the bridge's /services (WARP-1645), which normalises the
    orchestrator's own cached health snapshot.

    `carry` is how many of the services this cell cannot fit will be printed
    by band D underneath. Returns that carried slice, so the caller does not
    have to re-derive the split and the two blocks cannot disagree about it.
    """
    d = _d()
    g = geom()
    x, w = g.cells["services"]
    _eyebrow(draw, "SERVICES", x)

    svc = v.get("services") or {}
    up, total = svc.get("up"), svc.get("total")
    degraded: List[dict] = list(svc.get("degraded") or [])
    # The orchestrator's OWN aggregate classification. It knows which
    # components are hard dependencies; we do not re-derive that here from a
    # guessed list of "core" services. `core` on a row is presentation only.
    status = svc.get("status")

    if up is None or total is None:
        # Bridge or orchestrator unreachable. An em dash, never "0/0" — see
        # WARP-1643; a zero here would read as "no services running", which is
        # a far more alarming and entirely wrong claim.
        hero, ink, summary = "—", d.V3_LABEL4, "no data"
    else:
        hero = f"{up}/{total}"
        ink = (d.V3_RED if status == "down" else
               d.V3_ORANGE if (status == "degraded" or up < total)
               else d.V3_GREEN)
        summary = ("all healthy" if not degraded else
                   f"{len(degraded)} degraded")
    d._v3_text(draw, hero, x, g.by(76), font=d._get_font(40, weight="heavy"),
               fill=ink)
    d._v3_text(draw, summary, x, g.by(124), font=d._get_font(12),
               fill=d.V3_LABEL3)

    # Core-first, then alphabetical. Never truncate silently — 4+ collapses to
    # two rows and an explicit "+N more".
    degraded.sort(key=lambda s: (not s.get("core"), str(s.get("name", ""))))
    rows = degraded[:3]
    if len(degraded) > 3:
        rows = degraded[:2]
    # What this cell could not fit. On a tall panel band D continues the list,
    # so only the services that reach NO block at all earn a "+N more": a
    # panel printing "+5 more" directly above those same five is just noise.
    rest = degraded[len(rows):]
    hidden = max(0, len(rest) - carry)

    for i, s in enumerate(rows):
        y = g.by(146) + i * 26
        dot = d.V3_RED if s.get("core") else d.V3_ORANGE
        draw.ellipse([x, y + 4, x + 6, y + 10], fill=dot)
        d._v3_text(draw, _clip(str(s.get("name", "?")), 14), x + 14, y,
                   font=d._get_font(13, weight="bold"), fill=d.V3_TEXT)
        # Ellipsis rather than a bare slice: a hard cut at 16 chars turns
        # "connection refused" into "connection refus", which reads as a
        # different (and nonsense) error rather than a shortened one.
        d._v3_text(draw, _clip(str(s.get("state", "")), 18), x + 14, y + 14,
                   font=d._get_font(11), fill=d.V3_LABEL3)
    if hidden:
        d._v3_text(draw, f"+{hidden} more", x, g.by(194), font=d._get_font(11),
                   fill=d.V3_LABEL3)
    return rest[:carry]


def _cell_netstore(disp, draw, v: dict) -> None:
    d = _d()
    g = geom()
    x, w = g.cells["netstore"]
    wifi = v.get("wifi") or {}
    cams = v.get("cameras") or {}
    store = v.get("storage") or {}

    _eyebrow(draw, "NETWORK", x)
    # WARP-2047 — ask the display for the household SSID rather than reading
    # the client-scan feed directly. `wifi` (the bridge's /wifi) is a STATION
    # scan and carries no ssid on the shapes where an external access point
    # hosts the network, so this tile could only ever name the box's own
    # hotspot. On droplet-sys that meant it printed the vitals placeholder
    # while the household was on "Warp". household_ssid() prefers the
    # /openwrt/qr join feed, which resolves all three shapes.
    d._v3_text(draw, (disp.household_ssid() or "—")[:14], x, g.by(76),
               font=d._get_font(18, weight="bold"), fill=d.V3_TEXT)
    detail = " · ".join(p for p in (
        wifi.get("band") or None,
        f"ch {wifi['channel']}" if wifi.get("channel") else None,
        f"{wifi['clients']} clients" if wifi.get("clients") is not None else None,
    ) if p)
    d._v3_text(draw, detail or "—", x, g.by(100), font=d._get_font(11),
               fill=d.V3_LABEL3)
    draw.rectangle([x, g.by(120), x + w, g.by(120)], fill=d.V3_SEP)

    _eyebrow(draw, "STORAGE", x, g.by(130))
    used, cap = store.get("used_tb"), store.get("total_tb")
    d._v3_text(draw, "—" if cap is None else f"{used:.1f} / {cap:.1f} TB",
               x, g.by(144), font=d._get_font(20, weight="bold"),
               fill=d.V3_TEXT)
    d._rrect(draw, x, g.by(172), w, 6, 3, fill=d.V3_TRACK)
    if cap:
        frac = max(0.0, min(1.0, (used or 0) / cap))
        bar = d.V3_RED if frac >= 0.92 else d.V3_ORANGE if frac >= 0.80 \
            else d.V3_ACCENT
        d._rrect(draw, x, g.by(172), max(6, int(w * frac)), 6, 3, fill=bar)

    _eyebrow(draw, "CAMERAS", x, g.by(190))
    online, total = cams.get("online"), cams.get("total")
    # WARP-1643: `total == 0` is not None, so this used to render a GREEN
    # "0/0 online" — which reads as "all cameras up" when it means "there are
    # no cameras". No cameras configured is an absence, not a healthy state.
    if not total:
        cam_txt, cam_ink = "—", d.V3_LABEL4
    else:
        cam_txt = f"{online}/{total} online"
        cam_ink = d.V3_GREEN if online == total else d.V3_ORANGE
    d._v3_text(draw, cam_txt, x, g.by(204), font=d._get_font(16, weight="bold"),
               fill=cam_ink)


# ---------------------------------------------------------------------------
# Band D - the tall-panel extras row
# ---------------------------------------------------------------------------
# Drawn only when geom() resolves the `tall` density, i.e. when there is room
# under the primary row for a whole second one. Every block here shows data
# the box ALREADY streams and the compact panel has to drop: the alert list
# you can otherwise only reach by tapping the chrome badge, the degraded
# services past the third, the MEM/DISK trend hiding behind two bare
# percentages, and lan_clients - fed by the bridge and, until now, rendered on
# no screen at all.
#
# Nothing here is invented to fill space. A block with no data says so, in the
# same voice as the rest of the panel: an em dash or a named empty state,
# never a plausible-looking zero (WARP-1643).
def _spark(draw, x: int, y: int, w: int, h: int, series, ink, fill) -> bool:
    """One mini trend. Returns False when there is too little history to draw
    an honest line, so the caller can say so rather than paint a flat line at
    the current value - which would assert a steadiness nobody measured."""
    d = _d()
    draw.rectangle([x, y + h, x + w, y + h], fill=d.V3_SEP)
    pts = [float(q) for q in (series or []) if q is not None]
    if len(pts) < 2:
        return False
    lo, hi = min(pts), max(pts)
    rng = max(1.0, hi - lo)
    coords = [(x + (i / (len(pts) - 1)) * w, y + h - ((val - lo) / rng) * h)
              for i, val in enumerate(pts)]
    draw.polygon(coords + [(x + w, y + h), (x, y + h)], fill=fill)
    draw.line(coords, fill=ink, width=2, joint="curve")
    return True


def _extra_rule(draw) -> None:
    d = _d()
    g = geom()
    y = g.extra_top - EXTRA_GAP // 2
    draw.rectangle([g.left, y, g.content_r, y], fill=d.V3_SEP)


def _extra_activity(disp, draw, v: dict) -> None:
    """The alert list, in the open.

    On the compact panel an alert is a red dot in the chrome that you have to
    TAP to read - which needs a free hand at the rack, which is exactly what
    you do not have while carrying a laptop. Open alerts sort above cleared
    ones, so the thing still wrong is the thing at the top."""
    d = _d()
    g = geom()
    x, w = g.cells["reach"]
    _eyebrow(draw, "ACTIVITY", x, g.extra_top)

    alerts = [a for a in (getattr(disp, "_alerts", None) or [])
              if isinstance(a, dict)]
    alerts.sort(key=lambda a: bool(a.get("cleared")))
    y = g.extra_top + EXTRA_HEAD_H
    shown = 0
    for a in alerts[:g.extra_rows]:
        live = not a.get("cleared")
        draw.ellipse([x, y + 5, x + 6, y + 11],
                     fill=d.V3_ORANGE if live else d.V3_LABEL4)
        when = str(a.get("time") or "")
        wf = d._get_font(11)
        when_w = int(d._v3_text_width(draw, when, wf)) + 12 if when else 0
        # Fit the title to what is left AFTER the timestamp is reserved. The
        # two are drawn from opposite edges of one column, so measuring the
        # title against the full width is exactly how they end up
        # overprinting each other on a long service name.
        tf, tt = _fit_text(draw, str(a.get("title") or "-"),
                           max(24, w - 14 - when_w), 12, floor=10,
                           weight="bold")
        d._v3_text(draw, tt, x + 14, y, font=tf,
                   fill=d.V3_TEXT if live else d.V3_LABEL3)
        if when:
            d._v3_text(draw, when, x + w, y, font=wf, fill=d.V3_LABEL4,
                       anchor="ra")
        y += EXTRA_ROW_H
        shown += 1

    if not shown:
        # "No alerts" is a real and good state, so say it plainly - and hand
        # the last event over underneath so the block still carries something.
        d._v3_text(draw, "No open alerts", x, g.extra_top + EXTRA_HEAD_H,
                   font=d._get_font(12, weight="bold"), fill=d.V3_LABEL2)
        event = v.get("last_event")
        if event and g.extra_rows > 1:
            ef, et = _fit_text(draw, str(event), w, 11, floor=9,
                               weight="regular")
            d._v3_text(draw, et, x, g.extra_top + EXTRA_HEAD_H + 20, font=ef,
                       fill=d.V3_LABEL4)


def _extra_trends(disp, draw, v: dict) -> None:
    """MEM and DISK over the same window as the CPU spark above them.

    The primary row prints both as bare percentages, which cannot answer the
    question you walked to the rack holding: is this climbing, or has it been
    sitting there all week?"""
    d = _d()
    g = geom()
    x, w = g.cells["health"]
    _eyebrow(draw, "TRENDS", x, g.extra_top)

    half = max(40, (w - 24) // 2)
    head = g.extra_top + EXTRA_HEAD_H
    h = max(12, min(30, g.extra_bot - head - 18))
    for i, (label, buf, cur) in enumerate((
            ("MEM", v.get("sparks_mem"), v.get("mem")),
            ("DISK", v.get("sparks_disk"), v.get("disk")))):
        sx = x + i * (half + 24)
        _eyebrow(draw, label, sx, head)
        d._v3_text(draw, _num(cur, "%"), sx + half, head - 4,
                   font=d._get_font(14, weight="heavy"), fill=d.V3_TEXT,
                   anchor="ra")
        if not _spark(draw, sx, head + 14, half, h, buf, d.V3_ACCENT,
                      d.V3_SPARK_FILL):
            d._v3_text(draw, "no history yet", sx, head + 16,
                       font=d._get_font(10), fill=d.V3_LABEL4)


def _extra_degraded(disp, draw, v: dict, carried: List[dict]) -> None:
    """The degraded services the primary cell could not fit.

    `carried` comes back from _cell_services rather than being re-derived, so
    the two blocks cannot disagree about where the list was cut."""
    d = _d()
    g = geom()
    x, w = g.cells["services"]
    _eyebrow(draw, "ALSO DEGRADED", x, g.extra_top)

    y = g.extra_top + EXTRA_HEAD_H
    for svc in carried:
        draw.ellipse([x, y + 4, x + 6, y + 10],
                     fill=d.V3_RED if svc.get("core") else d.V3_ORANGE)
        nf, nt = _fit_text(draw, str(svc.get("name") or "?"), max(20, w - 14),
                           12, floor=9, weight="bold")
        d._v3_text(draw, nt, x + 14, y, font=nf, fill=d.V3_TEXT)
        y += EXTRA_ROW_H

    if not carried:
        # "No feed" and "nothing degraded" are different facts and must not
        # share a rendering: a green "None" over a dead feed claims a health
        # nobody measured. Same rule as the em-dash hero above.
        if ((v.get("services") or {}).get("up")) is None:
            d._v3_text(draw, "-", x, g.extra_top + EXTRA_HEAD_H,
                       font=d._get_font(13, weight="bold"), fill=d.V3_LABEL4)
        else:
            d._v3_text(draw, "None", x, g.extra_top + EXTRA_HEAD_H,
                       font=d._get_font(13, weight="bold"), fill=d.V3_GREEN)


def _extra_clients(disp, draw, v: dict) -> None:
    """Who is actually attached.

    `lan_clients` has been streamed by the bridge since WARP-1645 and drawn on
    no screen since - the compact panel simply has no room for it.

    Both counts collapse a seeded 0 to unknown, exactly as the WAN latency
    chip does: `lan_clients` and `wifi.clients` are seeded 0 in _v3, and a box
    that has never answered leaves them there, so a printed "0" would be a
    reading nobody took. A box with genuinely zero LAN clients would not have
    a panel on the LAN to say so on."""
    d = _d()
    g = geom()
    x, w = g.cells["netstore"]
    _eyebrow(draw, "CLIENTS", x, g.extra_top)

    wifi = v.get("wifi") or {}
    y = g.extra_top + EXTRA_HEAD_H
    for label, n in (("LAN", v.get("lan_clients") or None),
                     ("WI-FI", wifi.get("clients") or None)):
        d._v3_text(draw, label, x, y + 4, font=d._get_font(10, weight="bold"),
                   fill=d.V3_LABEL3, tracking=1.2)
        d._v3_text(draw, _num(n), x + w, y,
                   font=d._get_font(16, weight="heavy"),
                   fill=d.V3_TEXT if n else d.V3_LABEL4, anchor="ra")
        y += EXTRA_ROW_H


def render_extras(disp, draw, v: dict, carried: List[dict]) -> None:
    """Band D, or nothing at all on a compact panel."""
    if not geom().is_tall:
        return
    _extra_rule(draw)
    _extra_activity(disp, draw, v)
    _extra_trends(disp, draw, v)
    _extra_degraded(disp, draw, v, carried)
    _extra_clients(disp, draw, v)


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
    svc = v.get("services") or {}
    # WARP-1645: the pill now follows the ORCHESTRATOR's aggregate status
    # rather than a guess made here. It classifies `down` only when a hard
    # dependency has failed (postgres) — that is the box not doing its job, so
    # it earns ALERT; anything else failing is DEGRADED.
    # TODO: ALERT should also replace C2+C3 with an incident block (brief §6).
    svc_status = svc.get("status")
    if disp._open_alerts_count() or svc_status == "down":
        state = "alert"
    elif svc_status == "degraded" or (svc.get("degraded") or []):
        state = "degraded"

    _render_chrome(disp, draw, now, state)

    for dx in g.dividers:
        draw.rectangle([dx, g.band_b_top, dx, g.band_b_bot], fill=d.V3_SEP)

    _cell_reach(disp, draw, v)
    _cell_health(disp, draw, v)
    # `carry` is how many overflow services band D will print underneath,
    # so the cell knows what genuinely stays hidden. Zero on a compact
    # panel, which is what keeps the rack bar's render identical.
    carried = _cell_services(disp, draw, v, carry=g.extra_rows)
    _cell_netstore(disp, draw, v)
    render_extras(disp, draw, v, carried)
    _render_foot(disp, draw, v)

    render_rail(disp, draw, img, **_rail_content(disp, v))

    _bind_cell_regions(disp)
    return img


def _rail_content(disp, v: dict) -> dict:
    """Which QR the rail is showing, and the three lines under it (WARP-1782).

    The Wi-Fi face deliberately does NOT put the passphrase in the fallback
    slot, even though that slot exists precisely so the typed path never
    disappears. The passphrase is the one string on this panel where the typed
    path is the threat: a QR has to be scanned from ~25cm, text can be read
    across the room. So the slot carries the way back instead, and the SSID —
    the fact a visitor actually needs to confirm — takes the headline.

    A box with no scannable Wi-Fi payload reports ONE face, so the pager does
    not advertise a flip that would go nowhere.
    """
    d = _d()
    host = str(v.get("public_host") or v.get("hostname") or "droplet")
    wifi_payload = disp.wifi_qr_payload()
    faces = 2 if (d.RAIL_WIFI_QR and wifi_payload) else 1

    if faces == 1 or disp.rail_face() != "wifi":
        return dict(payload=f"https://{host}/dashboard",
                    caption="SCAN TO OPEN", headline="Dashboard",
                    fallback=host, faces=faces, face_index=0)

    ssid = str((v.get("wifi") or {}).get("ssid") or "Wi-Fi")
    return dict(payload=wifi_payload, caption="JOIN WI-FI", headline=ssid,
                fallback="TAP FOR DASHBOARD", faces=faces, face_index=1)


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
        # WARP-1782: the whole rail is the target, not just the card — you aim
        # at a QR by putting a finger on it, and the card is the part you are
        # least likely to want a fingerprint on.
        disp._touch_regions.append(d.TouchRegion(
            "rail_qr", g.rail_x, 0, g.rail_w, d.HEIGHT, disp._tap_rail_qr))


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
    d.draw_droplet_mark(draw, g.left, g.top + 12, 22,
                        primary=d.V3_ORANGE, highlight=d.V3_ACCENT_INK)
    d._v3_text(draw, "DEBUG · RECOVERY", g.left + 30, g.top + 16,
               font=d._get_font(9, weight="bold"), fill=d.V3_ORANGE, tracking=2)
    _back_button(disp, draw)
    clk = disp._fmt_clock_parts(now)["str"]
    d._v3_text(draw, clk, g.content_r, g.top + 10,
               font=d._get_font(20, weight="heavy"),
               fill=d.V3_LABEL2, anchor="ra")
    draw.rectangle([g.left, g.band_a_rule, g.content_r, g.band_a_rule], fill=d.V3_SEP)
    for dx in g.dividers[:2]:
        draw.rectangle([dx, g.band_b_top, dx, g.band_b_bot], fill=d.V3_SEP)

    # ---- C1: how to reach this box ----
    x, w = g.cells["reach"]
    _eyebrow(draw, "GET IN", x)
    ip = str(v.get("ip", "-"))
    ssh_font, ssh_text = _fit_text(draw, f"ssh droplet@{ip}", w, 26,
                                   weight="bold")
    d._v3_text(draw, ssh_text, x, g.by(78), font=ssh_font, fill=d.V3_TEXT)
    rows = (
        ("HOST", str(v.get("hostname", "-"))),
        ("PANEL", "{}×{}".format(*(
            (status["panel"]["width"], status["panel"]["height"])
            if status.get("panel") else (d.WIDTH, d.HEIGHT)))),
        ("KEYBOARD", "Ctrl+Alt+F2 for a clean VT"),
    )
    for i, (k, val) in enumerate(rows):
        y = g.by(122) + i * 34
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
        y = g.by(84) + i * 36
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
    d._rrect(draw, x3, g.by(74), bw, 64, 12, fill=fill, outline=d.V3_SEP2,
             width=1)
    d._v3_text(draw, label, x3 + bw // 2, g.by(92),
               font=d._get_font(15, weight="heavy"), fill=ink, anchor="ma")
    d._v3_text(draw, sub, x3 + bw // 2, g.by(114), font=d._get_font(11),
               fill=d.V3_LABEL3, anchor="ma")
    with disp._touch_regions_lock:
        disp._touch_regions.append(d.TouchRegion(
            "console_return", x3, g.by(74), bw, 64, disp._tap_return_console))

    note = disp._console_last_result or (
        "The panel's touchscreen cannot type — it is HID with no keyboard "
        "keys. You still need a USB keyboard to use the prompt.")
    note_font = d._get_font(11)
    lines = _wrap(draw, note, note_font, bw)
    for i, line in enumerate(lines[:3]):
        d._v3_text(draw, line, x3, g.by(150) + i * 15, font=note_font,
                   fill=d.V3_LABEL3)
    d._v3_text(draw, "Returns automatically if this service stops answering.",
               x3, g.by(150) + min(len(lines), 3) * 15 + 6, font=note_font,
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
    x, y, w, h = g.left + 172, g.top + 12, 74, 22
    d._rrect(draw, x, y, w, h, 11, fill=d.V3_SURFACE, outline=d.V3_SEP, width=1)
    d._v3_text(draw, "‹ BACK", x + w // 2, y + 5,
               font=d._get_font(10, weight="bold"), fill=d.V3_LABEL2,
               anchor="ma", tracking=1)
    # WARP-1801 — the hit box is the whole lockup, not just this chip. The chip
    # stays as the affordance; what changes is how much of the corner accepts
    # the tap. See _lockup_region for why the two must be the same span.
    _lockup_region(disp, "debug_back", disp._go_home)


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
