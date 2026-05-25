"""PDF extractor using pypdf.

Records per-page text plus the cumulative character offset where each
page ended, so chunkers / citation rendering can deep-link to a page
number.

WARP-435 / ADR-003 Phase 1: also walks the document's outline (a.k.a.
bookmarks) tree to assign every page a hierarchical ``sectionPath``
(e.g. ``["Chapter 2", "2.1 Background"]``). The per-page section paths
land on ``metadata.section_paths`` so downstream code in
``brain_ingest`` / ``watcher`` / ``transcription_worker`` can derive a
per-chunk path from each chunk's start char offset → section path.
PDFs without an outline (the majority of scanned + auto-generated PDFs)
just get an empty list — the caller falls back to ``[filename]`` at
chunk time.

QA follow-up (WARP-435): ``section_paths`` is emitted as
``list[tuple[int, list[str]]]`` — `(char_offset_of_page_start, path)` —
matching the shape ``chunker.section_path_for_offset`` consumes and
matching the DOCX / PPTX / TXT / EML extractors. The previous shape
(``list[list[str]]`` indexed by page) raised ``ValueError`` on the
first chunk of any PDF with an empty-outline page.
"""
from __future__ import annotations

import logging
from typing import Any, cast

from pypdf import PdfReader

from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)


def _flatten_outline(
    reader: PdfReader, outline: Any, stack: list[str], out: list[tuple[int, list[str]]]
) -> None:
    """Walk pypdf's nested outline list, emitting (page_index, path) tuples.

    pypdf models the outline as a nested list:
      [DestA, [SubDestA1, SubDestA2], DestB, ...]
    where a list immediately following a Destination contains that
    Destination's children. We walk it iteratively maintaining a stack
    of titles representing the current ancestor chain.

    ``page_index`` resolution: each ``Destination`` carries a
    ``.page`` reference. ``reader.get_destination_page_number(dest)``
    is the canonical way to turn that into a 0-based page index; we
    fall back to scanning ``reader.pages`` for older pypdf shapes.

    Failures (corrupt outline, missing page ref, unhashable Destination)
    are swallowed — bookmarks are nice-to-have, not load-bearing for
    extraction.
    """
    if outline is None:
        return
    # outline may be a single Destination or a list. Normalise.
    if not isinstance(outline, list):
        outline = [outline]

    i = 0
    while i < len(outline):
        entry = outline[i]
        if isinstance(entry, list):
            # A bare nested list with no preceding parent — descend with
            # the current stack unchanged. Defensive against weird PDFs.
            _flatten_outline(reader, entry, stack, out)
            i += 1
            continue

        title = ""
        try:
            title = str(getattr(entry, "title", "") or "").strip()
        except Exception:
            title = ""

        page_index = None
        try:
            page_index = reader.get_destination_page_number(entry)
        except Exception:
            page_index = None

        new_stack = stack + [title] if title else list(stack)
        if page_index is not None and new_stack:
            out.append((page_index, list(new_stack)))

        # Look ahead — if the next element is a list, it's our children.
        if i + 1 < len(outline) and isinstance(outline[i + 1], list):
            _flatten_outline(reader, outline[i + 1], new_stack, out)
            i += 2
        else:
            i += 1


def _build_section_paths(
    reader: PdfReader, page_start_offsets: list[int]
) -> list[tuple[int, list[str]]]:
    """Return ``(char_offset_of_page_start, path)`` tuples for the doc.

    ``page_start_offsets`` is the per-page char offset into ``full_text``
    where each page's content begins (page 0 starts at 0, page 1 starts
    just after page 0's text + "\\n\\n" join, etc.). We map each outline
    entry's page index through that lookup so downstream callers can
    feed the result straight into ``chunker.section_path_for_offset``
    without any extra page-→-offset translation.

    Only outline entries with a *change* in section path get an entry in
    the output (no redundant tuples for pages that inherit the previous
    section). Pages preceding any outline entry are implicitly covered
    by the chunker's fallback (returns ``[]`` when offset precedes the
    first entry, so the chunk header degrades to just the filename).
    """
    if not page_start_offsets:
        return []

    try:
        outline = reader.outline
    except Exception as e:
        logger.debug("pdf: outline unavailable (%s); skipping section paths", e)
        return []

    if not outline:
        return []

    entries: list[tuple[int, list[str]]] = []
    try:
        _flatten_outline(reader, outline, [], entries)
    except Exception as e:  # pragma: no cover - defensive
        logger.debug("pdf: outline walk failed (%s); skipping", e)
        return []

    if not entries:
        return []

    # Sort by page index, stable so siblings on the same page retain
    # in-document recursion order.
    entries.sort(key=lambda t: t[0])

    n_pages = len(page_start_offsets)
    out: list[tuple[int, list[str]]] = []
    prev_path: list[str] | None = None
    for page_idx, path in entries:
        if page_idx < 0 or page_idx >= n_pages:
            # Outline pointing at a page we don't have text for (e.g.
            # an empty page that got dropped). Skip rather than crash.
            continue
        if prev_path is not None and path == prev_path:
            # Same path as previous entry — no new tuple needed; the
            # earlier offset already covers this page.
            continue
        out.append((page_start_offsets[page_idx], list(path)))
        prev_path = path

    return out


def extract(path: str) -> ExtractedDoc:
    reader = PdfReader(path)
    parts: list[str] = []
    page_breaks: list[int] = []
    # Per-page start offset into the joined ``full_text``. Page 0
    # always starts at 0; subsequent pages start just past the prior
    # page's text + the "\n\n" separator. Pages that yielded no text
    # don't contribute to ``parts`` (and so don't get a join separator)
    # — their start offset collapses to the running ``cum`` cursor.
    page_start_offsets: list[int] = []
    cum = 0
    for page in reader.pages:
        text = (page.extract_text() or "").strip()
        if text:
            page_start_offsets.append(cum)
            parts.append(text)
            cum += len(text) + 2  # +2 for "\n\n" join below
        else:
            page_start_offsets.append(cum)
        page_breaks.append(cum)

    full_text = "\n\n".join(parts)
    section_paths = _build_section_paths(reader, page_start_offsets)

    return cast(
        ExtractedDoc,
        {
            "text": full_text,
            "page_breaks": page_breaks,
            "language": None,
            "metadata": {
                "extractor_name": "pdf",
                "extractor_version": "1.2",
                "page_count": len(reader.pages),
                "word_count": len(full_text.split()),
                # WARP-435 (QA fix): (char_offset, path) tuples derived
                # from the PDF outline, matching the shape DOCX / PPTX /
                # TXT / EML emit so ``chunker.section_path_for_offset``
                # consumes them directly. Empty list when the PDF has
                # no outline — the chunker then falls back to a
                # filename-only header per chunk.
                "section_paths": section_paths,
            },
            "warnings": [],
        },
    )
