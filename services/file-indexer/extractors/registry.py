"""MIME -> extractor dispatch.

Caller responsibility: pass the path to a real file + the detected MIME.
We pick the right extractor, run it, and return the `ExtractedDoc`.

Returns None when:
  - The MIME is not known.
  - The file is over MAX_INDEX_BYTES (logged as `oversized`).
  - The extractor itself errored (logged; chunks just don't get written).
"""
from __future__ import annotations

import logging
import os
from typing import Callable, Optional

from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)

MAX_INDEX_BYTES = int(os.environ.get("MAX_INDEX_BYTES", 50 * 1024 * 1024))
MAX_INDEX_CHARS = int(os.environ.get("MAX_INDEX_CHARS", 5_000_000))


def _route(mime: str) -> Optional[Callable[[str], ExtractedDoc]]:
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
    if size > MAX_INDEX_BYTES:
        logger.info(
            "dispatch: skipping oversized file %s (%d bytes > %d) reason=oversized",
            path,
            size,
            MAX_INDEX_BYTES,
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

    # Truncate-and-warn if the extracted text is huge.
    text = doc.get("text", "")
    if len(text) > MAX_INDEX_CHARS:
        doc["text"] = text[:MAX_INDEX_CHARS]
        warnings = doc.setdefault("warnings", [])
        warnings.append(f"truncated_at_{MAX_INDEX_CHARS}_chars")

    return doc
