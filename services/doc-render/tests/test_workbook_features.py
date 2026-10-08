"""Round-trip the workbook features and reject formulas outside the subset."""

from __future__ import annotations

import io
import zipfile

import pytest
from openpyxl import Workbook, load_workbook

from renderers import RenderError, _cell, render_xlsx
from workbook_features import WorkbookFeatureError, apply_workbook_features


def _sheet(spec):
    wb = Workbook()
    ws = wb.active
    ws.title = "Revenue"
    if spec.get("columns"):
        ws.append([_cell(value) for value in spec["columns"]])
    for row in spec.get("rows", []):
        ws.append([_cell(value) for value in row])
    return wb, ws


def _reopen(wb):
    buffer = io.BytesIO()
    wb.save(buffer)
    return load_workbook(io.BytesIO(buffer.getvalue())), buffer.getvalue()


def test_explicit_formula_round_trips_while_other_cells_keep_native_types():
    spec = {
        "columns": ["Month", "Revenue", "Active", "Zip", "Source"],
        "rows": [["Jan", 100, True, "01234", "=SUM(B2:B3)"], ["Feb", 125.5, False, "00123", "-offset"], ["Total", "", None, "", ""]],
        "formulas": [{"cell": "b4", "expression": " sum($b$2:b3) "}],
    }
    wb, ws = _sheet(spec)
    apply_workbook_features(ws, spec)
    reopened, _ = _reopen(wb)
    result = reopened.active
    assert result["B4"].value == "=SUM($B$2:B3)"
    assert result["B4"].data_type == "f"
    assert result["B2"].value == 100 and result["B2"].data_type == "n"
    assert result["B3"].value == 125.5 and result["B3"].data_type == "n"
    assert result["C2"].value is True and result["C2"].data_type == "b"
    assert result["D2"].value == "01234" and result["D2"].data_type == "s"
    assert result["E2"].value == "'=SUM(B2:B3)" and result["E2"].data_type == "s"
    assert result["E3"].value == "'-offset" and result["E3"].data_type == "s"
    assert result.auto_filter.ref == "A1:E4"


def test_renderer_integration_recalculates_explicit_formulas_and_preserves_chart():
    data = render_xlsx([{
        "name": "Revenue",
        "columns": ["Month", "Revenue"],
        "rows": [["Jan", 100], ["Feb", 125], ["Total", ""]],
        "formulas": [{"cell": "B4", "expression": "SUM(B2:B3)"}],
        "chart": {"title": "Revenue", "kind": "bar", "category_column": 1, "value_column": 2},
    }])
    wb = load_workbook(io.BytesIO(data))
    assert wb["Revenue"]["B4"].value == "=SUM(B2:B3)"
    assert len(wb["Revenue"]._charts) == 1
    assert wb.calculation.fullCalcOnLoad is True
    assert wb.calculation.forceFullCalc is True
    assert wb.calculation.calcMode == "auto"


@pytest.mark.parametrize("expression", [
    "=ROUND(AVERAGE(B2:B3),2)", "SUM(B2:B3)+MIN(B2:B3)-MAX(B2:B3)",
    "ABS(-B2)/COUNT(B2:B3)", "(B2+B3)*.5^2+10%", "1e3+2.5E-2", "+B2", "1+2+3+4",
])
def test_numeric_formula_subset_survives_save_and_reopen(expression):
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", 100], ["Feb", 125], ["Total", ""]], "formulas": [{"cell": "B4", "expression": expression}]}
    wb, ws = _sheet(spec)
    apply_workbook_features(ws, spec)
    reopened, _ = _reopen(wb)
    assert reopened.active["B4"].data_type == "f"
    assert reopened.active["B4"].value.startswith("=")


@pytest.mark.parametrize("kind, expected_tag", [("bar", b"barChart"), ("line", b"lineChart")])
def test_chart_contains_actual_data_references_and_reopens(kind, expected_tag):
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", 100], ["Feb", 125]], "chart": {"title": "Revenue", "kind": kind, "category_column": 1, "value_column": 2}}
    wb, ws = _sheet(spec)
    apply_workbook_features(ws, spec)
    reopened, data = _reopen(wb)
    charts = reopened.active._charts
    assert len(charts) == 1
    assert charts[0].series[0].val.numRef.f == "'Revenue'!$B$2:$B$3"
    assert charts[0].series[0].cat.numRef.f == "'Revenue'!$A$2:$A$3"
    assert charts[0].series[0].tx.strRef.f == "'Revenue'!B1"
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        xml = archive.read("xl/charts/chart1.xml")
        assert expected_tag in xml and b"Revenue" in xml


@pytest.mark.parametrize("expression", [
    'HYPERLINK("https://evil.example","click")', "WEBSERVICE(A2)", "INDIRECT(A2)",
    "OFFSET(A2,0,0)", "CALL(A2)", "REGISTER.ID(A2)", "EXEC(A2)", "OLE(A2)",
    "[evil.xlsx]Sheet1!A1", "'Sheet 2'!A1", "Sheet1!A1", "cmd|' /C calc'!A1",
    "https://evil.example", "SUM(A:A)", "SUM(1:3)", "SUM(A2#)", "@A2", "A2&A3",
    "TRUE", "SUM()", "SUM(A2,)", "ROUND(A2)", "ABS(A2,A3)", "SUM(A2", "A2 A3",
    "1+", "=", "SUM(A4:A2)", "A1000000", "XFD2", "SUM(A2:B500000)",
])
def test_unsafe_or_malformed_formulas_are_refused(expression):
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", 100], ["Feb", 125], ["Total", ""]], "formulas": [{"cell": "B4", "expression": expression}]}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError):
        apply_workbook_features(ws, spec)
    assert ws["B4"].data_type != "f"


@pytest.mark.parametrize("target", ["B5", "C2", "A0", "A1:B2", "Sheet1!A1", "[file]A1", 2, None])
def test_formula_target_cannot_enlarge_or_escape_grid(target):
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", 100]], "formulas": [{"cell": target, "expression": "SUM(B2)"}]}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError):
        apply_workbook_features(ws, spec)
    assert (ws.max_row, ws.max_column) == (2, 2)


def test_all_features_are_validated_before_any_cell_is_changed():
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", 100], ["Total", ""]], "formulas": [{"cell": "B3", "expression": "SUM(B2)"}, {"cell": "A3", "expression": "INDIRECT(A2)"}]}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError):
        apply_workbook_features(ws, spec)
    assert ws["B3"].value == "" and ws["A3"].value == "Total"
    assert ws.auto_filter.ref is None


def test_duplicate_formula_targets_are_refused_instead_of_overwritten():
    spec = {"columns": ["Value"], "rows": [[1], [""]], "formulas": [{"cell": "A3", "expression": "SUM(A2)"}, {"cell": "$a$3", "expression": "42"}]}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError, match="duplicated"):
        apply_workbook_features(ws, spec)
    assert ws["A3"].value == ""


@pytest.mark.parametrize("expression", ["1+" * 5000 + "1", "(" * 40 + "1" + ")" * 40, "+" * 40 + "1", "1^(" * 40 + "1" + ")" * 40])
def test_oversized_or_deep_formulas_are_rejected_without_truncation(expression):
    spec = {"columns": ["Value"], "rows": [[""]], "formulas": [{"cell": "A2", "expression": expression}]}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError):
        apply_workbook_features(ws, spec)
    assert ws["A2"].value == ""


@pytest.mark.parametrize("patch", [
    {"kind": "scatter"}, {"category_column": 0}, {"value_column": 3},
    {"category_column": True}, {"value_column": 2.0}, {"category_column": 2},
    {"title": "x" * 201},
])
def test_bad_chart_is_refused_before_formula_mutation(patch):
    chart = {"title": "Revenue", "kind": "bar", "category_column": 1, "value_column": 2, **patch}
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", 100], ["Total", ""]], "chart": chart, "formulas": [{"cell": "B3", "expression": "SUM(B2)"}]}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError):
        apply_workbook_features(ws, spec)
    assert ws["B3"].value == "" and not ws._charts


@pytest.mark.parametrize("columns, rows", [(["Month", "Revenue"], []), ([], [["Jan", 100], ["Feb", 125]])])
def test_chart_needs_explicit_headers_and_data(columns, rows):
    spec = {"columns": columns, "rows": rows, "chart": {"kind": "line", "category_column": 1, "value_column": 2}}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError):
        apply_workbook_features(ws, spec)


@pytest.mark.parametrize("value", ["100", "=SUM(B2)", "text", True, False, float("nan"), float("inf"), float("-inf")])
def test_chart_refuses_non_numeric_value_cells_before_any_mutation(value):
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", value], ["Total", ""]], "formulas": [{"cell": "B3", "expression": "100"}], "chart": {"kind": "bar", "category_column": 1, "value_column": 2}}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError, match="chart values"):
        apply_workbook_features(ws, spec)
    assert ws["B3"].value == "" and not ws._charts


def test_chart_allows_numbers_and_explicit_formulas_with_optional_blanks():
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", 0], ["Feb", None], ["Mar", ""], ["Apr", "placeholder"]], "formulas": [{"cell": "B5", "expression": "42"}], "chart": {"kind": "line", "category_column": 1, "value_column": 2}}
    wb, ws = _sheet(spec)
    apply_workbook_features(ws, spec)
    reopened, _ = _reopen(wb)
    assert reopened.active["B5"].value == "=42"
    assert len(reopened.active._charts) == 1


def test_chart_needs_some_numeric_or_formula_data():
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", None], ["Feb", ""]], "chart": {"kind": "bar", "category_column": 1, "value_column": 2}}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError, match="at least one numeric"):
        apply_workbook_features(ws, spec)


def test_renderer_maps_bad_chart_values_to_render_error():
    with pytest.raises(RenderError, match="chart values"):
        render_xlsx([{"columns": ["Month", "Revenue"], "rows": [["Jan", True]], "chart": {"kind": "bar", "category_column": 1, "value_column": 2}}])


@pytest.mark.parametrize("formulas", [
    [{"cell": "B3", "expression": "B3+1"}],
    [{"cell": "B3", "expression": "SUM(B2:B3)"}],
    [{"cell": "A3", "expression": "B3"}, {"cell": "B3", "expression": "A3"}],
    [{"cell": "A3", "expression": "SUM(B2:B3)"}, {"cell": "B3", "expression": "A3+1"}],
])
def test_circular_formula_dependencies_are_refused_before_mutation(formulas):
    spec = {"columns": ["Month", "Revenue"], "rows": [["Jan", 100], ["Total", ""]], "formulas": formulas}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError, match="circular"):
        apply_workbook_features(ws, spec)
    assert ws["A3"].value == "Total" and ws["B3"].value == ""


def test_long_acyclic_formula_chain_uses_no_recursive_graph_traversal():
    formulas = [{"cell": f"A{row}", "expression": f"A{row + 1}+1"} for row in range(2, 1001)]
    formulas.append({"cell": "A1001", "expression": "1"})
    spec = {"columns": ["Value"], "rows": [[""] for _ in range(1000)], "formulas": formulas}
    wb, ws = _sheet(spec)
    apply_workbook_features(ws, spec)
    reopened, _ = _reopen(wb)
    assert reopened.active["A2"].value == "=A3+1"
    assert reopened.active["A1001"].value == "=1"


def test_too_many_formulas_are_refused_without_dropping_any():
    spec = {"columns": ["Value"], "rows": [[""] for _ in range(1001)], "formulas": [{"cell": f"A{row}", "expression": "1"} for row in range(2, 1003)]}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError, match="at most 1000"):
        apply_workbook_features(ws, spec)
    assert ws["A2"].value == "" and ws["A1002"].value == ""


@pytest.mark.parametrize("formulas", ["A2=1", {}, ["A2=1"], [{"cell": "A2", "expression": 42}]])
def test_invalid_formula_shapes_fail_closed(formulas):
    spec = {"columns": ["Value"], "rows": [[""]], "formulas": formulas}
    _, ws = _sheet(spec)
    with pytest.raises(WorkbookFeatureError):
        apply_workbook_features(ws, spec)


def test_empty_sheet_does_not_get_a_filter_or_an_invented_data_grid():
    spec = {"columns": [], "rows": []}
    wb, ws = _sheet(spec)
    apply_workbook_features(ws, spec)
    reopened, _ = _reopen(wb)
    assert reopened.active.auto_filter.ref is None
    assert reopened.active["A1"].value is None


def test_cached_values_and_cross_sheet_formula_dependencies_reopen_without_excel():
    data = render_xlsx([
        {"name": "Summary", "columns": ["Value", "Rounded"], "rows": [["", ""], ["", ""]], "formulas": [
            {"cell": "A2", "expression": "SUM('Sales Q1'!B2:B3)"},
            {"cell": "B2", "expression": "ROUND(A2/3,2)"},
            {"cell": "A3", "expression": "1/0"}, {"cell": "B3", "expression": "ABS(A3)"}]},
        {"name": "Sales Q1", "columns": ["Month", "Amount"], "rows": [["Jan", 10], ["Feb", 20]]},
    ])
    cached = load_workbook(io.BytesIO(data), data_only=True)
    assert cached["Summary"]["A2"].value == 30
    assert cached["Summary"]["B2"].value == 10
    assert cached["Summary"]["A3"].value == "#DIV/0!"
    assert cached["Summary"]["B3"].value == "#DIV/0!"
    assert load_workbook(io.BytesIO(data))["Summary"]["A2"].value == "=SUM('Sales Q1'!B2:B3)"


@pytest.mark.parametrize("expression, expected", [
    ("2^3^2", 64), ("2^-2^3", .015625),
    ("2^(3^2)", 512), ("(2^3)^2", 64), ("-2^2", 4),
])
def test_formula_cache_uses_excel_power_associativity(expression, expected):
    data = render_xlsx([{"columns": ["Value"], "rows": [[""]],
        "formulas": [{"cell": "A2", "expression": expression}]}])
    assert load_workbook(io.BytesIO(data), data_only=True).active["A2"].value == expected
    assert load_workbook(io.BytesIO(data)).active["A2"].value == "=" + expression


@pytest.mark.parametrize("expression, expected", [
    ("COUNT(A2:A4)", 1), ("COUNT(A3)", 0), ("COUNT(A3,5)", 1),
])
def test_count_cache_ignores_errors_and_non_numeric_cells(expression, expected):
    data = render_xlsx([{"columns": ["Values", "Count"], "rows": [[10, ""], ["", ""], [True, ""]],
        "formulas": [{"cell": "A3", "expression": "1/0"}, {"cell": "B2", "expression": expression}]}])
    cached = load_workbook(io.BytesIO(data), data_only=True).active
    assert cached["A3"].value == "#DIV/0!"
    assert cached["B2"].value == expected


def test_cross_sheet_cycles_are_refused_and_no_workbook_bytes_escape():
    with pytest.raises(RenderError, match="circular"):
        render_xlsx([
            {"name": "One", "columns": ["Value"], "rows": [[""]], "formulas": [{"cell": "A2", "expression": "Two!A2"}]},
            {"name": "Two", "columns": ["Value"], "rows": [[""]], "formulas": [{"cell": "A2", "expression": "One!A2"}]},
        ])


@pytest.mark.parametrize("kind, columns", [("bar", [2, 3]), ("line", [2, 3]), ("pie", [2])])
def test_multiseries_and_pie_charts_include_numeric_caches(kind, columns):
    data = render_xlsx([{"name": "Data", "columns": ["Month", "Sales", "Cost"], "rows": [["Jan", 10, 8], ["Feb", "", 9]],
        "formulas": [{"cell": "B3", "expression": "B2*2"}],
        "chart": {"kind": kind, "category_column": 1, "value_columns": columns}}])
    chart = load_workbook(io.BytesIO(data)).active._charts[0]
    assert len(chart.series) == len(columns)
    assert [point.v for point in chart.series[0].val.numRef.numCache.pt] == [10, 20]


def test_formats_preserve_native_types_and_iso_dates():
    import datetime
    data = render_xlsx([{"columns": ["Amount", "Share", "Date"], "rows": [[10, .125, "2026-10-08"]], "formats": [
        {"range": "A2", "kind": "currency", "currency": "EUR", "precision": 2},
        {"range": "B2", "kind": "percent", "precision": 1}, {"range": "C2", "kind": "date"}]}])
    ws = load_workbook(io.BytesIO(data)).active
    assert ws["A2"].value == 10 and ws["A2"].number_format == '"EUR" #,##0.00'
    assert ws["B2"].value == .125 and ws["B2"].number_format == "0.0%"
    assert ws["C2"].value == datetime.datetime(2026, 10, 8) and ws["C2"].number_format == "yyyy-mm-dd"


@pytest.mark.parametrize("format_spec", [
    {"range": "A2:B1", "kind": "number"}, {"range": "A3", "kind": "number"},
    {"range": "A2", "kind": "currency", "currency": "BOGUS"},
    {"range": "A2", "kind": "number", "precision": True},
    {"range": "A2", "kind": "date"},
])
def test_malformed_or_unsupported_formats_fail_before_render(format_spec):
    with pytest.raises(RenderError):
        render_xlsx([{"columns": ["Value", "Other"], "rows": [["not a date", 2]], "formats": [format_spec]}])
