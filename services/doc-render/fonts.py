"""Bundled, permissively licensed fonts; no runtime downloads or OS fonts."""

from __future__ import annotations

import unicodedata
from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

REGULAR = "DropletSans"
BOLD = "DropletSansBold"
ITALIC = "DropletSansItalic"
BOLD_ITALIC = "DropletSansBoldItalic"
_FONT_DIR = Path(__file__).with_name("fonts")
_FONTS = {
    REGULAR: "NotoSans-Regular.ttf",
    BOLD: "NotoSans-Bold.ttf",
    ITALIC: "NotoSans-Italic.ttf",
    BOLD_ITALIC: "NotoSans-BoldItalic.ttf",
}
for _name, _filename in _FONTS.items():
    pdfmetrics.registerFont(TTFont(_name, str(_FONT_DIR / _filename)))
pdfmetrics.registerFontFamily(REGULAR, normal=REGULAR, bold=BOLD, italic=ITALIC, boldItalic=BOLD_ITALIC)
_SUPPORTED = set.intersection(*(set(pdfmetrics.getFont(name).face.charToGlyph) for name in _FONTS))


def prepare_text(text: str, location: str) -> str:
    """NFC preserves composed accents; unsupported/shaped scripts fail clearly.

    Noto Sans covers Latin, Greek and Cyrillic, including punctuation and many
    symbols. A glyph being present does not prove we can lay out a script:
    right-to-left/shaping scripts and uncomposed combining marks need a shaping
    engine, so they are refused rather than drawn in the wrong order.
    """
    from renderers import RenderError

    text = unicodedata.normalize("NFC", text)
    for char in text:
        if char in ("\n", "\r", "\t"):
            continue
        if unicodedata.category(char) in ("Cc", "Cf", "Cs"):
            raise RenderError(f"{location} contains an unsupported control character")
        if unicodedata.bidirectional(char) in ("R", "AL", "AN") or unicodedata.combining(char):
            raise RenderError(f"{location} contains text requiring an unsupported shaping layout (U+{ord(char):04X})")
        if ord(char) not in _SUPPORTED:
            raise RenderError(f"{location} contains a character unsupported by the bundled font (U+{ord(char):04X})")
    return text
