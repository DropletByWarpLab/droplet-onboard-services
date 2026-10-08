"""Explicit, bounded formulas and charts for generated workbooks.

Ordinary cell strings still go through renderers._cell. Only the separate
formulas specification may create an Excel formula, and its grammar admits
arithmetic and a small numeric-function whitelist, never links or other sheets.
"""

from __future__ import annotations

import math
import re
from typing import Any

from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.utils import column_index_from_string, get_column_letter

FUNCTIONS = {"SUM", "AVERAGE", "MIN", "MAX", "COUNT", "ROUND", "ABS"}
MAX_FORMULA_CHARS = 8192  # Excel's limit includes the leading '='.
MAX_FORMULA_DEPTH = 32
MAX_FORMULAS = 1000
CELL = re.compile(r"\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})\Z")
TOKEN = re.compile(
    r"\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}"
    r"|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?"
    r"|[A-Za-z]+|[+*/^%(),:\-]"
)
NUMBER = re.compile(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


class WorkbookFeatureError(ValueError):
    """An unsafe, malformed or out-of-bounds workbook feature."""


def _coordinate(raw: Any, max_row: int, max_column: int) -> str:
    match = CELL.fullmatch(raw) if isinstance(raw, str) else None
    if match is None:
        raise WorkbookFeatureError("formula cells must be within-sheet A1 references")
    column, row = match.groups()
    if int(row) > max_row or column_index_from_string(column.upper()) > max_column:
        raise WorkbookFeatureError("formula cells must be inside the existing sheet grid")
    return f"{column.upper()}{row}"


class _FormulaParser:
    """Validate the numeric subset without evaluating any model-supplied code."""

    def __init__(self, expression: str, max_row: int, max_column: int) -> None:
        self.tokens: list[str] = []
        self.position = 0
        self.max_row = max_row
        self.max_column = max_column
        self.references: set[tuple[int, int, int, int]] = set()
        offset = 0
        while offset < len(expression):
            if expression[offset].isspace():
                offset += 1
                continue
            match = TOKEN.match(expression, offset)
            if match is None:
                raise WorkbookFeatureError("formula contains unsupported syntax")
            self.tokens.append(match.group())
            offset = match.end()

    def peek(self) -> str:
        return self.tokens[self.position] if self.position < len(self.tokens) else ""

    def take(self) -> str:
        token = self.peek()
        self.position += 1
        return token

    def expression(self, minimum: int = 0, depth: int = 0) -> None:
        if depth > MAX_FORMULA_DEPTH:
            raise WorkbookFeatureError("formula nesting is too deep")
        token = self.take()
        if token in ("+", "-"):
            self.expression(4, depth + 1)
        elif token == "(":
            self.expression(0, depth + 1)
            if self.take() != ")":
                raise WorkbookFeatureError("formula has unmatched parentheses")
        elif CELL.fullmatch(token):
            start = _coordinate(token, self.max_row, self.max_column)
            end = start
            if self.peek() == ":":
                self.take()
                end = _coordinate(self.take(), self.max_row, self.max_column)
            a, b = CELL.fullmatch(start), CELL.fullmatch(end)
            start_column, end_column = column_index_from_string(a[1]), column_index_from_string(b[1])
            start_row, end_row = int(a[2]), int(b[2])
            if start_row > end_row or start_column > end_column:
                raise WorkbookFeatureError("formula ranges must run from top-left to bottom-right")
            self.references.add((start_column, start_row, end_column, end_row))
        elif NUMBER.fullmatch(token):
            pass
        elif token.upper() in FUNCTIONS and self.take() == "(":
            count = 1
            self.expression(0, depth + 1)
            while self.peek() == ",":
                self.take()
                count += 1
                self.expression(0, depth + 1)
            if self.take() != ")":
                raise WorkbookFeatureError("formula has unmatched function parentheses")
            if (token.upper() == "ROUND" and count != 2) or (token.upper() == "ABS" and count != 1):
                raise WorkbookFeatureError("formula has an invalid numeric-function argument count")
        else:
            raise WorkbookFeatureError("formula supports only numeric literals, local cells and approved functions")

        while self.peek() == "%":
            self.take()
        precedence = {"+": 1, "-": 1, "*": 2, "/": 2, "^": 3}
        while self.peek() in precedence and precedence[self.peek()] >= minimum:
            operator = self.take()
            level = precedence[operator]
            self.expression(level if operator == "^" else level + 1, depth + 1)

    def validate(self) -> str:
        self.expression()
        if self.position != len(self.tokens):
            raise WorkbookFeatureError("formula contains unsupported syntax")
        return "=" + "".join(self.tokens).upper()


def _formula(raw: Any, max_row: int, max_column: int) -> tuple[str, set[tuple[int, int, int, int]]]:
    if not isinstance(raw, str):
        raise WorkbookFeatureError("formula expression must be a string")
    expression = raw.strip()
    if expression.startswith("="):
        expression = expression[1:]
    if not expression or len(expression) + 1 > MAX_FORMULA_CHARS:
        raise WorkbookFeatureError("formula expression must contain 1 to 8191 characters")
    parser = _FormulaParser(expression, max_row, max_column)
    return parser.validate(), parser.references


def _reject_cycles(formulas: list[tuple[str, str, set[tuple[int, int, int, int]]]]) -> None:
    """Topologically remove formula targets; no recursion or range expansion."""
    coordinates = {}
    for target, _, _ in formulas:
        match = CELL.fullmatch(target)
        coordinates[target] = (column_index_from_string(match[1]), int(match[2]))
    targets_at = {coordinate: target for target, coordinate in coordinates.items()}
    dependents: dict[str, set[str]] = {target: set() for target in coordinates}
    pending = {}
    for target, _, references in formulas:
        dependencies: set[str] = set()
        for left, top, right, bottom in references:
            if left == right and top == bottom:
                dependency = targets_at.get((left, top))
                if dependency is not None:
                    dependencies.add(dependency)
            else:
                # At most 1,000 formula targets, regardless of the range's size.
                dependencies.update(name for name, (column, row) in coordinates.items() if left <= column <= right and top <= row <= bottom)
        pending[target] = len(dependencies)
        for dependency in dependencies:
            dependents[dependency].add(target)
    ready = [target for target, count in pending.items() if count == 0]
    visited = 0
    while ready:
        dependency = ready.pop()
        visited += 1
        for target in dependents[dependency]:
            pending[target] -= 1
            if pending[target] == 0:
                ready.append(target)
    if visited != len(formulas):
        raise WorkbookFeatureError("formula dependencies must not contain a circular reference")


def _chart(spec: Any, ws: Any, max_row: int, max_column: int, rows: list[list[Any]], formula_targets: set[str]) -> Any:
    if not isinstance(spec, dict):
        raise WorkbookFeatureError("sheet chart must be an object")
    kind = spec.get("kind")
    if kind not in ("bar", "line"):
        raise WorkbookFeatureError("chart kind must be bar or line")
    columns = [spec.get("category_column"), spec.get("value_column")]
    if any(type(column) is not int or not 1 <= column <= max_column for column in columns):
        raise WorkbookFeatureError("chart columns must be integers inside the existing sheet grid")
    if columns[0] == columns[1]:
        raise WorkbookFeatureError("chart category and value columns must be different")
    if max_row < 2:
        raise WorkbookFeatureError("chart needs a header row and at least one data row")
    has_value = False
    for index, row in enumerate(rows, start=2):
        if f"{get_column_letter(columns[1])}{index}" in formula_targets:
            has_value = True
            continue
        value = row[columns[1] - 1] if len(row) >= columns[1] else None
        if value is None or value == "":
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or (isinstance(value, float) and not math.isfinite(value)):
            raise WorkbookFeatureError("chart values must be finite numbers, explicit formulas or blanks")
        has_value = True
    if not has_value:
        raise WorkbookFeatureError("chart needs at least one numeric value or explicit formula")
    title = spec.get("title", "")
    if not isinstance(title, str) or len(title) > 200:
        raise WorkbookFeatureError("chart title must be a string of at most 200 characters")
    chart = BarChart() if kind == "bar" else LineChart()
    if title:
        chart.title = title
    chart.add_data(Reference(ws, min_col=columns[1], min_row=1, max_row=max_row), titles_from_data=True)
    chart.set_categories(Reference(ws, min_col=columns[0], min_row=2, max_row=max_row))
    return chart


def apply_workbook_features(ws: Any, spec: dict[str, Any]) -> None:
    """Validate all features, then update an already-written worksheet.

    Targets and source ranges cannot enlarge the original data grid. Formula
    targets may replace explicit empty placeholders. A bad chart or later
    formula leaves earlier cells untouched; nothing is silently dropped.
    """
    columns, rows = spec.get("columns") or [], spec.get("rows") or []
    max_column = max([len(columns)] + [len(row) for row in rows])
    max_row = len(rows) + (1 if columns else 0)
    formulas = spec.get("formulas")
    if formulas is None:
        formulas = []
    if not isinstance(formulas, list):
        raise WorkbookFeatureError("sheet formulas must be an array")
    if len(formulas) > MAX_FORMULAS:
        raise WorkbookFeatureError("sheet supports at most 1000 explicit formulas")
    validated: list[tuple[str, str, set[tuple[int, int, int, int]]]] = []
    targets: set[str] = set()
    for formula in formulas:
        if not isinstance(formula, dict):
            raise WorkbookFeatureError("each formula must be an object")
        target = _coordinate(formula.get("cell"), max_row, max_column)
        if target in targets:
            raise WorkbookFeatureError("formula targets must not be duplicated")
        targets.add(target)
        expression, references = _formula(formula.get("expression"), max_row, max_column)
        validated.append((target, expression, references))
    _reject_cycles(validated)
    chart = None
    if spec.get("chart") is not None:
        if not columns:
            raise WorkbookFeatureError("chart needs explicit column headers")
        chart = _chart(spec["chart"], ws, max_row, max_column, rows, targets)

    for target, expression, _ in validated:
        ws[target] = expression
    if columns and rows and max_column:
        ws.auto_filter.ref = f"A1:{get_column_letter(max_column)}{max_row}"
    if chart is not None:
        ws.add_chart(chart, f"{get_column_letter(max_column + 2)}2")
