"""Bounded Excel numeric grammar/evaluator. No eval, external links or macros."""
from __future__ import annotations
import math
import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.utils.datetime import to_excel
import datetime

FUNCTIONS = {"SUM", "AVERAGE", "MIN", "MAX", "COUNT", "ROUND", "ABS"}
CELL = re.compile(r"\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})\Z")
REF = re.compile(r"(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_]*))!)?(\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6})\Z")
NUMBER = re.compile(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")
TOKEN = re.compile(r"(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_]*)!)?\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[A-Za-z]+|[+*/^%(),:\-]")

class FormulaError(ValueError):
    pass

class CellError:
    def __init__(self, code): self.code = code

def coordinate(raw: Any, dimensions: tuple[int, int]) -> str:
    match = CELL.fullmatch(raw) if isinstance(raw, str) else None
    if match is None: raise FormulaError("formula cells must be within-sheet A1 references")
    column, row = match.groups()
    if int(row) > dimensions[0] or column_index_from_string(column) > dimensions[1]:
        raise FormulaError("formula cells must be inside the existing sheet grid")
    return f"{column.upper()}{row}"

class Parser:
    def __init__(self, raw, sheet, dimensions):
        if not isinstance(raw, str): raise FormulaError("formula expression must be a string")
        expression = raw.strip().removeprefix("=")
        if not expression or len(expression) > 8191: raise FormulaError("formula expression must contain 1 to 8191 characters")
        self.sheet, self.dimensions, self.tokens, self.position, self.refs = sheet, dimensions, [], 0, set()
        offset = 0
        while offset < len(expression):
            if expression[offset].isspace(): offset += 1; continue
            match = TOKEN.match(expression, offset)
            if not match: raise FormulaError("formula contains unsupported syntax")
            self.tokens.append(match.group()); offset = match.end()
    def peek(self): return self.tokens[self.position] if self.position < len(self.tokens) else ""
    def take(self):
        token = self.peek(); self.position += 1; return token
    def reference(self, token, default=None):
        match = REF.fullmatch(token)
        if not match: raise FormulaError("formula contains an invalid cell reference")
        named = (match[1].replace("''", "'") if match[1] else match[2]) or default or self.sheet
        names = {name.casefold(): name for name in self.dimensions}
        name = names.get(named.casefold())
        if name is None: raise FormulaError(f"formula refers to missing sheet {named!r}")
        cell = coordinate(match[3], self.dimensions[name]); parsed = CELL.fullmatch(cell)
        return name, column_index_from_string(parsed[1]), int(parsed[2])
    def expression(self, minimum=0, depth=0):
        if depth > 32: raise FormulaError("formula nesting is too deep")
        token = self.take()
        if token in ("+", "-"): node = ("unary", token, self.expression(4, depth + 1))
        elif token == "(":
            node = self.expression(0, depth + 1)
            if self.take() != ")": raise FormulaError("formula has unmatched parentheses")
        elif REF.fullmatch(token):
            name, column, row = self.reference(token)
            end_column, end_row = column, row
            if self.peek() == ":":
                self.take(); end_name, end_column, end_row = self.reference(self.take(), name)
                if end_name != name: raise FormulaError("ranges cannot span sheets")
            if end_column < column or end_row < row: raise FormulaError("formula ranges must run from top-left to bottom-right")
            self.refs.add((name, column, row, end_column, end_row))
            node = ("ref", name, column, row) if (column, row) == (end_column, end_row) else ("range", name, column, row, end_column, end_row)
        elif NUMBER.fullmatch(token):
            value = float(token)
            if not math.isfinite(value): raise FormulaError("formula numeric literals must be finite")
            node = ("number", value)
        elif token.upper() in FUNCTIONS and self.take() == "(":
            args = [self.expression(0, depth + 1)]
            while self.peek() == ",": self.take(); args.append(self.expression(0, depth + 1))
            if self.take() != ")": raise FormulaError("formula has unmatched function parentheses")
            name = token.upper()
            if (name == "ROUND" and len(args) != 2) or (name == "ABS" and len(args) != 1): raise FormulaError("formula has an invalid numeric-function argument count")
            node = ("function", name, args)
        else: raise FormulaError("formula supports only numeric literals, workbook cells and approved functions")
        while self.peek() == "%": self.take(); node = ("unary", "%", node)
        precedence = {"+": 1, "-": 1, "*": 2, "/": 2, "^": 3}
        while self.peek() in precedence and precedence[self.peek()] >= minimum:
            op = self.take(); level = precedence[op]
            node = ("binary", op, node, self.expression(level if op == "^" else level + 1, depth + 1))
        return node
    def parse(self):
        ast = self.expression()
        if self.position != len(self.tokens): raise FormulaError("formula contains unsupported syntax")
        # Preserve quoted sheet names; only identifiers and cell columns fold.
        normalized = []
        for token in self.tokens:
            match = REF.fullmatch(token)
            if match:
                prefix = token.rsplit("!", 1)[0] + "!" if "!" in token else ""
                normalized.append(prefix + match[3].upper())
            else: normalized.append(token.upper())
        return "=" + "".join(normalized), ast, self.refs

def formula_order(formulas):
    dependents = {target: set() for target in formulas}
    pending = {}
    for target, (_, _, references) in formulas.items():
        dependencies = set()
        for sheet, left, top, right, bottom in references:
            if left == right and top == bottom:
                reference = (sheet, left, top)
                if reference in formulas: dependencies.add(reference)
            else:
                dependencies.update(key for key in formulas if key[0] == sheet and left <= key[1] <= right and top <= key[2] <= bottom)
        pending[target] = len(dependencies)
        for dependency in dependencies: dependents[dependency].add(target)
    ready = [target for target, count in pending.items() if count == 0]
    ordered = []
    while ready:
        target = ready.pop(); ordered.append(target)
        for dependent in dependents[target]:
            pending[dependent] -= 1
            if pending[dependent] == 0: ready.append(dependent)
    if len(ordered) != len(formulas): raise FormulaError("formula dependencies must not contain a circular reference")
    return ordered

def calculate(workbook, formulas):
    values, visits = {}, [0]
    def read(sheet, column, row):
        visits[0] += 1
        if visits[0] > 1_000_000: raise FormulaError("formula calculation exceeds one million cell reads")
        key = (sheet, column, row)
        if key in values: return values[key]
        value = workbook[sheet].cell(row, column).value
        if isinstance(value, (datetime.datetime, datetime.date)): return to_excel(value)
        return value
    def numeric(value):
        if isinstance(value, CellError): return value
        if isinstance(value, list): return CellError("#VALUE!")
        if value in (None, ""): return 0.0
        try: return float(value)
        except (ValueError, TypeError): return CellError("#VALUE!")
    def evaluate(ast):
        # Iterative post-order also handles long left-associative expressions.
        stack, results = [(ast, False)], {}
        while stack:
            node, visited = stack.pop(); kind = node[0]
            children = [node[2]] if kind == "unary" else [node[2], node[3]] if kind == "binary" else node[2] if kind == "function" else []
            if children and not visited:
                stack.append((node, True)); stack.extend((child, False) for child in reversed(children)); continue
            if kind == "number": result = node[1]
            elif kind == "ref": result = read(*node[1:])
            elif kind == "range": result = [read(node[1], col, row) for row in range(node[3], node[5] + 1) for col in range(node[2], node[4] + 1)]
            elif kind in ("binary", "unary"):
                operands = [numeric(results[id(child)]) for child in children]
                result = next((value for value in operands if isinstance(value, CellError)), None)
                if result is None:
                    a = operands[0]
                    if kind == "unary": result = -a if node[1] == "-" else a / 100 if node[1] == "%" else a
                    else:
                        b = operands[1]
                        try: result = a+b if node[1] == "+" else a-b if node[1] == "-" else a*b if node[1] == "*" else a/b if node[1] == "/" else a**b
                        except ZeroDivisionError: result = CellError("#DIV/0!")
                        except (OverflowError, ValueError): result = CellError("#NUM!")
            else:
                args = [results[id(child)] for child in children]
                flat = [value for arg in args for value in (arg if isinstance(arg, list) else [arg])]
                result = next((value for value in flat if isinstance(value, CellError)), None)
                if result is None:
                    numbers = [float(value) for value in flat if isinstance(value, (int, float)) and not isinstance(value, bool)]
                    name = node[1]
                    if name == "SUM": result = sum(numbers)
                    elif name == "COUNT": result = len(numbers)
                    elif name == "AVERAGE": result = sum(numbers)/len(numbers) if numbers else CellError("#DIV/0!")
                    elif name == "MIN": result = min(numbers) if numbers else 0
                    elif name == "MAX": result = max(numbers) if numbers else 0
                    else:
                        operands = [numeric(arg) for arg in args]
                        result = next((value for value in operands if isinstance(value, CellError)), None)
                        if result is None:
                            if name == "ABS": result = abs(operands[0])
                            else:
                                digits = operands[1]
                                if not digits.is_integer() or abs(digits) > 100: result = CellError("#NUM!")
                                else:
                                    try: result = float(Decimal(str(operands[0])).quantize(Decimal(1).scaleb(-int(digits)), rounding=ROUND_HALF_UP))
                                    except Exception: result = CellError("#NUM!")
            if isinstance(result, complex) or (isinstance(result, (float, int)) and not math.isfinite(result)): result = CellError("#NUM!")
            results[id(node)] = result
        result = results[id(ast)]
        return CellError("#VALUE!") if isinstance(result, list) else result
    for target in formula_order(formulas): values[target] = evaluate(formulas[target][1])
    return values
