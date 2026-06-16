"""Archive extractor: one span per member, recursive innerAnchor capped at depth 3."""
from __future__ import annotations

import zipfile
from pathlib import Path

from anchor_schema import (
    ArchiveMemberAnchor,
    NoneAnchor,
    PdfPageAnchor,
)
from extractors import archive


def test_archive_extractor_one_span_per_member(tmp_path: Path):
    zpath = tmp_path / "test.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.writestr("a.txt", "alpha content")
        zf.writestr("b.txt", "beta content")
    doc = archive.extract(str(zpath))
    spans = doc["spans"]
    members = {s.anchor.member for s in spans}
    assert members == {"a.txt", "b.txt"}
    assert all(isinstance(s.anchor, ArchiveMemberAnchor) for s in spans)


def test_archive_extractor_recurses_into_pdf(tmp_path: Path):
    """A .zip containing a .pdf produces spans whose innerAnchor is PdfPageAnchor."""
    from reportlab.pdfgen import canvas
    pdf_path = tmp_path / "inner.pdf"
    c = canvas.Canvas(str(pdf_path))
    c.drawString(72, 720, "page one")
    c.showPage()
    c.drawString(72, 720, "page two")
    c.showPage()
    c.save()

    zpath = tmp_path / "wrap.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.write(pdf_path, arcname="docs/inner.pdf")

    doc = archive.extract(str(zpath))
    spans = doc["spans"]
    pdf_spans = [s for s in spans if s.anchor.member == "docs/inner.pdf"]
    assert len(pdf_spans) == 2  # one per page
    for span in pdf_spans:
        assert isinstance(span.anchor.innerAnchor, PdfPageAnchor)


def test_archive_extractor_caps_recursion_at_depth_3(tmp_path: Path):
    """zip-in-zip-in-zip-in-zip → 4th level innerAnchor is None with a warning."""
    def build_zip(parent_dir: Path, name: str, contents: list[tuple[str, bytes]]) -> Path:
        p = parent_dir / name
        with zipfile.ZipFile(p, "w") as zf:
            for arc, data in contents:
                zf.writestr(arc, data)
        return p

    l4_data = b"leaf content"
    l3_zip = build_zip(tmp_path, "l3.zip", [("leaf.txt", l4_data)])
    l2_zip = build_zip(tmp_path, "l2.zip", [("l3.zip", l3_zip.read_bytes())])
    l1_zip = build_zip(tmp_path, "l1.zip", [("l2.zip", l2_zip.read_bytes())])
    outer  = build_zip(tmp_path, "outer.zip", [("l1.zip", l1_zip.read_bytes())])

    doc = archive.extract(str(outer))
    depths = []
    for span in doc["spans"]:
        depth = 1
        a = span.anchor
        while isinstance(a, ArchiveMemberAnchor) and a.innerAnchor is not None and not isinstance(a.innerAnchor, NoneAnchor):
            depth += 1
            a = a.innerAnchor
        depths.append(depth)
    assert max(depths) <= 3
    assert "archive_recursion_capped" in doc.get("warnings", [])
