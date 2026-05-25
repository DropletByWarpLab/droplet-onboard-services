"""PDF extractor using pypdf.

Records per-page text plus the cumulative character offset where each
page ended, so chunkers / citation rendering can deep-link to a page
number.

WARP-435 / ADR-003 Phase 1: also walks the document's outline (a.k.a.
bookmarks) tree to assign every page a hierarchical ``sectionPath``
(e.g. ``["Chapter 2", "2.1 Background"]``). The per-page section paths
land on ``metadata.section_paths`` so downstream code in
``brain_ingest`` / ``watcher`` / ``transcription_worker`` can derive a
per-chunk path from each chunk's start char offset → page → section
path. PDFs without an outline (the majority of scanned + auto-generated
PDFs) just get an empty list — the caller falls back to
``[filename]`` at chunk time.
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


def _build_section_paths_per_page(
    reader: PdfReader, n_pages: int
) -> list[list[str]]:
    """Return a list of length ``n_pages``; index i = section path covering page i.

    Pages preceding any outline entry get ``[]`` — caller falls back to
    document-level ``[filename]``. Pages between two outline entries
    inherit the most recent preceding entry's path (standard outline
    semantics).
    """
    section_paths: list[list[str]] = [[] for _ in range(n_pages)]
    try:
        outline = reader.outline
    except Exception as e:
        logger.debug("pdf: outline unavailable (%s); skipping section paths", e)
        return section_paths

    if not outline:
        return section_paths

    entries: list[tuple[int, list[str]]] = []
    try:
        _flatten_outline(reader, outline, [], entries)
    except Exception as e:  # pragma: no cover - defensive
        logger.debug("pdf: outline walk failed (%s); skipping", e)
        return section_paths

    if not entries:
        return section_paths

    # Sort by page index then by recursion order. Stable sort preserves
    # in-document order for siblings at the same page.
    entries.sort(key=lambda t: t[0])

    # Sweep: every page after entry's page_index inherits its path until
    # the next entry comes along.
    current_path: list[str] = []
    next_idx = 0
    for page_i in range(n_pages):
        while next_idx < len(entries) and entries[next_idx][0] <= page_i:
            current_path = entries[next_idx][1]
            next_idx += 1
        section_paths[page_i] = list(current_path)

    return section_paths


def extract(path: str) -> ExtractedDoc:
    reader = PdfReader(path)
    parts: list[str] = []
    page_breaks: list[int] = []
    cum = 0
    for page in reader.pages:
        text = (page.extract_text() or "").strip()
        if text:
            parts.append(text)
            cum += len(text) + 2  # +2 for "\n\n" join below
        page_breaks.append(cum)

    full_text = "\n\n".join(parts)
    section_paths = _build_section_paths_per_page(reader, len(reader.pages))

    return cast(
        ExtractedDoc,
        {
            "text": full_text,
            "page_breaks": page_breaks,
            "language": None,
            "metadata": {
                "extractor_name": "pdf",
                "extractor_version": "1.1",
                "page_count": len(reader.pages),
                "word_count": len(full_text.split()),
                # WARP-435: per-page section path derived from the PDF
                # outline. Empty list per page when no outline exists.
                # Indexed by page number (0-based). Caller maps chunk
                # char-offset → page (via page_breaks) → section path.
                "section_paths": section_paths,
            },
            "warnings": [],
        },
    )
