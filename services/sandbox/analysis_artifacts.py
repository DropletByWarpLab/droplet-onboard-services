"""Validate untrusted analysis output in the service, never in its child.

User code can introspect and mutate the child's helpers and globals. Only this
parent-process check establishes the CSV/SVG artifact safety boundary.
"""
from __future__ import annotations

import base64
import binascii
import csv
import io
import math
import re
import xml.etree.ElementTree as ET

MAX_ARTIFACT_BYTES = 512_000
MAX_ARTIFACTS = 8
MAX_ROWS = 10_000
MAX_COLUMNS = 200
MAX_CELLS = 100_000
MAX_CELL_BYTES = 8192
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$")
NUMBER = r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?"
NUMERIC_NEGATIVE = re.compile(r"-" + NUMBER.removeprefix("[+-]?"))
SVG_NS = "{http://www.w3.org/2000/svg}"
ATTRIBUTES = {
    "svg": {"width", "height", "viewBox"},
    "rect": {"x", "y", "width", "height", "fill"},
    "text": {"x", "y", "font-family", "font-size", "text-anchor", "transform"},
    "path": {"d", "stroke", "fill"},
    "polyline": {"points", "fill", "stroke", "stroke-width"},
}


def _csv(raw: bytes) -> bytes:
    text = raw.decode("utf-8-sig", errors="strict")
    if any(ord(char) < 32 and char not in "\t\r\n" for char in text):
        raise ValueError("CSV contains unsupported control characters")
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    width, cells, row_count = None, 0, 0
    for row in csv.reader(io.StringIO(text, newline=""), strict=True):
        row_count += 1
        if width is None:
            width = len(row)
        cells += len(row)
        if row_count > MAX_ROWS + 1 or len(row) > MAX_COLUMNS or cells > MAX_CELLS:
            raise ValueError("CSV exceeds row, column or cell limits")
        if len(row) != width:
            raise ValueError("CSV rows must match the header")
        safe = []
        for value in row:
            if len(value.encode("utf-8")) > MAX_CELL_BYTES:
                raise ValueError("CSV cell exceeds byte limit")
            # Raw CSV no longer records Python cell types. Preserve only
            # strict numeric negatives; every other formula-leading string
            # gets an Excel literal prefix, including whitespace/control/BOM.
            leading = re.sub(r"^[\s\ufeff]+", "", value)
            dangerous = leading.startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r", "\n", "\ufeff"))
            if dangerous and not NUMERIC_NEGATIVE.fullmatch(value):
                value = "'" + value
            safe.append(value)
        writer.writerow(safe)
        if output.tell() > MAX_ARTIFACT_BYTES:
            raise ValueError("CSV exceeds byte limit after escaping")
    if width is None:
        raise ValueError("CSV requires a header row")
    encoded = output.getvalue().encode("utf-8")
    if len(encoded) > MAX_ARTIFACT_BYTES:
        raise ValueError("CSV exceeds byte limit after escaping")
    return encoded


def _number(value: str, minimum: float = -10_000, maximum: float = 10_000) -> None:
    if not re.fullmatch(NUMBER, value):
        raise ValueError("SVG geometry must be numeric")
    number = float(value)
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ValueError("SVG geometry exceeds bounds")


def _svg(raw: bytes) -> bytes:
    text = raw.decode("utf-8", errors="strict")
    # No DTD/entity expansion, comments, CDATA or processing instructions.
    # These constructs are absent from the generated-chart format.
    if "<!" in text or "<?" in text:
        raise ValueError("SVG declarations and processing instructions are unsupported")
    root = ET.fromstring(text)
    if root.tag != SVG_NS + "svg" or root.attrib != {"width": "900", "height": "520", "viewBox": "0 0 900 520"}:
        raise ValueError("SVG must use the generated chart canvas")
    nodes = list(root.iter())
    if len(nodes) > 350:
        raise ValueError("SVG exceeds chart element limit")
    for element in nodes:
        tag = element.tag.removeprefix(SVG_NS) if isinstance(element.tag, str) else ""
        if element.tag != SVG_NS + tag or tag not in ATTRIBUTES or (tag == "svg" and element is not root):
            raise ValueError("SVG contains an unsupported chart element")
        if element is not root and len(element):
            raise ValueError("SVG chart elements must be direct children")
        if set(element.attrib) - ATTRIBUTES[tag]:
            raise ValueError("SVG contains an unsupported or active attribute")
        if tag != "text" and element.text and element.text.strip():
            raise ValueError("SVG text is allowed only in text elements")
        if element.tail and element.tail.strip():
            raise ValueError("SVG contains unexpected trailing text")
        if tag == "text" and len(element.text or "") > 160:
            raise ValueError("SVG chart text exceeds limit")
        for name, value in element.attrib.items():
            if name in {"x", "y", "width", "height"}:
                _number(value, 0 if name in {"width", "height"} else -10_000)
            elif name == "stroke-width":
                _number(value, 0, 20)
            elif name == "font-size":
                _number(value, 1, 72)
            elif name in {"fill", "stroke"}:
                if value not in {"none", "white"} and not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                    raise ValueError("SVG paint must be a literal chart color")
            elif name == "font-family" and value != "sans-serif":
                raise ValueError("SVG font must be sans-serif")
            elif name == "text-anchor" and value not in {"start", "middle", "end"}:
                raise ValueError("SVG has an unsupported text anchor")
            elif name == "transform":
                match = re.fullmatch(rf"rotate\(({NUMBER}) ({NUMBER}) ({NUMBER})\)", value)
                if not match:
                    raise ValueError("SVG transform must be a numeric rotation")
                for number in match.groups():
                    _number(number)
            elif name == "d":
                match = re.fullmatch(rf"M ({NUMBER}) ({NUMBER}) V ({NUMBER}) M ({NUMBER}) ({NUMBER}) H ({NUMBER})", value)
                if not match:
                    raise ValueError("SVG path must be generated chart axes")
                for number in match.groups():
                    _number(number)
            elif name == "points":
                points = value.split()
                if not 1 <= len(points) <= 100:
                    raise ValueError("SVG exceeds chart point limit")
                for point in points:
                    match = re.fullmatch(rf"({NUMBER}),({NUMBER})", point)
                    if not match:
                        raise ValueError("SVG chart points must be numeric")
                    for number in match.groups():
                        _number(number)
    return raw


def validate_artifacts(items: object) -> list[dict[str, str]]:
    """Return safe artifacts, or reject the entire untrusted response."""
    if not isinstance(items, list) or len(items) > MAX_ARTIFACTS:
        raise ValueError("invalid artifact list or artifact count")
    result, names = [], set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {"name", "mimeType", "contentBase64"}:
            raise ValueError("invalid artifact envelope")
        name, mime, encoded = item["name"], item["mimeType"], item["contentBase64"]
        if not isinstance(name, str) or not NAME.fullmatch(name) or ".." in name or name.casefold() in names:
            raise ValueError("invalid or duplicate artifact name")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_ARTIFACT_BYTES + 2) // 3) * 4:
            raise ValueError("artifact exceeds encoded byte limit")
        if not isinstance(mime, str) or (mime, name.lower().rsplit(".", 1)[-1]) not in {("text/csv", "csv"), ("image/svg+xml", "svg")}:
            raise ValueError("unsupported artifact type or extension")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("artifact content must be valid base64") from exc
        if len(raw) > MAX_ARTIFACT_BYTES:
            raise ValueError("artifact exceeds byte limit")
        try:
            safe = _csv(raw) if mime == "text/csv" else _svg(raw)
        except (csv.Error, ET.ParseError) as exc:
            raise ValueError(f"invalid artifact content: {exc}") from exc
        names.add(name.casefold())
        result.append({"name": name, "mimeType": mime, "contentBase64": base64.b64encode(safe).decode("ascii")})
    return result
