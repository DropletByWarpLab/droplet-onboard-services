"""POST /render — content types, validation, and the size ceiling."""

from __future__ import annotations

import io
import zipfile

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def test_pdf_comes_back_as_a_pdf(client, auth):
    r = client.post(
        "/render", json={"format": "pdf", "title": "T", "body_markdown": "# H"}, headers=auth
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.content.startswith(b"%PDF-")


def test_docx_comes_back_as_a_reopenable_package(client, auth):
    r = client.post(
        "/render", json={"format": "docx", "title": "T", "body_markdown": "body"}, headers=auth
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(DOCX_MIME)
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        assert "word/document.xml" in z.namelist()


def test_xlsx_comes_back_as_a_reopenable_workbook(client, auth):
    from openpyxl import load_workbook

    r = client.post(
        "/render",
        json={"format": "xlsx", "sheets": [{"name": "S", "columns": ["A"], "rows": [["1"]]}]},
        headers=auth,
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(XLSX_MIME)
    assert load_workbook(io.BytesIO(r.content))["S"]["A1"].value == "A"


def test_an_unknown_format_is_rejected_by_the_schema(client, auth):
    r = client.post("/render", json={"format": "rtf"}, headers=auth)
    assert r.status_code == 422


def test_xlsx_with_no_sheets_is_a_clean_400(client, auth):
    """A RenderError is the caller's fault, not a 500."""
    r = client.post("/render", json={"format": "xlsx", "sheets": []}, headers=auth)
    assert r.status_code == 400


def test_an_oversized_body_is_refused_before_rendering(client, auth):
    import main

    r = client.post(
        "/render",
        json={"format": "pdf", "body_markdown": "x" * (main.MAX_BODY_CHARS + 1)},
        headers=auth,
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "body_too_long"


def test_an_oversized_title_is_refused(client, auth):
    import main

    r = client.post(
        "/render",
        json={"format": "pdf", "title": "x" * (main.MAX_TITLE_CHARS + 1)},
        headers=auth,
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "title_too_long"


def test_a_rendered_document_over_the_ceiling_is_413(client, auth, monkeypatch):
    """Mirrors MAX_WRITE_BYTES. Enforced here as well as at the route, because
    a renderer that can be made to return 500 MB is a memory lever whatever
    the caller intended."""
    import main

    monkeypatch.setattr(main, "MAX_OUTPUT_BYTES", 10)
    r = client.post("/render", json={"format": "pdf", "title": "T"}, headers=auth)
    assert r.status_code == 413


def test_pdf_with_slides_is_a_deck(client, auth):
    from pypdf import PdfReader

    r = client.post("/render", json={"format": "pdf", "slides": [{"title": "One"}, {"title": "Two"}]}, headers=auth)
    assert r.status_code == 200
    reader = PdfReader(io.BytesIO(r.content))
    assert len(reader.pages) == 2
    assert float(reader.pages[0].mediabox.width) / float(reader.pages[0].mediabox.height) == 16 / 9


def test_pptx_route_returns_an_editable_package(client, auth):
    from pptx import Presentation

    r = client.post("/render", json={"format": "pptx", "title": "Deck", "slides": [{"title": "One", "bullets": ["Two"]}]}, headers=auth)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(PPTX_MIME)
    assert len(Presentation(io.BytesIO(r.content)).slides) == 1


def test_pptx_without_slides_is_a_clean_400(client, auth):
    r = client.post("/render", json={"format": "pptx"}, headers=auth)
    assert r.status_code == 400
    assert "at least one slide" in r.json()["detail"]


def test_crowded_slide_is_a_clean_400(client, auth):
    r = client.post("/render", json={"format": "pdf", "slides": [{"title": "T", "bullets": ["Long content " * 30] * 8}]}, headers=auth)
    assert r.status_code == 400
    assert "slide 1 content does not fit" in r.json()["detail"]


def test_slide_spec_rejects_unknown_fields_and_wrong_text_types(client, auth):
    for spec in [{"title": "T", "image": "https://example.com"}, {"title": "T", "bullets": [1]}]:
        r = client.post("/render", json={"format": "pptx", "slides": [spec]}, headers=auth)
        assert r.status_code == 422


def test_slide_input_cannot_silently_discard_document_body_or_sheets(client, auth):
    cases = [
        {"format": "docx", "slides": [{"title": "T"}]},
        {"format": "xlsx", "slides": [{"title": "T"}]},
        {"format": "pdf", "body_markdown": "Body", "slides": [{"title": "T"}]},
        {"format": "pptx", "sheets": [{"columns": ["A"]}], "slides": [{"title": "T"}]},
    ]
    for spec in cases:
        assert client.post("/render", json=spec, headers=auth).status_code == 400


def test_slide_output_keeps_the_size_ceiling(client, auth, monkeypatch):
    import main

    monkeypatch.setattr(main, "MAX_OUTPUT_BYTES", 10)
    for format in ["pdf", "pptx"]:
        r = client.post("/render", json={"format": format, "slides": [{"title": "T"}]}, headers=auth)
        assert r.status_code == 413


def test_xlsx_route_preserves_explicit_formulas_and_a_chart(client, auth):
    from openpyxl import load_workbook

    r = client.post("/render", json={"format": "xlsx", "sheets": [{
        "name": "Budget", "columns": ["Month", "Revenue", "Total"],
        "rows": [["October", 100, None], ["November", 150, None]],
        "formulas": [{"cell": "C2", "expression": "=SUM(B2:B3)"}],
        "chart": {"kind": "bar", "title": "Revenue", "category_column": 1, "value_column": 2},
    }]}, headers=auth)
    assert r.status_code == 200
    workbook = load_workbook(io.BytesIO(r.content))
    assert workbook["Budget"]["C2"].value == "=SUM(B2:B3)"
    assert workbook["Budget"]["C2"].data_type == "f"
    assert len(workbook["Budget"]._charts) == 1
    assert workbook.calculation.fullCalcOnLoad


def test_xlsx_route_rejects_unsafe_formula_as_a_clean_400(client, auth):
    r = client.post("/render", json={"format": "xlsx", "sheets": [{
        "columns": ["A"], "rows": [[None]],
        "formulas": [{"cell": "A2", "expression": '=WEBSERVICE("https://example.com")'}],
    }]}, headers=auth)
    assert r.status_code == 400


def test_xlsx_route_refuses_wide_rows_without_discarding_cells(client, auth):
    import renderers

    r = client.post("/render", json={"format": "xlsx", "sheets": [{
        "rows": [["kept"] * (renderers.MAX_COLUMNS + 1)],
    }]}, headers=auth)
    assert r.status_code == 400
    assert "too many columns in a row" in r.json()["detail"]
