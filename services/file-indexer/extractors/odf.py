"""OpenDocument extractor: .odt, .ods, .odp, .odg.

An ODF file is a ZIP whose ``content.xml`` holds the document body, so this
reads it with the stdlib (zipfile + ElementTree) rather than pulling in
odfpy. That keeps the image unchanged and avoids a dependency whose only job
would be the same XML walk.

Span shape follows the structure the format actually has:

* ``.ods`` — one Span per ``table:table``, section_path ``[sheet name]``,
  rows joined with ``" | "`` (matching the xlsx/docx table convention).
* ``.odp`` / ``.odg`` — one Span per ``draw:page``, section_path
  ``[page name]`` (slide or drawing page).
* ``.odt`` — heading-delimited sections, mirroring the docx extractor:
  ``text:h`` opens a section at its ``text:outline-level`` and consecutive
  paragraphs under the same heading path coalesce into one Span.

WARP-287: ODF carries no anchor vocabulary the Files surface can deep-link
to, so every Span uses ``NoneAnchor``.
"""
from __future__ import annotations

import logging
import os
import zipfile
from xml.etree import ElementTree

from anchor_schema import NoneAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)

_NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "draw": "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
}

TEXT_MIME = "application/vnd.oasis.opendocument.text"
SPREADSHEET_MIME = "application/vnd.oasis.opendocument.spreadsheet"
PRESENTATION_MIME = "application/vnd.oasis.opendocument.presentation"
GRAPHICS_MIME = "application/vnd.oasis.opendocument.graphics"

SUPPORTED_MIMES = {
    TEXT_MIME,
    SPREADSHEET_MIME,
    PRESENTATION_MIME,
    GRAPHICS_MIME,
}

_EXT_TO_MIME = {
    ".odt": TEXT_MIME,
    ".ods": SPREADSHEET_MIME,
    ".odp": PRESENTATION_MIME,
    ".odg": GRAPHICS_MIME,
}

# ODF collapses runs of identical cells with table:number-columns-repeated,
# and templates routinely set it to 1024 to pad a row to the sheet edge.
# Expanding those verbatim would bury the real content in separators.
_MAX_CELL_REPEAT = 32
_MAX_CELLS_PER_ROW = 512


def _q(prefix: str, tag: str) -> str:
    return f"{{{_NS[prefix]}}}{tag}"


def _text_of(node) -> str:
    """All descendant text of a node, with ODF's spacing elements honored.

    ``text:s`` encodes a run of spaces and ``text:tab`` a tab; both are empty
    elements, so a plain itertext() would silently glue words together.
    """
    parts: list[str] = []

    def walk(el) -> None:
        tag = el.tag
        if tag == _q("text", "s"):
            try:
                count = int(el.get(_q("text", "c"), "1"))
            except ValueError:
                count = 1
            parts.append(" " * max(1, min(count, 64)))
        elif tag == _q("text", "tab"):
            parts.append("\t")
        elif tag == _q("text", "line-break"):
            parts.append("\n")
        if el.text:
            parts.append(el.text)
        for child in el:
            walk(child)
            if child.tail:
                parts.append(child.tail)

    walk(node)
    return "".join(parts).strip()


def _paragraph_lines(node) -> list[str]:
    """Every text:p / text:h under a node, in document order."""
    lines = []
    for el in node.iter():
        if el.tag in (_q("text", "p"), _q("text", "h")):
            text = _text_of(el)
            if text:
                lines.append(text)
    return lines


def _rows_of_table(table) -> list[str]:
    lines: list[str] = []
    for row in table.iter(_q("table", "table-row")):
        cells: list[str] = []
        for cell in row.findall(_q("table", "table-cell")):
            try:
                repeat = int(cell.get(_q("table", "number-columns-repeated"), "1"))
            except ValueError:
                repeat = 1
            text = " ".join(_paragraph_lines(cell))
            if not text:
                continue
            cells.extend([text] * max(1, min(repeat, _MAX_CELL_REPEAT)))
            if len(cells) >= _MAX_CELLS_PER_ROW:
                break
        line = " | ".join(cells[:_MAX_CELLS_PER_ROW])
        if line:
            lines.append(line)
    return lines


def _heading_level(el) -> int | None:
    if el.tag != _q("text", "h"):
        return None
    try:
        level = int(el.get(_q("text", "outline-level"), "1"))
    except ValueError:
        return 1
    return level if 1 <= level <= 9 else 1


def _spans_for_text_doc(body, filename: str) -> list[Span]:
    """Heading-delimited sections — same shape the docx extractor produces."""
    sections: list[tuple[list[str], list[str]]] = []
    stack: list[str] = []

    def current_path() -> list[str]:
        path = [s for s in stack if s]
        return path or [filename]

    def append(text: str) -> None:
        path = current_path()
        if sections and sections[-1][0] == path:
            sections[-1][1].append(text)
        else:
            sections.append((path, [text]))

    for el in body.iter():
        if el.tag not in (_q("text", "p"), _q("text", "h")):
            continue
        text = _text_of(el)
        if not text:
            continue
        level = _heading_level(el)
        if level is not None:
            stack = stack[: level - 1]
            while len(stack) < level - 1:
                stack.append("")
            stack.append(text)
        append(text)

    spans = []
    for path, paras in sections:
        joined = "\n\n".join(paras).strip()
        if joined:
            spans.append(Span(text=joined, anchor=NoneAnchor(), section_path=path))
    return spans


def _spans_for_pages(body, filename: str) -> list[Span]:
    """One Span per draw:page — a slide (.odp) or a drawing page (.odg)."""
    spans = []
    for index, page in enumerate(body.iter(_q("draw", "page")), start=1):
        name = page.get(_q("draw", "name")) or f"Page {index}"
        lines = _paragraph_lines(page)
        if not lines:
            continue
        spans.append(
            Span(text="\n".join(lines), anchor=NoneAnchor(), section_path=[name])
        )
    return spans


def _spans_for_tables(body, filename: str) -> list[Span]:
    """One Span per table:table — a sheet in an .ods workbook."""
    spans = []
    for index, table in enumerate(body.iter(_q("table", "table")), start=1):
        name = table.get(_q("table", "name")) or f"Sheet {index}"
        lines = _rows_of_table(table)
        if not lines:
            continue
        spans.append(
            Span(text="\n".join(lines), anchor=NoneAnchor(), section_path=[name])
        )
    return spans


def _declared_mime(archive: zipfile.ZipFile, path: str) -> str:
    """The ODF `mimetype` member, falling back to the file extension.

    The member is mandatory and stored uncompressed as the first entry, but
    some producers omit it, so the extension is the backstop.
    """
    try:
        declared = archive.read("mimetype").decode("ascii", "ignore").strip()
    except KeyError:
        declared = ""
    if declared in SUPPORTED_MIMES:
        return declared
    return _EXT_TO_MIME.get(os.path.splitext(path)[1].lower(), TEXT_MIME)


def extract(path: str, mime: str = "") -> ExtractedDoc:
    filename = os.path.basename(path)
    warnings: list[str] = []

    with zipfile.ZipFile(path) as archive:
        declared = _declared_mime(archive, path)
        content = archive.read("content.xml")

    root = ElementTree.fromstring(content)
    body = root.find(_q("office", "body"))
    if body is None:
        body = root

    if declared == SPREADSHEET_MIME:
        spans = _spans_for_tables(body, filename)
    elif declared in (PRESENTATION_MIME, GRAPHICS_MIME):
        spans = _spans_for_pages(body, filename)
    else:
        spans = _spans_for_text_doc(body, filename)

    # A drawing whose text lives outside draw:page (or any layout we didn't
    # anticipate) still has paragraphs somewhere — fall back to a flat walk
    # rather than reporting the document as empty.
    if not spans:
        lines = _paragraph_lines(body)
        if lines:
            spans = [
                Span(
                    text="\n".join(lines),
                    anchor=NoneAnchor(),
                    section_path=[filename],
                )
            ]
            warnings.append("odf_structure_fallback")

    return ExtractedDoc(
        spans=spans,
        language=None,
        metadata={
            "extractor_name": "odf",
            "extractor_version": "1",
            "odf_kind": declared,
            "section_count": len(spans),
        },
        warnings=warnings,
    )
