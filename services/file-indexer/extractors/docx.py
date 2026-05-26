"""DOCX extractor using python-docx.

Flattens paragraphs and table rows into a single document body. Tables
are joined with `" | "` between cells so column structure survives the
chunker.

WARP-435 / ADR-003 Phase 1: walks the paragraph stream and tracks
heading-style depth via ``paragraph.style.name`` (``Heading 1``,
``Heading 2``, ...). Each body paragraph emits a ``sectionPath`` based
on the most recent heading at each depth. The result lands on
``metadata.section_paths`` as a list of (char_offset, path) tuples, so
the chunker can derive a per-chunk path from the chunk's start offset.
"""
from __future__ import annotations

from typing import cast

from docx import Document

from extractors.types import ExtractedDoc


def _heading_level(style_name: str) -> int | None:
    """Parse a Word style name into a heading depth (1..9) or None.

    Word ships ``Heading 1`` .. ``Heading 9`` as the canonical heading
    styles; some templates add custom ``Heading X - Foo`` variants. We
    accept anything that starts with ``Heading `` followed by a number.
    """
    if not style_name or not style_name.startswith("Heading"):
        return None
    # Strip the "Heading" prefix and grab the first space-separated token.
    rest = style_name[len("Heading") :].strip()
    if not rest:
        return None
    first = rest.split()[0]
    try:
        level = int(first)
    except ValueError:
        return None
    if 1 <= level <= 9:
        return level
    return None


def extract(path: str) -> ExtractedDoc:
    document = Document(path)
    parts: list[str] = []

    # Per-emitted-paragraph section path. We track the live heading
    # stack as we walk and snapshot it for every body paragraph that
    # follows. Heading paragraphs themselves are included in the body
    # text (they're meaningful content) but their *own* path is the
    # stack *before* they were added — same convention as PDF outlines.
    stack: list[str] = []
    # ``section_paths``: list of (cumulative_char_offset, path) tuples
    # marking the start of each body span. The chunker maps a chunk
    # start offset to the most recent preceding entry.
    section_paths: list[tuple[int, list[str]]] = []
    cum_offset = 0

    for para in document.paragraphs:
        text = para.text.strip()
        if not text:
            continue

        style_name = ""
        try:
            style_name = (para.style.name or "").strip() if para.style else ""
        except Exception:
            style_name = ""

        level = _heading_level(style_name)
        if level is not None:
            # Truncate stack to ``level - 1`` (heading-1 resets to empty,
            # heading-2 keeps the heading-1 above it, etc.) then push the
            # new heading. ``len(stack)`` may already be shorter — pad
            # with empty strings rather than over-popping.
            stack = stack[: level - 1]
            while len(stack) < level - 1:
                stack.append("")
            stack.append(text)

        # Snapshot the path for this paragraph. For headings we capture
        # the freshly-updated path (heading is part of its own section);
        # for body paragraphs we capture the live stack.
        section_paths.append((cum_offset, list(stack)))
        parts.append(text)
        cum_offset += len(text) + 2  # +2 for the "\n\n" join below

    # Tables go too — flatten cell text. Tables inherit whatever section
    # was active when they appear; python-docx doesn't expose
    # heading-aware ordering for tables vs paragraphs in a single
    # iteration (would require walking ``document.element.body``), so
    # we attach all tables to the trailing section path. That's a
    # pragmatic approximation — better than the legacy "no path" path.
    for table in document.tables:
        for row in table.rows:
            row_text = " | ".join(
                cell.text.strip() for cell in row.cells if cell.text.strip()
            )
            if row_text:
                section_paths.append((cum_offset, list(stack)))
                parts.append(row_text)
                cum_offset += len(row_text) + 2

    full_text = "\n\n".join(parts)

    return cast(
        ExtractedDoc,
        {
            "text": full_text,
            "page_breaks": [],  # python-docx doesn't track page breaks reliably
            "language": None,
            "metadata": {
                "extractor_name": "docx",
                "extractor_version": "1.1",
                "paragraph_count": len(document.paragraphs),
                "word_count": len(full_text.split()),
                # WARP-435: list of (char_offset, [section, ...]) tuples
                # tracking heading hierarchy at each body-span boundary.
                # Empty list = no headings in the doc.
                "section_paths": section_paths,
            },
            "warnings": [],
        },
    )
