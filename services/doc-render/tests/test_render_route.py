"""POST /render — content types, validation, and the size ceiling."""

from __future__ import annotations

import io
import zipfile

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


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
