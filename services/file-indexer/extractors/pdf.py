"""PDF extractor using pypdf.

Emits one Span per non-empty page with ``Anchor(kind="pdf-page", page=N)``
(WARP-287). Blank pages are skipped (the Span dataclass rejects empty
text).

WARP-435 / ADR-003 Phase 1: also walks the document's outline (a.k.a.
bookmarks) tree to assign every page a hierarchical ``section_path``
(e.g. ``["Chapter 2", "2.1 Background"]``). The unified design carries
that path on each page's Span (``Span.section_path``) rather than on a
global offset table — the page-span's section_path is the outline section
covering that page's start (best-effort). Pages with no covering outline
entry fall back to ``[filename]``.

PDFs without an outline (the majority of scanned + auto-generated PDFs)
get ``[filename]`` for every page.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from pypdf import PdfReader

from anchor_schema import PdfPageAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)


# Default depth cap for outline traversal. The PDF spec doesn't strictly
# bound outline nesting, but 32 is comfortably more than any real document
# (the W3C-recommended XML element nesting limit is 256, so 32 leaves
# generous headroom for outlines). WARP-435 reviewer finding 2: prevents
# a malformed PDF with a pathologically deep outline from hitting Python's
# recursion limit unpredictably.
_OUTLINE_MAX_DEPTH = 32


def _flatten_outline(
    reader: PdfReader,
    outline: Any,
    stack: list[str],
    out: list[tuple[int, list[str]]],
    *,
    max_depth: int = _OUTLINE_MAX_DEPTH,
    _depth: int = 0,
    _visited: set[int] | None = None,
) -> None:
    """Walk pypdf's nested outline list, emitting (page_index, path) tuples.

    pypdf models the outline as a nested list:
      [DestA, [SubDestA1, SubDestA2], DestB, ...]
    where a list immediately following a Destination contains that
    Destination's children. We walk it iteratively maintaining a stack
    of titles representing the current ancestor chain.

    ``page_index`` resolution: each ``Destination`` carries a
    ``.page`` reference. ``reader.get_destination_page_number(dest)``
    is the canonical way to turn that into a 0-based page index.

    Bounded traversal (WARP-435 reviewer finding 2):
      * ``max_depth`` caps recursion depth (default 32). When hit we log
        a warning and stop descending — already-emitted entries are kept.
      * ``_visited`` tracks ``id()`` of every nested list we descend into.
        A malformed PDF with a self-referential or mutually-referential
        outline list would otherwise loop forever; on reentry we log a
        warning and skip.

    Failures (corrupt outline, missing page ref, unhashable Destination)
    are swallowed — bookmarks are nice-to-have, not load-bearing for
    extraction.
    """
    if outline is None:
        return
    if _visited is None:
        _visited = set()

    if _depth >= max_depth:
        logger.warning(
            "pdf: outline depth cap (%d) reached; stopping descent. "
            "Truncated PDF outline branch — earlier entries are kept.",
            max_depth,
        )
        return

    # outline may be a single Destination or a list. Normalise.
    if not isinstance(outline, list):
        outline = [outline]

    # Cycle guard: if we've already walked this exact list object, skip.
    list_id = id(outline)
    if list_id in _visited:
        logger.warning(
            "pdf: outline cycle detected (already-visited list id=%d); "
            "skipping reentry.",
            list_id,
        )
        return
    _visited.add(list_id)

    i = 0
    while i < len(outline):
        entry = outline[i]
        if isinstance(entry, list):
            # A bare nested list with no preceding parent — descend with
            # the current stack unchanged. Defensive against weird PDFs.
            _flatten_outline(
                reader,
                entry,
                stack,
                out,
                max_depth=max_depth,
                _depth=_depth + 1,
                _visited=_visited,
            )
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
            _flatten_outline(
                reader,
                outline[i + 1],
                new_stack,
                out,
                max_depth=max_depth,
                _depth=_depth + 1,
                _visited=_visited,
            )
            i += 2
        else:
            i += 1


def _section_path_by_page(reader: PdfReader, n_pages: int) -> dict[int, list[str]]:
    """Return a ``{page_index: section_path}`` map derived from the outline.

    Each outline entry's section path covers every page from its target
    page up to (but not including) the next entry's target page. We build
    a sparse map of "section starts here" entries, then forward-fill so
    every page index gets the most recent section path at or before it.

    Empty dict when the PDF has no outline — callers fall back to
    ``[filename]`` per page.
    """
    if n_pages <= 0:
        return {}

    try:
        outline = reader.outline
    except Exception as e:
        logger.debug("pdf: outline unavailable (%s); skipping section paths", e)
        return {}

    if not outline:
        return {}

    entries: list[tuple[int, list[str]]] = []
    try:
        _flatten_outline(reader, outline, [], entries)
    except Exception as e:  # pragma: no cover - defensive
        logger.debug("pdf: outline walk failed (%s); skipping", e)
        return {}

    if not entries:
        return {}

    # Sort by page index, stable so siblings on the same page retain
    # in-document recursion order (last one wins as the page's path).
    entries.sort(key=lambda t: t[0])

    # Sparse "section starts here" map: page_index -> path.
    starts: dict[int, list[str]] = {}
    for page_idx, path in entries:
        if 0 <= page_idx < n_pages:
            starts[page_idx] = list(path)

    if not starts:
        return {}

    # Forward-fill: every page inherits the most recent section start.
    by_page: dict[int, list[str]] = {}
    current: list[str] = []
    for idx in range(n_pages):
        if idx in starts:
            current = starts[idx]
        if current:
            by_page[idx] = current
    return by_page


def extract(path: str) -> ExtractedDoc:
    reader = PdfReader(path)
    spans: list[Span] = []
    warnings: list[str] = []

    filename = os.path.basename(path)
    n_pages = len(reader.pages)
    section_by_page = _section_path_by_page(reader, n_pages)

    for idx, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001 — per-page failure must not abort the file
            logger.warning(
                "extractor.span.failed",
                extra={"extractor": "pdf", "page": idx, "error": str(exc)},
            )
            warnings.append(f"page_{idx}_extract_failed")
            continue

        if not text or not text.strip():
            continue

        # section_by_page is 0-based; our page anchor is 1-based.
        section_path = section_by_page.get(idx - 1) or [filename]
        spans.append(
            Span(
                text=text,
                anchor=PdfPageAnchor(page=idx),
                section_path=section_path,
            )
        )

    return ExtractedDoc(
        spans=spans,
        language=None,
        metadata={
            "extractor_name": "pdf",
            "extractor_version": "2",
            "page_count": n_pages,
        },
        warnings=warnings,
    )
