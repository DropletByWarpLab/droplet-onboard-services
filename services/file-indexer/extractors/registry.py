"""MIME -> extractor dispatch.

Caller responsibility: pass the path to a real file + the detected MIME.
We pick the right extractor, run it, and return the `ExtractedDoc`.

Returns None when:
  - The MIME is not known.
  - The file is over the per-MIME byte cap (logged as `oversized`).
  - The extractor itself errored (logged; chunks just don't get written).

Per-MIME size caps:
  - Phase 1 docs / images: DEFAULT_MAX_BYTES (50 MB)
  - Phase 2 audio (WARP-197): AUDIO_MAX_BYTES (500 MB) — transcripts of
    multi-hour recordings are routine; 50 MB is too small for raw WAV.

WARP-199 will extend `dispatch()` with a `depth` parameter for the
recursion contract (email + archive members). This module ONLY adds
the audio MIME entries + cap in a way that does not break Phase 1.
"""
from __future__ import annotations

import logging
import os
from typing import Callable, Optional

from extractors import audio
from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)

# Phase 1 doc/image cap — kept at the original env-var name so any
# operator-set MAX_INDEX_BYTES override still wins for non-audio paths.
DEFAULT_MAX_BYTES = int(os.environ.get("MAX_INDEX_BYTES", 50 * 1024 * 1024))
AUDIO_MAX_BYTES = int(os.environ.get("AUDIO_MAX_BYTES", 500 * 1024 * 1024))

# Back-compat alias — existing tests in tests/test_extractors.py import
# this name. Equal to DEFAULT_MAX_BYTES (the doc cap).
MAX_INDEX_BYTES = DEFAULT_MAX_BYTES

MAX_INDEX_CHARS = int(os.environ.get("MAX_INDEX_CHARS", 5_000_000))


def _cap_for_mime(mime: str) -> int:
    """Per-MIME byte cap. Audio is much bigger than docs."""
    if mime in audio.SUPPORTED_MIMES:
        return AUDIO_MAX_BYTES
    return DEFAULT_MAX_BYTES


# WARP-197: handlers keyed by MIME. Audio extractor takes (path, mime),
# so we expose it through a one-arg adapter that closes over the MIME.
# Phase 1 extractors still go through `_route()` below.
_HANDLERS: dict[str, Callable[[str], Optional[ExtractedDoc]]] = {
    **{m: (lambda p, _m=m: audio.extract(p, _m)) for m in audio.SUPPORTED_MIMES},
}


def _route(mime: str) -> Optional[Callable[[str], Optional[ExtractedDoc]]]:
    # Phase 2 audio first — explicit handler dict.
    if mime in _HANDLERS:
        return _HANDLERS[mime]
    # Lazy import so test runners can monkeypatch individual extractors.
    if mime.startswith("text/") or mime in {"application/json", "application/xml"}:
        from extractors.text import extract as text_extract  # noqa: PLC0415
        return text_extract
    if mime == "application/pdf":
        from extractors.pdf import extract as pdf_extract  # noqa: PLC0415
        return pdf_extract
    if mime in {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
    }:
        from extractors.docx import extract as docx_extract  # noqa: PLC0415
        return docx_extract
    if mime.startswith("image/"):
        from extractors.image import extract as image_extract  # noqa: PLC0415
        return image_extract
    return None


def dispatch(path: str, mime: str) -> Optional[ExtractedDoc]:
    """Route to the right extractor; return None when nothing should be indexed."""
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
        doc = fn(path)
    except Exception as e:  # pragma: no cover - logged + skipped
        logger.warning("dispatch: extractor %s failed on %s: %s", fn.__name__, path, e)
        return None

    if doc is None:
        return None

    # Truncate-and-warn if the extracted text is huge.
    text = doc.get("text", "")
    if len(text) > MAX_INDEX_CHARS:
        doc["text"] = text[:MAX_INDEX_CHARS]
        warnings = doc.setdefault("warnings", [])
        warnings.append(f"truncated_at_{MAX_INDEX_CHARS}_chars")

    return doc
