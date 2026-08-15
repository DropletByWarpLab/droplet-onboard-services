"""MIME -> extractor dispatch.

Caller responsibility: pass the path to a real file + the detected MIME.
We pick the right extractor, run it, and return the `ExtractedDoc`.

Returns None when:
  - The MIME is not known.
  - The file is over the per-MIME byte cap (logged as `oversized`).
  - The extractor itself errored (logged; chunks just don't get written).

Recursion contract (WARP-199, spec §7):
  - `dispatch(path, mime, depth=0)` — handlers like email + archive call
    back with `depth+1` for nested attachments.
  - `MAX_RECURSION_DEPTH = 2` bounds how deep we go before bailing with a
    warning ExtractedDoc (never raises — the caller still wants its
    accumulated partial output).
  - Per-MIME byte caps live in `_cap_for_mime`; audio (WARP-197), video,
    email and archive bumps are larger than the document default.
  - `_call_handler` forwards `depth` only to handlers whose signature
    includes it (email, archive). Phase 1 handlers (text/pdf/docx/image)
    and audio (WARP-197) stay at the simpler `extract(path)` /
    `extract(path, mime)` shapes.
"""
from __future__ import annotations

import inspect
import logging
import os
from typing import Callable, Optional

from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)

# Recursion contract (WARP-199 / spec §7).
MAX_RECURSION_DEPTH = 2

# Default doc cap — preserved from Phase 1 (50 MB).
DEFAULT_MAX_BYTES = int(os.environ.get("MAX_INDEX_BYTES", 50 * 1024 * 1024))

# Per-MIME caps, env-overridable. Phase 2 bumps these for heavy formats:
AUDIO_MAX_BYTES = int(os.environ.get("AUDIO_MAX_BYTES", 500 * 1024 * 1024))
VIDEO_MAX_BYTES = int(os.environ.get("VIDEO_MAX_BYTES", 2048 * 1024 * 1024))
EMAIL_MAX_BYTES = int(os.environ.get("EMAIL_MAX_BYTES", 100 * 1024 * 1024))
ARCHIVE_MAX_BYTES = int(os.environ.get("ARCHIVE_MAX_BYTES", 200 * 1024 * 1024))

# Backwards-compat aliases used by callers + Phase 1 tests.
MAX_INDEX_BYTES = DEFAULT_MAX_BYTES
MAX_INDEX_CHARS = int(os.environ.get("MAX_INDEX_CHARS", 5_000_000))


def _route(mime: str) -> Optional[Callable[..., ExtractedDoc]]:
    # Lazy import so test runners can monkeypatch individual extractors.
    if mime.startswith("text/") or mime in {"application/json", "application/xml"}:
        from extractors.text import extract as text_extract  # noqa: PLC0415
        return text_extract
    if mime == "application/pdf":
        from extractors.pdf import extract as pdf_extract  # noqa: PLC0415
        return pdf_extract
    if mime == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ):
        from extractors.docx import extract as docx_extract  # noqa: PLC0415
        return docx_extract
    # Legacy binary Word is a different format from OOXML, not a variant of
    # it. Routing application/msword at python-docx made every .doc fail with
    # "is not a Word file, content type is ...themeManager+xml".
    try:
        from extractors import doc as doc_ext  # type: ignore  # noqa: PLC0415
        if mime in doc_ext.SUPPORTED_MIMES:
            return doc_ext.extract
    except ImportError:
        pass
    try:
        from extractors import spreadsheet as sheet_ext  # type: ignore  # noqa: PLC0415
        if mime in sheet_ext.SUPPORTED_MIMES:
            return sheet_ext.extract
    except ImportError:
        pass
    try:
        from extractors import odf as odf_ext  # type: ignore  # noqa: PLC0415
        if mime in odf_ext.SUPPORTED_MIMES:
            return odf_ext.extract
    except ImportError:
        pass
    # WARP-435 (ADR-003 Phase 1): PPTX. python-pptx is heavy (lxml at
    # import), so we lazy-import like the other extractors. Try/except
    # so the registry stays usable on branches that haven't shipped
    # python-pptx yet.
    try:
        from extractors import pptx as pptx_ext  # type: ignore  # noqa: PLC0415
        if mime in pptx_ext.SUPPORTED_MIMES:
            return pptx_ext.extract
    except ImportError:
        pass
    if mime.startswith("image/"):
        from extractors.image import extract as image_extract  # noqa: PLC0415
        return image_extract
    # Phase 2 extractors — try/except imports because each lands on its own
    # branch and may not be present in every checkout.
    try:
        from extractors import email as email_ext  # type: ignore  # noqa: PLC0415
        if mime in email_ext.SUPPORTED_MIMES:
            return email_ext.extract
    except ImportError:
        pass
    try:
        from extractors import audio as audio_ext  # type: ignore  # noqa: PLC0415
        if mime in audio_ext.SUPPORTED_MIMES:
            return audio_ext.extract
    except ImportError:
        pass
    try:
        from extractors import video as video_ext  # type: ignore  # noqa: PLC0415
        if mime in video_ext.SUPPORTED_MIMES:
            return video_ext.extract
    except ImportError:
        pass
    try:
        from extractors import archive as archive_ext  # type: ignore  # noqa: PLC0415
        if mime in archive_ext.SUPPORTED_MIMES:
            return archive_ext.extract
    except ImportError:
        pass
    return None


def _cap_for_mime(mime: str) -> int:
    """Per-MIME byte cap. Audio/video/email/archive are bigger than docs.

    Each extractor module exposes a `SUPPORTED_MIMES` frozenset; we consult
    them to decide which cap applies. Try/except imports keep the registry
    usable when a Phase 2 extractor module hasn't landed yet.
    """
    try:
        from extractors import audio as _audio  # type: ignore  # noqa: PLC0415
        if mime in _audio.SUPPORTED_MIMES:
            return AUDIO_MAX_BYTES
    except ImportError:
        pass
    try:
        from extractors import video as _video  # type: ignore  # noqa: PLC0415
        if mime in _video.SUPPORTED_MIMES:
            return VIDEO_MAX_BYTES
    except ImportError:
        pass
    try:
        from extractors import email as _email  # type: ignore  # noqa: PLC0415
        if mime in _email.SUPPORTED_MIMES:
            return EMAIL_MAX_BYTES
    except ImportError:
        pass
    try:
        from extractors import archive as _archive  # type: ignore  # noqa: PLC0415
        if mime in _archive.SUPPORTED_MIMES:
            return ARCHIVE_MAX_BYTES
    except ImportError:
        pass
    return DEFAULT_MAX_BYTES


def _call_handler(handler: Callable[..., ExtractedDoc], path: str, mime: str, depth: int) -> ExtractedDoc:
    """Invoke a handler, forwarding `depth` only when its signature accepts it.

    Phase 1 handlers are `extract(path)`. Phase 2 recursive handlers
    (email, archive) are `extract(path, mime, depth=0)`. Inspect the
    signature so we don't break old shapes when the contract evolves.
    """
    sig = inspect.signature(handler)
    params = sig.parameters
    if "depth" in params:
        # Recursive handlers expect (path, mime, depth=...).
        if "mime" in params:
            return handler(path, mime, depth=depth)
        return handler(path, depth=depth)
    if "mime" in params:
        return handler(path, mime)
    return handler(path)


def dispatch(path: str, mime: str, depth: int = 0) -> Optional[ExtractedDoc]:
    """Route to the right extractor; return None when nothing should be indexed.

    Recursion: email + archive extractors call back into dispatch() with
    depth+1. If `depth` exceeds `MAX_RECURSION_DEPTH`, we return an empty
    ExtractedDoc with a `max_recursion_depth_exceeded` warning. We never
    raise — the caller (an outer email/archive) still wants the partial
    output it already accumulated.
    """
    if depth > MAX_RECURSION_DEPTH:
        # WARP-287: ExtractedDoc is now spans-based. Return an empty
        # spans list rather than the old text/page_breaks shape; the
        # `max_recursion_depth_exceeded` warning is what callers key
        # off of.
        return ExtractedDoc(
            spans=[],
            language=None,
            metadata={"mime": mime, "depth": depth},
            warnings=["max_recursion_depth_exceeded"],
        )

    try:
        size = os.path.getsize(path)
    except OSError as e:
        logger.warning("dispatch: cannot stat %s: %s", path, e)
        return None

    cap = _cap_for_mime(mime)
    if size > cap:
        logger.info(
            "dispatch: skipping oversized file %s (%d bytes > %d) reason=oversized",
            path,
            size,
            cap,
        )
        return None

    fn = _route(mime)
    if fn is None:
        logger.debug("dispatch: no extractor for mime=%s path=%s", mime, path)
        return None

    try:
        doc = _call_handler(fn, path, mime, depth)
    except Exception as e:  # pragma: no cover - logged + skipped
        logger.warning("dispatch: extractor %s failed on %s: %s", getattr(fn, "__name__", "?"), path, e)
        return None

    if doc is None:
        return None

    # WARP-287: truncate-and-warn if the cumulative spans text exceeds
    # MAX_INDEX_CHARS. We walk spans in order and drop / clip whichever
    # one crosses the threshold so each surviving span keeps a valid
    # anchor. The dropped tail is reported in `warnings`.
    spans = doc.get("spans", []) or []
    total = sum(len(s.text) for s in spans)
    if total > MAX_INDEX_CHARS:
        budget = MAX_INDEX_CHARS
        kept: list = []
        for span in spans:
            if budget <= 0:
                break
            if len(span.text) <= budget:
                kept.append(span)
                budget -= len(span.text)
            else:
                # Clip this span; keep its anchor. Span rejects
                # empty/whitespace-only text in __post_init__, so guard
                # before constructing.
                clipped_text = span.text[:budget]
                if clipped_text.strip():
                    clipped = span.__class__(
                        text=clipped_text,
                        anchor=span.anchor,
                        section_path=list(span.section_path),
                    )
                    kept.append(clipped)
                budget = 0
        doc["spans"] = kept
        warnings = doc.setdefault("warnings", [])
        warnings.append(f"truncated_at_{MAX_INDEX_CHARS}_chars")

    return doc
