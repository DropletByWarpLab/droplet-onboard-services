"""OpenDocument extractor — .odt, .ods, .odp, .odg.

All four were `skipped/unsupported_or_failed_extraction` before WARP-2052:
registered as MIME types by WARP-1842 but with no extractor behind them.

Fixtures are built here rather than committed as binaries — an ODF file is
just a zip with a `mimetype` member and a `content.xml`, so constructing one
keeps the expected structure visible next to the assertion.
"""
from __future__ import annotations

import zipfile

import pytest

from extractors.odf import (
    GRAPHICS_MIME,
    PRESENTATION_MIME,
    SPREADSHEET_MIME,
    SUPPORTED_MIMES,
    TEXT_MIME,
    extract,
)
from extractors.registry import _route

_NS_DECL = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"'
)


def _odf(tmp_path, name, mimetype, body):
    content = (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f"<office:document-content {_NS_DECL}>"
        f"<office:body>{body}</office:body>"
        f"</office:document-content>"
    )
    path = tmp_path / name
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", mimetype)
        z.writestr("content.xml", content)
    return path


def test_odt_sections_follow_headings(tmp_path):
    body = (
        "<office:text>"
        '<text:h text:outline-level="1">Invoice</text:h>'
        "<text:p>Payable within 30 days.</text:p>"
        '<text:h text:outline-level="2">Line items</text:h>'
        "<text:p>Consultation</text:p>"
        "</office:text>"
    )
    doc = extract(str(_odf(tmp_path, "Invoice.odt", TEXT_MIME, body)))

    assert doc["metadata"]["odf_kind"] == TEXT_MIME
    assert [s.section_path for s in doc["spans"]] == [
        ["Invoice"],
        ["Invoice", "Line items"],
    ]
    assert "Payable within 30 days." in doc["spans"][0].text
    assert "Consultation" in doc["spans"][1].text


def test_ods_emits_one_span_per_sheet_with_row_structure(tmp_path):
    body = (
        "<office:spreadsheet>"
        '<table:table table:name="Expenses">'
        "<table:table-row>"
        "<table:table-cell><text:p>Item</text:p></table:table-cell>"
        "<table:table-cell><text:p>Cost</text:p></table:table-cell>"
        "</table:table-row>"
        "<table:table-row>"
        "<table:table-cell><text:p>Flights</text:p></table:table-cell>"
        "<table:table-cell><text:p>420</text:p></table:table-cell>"
        "</table:table-row>"
        "</table:table>"
        "</office:spreadsheet>"
    )
    doc = extract(str(_odf(tmp_path, "Expense report.ods", SPREADSHEET_MIME, body)))

    assert [s.section_path for s in doc["spans"]] == [["Expenses"]]
    assert doc["spans"][0].text == "Item | Cost\nFlights | 420"


def test_ods_repeated_empty_cells_do_not_flood_the_row(tmp_path):
    """Templates pad rows to the sheet edge with number-columns-repeated."""
    body = (
        "<office:spreadsheet>"
        '<table:table table:name="Padded">'
        "<table:table-row>"
        "<table:table-cell><text:p>Real</text:p></table:table-cell>"
        '<table:table-cell table:number-columns-repeated="1024"/>'
        "</table:table-row>"
        "</table:table>"
        "</office:spreadsheet>"
    )
    doc = extract(str(_odf(tmp_path, "Padded.ods", SPREADSHEET_MIME, body)))

    assert doc["spans"][0].text == "Real"


def test_odp_emits_one_span_per_slide_named_by_the_slide(tmp_path):
    body = (
        "<office:presentation>"
        '<draw:page draw:name="Title slide">'
        "<text:p>Droplet</text:p></draw:page>"
        '<draw:page draw:name="Agenda"><text:p>Roadmap</text:p></draw:page>'
        "</office:presentation>"
    )
    doc = extract(str(_odf(tmp_path, "Simple.odp", PRESENTATION_MIME, body)))

    assert [s.section_path for s in doc["spans"]] == [["Title slide"], ["Agenda"]]
    assert doc["spans"][1].text == "Roadmap"


def test_odg_pages_are_extracted(tmp_path):
    body = (
        "<office:drawing>"
        '<draw:page draw:name="Flow"><text:p>Start</text:p></draw:page>'
        "</office:drawing>"
    )
    doc = extract(str(_odf(tmp_path, "Flowchart.odg", GRAPHICS_MIME, body)))

    assert doc["spans"][0].section_path == ["Flow"]
    assert doc["spans"][0].text == "Start"


def test_spacing_elements_do_not_glue_words_together(tmp_path):
    body = (
        "<office:text><text:p>Total"
        '<text:s text:c="3"/>due<text:tab/>now</text:p></office:text>'
    )
    doc = extract(str(_odf(tmp_path, "Spaced.odt", TEXT_MIME, body)))

    assert doc["spans"][0].text == "Total   due\tnow"


def test_unstructured_body_falls_back_to_a_flat_walk(tmp_path):
    """Text outside any table/page must still be indexed, with a warning."""
    body = "<office:drawing><text:p>Loose caption</text:p></office:drawing>"
    doc = extract(str(_odf(tmp_path, "Odd.odg", GRAPHICS_MIME, body)))

    assert doc["spans"][0].text == "Loose caption"
    assert "odf_structure_fallback" in doc["warnings"]


def test_missing_mimetype_member_falls_back_to_the_extension(tmp_path):
    content = (
        f"<office:document-content {_NS_DECL}><office:body>"
        '<office:spreadsheet><table:table table:name="S">'
        "<table:table-row><table:table-cell><text:p>v</text:p>"
        "</table:table-cell></table:table-row>"
        "</table:table></office:spreadsheet>"
        "</office:body></office:document-content>"
    )
    path = tmp_path / "nomime.ods"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("content.xml", content)

    doc = extract(str(path))

    assert doc["metadata"]["odf_kind"] == SPREADSHEET_MIME
    assert doc["spans"][0].section_path == ["S"]


@pytest.mark.parametrize("mime", sorted(SUPPORTED_MIMES))
def test_registry_routes_every_odf_mime(mime):
    assert _route(mime) is extract
