"""Small, bounded table/chart specifications shared by document writers."""

from __future__ import annotations

import math
from typing import Any

from fonts import prepare_text
from renderers import RenderError


def validate_table(raw: Any, location: str) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) - {"headers", "rows"}:
        raise RenderError(f"{location} accepts only headers and rows")
    headers, rows = raw.get("headers"), raw.get("rows")
    if not isinstance(headers, list) or not 1 <= len(headers) <= 6:
        raise RenderError(f"{location} requires 1-6 headers")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 10:
        raise RenderError(f"{location} requires 1-10 rows")
    result = {"headers": [], "rows": []}
    for index, source in enumerate([headers, *rows]):
        if not isinstance(source, list) or len(source) != len(headers):
            raise RenderError(f"{location} rows must have exactly as many cells as headers")
        cells = []
        for cell in source:
            if not isinstance(cell, str) or len(cell) > 200:
                raise RenderError(f"{location} cells must be strings of at most 200 characters")
            cells.append(prepare_text(cell, location))
        if index == 0:
            result["headers"] = cells
        else:
            result["rows"].append(cells)
    return result


def validate_chart(raw: Any, location: str) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) - {"kind", "labels", "series"}:
        raise RenderError(f"{location} accepts only kind, labels and series")
    kind, labels, series = raw.get("kind"), raw.get("labels"), raw.get("series")
    if kind not in ("bar", "line", "pie"):
        raise RenderError(f"{location} kind must be bar, line or pie")
    if not isinstance(labels, list) or not 1 <= len(labels) <= 10:
        raise RenderError(f"{location} requires 1-10 category labels")
    if not isinstance(series, list) or not 1 <= len(series) <= 4:
        raise RenderError(f"{location} requires 1-4 series")
    if kind == "pie" and len(series) != 1:
        raise RenderError(f"{location} pie charts require exactly one series")
    prepared_labels = []
    for label in labels:
        if not isinstance(label, str) or not label.strip() or len(label) > 60:
            raise RenderError(f"{location} labels must contain 1-60 characters")
        prepared_labels.append(prepare_text(label, location))
    prepared_series = []
    for entry in series:
        if not isinstance(entry, dict) or set(entry) != {"name", "values"}:
            raise RenderError(f"{location} series require name and values")
        name, values = entry["name"], entry["values"]
        if not isinstance(name, str) or not name.strip() or len(name) > 60:
            raise RenderError(f"{location} series names must contain 1-60 characters")
        if not isinstance(values, list) or len(values) != len(labels):
            raise RenderError(f"{location} values must match the category labels")
        if any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 1e12 for v in values):
            raise RenderError(f"{location} values must be finite numbers between -1e12 and 1e12")
        if kind == "pie" and (any(v < 0 for v in values) or not any(v > 0 for v in values)):
            raise RenderError(f"{location} pie values must be nonnegative with a positive total")
        prepared_series.append({"name": prepare_text(name, location), "values": values})
    return {"kind": kind, "labels": prepared_labels, "series": prepared_series}
