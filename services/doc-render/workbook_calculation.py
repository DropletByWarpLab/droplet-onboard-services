"""Bounded Excel business-formula evaluator. No eval, external links or macros."""
from __future__ import annotations
import math
import re
import time
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.utils.datetime import to_excel
import datetime

FUNCTIONS = {"SUM", "AVERAGE", "MIN", "MAX", "COUNT", "ROUND", "ABS", "IF", "COUNTIF", "SUMIF"}
COMPARISONS = {"=", "<>", "<", "<=", ">", ">="}
MAX_CELL_READS = 1_000_000
MAX_EVALUATION_STEPS = 1_000_000
MAX_DEPENDENCY_CHECKS = 1_000_000
MAX_CALCULATION_SECONDS = 5
MAX_CRITERIA_LENGTH = 255
CELL = re.compile(r"\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})\Z")
REF = re.compile(r"(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_]*))!)?(\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6})\Z")
NUMBER = re.compile(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")
TOKEN = re.compile(r'''"(?:[^"\x00-\x08\x0b\x0c\x0e-\x1f]|"")*"|(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_]*)!)?\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[A-Za-z]+|<>|<=|>=|[=<>+*/^%(),:\-]''')

class FormulaError(ValueError):
    pass

class CellError:
    def __init__(self, code): self.code = code

def range_shape(node):
    if node[0] == "ref": return 1, 1
    if node[0] == "range": return node[5] - node[3] + 1, node[4] - node[2] + 1
    raise FormulaError("conditional aggregate arguments must be workbook cell ranges")

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
        elif token.startswith('"'):
            value = token[1:-1].replace('""', '"')
            if any(not (ch in "\t\n\r" or 0x20 <= ord(ch) <= 0xD7FF or 0xE000 <= ord(ch) <= 0xFFFD or 0x10000 <= ord(ch) <= 0x10FFFF) for ch in value):
                raise FormulaError("formula string literals must contain valid XML text")
            node = ("string", value)
        elif token.upper() in ("TRUE", "FALSE"):
            node = ("boolean", token.upper() == "TRUE")
        elif NUMBER.fullmatch(token):
            value = float(token)
            if not math.isfinite(value): raise FormulaError("formula numeric literals must be finite")
            node = ("number", value)
        elif token.upper() in FUNCTIONS and self.take() == "(":
            args = [self.expression(0, depth + 1)]
            while self.peek() == ",": self.take(); args.append(self.expression(0, depth + 1))
            if self.take() != ")": raise FormulaError("formula has unmatched function parentheses")
            name = token.upper()
            counts = {"ROUND": (2,), "ABS": (1,), "IF": (3,), "COUNTIF": (2,), "SUMIF": (2, 3)}
            if name in counts and len(args) not in counts[name]: raise FormulaError("formula has an invalid function argument count")
            if name in ("COUNTIF", "SUMIF"):
                shape = range_shape(args[0])
                if name == "SUMIF" and len(args) == 3 and range_shape(args[2]) != shape:
                    raise FormulaError("SUMIF ranges must have identical row and column counts")
            node = ("function", name, args)
        else: raise FormulaError("formula supports only scalar literals, workbook cells and approved functions")
        while self.peek() == "%": self.take(); node = ("unary", "%", node)
        precedence = {**{op: 0 for op in COMPARISONS}, "+": 1, "-": 1, "*": 2, "/": 2, "^": 3}
        while self.peek() in precedence and precedence[self.peek()] >= minimum:
            op = self.take(); level = precedence[op]
            # Excel evaluates equal-precedence operators left to right,
            # including powers; cached values must match its recalculation.
            node = ("binary", op, node, self.expression(level + 1, depth + 1))
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
            else: normalized.append(token if token.startswith('"') else token.upper())
        return "=" + "".join(normalized), ast, self.refs

def formula_order(formulas, tick=None):
    checks, deadline = 0, time.monotonic() + MAX_CALCULATION_SECONDS
    def check():
        nonlocal checks
        checks += 1
        if checks > MAX_DEPENDENCY_CHECKS: raise FormulaError("formula dependencies exceed their work limit")
        if checks % 64 == 0 and time.monotonic() >= deadline: raise FormulaError("formula dependencies exceed their time limit")
        if tick: tick()
    dependents = {target: set() for target in formulas}
    pending = {}
    for target, (_, _, references) in formulas.items():
        dependencies = set()
        for sheet, left, top, right, bottom in references:
            check()
            if left == right and top == bottom:
                reference = (sheet, left, top)
                if reference in formulas: dependencies.add(reference)
            else:
                for key in formulas:
                    check()
                    if key[0] == sheet and left <= key[1] <= right and top <= key[2] <= bottom: dependencies.add(key)
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

def compare_values(left, right, operator):
    """Excel scalar ordering: numbers, case-insensitive text, then booleans."""
    error = next((value for value in (left, right) if isinstance(value, CellError)), None)
    if error is not None: return error
    if isinstance(left, list) or isinstance(right, list): return CellError("#VALUE!")
    if left is None: left = "" if isinstance(right, str) else False if isinstance(right, bool) else 0
    if right is None: right = "" if isinstance(left, str) else False if isinstance(left, bool) else 0
    def ordered(value):
        if isinstance(value, bool): return 2, value
        if isinstance(value, str): return 1, value.casefold()
        return 0, value
    a, b = ordered(left), ordered(right)
    return a == b if operator == "=" else a != b if operator == "<>" else a < b if operator == "<" else a <= b if operator == "<=" else a > b if operator == ">" else a >= b

def wildcard_tokens(pattern):
    tokens, index = [], 0
    while index < len(pattern):
        char = pattern[index]; index += 1
        if char == "~" and index < len(pattern) and pattern[index] in "*?~":
            tokens.append(("literal", pattern[index])); index += 1
        elif char == "*":
            if not tokens or tokens[-1][0] != "star": tokens.append(("star", ""))
        elif char == "?": tokens.append(("question", ""))
        else: tokens.append(("literal", char))
    return tokens

def wildcard_match(text, tokens, tick):
    """Bounded greedy matching avoids regex backtracking on customer text."""
    offset, position, star, retry = 0, 0, -1, 0
    while offset < len(text):
        tick()
        if position < len(tokens) and (tokens[position][0] == "question" or tokens[position] == ("literal", text[offset])):
            offset += 1; position += 1
        elif position < len(tokens) and tokens[position][0] == "star":
            star, retry = position, offset; position += 1
        elif star >= 0:
            retry += 1; offset, position = retry, star + 1
        else: return False
    while position < len(tokens) and tokens[position][0] == "star": position += 1
    return position == len(tokens)

def criteria_matcher(criteria, tick):
    if isinstance(criteria, CellError): return criteria
    if isinstance(criteria, list): return CellError("#VALUE!")
    operator, operand = "=", 0 if criteria is None else criteria
    if isinstance(operand, str):
        if len(operand) > MAX_CRITERIA_LENGTH: return CellError("#VALUE!")
        prefix = re.match(r"(<=|>=|<>|=|<|>)(.*)\Z", operand, re.DOTALL)
        if prefix: operator, operand = prefix.groups()
        numeric = re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", operand.strip())
        if numeric:
            operand = float(operand)
            if not math.isfinite(operand): return CellError("#VALUE!")
        elif operand.upper() in ("TRUE", "FALSE"):
            operand = operand.upper() == "TRUE"
    if isinstance(operand, str) and operator in ("=", "<>") and any(char in operand for char in "*?~"):
        tokens = wildcard_tokens(operand.casefold())
        def matches_wildcard(value):
            matched = isinstance(value, str) and wildcard_match(value.casefold(), tokens, tick)
            return matched if operator == "=" else not matched
        return matches_wildcard
    def matches(value):
        if isinstance(value, CellError): return False
        if isinstance(operand, bool):
            if isinstance(value, str) and value.upper() in ("TRUE", "FALSE"):
                value = value.upper() == "TRUE"
            return compare_values(value, operand, operator) if isinstance(value, bool) else operator == "<>"
        if isinstance(operand, (int, float)):
            # Only equality/inequality coerces numeric text in the input cells.
            # Ordered numeric criteria ignore text, even text containing digits.
            if operator in ("=", "<>") and isinstance(value, str) and re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", value):
                value = float(value)
            if value is None or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value): return operator == "<>"
        elif operand == "" and operator == "<>":
            # Excel counts formula-produced empty text as a populated cell;
            # a physically empty input remains None and is excluded.
            return value is not None
        elif value is not None and not isinstance(value, str): return operator == "<>"
        return compare_values(value, operand, operator)
    return matches

def calculate(workbook, formulas):
    values, visits, steps = {}, [0], [0]
    deadline = time.monotonic() + MAX_CALCULATION_SECONDS
    def tick():
        steps[0] += 1
        if steps[0] > MAX_EVALUATION_STEPS: raise FormulaError("formula calculation exceeds its work limit")
        if (steps[0] == 1 or steps[0] % 64 == 0) and time.monotonic() >= deadline: raise FormulaError("formula calculation exceeds its time limit")
    def read(sheet, column, row):
        tick()
        visits[0] += 1
        if visits[0] > MAX_CELL_READS: raise FormulaError("formula calculation exceeds one million cell reads")
        key = (sheet, column, row)
        if key in values: return values[key]
        cell = workbook[sheet].cell(row, column)
        value = cell.value
        if cell.data_type == "e": return CellError(value)
        if value == "": return None
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
        stack, results, references = [(ast, 0)], {}, set()
        while stack:
            tick()
            node, phase = stack.pop(); kind = node[0]
            if kind == "function" and node[1] == "IF":
                test, yes, no = node[2]
                if phase == 0:
                    stack.extend(((node, 1), (test, 0))); continue
                condition = results[id(test)]
                if isinstance(condition, CellError): result = condition
                elif isinstance(condition, list): result = CellError("#VALUE!")
                elif isinstance(condition, str) and condition.upper() not in ("TRUE", "FALSE"): result = CellError("#VALUE!")
                else:
                    selected = yes if (condition.upper() == "TRUE" if isinstance(condition, str) else bool(condition)) else no
                    if phase == 1:
                        stack.extend(((node, 2), (selected, 0))); continue
                    result = results[id(selected)]
                    if id(selected) in references: references.add(id(node))
                    if isinstance(result, list): result = CellError("#VALUE!")
                    elif isinstance(result, (int, float)) and not math.isfinite(result): result = CellError("#NUM!")
                results[id(node)] = result
                continue
            children = [node[2]] if kind == "unary" else [node[2], node[3]] if kind == "binary" else node[2] if kind == "function" else []
            if children and not phase:
                stack.append((node, 1)); stack.extend((child, 0) for child in reversed(children)); continue
            if kind in ("number", "string", "boolean"): result = node[1]
            elif kind == "ref": result = read(*node[1:])
            elif kind == "range": result = [read(node[1], col, row) for row in range(node[3], node[5] + 1) for col in range(node[2], node[4] + 1)]
            elif kind in ("binary", "unary"):
                operands = [results[id(child)] for child in children]
                if kind == "binary" and node[1] in COMPARISONS:
                    results[id(node)] = compare_values(*operands, node[1]); continue
                operands = [numeric(value) for value in operands]
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
                if node[1] in ("COUNTIF", "SUMIF"):
                    matcher = criteria_matcher(args[1], tick)
                    if isinstance(matcher, CellError): result = matcher
                    else:
                        inputs = args[0] if isinstance(args[0], list) else [args[0]]
                        sums = (args[2] if isinstance(args[2], list) else [args[2]]) if len(args) == 3 else inputs
                        result = 0
                        for value, amount in zip(inputs, sums):
                            tick()
                            if isinstance(value, CellError) or not matcher(value): continue
                            if node[1] == "COUNTIF": result += 1
                            elif isinstance(amount, CellError): result = amount; break
                            elif isinstance(amount, (int, float)) and not isinstance(amount, bool): result += amount
                    if isinstance(result, (int, float)) and not math.isfinite(result): result = CellError("#NUM!")
                    results[id(node)] = result
                    continue
                flat = []
                for child, arg in zip(children, args):
                    for value in (arg if isinstance(arg, list) else [arg]):
                        tick()
                        # Excel ignores bool/text in cell references, including
                        # a reference selected by IF. Direct scalar arguments
                        # instead coerce bools and numeric text; bad text is an
                        # error (ignored only by COUNT).
                        if node[1] in ("SUM", "COUNT", "AVERAGE", "MIN", "MAX") and id(child) not in references and isinstance(value, (str, bool)):
                            try:
                                value = float(value)
                                if not math.isfinite(value): value = CellError("#VALUE!")
                            except ValueError: value = CellError("#VALUE!")
                        flat.append(value)
                # COUNT ignores error cells, along with other non-numbers;
                # the other numeric functions propagate those errors.
                result = None if node[1] == "COUNT" else next((value for value in flat if isinstance(value, CellError)), None)
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
            if kind in ("ref", "range"): references.add(id(node))
        result = results[id(ast)]
        return CellError("#VALUE!") if isinstance(result, list) else result
    for target in formula_order(formulas, tick):
        tick()
        values[target] = evaluate(formulas[target][1])
    return values
