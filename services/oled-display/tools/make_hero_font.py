#!/usr/bin/env python3
"""Generate the PyPortal hero bitmap font (BDF) for the py-v3 front-panel.

The editorial idle clock + CPU hero need a heavy proportional numeral face;
terminalio scaled to 132px is too blocky (design_handoff README §"Hero font").
CircuitPython's ``adafruit_bitmap_font`` reads BDF directly, so this tool
rasterises a *subset* (the only glyphs the heroes draw) from a heavy TTF into
a valid BDF bitmap font: digits, colon, %, °, space for the clock/CPU heroes,
plus A-Z and "-" for the WARP-632 claim-code hero (DRPL-XXXX-XXXX off the lid;
uppercase covers AM/PM too).

The output lives at
``services/oled-display/pyportal/lib/fonts/Inter-Hero-66.bdf`` and is copied
onto ``CIRCUITPY/lib/fonts/`` by ``scripts/flash-pyportal.sh``. The firmware
loads it best-effort and falls back to terminalio-scaled heroes if it is
missing or fails to parse, so a font problem never bricks the panel.

Usage (needs Pillow + a heavy TTF; Inter ExtraBold preferred):
    python make_hero_font.py --ttf /path/to/Inter-ExtraBold.ttf

Re-run only when the glyph set or base size changes; the BDF is committed.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# The glyphs the heroes draw. The clock/CPU heroes need digits + ": % ° AMP";
# the claim-code hero (WARP-632) reads off the lid as uppercase alphanumeric
# with hyphen group separators (DRPL-XXXX-XXXX, ADR-017), so we also rasterise
# A-Z and "-". Uppercase-only + the small symbol set keeps the BDF and the
# on-device lazy-rasterisation heap bounded.
GLYPHS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-: %°"
BASE_PX = 66          # base cell px; the firmware scales x2 toward the 132px hero
DEFAULT_TTF_CANDIDATES = [
    "Inter-ExtraBold.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
OUT = (Path(__file__).resolve().parent.parent
       / "pyportal" / "lib" / "fonts" / "Inter-Hero-66.bdf")


def _find_ttf(explicit: str | None) -> str:
    if explicit:
        return explicit
    here = Path(__file__).resolve().parent
    search = [here.parent.parent.parent / ".preview" / "_fonts",
              Path.cwd() / ".preview" / "_fonts"]
    for name in DEFAULT_TTF_CANDIDATES:
        p = Path(name)
        if p.is_absolute() and p.exists():
            return str(p)
        for d in search:
            if (d / name).exists():
                return str(d / name)
    raise SystemExit(
        "no heavy TTF found; pass --ttf (Inter-ExtraBold.ttf preferred)")


def build(ttf_path: str) -> str:
    font = ImageFont.truetype(ttf_path, BASE_PX)
    ascent, descent = font.getmetrics()
    cell_h = ascent + descent
    lines: list[str] = []
    lines.append("STARTFONT 2.1")
    lines.append("FONT -droplet-InterHero-bold-r-normal--%d-660-72-72-p-0-iso10646-1"
                 % cell_h)
    lines.append("SIZE %d 72 72" % BASE_PX)
    lines.append("FONTBOUNDINGBOX %d %d 0 %d" % (BASE_PX, cell_h, -descent))
    lines.append("STARTPROPERTIES 4")
    lines.append("FONT_ASCENT %d" % ascent)
    lines.append("FONT_DESCENT %d" % descent)
    lines.append("DEFAULT_CHAR 32")
    lines.append("PIXEL_SIZE %d" % cell_h)
    lines.append("ENDPROPERTIES")
    lines.append("CHARS %d" % len(GLYPHS))

    for ch in GLYPHS:
        cp = ord(ch)
        adv = int(round(font.getlength(ch)))
        # Render the glyph onto a tall canvas, baseline at y=ascent.
        canvas_w = max(adv + 4, BASE_PX)
        img = Image.new("1", (canvas_w, cell_h), 0)
        d = ImageDraw.Draw(img)
        d.text((0, 0), ch, font=font, fill=1)
        bbox = img.getbbox()
        if bbox is None:  # space — empty bitmap, just an advance
            lines += [
                "STARTCHAR U+%04X" % cp,
                "ENCODING %d" % cp,
                "SWIDTH %d 0" % int(adv * 1000 / BASE_PX),
                "DWIDTH %d 0" % adv,
                "BBX 1 1 0 0",
                "BITMAP",
                "00",
                "ENDCHAR",
            ]
            continue
        x0, y0, x1, y1 = bbox
        gw, gh = x1 - x0, y1 - y0
        # BDF y-offset of the bitmap's bottom from the baseline.
        y_off = ascent - y1
        glyph = img.crop((x0, y0, x1, y1))
        row_bytes = (gw + 7) // 8
        lines += [
            "STARTCHAR U+%04X" % cp,
            "ENCODING %d" % cp,
            "SWIDTH %d 0" % int(adv * 1000 / BASE_PX),
            "DWIDTH %d 0" % adv,
            "BBX %d %d %d %d" % (gw, gh, x0, y_off),
            "BITMAP",
        ]
        px = glyph.load()
        for ry in range(gh):
            val = 0
            for rx in range(gw):
                if px[rx, ry]:
                    val |= 1 << (row_bytes * 8 - 1 - rx)
            lines.append(("%0*X" % (row_bytes * 2, val)))
        lines.append("ENDCHAR")
    lines.append("ENDFONT")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ttf", default=None, help="heavy TTF to rasterise")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    ttf = _find_ttf(args.ttf)
    bdf = build(ttf)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(bdf, encoding="ascii")
    print("wrote %s (%d bytes) from %s" % (out, len(bdf), ttf), file=sys.stderr)


if __name__ == "__main__":
    main()
