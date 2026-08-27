"""
Block parser for the small Markdown subset the document renderers accept
(WARP-2211).

This is deliberately NOT a Markdown implementation. The renderers consume a
flat list of typed blocks, and the parser recognises only what a generated
report actually needs:

    headings (# / ## / ###), paragraphs, bullet lists, numbered lists,
    pipe tables, and inline **bold** / *italic*

Everything else is treated as paragraph text. That is the honest behaviour for
a subset: an unsupported construct still appears in the document as the author
wrote it, rather than vanishing or raising.

Why a shared parser rather than one per renderer: `python-docx` and `reportlab`
have nothing in common at the API level, but they need the *same* answer to
"what are the blocks of this document". Parsing twice would let the two formats
drift — the same input rendering a bullet in Word and a paragraph in PDF.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

# A generated report is bounded by the model's 4096-token output budget, so
# these caps are far above anything a legitimate spec produces. They exist so a
# malformed or hostile spec cannot make the renderer allocate without bound.
MAX_BLOCKS = 5_000
MAX_TABLE_COLUMNS = 64


@dataclass
class Block:
    kind: Literal["heading", "paragraph", "bullets", "numbers", "table"]
    text: str = ""
    level: int = 1
    items: list[str] = field(default_factory=list)
    header: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)


_HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
_BULLET = re.compile(r"^[-*]\s+(.*)$")
_NUMBER = re.compile(r"^\d+[.)]\s+(.*)$")
# A table separator: |---|:--:| etc. Its presence on line 2 is what promotes a
# run of pipe rows to a table, matching how every Markdown dialect decides.
_TABLE_SEP = re.compile(r"^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$")


def _split_row(line: str) -> list[str]:
    """Split one pipe-table row into trimmed cells.

    Leading and trailing pipes are optional and are dropped when present, so
    `| a | b |` and `a | b` both yield ["a", "b"].
    """
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")][:MAX_TABLE_COLUMNS]


def parse_blocks(source: str) -> list[Block]:
    """Parse the Markdown subset into a flat block list.

    Consecutive list items of the same kind coalesce into one block, because
    both renderers want to emit a list as a unit rather than as a run of
    lookalike paragraphs. A blank line always closes the block in progress.
    """
    blocks: list[Block] = []
    lines = (source or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i = 0
    para: list[str] = []

    def flush_paragraph() -> None:
        if para:
            blocks.append(Block(kind="paragraph", text=" ".join(para).strip()))
            para.clear()

    while i < len(lines) and len(blocks) < MAX_BLOCKS:
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            flush_paragraph()
            i += 1
            continue

        heading = _HEADING.match(stripped)
        if heading:
            flush_paragraph()
            blocks.append(
                Block(kind="heading", level=len(heading.group(1)), text=heading.group(2).strip())
            )
            i += 1
            continue

        # A pipe table needs its separator on the very next line; without one,
        # a line containing "|" is just prose and is treated as such.
        if "|" in stripped and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1].strip()):
            flush_paragraph()
            header = _split_row(stripped)
            rows: list[list[str]] = []
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(_split_row(lines[i]))
                i += 1
            blocks.append(Block(kind="table", header=header, rows=rows))
            continue

        bullet = _BULLET.match(stripped)
        if bullet:
            flush_paragraph()
            items = [bullet.group(1).strip()]
            i += 1
            while i < len(lines):
                m = _BULLET.match(lines[i].strip())
                if not m:
                    break
                items.append(m.group(1).strip())
                i += 1
            blocks.append(Block(kind="bullets", items=items))
            continue

        number = _NUMBER.match(stripped)
        if number:
            flush_paragraph()
            items = [number.group(1).strip()]
            i += 1
            while i < len(lines):
                m = _NUMBER.match(lines[i].strip())
                if not m:
                    break
                items.append(m.group(1).strip())
                i += 1
            blocks.append(Block(kind="numbers", items=items))
            continue

        para.append(stripped)
        i += 1

    flush_paragraph()
    return blocks[:MAX_BLOCKS]


# Inline spans. Bold is matched before italic so `**x**` is not seen as an
# italic `*` wrapping `*x*`.
_BOLD = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_ITALIC = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", re.DOTALL)


def split_inline(text: str) -> list[tuple[str, bool, bool]]:
    """Split text into `(run, bold, italic)` spans for python-docx.

    Word has no markup string — a run's boldness is a property of the run
    object — so the docx renderer needs the spans, not a marked-up string.
    """
    spans: list[tuple[str, bool, bool]] = []
    pos = 0
    for m in _BOLD.finditer(text):
        if m.start() > pos:
            spans.extend(_split_italic(text[pos : m.start()]))
        spans.append((m.group(1), True, False))
        pos = m.end()
    if pos < len(text):
        spans.extend(_split_italic(text[pos:]))
    return [s for s in spans if s[0]]


def _split_italic(text: str) -> list[tuple[str, bool, bool]]:
    spans: list[tuple[str, bool, bool]] = []
    pos = 0
    for m in _ITALIC.finditer(text):
        if m.start() > pos:
            spans.append((text[pos : m.start()], False, False))
        spans.append((m.group(1), False, True))
        pos = m.end()
    if pos < len(text):
        spans.append((text[pos:], False, False))
    return spans


def to_rl_markup(text: str) -> str:
    """Convert inline spans to ReportLab's Paragraph mini-markup.

    ReportLab parses `<b>` / `<i>` out of the string it is handed, so the
    user's own text MUST be XML-escaped FIRST — otherwise a report body
    containing `<b>` or a bare `&` either restyles the document or raises a
    parse error deep inside the PDF build. Escape, then introduce our own
    tags: never the other way round.
    """
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    out = _BOLD.sub(lambda m: f"<b>{m.group(1)}</b>", escaped)
    out = _ITALIC.sub(lambda m: f"<i>{m.group(1)}</i>", out)
    return out
