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

# Suppress pdfminer's per-font noise globally at import time so it doesn't
# pollute log output whenever the WARP-862 fallback path is exercised.
logging.getLogger("pdfminer").setLevel(logging.ERROR)


# Default depth cap for outline traversal. The PDF spec doesn't strictly
# bound outline nesting, but 32 is comfortably more than any real document
# (the W3C-recommended XML element nesting limit is 256, so 32 leaves
# generous headroom for outlines). WARP-435 reviewer finding 2: prevents
# a malformed PDF with a pathologically deep outline from hitting Python's
# recursion limit unpredictably.
_OUTLINE_MAX_DEPTH = 32

# Per-page OCR fallback budget for PDFs with no text layer. 0 disables the
# fallback entirely. Tesseract runs ~1-3 s/page, so an uncapped 500-page scan
# would hold the indexer for 10+ minutes and stall every file queued behind it.
_PDF_OCR_MAX_PAGES = int(os.environ.get("PDF_OCR_MAX_PAGES", "50"))

# Rasterization DPI for the OCR fallback. 200 is the low end of Tesseract's
# reliable range for body text; 300 roughly doubles the time for marginal gain
# on the office-scan and fax material this path actually sees.
_PDF_OCR_DPI = int(os.environ.get("PDF_OCR_DPI", "200"))


def _ocr_pdf_pages(path: str, pages: list[int]) -> dict[int, str]:
    """Rasterize the given 1-based page numbers and run Tesseract on each.

    Returns ``{page_number: text}`` for pages that produced any text; pages
    that OCR to nothing (genuinely blank) are omitted. Imported lazily so the
    overwhelmingly common text-layer path never pays for the rasterizer.

    Rendering goes through pypdfium2 directly rather than pdfplumber's
    ``Page.to_image()``. pdfplumber wraps the same renderer but adds its own
    page-parsing layer, and that layer silently reported **zero pages** for
    two of the scanned referral forms on the lab corpus (pypdf read 1 and 3
    pages from the same files). Since every page then fell out of range, the
    OCR fallback returned nothing and the documents stayed unsearchable.
    """
    import pypdfium2

    from extractors.image import _ocr_image

    out: dict[int, str] = {}
    doc = pypdfium2.PdfDocument(path)
    try:
        n_pages = len(doc)
        for page_no in pages:
            if page_no > n_pages:
                continue
            try:
                img = doc[page_no - 1].render(scale=_PDF_OCR_DPI / 72).to_pil()
                text, _warnings, _conf = _ocr_image(img)
            except Exception as exc:  # noqa: BLE001 — one bad page must not abort the file
                logger.warning(
                    "extractor.pdf_ocr_page_failed",
                    extra={"extractor": "pdf", "page": page_no, "error": str(exc)},
                )
                continue
            if text.strip():
                out[page_no] = text
    finally:
        doc.close()
    return out


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


def _looks_letter_spaced(text: str, *, min_tokens: int = 20) -> bool:
    """Detect pypdf's per-glyph failure mode (WARP-862).

    PDFs that position every glyph individually (design-tool exports are
    the common case) make ``page.extract_text()`` emit each character or
    tiny glyph cluster as its own whitespace-separated token::

        D ro p le t
        t a p  t o o l s  —  a  w i d e n i n g  s w i t c h i n g - c o s t

    Such text is useless for retrieval: no real words for lexical search,
    token soup for the embedder. Heuristic: among alphabetic tokens, an
    overwhelming majority being 1–2 characters long never happens in real
    prose (typical English averages ~4–5 chars/word) but is the defining
    signature of glyph-split output. Short samples are skipped — a page
    holding only "Q 4" must not trip the fallback.
    """
    tokens = [t for t in text.split() if any(c.isalpha() for c in t)]
    if len(tokens) < min_tokens:
        return False
    tiny = sum(1 for t in tokens if len(t) <= 2)
    return tiny / len(tokens) > 0.6


def _pdfminer_page_texts(path: str, n_pages: int) -> list[str]:
    """Per-page re-extraction via pdfminer.six (the WARP-862 fallback).

    pdfminer reconstructs words from glyph positions itself, which handles
    the per-glyph PDFs pypdf mangles. Imported lazily so the common path
    never pays for it; its noisy per-font warnings are squelched to ERROR.
    """
    from pdfminer.high_level import extract_text as pdfminer_extract_text

    full = pdfminer_extract_text(path)
    pages = full.split('\f')
    # pdfminer appends a trailing \f on the last page; drop empty tail
    if pages and pages[-1].strip() == '':
        pages = pages[:-1]
    # Pad or trim to match the expected page count
    while len(pages) < n_pages:
        pages.append('')
    return pages[:n_pages]


def extract(path: str) -> ExtractedDoc:
    reader = PdfReader(path)
    spans: list[Span] = []
    warnings: list[str] = []

    filename = os.path.basename(path)
    n_pages = len(reader.pages)
    section_by_page = _section_path_by_page(reader, n_pages)

    page_texts: dict[int, str] = {}
    for idx, page in enumerate(reader.pages, start=1):
        try:
            page_texts[idx] = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001 — per-page failure must not abort the file
            logger.warning(
                "extractor.span.failed",
                extra={"extractor": "pdf", "page": idx, "error": str(exc)},
            )
            warnings.append(f"page_{idx}_extract_failed")

    # WARP-862 — pypdf emits per-glyph token soup for PDFs that position
    # every character individually. When the document as a whole reads as
    # letter-spaced, re-extract through pdfminer.six, which rebuilds words
    # from glyph geometry. Whole-document check (not per-page) so a short
    # spaced heading on an otherwise-fine page doesn't flip backends.
    extractor_name = "pdf"
    combined = "\n".join(page_texts.values())
    if combined.strip() and _looks_letter_spaced(combined):
        try:
            miner_texts = _pdfminer_page_texts(path, n_pages)
        except Exception as exc:  # noqa: BLE001 — fallback failure keeps pypdf output
            logger.warning(
                "extractor.pdfminer_fallback_failed",
                extra={"extractor": "pdf", "error": str(exc)},
            )
            warnings.append("pdfminer_fallback_failed")
        else:
            for idx in range(1, n_pages + 1):
                if miner_texts[idx - 1].strip():
                    page_texts[idx] = miner_texts[idx - 1]
            extractor_name = "pdf+pdfminer"
            warnings.append("pypdf_letter_spaced_used_pdfminer")

    # Scanned material — faxes, photographed forms, NAS scans — carries no text
    # layer at all: pypdf and pdfminer both return "" for every page, the file
    # produces zero Spans, and the watcher files it as `skipped/empty_extraction`
    # with no user-visible signal that the document is unsearchable. Tesseract
    # and Pillow are already in this image for the image extractor, so fall back
    # to rasterize-then-OCR for any page that yielded no text. Pages are handled
    # individually rather than gating on the whole document, so a scanned insert
    # inside an otherwise-digital PDF is recovered too.
    ocr_page_count = 0
    blank_pages = [
        idx for idx in range(1, n_pages + 1) if not page_texts.get(idx, "").strip()
    ]
    if blank_pages and _PDF_OCR_MAX_PAGES > 0:
        budget = blank_pages[:_PDF_OCR_MAX_PAGES]
        if len(blank_pages) > len(budget):
            warnings.append("pdf_ocr_page_cap_reached")
        try:
            ocr_texts = _ocr_pdf_pages(path, budget)
        except Exception as exc:  # noqa: BLE001 — OCR failure keeps the text-layer result
            logger.warning(
                "extractor.pdf_ocr_failed",
                extra={"extractor": "pdf", "error": str(exc)},
            )
            warnings.append("pdf_ocr_failed")
        else:
            if ocr_texts:
                page_texts.update(ocr_texts)
                ocr_page_count = len(ocr_texts)
                extractor_name = f"{extractor_name}+ocr"
                warnings.append("pdf_ocr_used")

    for idx in range(1, n_pages + 1):
        text = page_texts.get(idx, "")
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
            "extractor_name": extractor_name,
            "extractor_version": "4",
            "page_count": n_pages,
            "ocr_page_count": ocr_page_count,
        },
        warnings=warnings,
    )
