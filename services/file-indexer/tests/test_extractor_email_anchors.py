"""Email extractor: one span per text-bearing MIME part, with email-part anchors."""
from __future__ import annotations

from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

from anchor_schema import EmailPartAnchor
from extractors import email as email_extractor


def _write_eml(tmp_path: Path) -> Path:
    msg = MIMEMultipart()
    msg["Message-ID"] = "<abc123@example.com>"
    msg["Subject"] = "Hello"
    msg["From"] = "a@example.com"
    msg["To"] = "b@example.com"
    msg.attach(MIMEText("plain body text", "plain"))
    msg.attach(MIMEText("<p>html body</p>", "html"))
    path = tmp_path / "msg.eml"
    path.write_bytes(msg.as_bytes())
    return path


def test_email_extractor_produces_one_span_per_text_part(tmp_path: Path):
    path = _write_eml(tmp_path)
    doc = email_extractor.extract(str(path))
    spans = doc["spans"]

    assert len(spans) >= 2  # at minimum: plain + html (header span optional)

    anchors = [s.anchor for s in spans]
    assert all(isinstance(a, EmailPartAnchor) for a in anchors)
    assert all(a.messageId == "<abc123@example.com>" for a in anchors)

    part_indexes = sorted(a.partIndex for a in anchors)
    assert part_indexes == list(range(len(part_indexes)))  # 0, 1, [2]
