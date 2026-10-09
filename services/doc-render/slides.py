"""Stateless slide writer: shared measured layout for PDF and editable PPTX.

Only bounded raster bytes hydrated by the orchestrator enter image slides;
HTML, file paths and external resources never reach this writer.
Rather than shrink or discard crowded text, reject it with a slide number so
the caller can split that slide. The bundled font supports Latin, Greek and Cyrillic; unsupported glyphs
and scripts needing shaping fail explicitly instead of producing broken text.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from reportlab.pdfbase.pdfmetrics import stringWidth

from renderers import RenderError
from fonts import BOLD, REGULAR, prepare_text

MAX_SLIDES = 60
MAX_DECK_TITLE_CHARS = 255  # OOXML core-properties hard limit; never truncate.
MAX_SLIDE_TITLE_CHARS = 160
MAX_BULLETS = 8
MAX_BULLET_CHARS = 500
MAX_DECK_CHARS = 50_000
PAGE_WIDTH, PAGE_HEIGHT = 960, 540  # points, 16:9
MARGIN = 60
TITLE_SIZE, TITLE_LEADING = 32, 40
BODY_SIZE, BODY_LEADING = 22, 30
BULLET_GAP = 10
TEXT_WIDTH = PAGE_WIDTH - MARGIN * 2
# Arial in PowerPoint is close to Helvetica. Leave width and height headroom
# for font substitution on the viewer's machine; neither format auto-shrinks.
MEASURE_WIDTH = TEXT_WIDTH * 0.90
INK = "173042"
ACCENT = "007E87"
MUTED = "61717D"


@dataclass(frozen=True)
class TextBlock:
    lines: list[str]
    x: float
    top: float
    font_size: int
    leading: int
    bold: bool = False
    bullet: bool = False
    width: float = TEXT_WIDTH


@dataclass(frozen=True)
class SlideLayout:
    title: TextBlock
    bullets: list[TextBlock]
    subtitle: TextBlock | None = None
    headings: list[TextBlock] | None = None
    table: Any = None
    chart: Any = None
    notes: str = ""
    image: Any = None


def _validate_text(text: Any, limit: int, location: str, *, required: bool = False) -> str:
    if not isinstance(text, str):
        raise RenderError(f"{location} must be a string")
    if len(text) > limit:
        raise RenderError(f"{location} is too long (max {limit} characters)")
    if required and not text.strip():
        raise RenderError(f"{location} must not be empty")
    if "\r" in text or "\t" in text:
        raise RenderError(f"{location} contains an unsupported control character")
    return prepare_text(text, location)


def _wrap(text: str, width: float, size: int, bold: bool = False) -> list[str]:
    """Wrap plain text, including explicit breaks and long unbroken words."""
    font = BOLD if bold else REGULAR
    lines: list[str] = []
    for paragraph in text.split("\n"):
        current = ""
        for word in paragraph.split():
            candidate = f"{current} {word}" if current else word
            if stringWidth(candidate, font, size) <= width:
                current = candidate
                continue
            if current:
                lines.append(current)
                current = ""
            # URLs and identifiers are still text, never fetch targets. Break
            # long words at a character boundary instead of clipping them.
            for char in word:
                if stringWidth(current + char, font, size) > width and current:
                    lines.append(current)
                    current = ""
                current += char
        lines.append(current)
    return lines


def _layout(title: str, slides: list[dict[str, Any]]) -> list[SlideLayout]:
    from rich_slides import layout_deck
    return layout_deck(title, slides)


def render_deck(title: str, slides: list[dict[str, Any]], format: str, theme: str = "droplet") -> bytes:
    from rich_slides import render_pdf, render_pptx, THEMES
    if format not in ("pdf", "pptx"):
        raise RenderError("slide decks require pdf or pptx")
    if theme not in THEMES:
        raise RenderError("slide theme must be droplet, light or dark")
    layouts = _layout(title, slides)
    renderer = render_pdf if format == "pdf" else render_pptx
    return renderer(title, layouts, THEMES[theme])
