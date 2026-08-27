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


# ── Line prefixes, parsed WITHOUT regex ───────────────────────────────────
#
# These were regexes (`^[-*]\s+(.*)$` and friends) until CodeQL's
# py/polynomial-redos flagged five of them. The pattern is subtle and worth
# naming: `\s+` followed by `(.*)` is ambiguous — for an input like
# "* " + " " * n the engine has n ways to split the run of spaces between the
# two quantifiers, and tries all of them before failing. Body text reaches this
# parser from a model that a user prompts, and the renderer runs under a CPU
# limit, so a line that costs quadratic time is a denial-of-service lever.
#
# Hand-parsing is linear by construction, needs no lookahead, and is frankly
# easier to read than the pattern it replaces. Each helper returns the content
# after the marker, or None when the line is not that kind of line.


def _strip_marker(line: str, marker_len: int) -> str | None:
    """Content after a marker, requiring at least one space to separate it.

    Returns None when the marker is not followed by whitespace — `#hashtag` is
    prose, `# Heading` is a heading.
    """
    rest = line[marker_len:]
    if not rest or not rest[0].isspace():
        return None
    return rest.lstrip()


def _match_heading(line: str) -> tuple[int, str] | None:
    level = 0
    while level < len(line) and line[level] == "#":
        level += 1
        if level > 3:
            return None
    if level == 0:
        return None
    content = _strip_marker(line, level)
    return None if content is None else (level, content)


def _match_bullet(line: str) -> str | None:
    if not line or line[0] not in "-*":
        return None
    return _strip_marker(line, 1)


def _match_number(line: str) -> str | None:
    i = 0
    while i < len(line) and line[i].isdigit():
        i += 1
    if i == 0 or i >= len(line) or line[i] not in ".)":
        return None
    return _strip_marker(line, i + 1)


def _is_table_separator(line: str) -> bool:
    """True for a `|---|:--:|` row.

    Also formerly a regex, and the worst of them: nested quantifiers around
    an inner `\\s*` group. A single pass over the characters answers the same
    question in linear time — the row must contain at least one dash and
    nothing outside the separator alphabet.
    """
    if not line or "-" not in line:
        return False
    return all(ch in "|:- \t" for ch in line)


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

        heading = _match_heading(stripped)
        if heading is not None:
            flush_paragraph()
            level, text = heading
            blocks.append(Block(kind="heading", level=level, text=text))
            i += 1
            continue

        # A pipe table needs its separator on the very next line; without one,
        # a line containing "|" is just prose and is treated as such.
        if "|" in stripped and i + 1 < len(lines) and _is_table_separator(lines[i + 1].strip()):
            flush_paragraph()
            header = _split_row(stripped)
            rows: list[list[str]] = []
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(_split_row(lines[i]))
                i += 1
            blocks.append(Block(kind="table", header=header, rows=rows))
            continue

        bullet = _match_bullet(stripped)
        if bullet is not None:
            flush_paragraph()
            items = [bullet]
            i += 1
            while i < len(lines):
                nxt = _match_bullet(lines[i].strip())
                if nxt is None:
                    break
                items.append(nxt)
                i += 1
            blocks.append(Block(kind="bullets", items=items))
            continue

        number = _match_number(stripped)
        if number is not None:
            flush_paragraph()
            items = [number]
            i += 1
            while i < len(lines):
                nxt = _match_number(lines[i].strip())
                if nxt is None:
                    break
                items.append(nxt)
                i += 1
            blocks.append(Block(kind="numbers", items=items))
            continue

        para.append(stripped)
        i += 1

    flush_paragraph()
    return blocks[:MAX_BLOCKS]


# Inline spans. Bold is matched before italic so `**x**` is not seen as an
# italic `*` wrapping `*x*`.
#
# The span is `[^*]+`, not a lazy `.+?`. Excluding the delimiter leaves exactly
# one way to match up to the closing marker, so the engine never backtracks —
# the same py/polynomial-redos class as the line prefixes above. The cost is
# that emphasis cannot contain a literal `*`, which for this subset is the
# correct reading anyway.
_BOLD = re.compile(r"\*\*([^*]+)\*\*", re.DOTALL)
_ITALIC = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)", re.DOTALL)


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
