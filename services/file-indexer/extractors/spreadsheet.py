"""Spreadsheet extractor: .xlsx via openpyxl, legacy .xls via xlrd.

Emits one Span per worksheet, carrying the sheet name as its
``section_path`` so Knowledge breadcrumbs read "workbook > sheet". Rows are
joined with ``" | "`` between cells (the docx table convention) and newlines
between rows, so column structure survives the chunker and a row still reads
as one record.

WARP-287: spreadsheets have no positional anchor vocabulary — a cell
reference is not a deep-link target the Files surface can open — so every
Span carries ``NoneAnchor``.

Both backends read values, not formulas: openpyxl with ``data_only=True``
returns the cached result Excel last wrote. A workbook that has never been
opened by Excel has no cached values, so formula-only sheets can come back
empty; that is a property of the file, not a failure to extract.
"""
from __future__ import annotations

import logging
import os

from anchor_schema import NoneAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)

XLSX_MIMES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
}
XLS_MIMES = {
    "application/vnd.ms-excel",
    "application/msexcel",
}
SUPPORTED_MIMES = XLSX_MIMES | XLS_MIMES

# A single row is joined into one line; a runaway row (some exports pad to
# 16k columns) would otherwise produce a single unusable mega-line.
_MAX_CELLS_PER_ROW = 512


def _row_text(values) -> str:
    cells = []
    for value in list(values)[:_MAX_CELLS_PER_ROW]:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            cells.append(text)
    return " | ".join(cells)


def _sheets_from_xlsx(path: str) -> list[tuple[str, list[str]]]:
    import openpyxl

    # read_only streams rows instead of building the whole cell graph, which
    # matters for the 1500-row patient exports; data_only returns cached
    # values rather than formula strings.
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        out: list[tuple[str, list[str]]] = []
        for sheet in workbook.worksheets:
            lines = [
                line
                for line in (
                    _row_text(row) for row in sheet.iter_rows(values_only=True)
                )
                if line
            ]
            out.append((sheet.title, lines))
        return out
    finally:
        workbook.close()


def _sheets_from_xls(path: str) -> list[tuple[str, list[str]]]:
    import xlrd

    book = xlrd.open_workbook(path)
    try:
        out: list[tuple[str, list[str]]] = []
        for sheet in book.sheets():
            lines = []
            for row_index in range(sheet.nrows):
                line = _row_text(cell.value for cell in sheet.row(row_index))
                if line:
                    lines.append(line)
            out.append((sheet.name, lines))
        return out
    finally:
        book.release_resources()


def extract(path: str, mime: str = "") -> ExtractedDoc:
    filename = os.path.basename(path)

    # Prefer the declared MIME, but fall back to the extension: the watcher
    # registers .xls as application/vnd.ms-excel, and some uploads arrive
    # with a generic octet-stream that the registry has already resolved.
    is_legacy = mime in XLS_MIMES or (
        not mime and path.lower().endswith(".xls")
    )
    reader = _sheets_from_xls if is_legacy else _sheets_from_xlsx

    sheets = reader(path)

    spans: list[Span] = []
    row_count = 0
    for name, lines in sheets:
        if not lines:
            continue
        row_count += len(lines)
        # Sheet name first so a chunk that lands mid-sheet still names its
        # source, then the rows.
        section = [name] if name else [filename]
        spans.append(
            Span(
                text="\n".join(lines),
                anchor=NoneAnchor(),
                section_path=section,
            )
        )

    return ExtractedDoc(
        spans=spans,
        language=None,
        metadata={
            "extractor_name": "xls" if is_legacy else "xlsx",
            "extractor_version": "1",
            "sheet_count": len(sheets),
            "row_count": row_count,
        },
        warnings=[] if spans else ["spreadsheet_no_values"],
    )
