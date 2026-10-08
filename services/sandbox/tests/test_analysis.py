"""Exercise the actual constrained child interpreter, loaders and artifacts."""
import base64
import io
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

import pytest
import main
from main import AnalysisRequest, AnalysisSource, run_transform


def analyze(code, sources=None, inputs=None, **kwargs):
    if not sys.platform.startswith("linux"):
        pytest.skip("secure analysis execution requires Linux Landlock/seccomp; unsupported hosts fail closed")
    return run_transform(AnalysisRequest(code=code, inputs=inputs or {}, sources=sources or [], **kwargs), True)


def source(name, data, format="csv"):
    return AnalysisSource(name=name, format=format, contentBase64=base64.b64encode(data).decode())


def test_real_csv_aggregation_logs_and_artifacts():
    result = analyze(
        "import statistics\n"
        "sheet = tables[0]['sheets'][0]\n"
        "numbers = [float(row[1]) for row in sheet['rows']]\n"
        "print('Read', len(numbers), 'rows')\n"
        "output = {'sum': sum(numbers), 'mean': statistics.mean(numbers)}\n"
        "emit_csv('summary.csv', ['metric','value'], [['sum',sum(numbers)]])\n"
        "emit_chart('sales.svg', 'Sales & profit', [row[0] for row in sheet['rows']], numbers)\n",
        [source("sales.csv", b"month,amount\nJan,10\nFeb,20\n")],
    )
    assert result["output"] == {"sum": 30, "mean": 15}
    assert result["stdout"] == "Read 2 rows\n"
    assert result["sources"] == [{"name": "sales.csv", "sheets": [{"name": "CSV", "columns": ["month", "amount"], "rowCount": 2}]}]
    assert base64.b64decode(result["artifacts"][0]["contentBase64"]) == b"metric,value\r\nsum,30.0\r\n"
    chart = base64.b64decode(result["artifacts"][1]["contentBase64"])
    ET.fromstring(chart)
    assert b"Sales &amp; profit" in chart and b"Jan" in chart and b"Feb" in chart


def test_xlsx_cells_dates_and_cache_warning():
    import openpyxl
    import datetime

    workbook = openpyxl.Workbook()
    workbook.active.title = "Sales"
    workbook.active.append(["Date", "Amount", "Formula"])
    workbook.active.append([datetime.date(2026, 10, 8), 12, "=B2*2"])
    stream = io.BytesIO()
    workbook.save(stream)
    result = analyze("output = tables[0]['sheets']", [source("sales.xlsx", stream.getvalue(), "xlsx")])
    assert "output" in result, result
    assert result["output"][0]["rows"] == [["2026-10-08T00:00:00", 12, None]]
    assert "not recalculated" in result["warnings"][0]


def test_xlsx_zip_expansion_refused_before_library_load():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("large.xml", b"x" * (17 * 1024 * 1024))
    result = analyze("output=1", [source("large.xlsx", stream.getvalue(), "xlsx")])
    assert "uncompressed content" in result["error"]


@pytest.mark.parametrize("code,reason", [
    ("import os\noutput=1", "not allowed"),
    ("import pandas\noutput=1", "not allowed"),
    ("output=open('/etc/passwd').read()", "NameError"),
    ("output=1/0", "ZeroDivisionError at line 1"),
    ("output=float('nan')", "Out of range float"),
    ("emit_csv('../evil.csv', ['x'], [[1]])\noutput=1", "simple filename"),
    ("emit_chart('a.svg','a',['x'],[float('inf')])\noutput=1", "finite numbers"),
])
def test_execution_refusals_are_legible(code, reason):
    assert reason in analyze(code)["error"]


def test_deadline_and_output_caps_are_real():
    assert "exceeded 500 ms" in analyze("while True: pass", timeoutMs=500)["error"]
    assert "output exceeded" in analyze("output='x'*10000", outputCapBytes=1024)["error"]


def test_artifact_csv_formula_strings_are_inert_and_numeric_negatives_stay_numeric():
    result = analyze("emit_csv('a.csv', ['value'], [['=1+1'], [' @SUM(1)'], [-2]])\noutput=1")
    content = base64.b64decode(result["artifacts"][0]["contentBase64"]).decode()
    assert "'=1+1" in content and "' @SUM(1)" in content and "\r\n-2\r\n" in content


def test_svg_text_is_escaped_and_has_no_user_markup():
    result = analyze("emit_chart('a.svg', '<script>hi</script>', ['<image onload=hi>'], [-2], 'line')\noutput=1")
    content = base64.b64decode(result["artifacts"][0]["contentBase64"]).decode()
    root = ET.fromstring(content)
    assert "&lt;script&gt;" in content
    assert all(element.tag.split("}")[-1] in {"svg", "rect", "text", "path", "polyline"} for element in root.iter())


def test_no_artifacts_are_returned_when_user_code_fails_after_emitting():
    result = analyze("emit_csv('a.csv',['x'],[[1]])\noutput=1/0")
    assert "error" in result and "artifacts" not in result


def test_print_is_bounded_and_reports_truncation():
    result = analyze("print('x'*20000)\noutput=42")
    assert result["output"] == 42
    assert len(result["stdout"].encode()) <= 8192 and result["stdoutTruncated"] is True


def test_analysis_http_auth_schema_and_lock(client, auth, monkeypatch):
    assert client.post("/analysis", json={"code": "output=1"}).status_code == 401
    assert client.post("/analysis", headers=auth, json={"code": "output=1", "env": {"TOKEN": "x"}}).status_code == 422
    monkeypatch.setattr(main, "SANDBOX_SERVICE_TOKEN", "")
    assert client.post("/analysis", headers=auth, json={"code": "output=1"}).status_code == 503
    monkeypatch.setattr(main, "SANDBOX_SERVICE_TOKEN", "pytest-fake-token")
    assert main.ANALYSIS_LOCK.acquire(blocking=False)
    try:
        result = client.post("/analysis", headers=auth, json={"code": "output=1"})
        assert "busy" in result.json()["error"]
    finally:
        main.ANALYSIS_LOCK.release()


def test_source_limits_never_silently_truncate():
    assert "maximum" in analyze("output=1", [source("many.csv", b"x\n" * 10002)])["error"]
    assert "UnicodeDecodeError" in analyze("output=1", [source("invalid.csv", b"\xff")])["error"]
    assert "columns" in analyze("output=1", [source("wide.csv", ("," * 201).encode())])["error"]
