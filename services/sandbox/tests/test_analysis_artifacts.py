"""Parent-process validation treats every child artifact byte as untrusted."""
import base64
import csv
import io

import pytest

from analysis_artifacts import MAX_ARTIFACT_BYTES, validate_artifacts


def artifact(raw, name="result.csv", mime="text/csv"):
    return {"name": name, "mimeType": mime, "contentBase64": base64.b64encode(raw).decode("ascii")}


def test_csv_is_reparsed_and_formula_text_is_inert_without_changing_numeric_negatives():
    text = io.StringIO(newline="")
    writer = csv.writer(text)
    writer.writerow(["value"])
    values = ['=WEBSERVICE("https://example.invalid")', "+1+1", " @SUM(1)", "-2+3", "\t=1", " \ufeff \ufeff=1", "-2", "-2.5e-3", "'-2"]
    for value in values:
        writer.writerow([value])
    result = validate_artifacts([artifact(text.getvalue().encode())])
    rows = list(csv.reader(io.StringIO(base64.b64decode(result[0]["contentBase64"]).decode())))
    assert [row[0] for row in rows[1:]] == ["'" + value for value in values[:6]] + values[6:]


@pytest.mark.parametrize("items", [
    None, {}, [None], [{"name": "a.csv"}],
    [{**artifact(b"x\n"), "path": "/private"}],
    [artifact(b"x\n", "../a.csv")],
    [artifact(b"x\n", "a.svg")],
    [artifact(b"x\n", mime="text/html")],
    [{**artifact(b"x\n"), "mimeType": {}}],
    [{**artifact(b"x\n"), "contentBase64": "!invalid"}],
    [artifact(b"x\n", "a.csv"), artifact(b"x\n", "A.csv")],
    [artifact(b"x\n", f"{i}.csv") for i in range(9)],
    [artifact(b"x" * (MAX_ARTIFACT_BYTES + 1))],
])
def test_unsafe_envelopes_are_rejected(items):
    with pytest.raises(ValueError):
        validate_artifacts(items)


@pytest.mark.parametrize("raw", [
    b"\xff", b"x\n\x00\n", b'x\n"unterminated', b"a,b\n1\n",
    b"x\n" * 10002,
    ("," * 200 + "\n").encode(),
    ((",".join(["x"] * 200) + "\n") * 501).encode(),
    b"x\n" + b"a" * 8193,
], ids=["invalid-utf8", "control-byte", "unclosed-quote", "unequal-columns", "row-limit", "column-limit", "cell-limit", "cell-byte-limit"])
def test_invalid_or_unbounded_csv_is_rejected(raw):
    with pytest.raises(ValueError):
        validate_artifacts([artifact(raw)])


@pytest.mark.parametrize("markup", [
    '<script>alert(1)</script>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">active</div></foreignObject>',
    '<image href="https://example.invalid/private"/>',
    '<text x="1" y="1" onload="alert(1)">active</text>',
    '<rect width="1" height="1" style="fill:url(https://example.invalid)"/>',
    '<rect width="1" height="1" fill="url(https://example.invalid)"/>',
    '<a href="https://example.invalid"><text>link</text></a>',
    '<path d="M 0 0 L 1 1"/>',
])
def test_active_or_external_svg_is_rejected(markup):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520">{markup}</svg>'
    with pytest.raises(ValueError):
        validate_artifacts([artifact(svg.encode(), "chart.svg", "image/svg+xml")])


def test_svg_entity_expansion_is_rejected_before_xml_parsing():
    svg = b'<!DOCTYPE svg [<!ENTITY a "expanded">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>'
    with pytest.raises(ValueError, match="declarations"):
        validate_artifacts([artifact(svg, "chart.svg", "image/svg+xml")])
