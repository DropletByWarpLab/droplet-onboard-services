"""Spreadsheet extractor — .xlsx (openpyxl) and legacy .xls (xlrd).

Before WARP-2055 neither had an extractor at all: every workbook on the box
landed `skipped/unsupported_or_failed_extraction`, including the practice's
patient-contact and billing exports.
"""
from __future__ import annotations

import pytest

from extractors.registry import _route
from extractors.spreadsheet import XLS_MIMES, XLSX_MIMES, extract

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
XLS_MIME = "application/vnd.ms-excel"


@pytest.fixture
def workbook(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    contacts = wb.active
    contacts.title = "Contacts"
    contacts.append(["last_name", "first_name", "city"])
    contacts.append(["Abrahams", "Lawrence", "Laguna Beach"])
    contacts.append([None, None, None])  # blank row — must not emit a line
    billing = wb.create_sheet("Billing")
    billing.append(["invoice", "amount"])
    billing.append(["INV-1", 250])
    path = tmp_path / "referrals.xlsx"
    wb.save(path)
    return path


def test_one_span_per_sheet_named_by_sheet(workbook):
    doc = extract(str(workbook), XLSX_MIME)

    assert [s.section_path for s in doc["spans"]] == [["Contacts"], ["Billing"]]
    assert doc["metadata"]["extractor_name"] == "xlsx"
    assert doc["metadata"]["sheet_count"] == 2


def test_rows_keep_column_structure(workbook):
    doc = extract(str(workbook), XLSX_MIME)

    contacts = doc["spans"][0].text
    assert "last_name | first_name | city" in contacts
    assert "Abrahams | Lawrence | Laguna Beach" in contacts
    # The all-None row contributes nothing rather than a bare separator.
    assert "| |" not in contacts
    assert doc["metadata"]["row_count"] == 4


def test_empty_workbook_reports_a_warning_not_a_crash(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    path = tmp_path / "blank.xlsx"
    wb.save(path)

    doc = extract(str(path), XLSX_MIME)

    assert doc["spans"] == []
    assert "spreadsheet_no_values" in doc["warnings"]


def test_legacy_xls_is_routed_to_the_xlrd_backend(tmp_path, monkeypatch):
    """.xls is BIFF, not a zip — openpyxl cannot read it at all."""
    seen = {}

    def _fake_xls(path):
        seen["path"] = path
        return [("Sheet1", ["a | b"])]

    monkeypatch.setattr("extractors.spreadsheet._sheets_from_xls", _fake_xls)
    target = tmp_path / "referrals.xls"
    target.write_bytes(b"\x09\x00\x04\x00")  # BIFF2 BOF, not a zip

    doc = extract(str(target), XLS_MIME)

    assert seen["path"] == str(target)
    assert doc["metadata"]["extractor_name"] == "xls"
    assert doc["spans"][0].text == "a | b"


def test_extension_decides_when_the_mime_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "extractors.spreadsheet._sheets_from_xls",
        lambda path: [("Sheet1", ["x"])],
    )
    target = tmp_path / "bday.xls"
    target.write_bytes(b"\x09\x00")

    assert extract(str(target))["metadata"]["extractor_name"] == "xls"


@pytest.mark.parametrize("mime", sorted(XLSX_MIMES | XLS_MIMES))
def test_registry_routes_every_supported_mime(mime):
    assert _route(mime) is extract
