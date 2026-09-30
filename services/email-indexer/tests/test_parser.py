"""WARP-465 D1 follow-up — MIME parser tests."""
from __future__ import annotations

import pytest

from parser import derive_thread_key, parse_message


def _make_raw(
    msg_id: str = "<id-1@example.com>",
    in_reply_to: str | None = None,
    references: str | None = None,
    from_hdr: str = "Carrier Ops <ops@carrier.com>",
    to_hdr: str = "stefan@example.com",
    subject: str = "Test",
    body: str = "Hello.",
    date: str = "Wed, 27 May 2026 10:00:00 +0000",
) -> bytes:
    parts = [
        f"Message-ID: {msg_id}",
        f"From: {from_hdr}",
        f"To: {to_hdr}",
        f"Subject: {subject}",
        f"Date: {date}",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
    ]
    if in_reply_to:
        parts.append(f"In-Reply-To: {in_reply_to}")
    if references:
        parts.append(f"References: {references}")
    headers = "\r\n".join(parts)
    return f"{headers}\r\n\r\n{body}\r\n".encode("utf-8")


class TestThreadKeyDerivation:
    def test_root_message_uses_own_id(self):
        assert derive_thread_key("a", None, None) == "a"

    def test_reply_with_in_reply_to_uses_it(self):
        assert derive_thread_key("b", "a", None) == "a"

    def test_references_takes_precedence_over_in_reply_to(self):
        assert derive_thread_key("c", "b", "<a> <b>") == "a"

    def test_empty_references_falls_back_to_in_reply_to(self):
        assert derive_thread_key("c", "b", "   ") == "b"


class TestParseMessage:
    def test_root_message_happy_path(self):
        parsed = parse_message(_make_raw())
        assert parsed is not None
        assert parsed["messageId"] == "id-1@example.com"
        assert parsed["fromAddr"] == "ops@carrier.com"
        assert parsed["fromName"] == "Carrier Ops"
        assert parsed["toAddrs"] == ["stefan@example.com"]
        assert parsed["subject"] == "Test"
        assert parsed["bodyText"] == "Hello.\r\n"
        assert parsed["bodyHtml"] is None
        assert parsed["threadKey"] == "id-1@example.com"
        assert parsed["receivedAt"].startswith("2026-05-27T10:00:00")

    def test_reply_links_to_root_via_references(self):
        raw = _make_raw(
            msg_id="<id-2@example.com>",
            in_reply_to="<id-1@example.com>",
            references="<id-1@example.com>",
        )
        parsed = parse_message(raw)
        assert parsed is not None
        assert parsed["inReplyTo"] == "id-1@example.com"
        assert parsed["threadKey"] == "id-1@example.com"

    def test_rejects_message_without_messageid(self):
        raw = (
            "From: x@y.com\r\n"
            "To: a@b.com\r\n"
            "Subject: x\r\n"
            "Date: Wed, 27 May 2026 10:00:00 +0000\r\n"
            "\r\n"
            "body\r\n"
        ).encode("utf-8")
        assert parse_message(raw) is None

    def test_rejects_message_without_from(self):
        raw = (
            "Message-ID: <id-1@x.com>\r\n"
            "To: a@b.com\r\n"
            "Subject: x\r\n"
            "Date: Wed, 27 May 2026 10:00:00 +0000\r\n"
            "\r\n"
            "body\r\n"
        ).encode("utf-8")
        assert parse_message(raw) is None

    def test_rejects_message_without_date(self):
        raw = (
            "Message-ID: <id-1@x.com>\r\n"
            "From: x@y.com\r\n"
            "To: a@b.com\r\n"
            "Subject: x\r\n"
            "\r\n"
            "body\r\n"
        ).encode("utf-8")
        assert parse_message(raw) is None

    def test_multipart_text_html(self):
        raw = (
            "Message-ID: <id-mp@x.com>\r\n"
            "From: x@y.com\r\n"
            "To: a@b.com\r\n"
            "Subject: mp\r\n"
            "Date: Wed, 27 May 2026 10:00:00 +0000\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: multipart/alternative; boundary="bnd"\r\n'
            "\r\n"
            "--bnd\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n\r\n"
            "Plain body.\r\n"
            "--bnd\r\n"
            "Content-Type: text/html; charset=utf-8\r\n\r\n"
            "<p>HTML body.</p>\r\n"
            "--bnd--\r\n"
        ).encode("utf-8")
        parsed = parse_message(raw)
        assert parsed is not None
        assert "Plain body." in (parsed["bodyText"] or "")
        assert "<p>HTML body.</p>" in (parsed["bodyHtml"] or "")

    def test_attachment_part_is_ignored(self):
        raw = (
            "Message-ID: <id-att@x.com>\r\n"
            "From: x@y.com\r\n"
            "To: a@b.com\r\n"
            "Subject: with attachment\r\n"
            "Date: Wed, 27 May 2026 10:00:00 +0000\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: multipart/mixed; boundary="bnd"\r\n'
            "\r\n"
            "--bnd\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n\r\n"
            "Body.\r\n"
            "--bnd\r\n"
            "Content-Type: application/pdf\r\n"
            "Content-Disposition: attachment; filename=foo.pdf\r\n\r\n"
            "garbage\r\n"
            "--bnd--\r\n"
        ).encode("utf-8")
        parsed = parse_message(raw)
        assert parsed is not None
        assert "Body." in (parsed["bodyText"] or "")
        # bodyHtml stays None — the PDF is not text/html.
        assert parsed["bodyHtml"] is None

    def test_cc_addresses_extracted(self):
        raw = _make_raw().replace(b"To: stefan@example.com\r\n", b"To: stefan@example.com\r\nCc: dup@x.com, ops@y.com\r\n")
        parsed = parse_message(raw)
        assert parsed is not None
        assert parsed["ccAddrs"] == ["dup@x.com", "ops@y.com"]


class TestMalformedDateTolerance:
    """IDX-07 — a malformed `Date:` header must not raise (which would abort
    the whole IDLE batch). It is treated as "no timestamp" → parse_message
    returns None, same as a missing Date, and the caller skips just that UID."""

    @pytest.mark.parametrize(
        "bad_date",
        [
            "garbage",
            "not a date at all",
            "Mon, 32 Foo 2026 99:99:99 +9999",  # parseable-shaped but out of range
            "Tue, 29 Feb 2026 10:00:00 +0000",  # day out of range for month
        ],
    )
    def test_malformed_date_returns_none_not_raises(self, bad_date):
        raw = _make_raw(date=bad_date)
        # The pre-fix code let parsedate_to_datetime raise here.
        assert parse_message(raw) is None

    def test_valid_date_still_parses(self):
        parsed = parse_message(_make_raw(date="Wed, 27 May 2026 10:00:00 +0000"))
        assert parsed is not None
        assert parsed["receivedAt"].startswith("2026-05-27T10:00:00")


# WARP-3267 — attachments are listed and, within the limits, kept.

import base64 as _b64
from email.message import EmailMessage as _EM

import parser as _parser


def _with_attachments(*parts):
    m = _EM()
    m["Message-ID"] = "<a@x>"
    m["From"] = "a@x.com"
    m["To"] = "b@x.com"
    m["Subject"] = "files"
    m["Date"] = "Mon, 1 Jun 2026 10:00:00 +0000"
    m.set_content("see attached")
    for name, data in parts:
        m.add_attachment(data, maintype="application", subtype="pdf", filename=name)
    return m.as_bytes()


def test_attachment_is_stored_with_metadata():
    out = _parser.parse_message(_with_attachments(("invoice.pdf", b"%PDF")))
    assert out["bodyText"].strip() == "see attached"
    [att] = out["attachments"]
    assert att["filename"] == "invoice.pdf"
    assert att["contentType"] == "application/pdf"
    assert att["size"] == 4 and att["status"] == "stored"
    assert _b64.b64decode(att["data"]) == b"%PDF"


def test_attachment_over_the_size_limit_is_listed_without_bytes(monkeypatch):
    monkeypatch.setattr(_parser, "MAX_ATTACHMENT_BYTES", 3)
    out = _parser.parse_message(_with_attachments(("big.pdf", b"%PDF")))
    [att] = out["attachments"]
    assert att["status"] == "too_large" and "data" not in att and att["size"] == 4


def test_attachments_over_the_count_limit_are_listed_as_over_limit(monkeypatch):
    monkeypatch.setattr(_parser, "MAX_STORED_ATTACHMENTS", 1)
    out = _parser.parse_message(_with_attachments(("a.pdf", b"1"), ("b.pdf", b"2")))
    assert [a["status"] for a in out["attachments"]] == ["stored", "over_limit"]


def test_attachments_that_would_overflow_the_ingest_body_are_demoted(monkeypatch):
    # Budget fits the message and one small part, not the second.
    monkeypatch.setattr(_parser, "MAX_INGEST_PAYLOAD_BYTES", 1)
    out = _parser.parse_message(_with_attachments(("a.pdf", b"1")))
    [att] = out["attachments"]
    assert att["status"] == "too_large" and "data" not in att


def test_serialised_payload_never_exceeds_the_budget(monkeypatch):
    import json

    monkeypatch.setattr(_parser, "MAX_INGEST_PAYLOAD_BYTES", 2000)
    out = _parser.parse_message(
        _with_attachments(("a.pdf", b"x" * 600), ("b.pdf", b"y" * 600), ("c.pdf", b"z" * 600))
    )
    assert len(json.dumps(out)) <= 2000
    assert [a["status"] for a in out["attachments"]][0] == "stored"
    assert "too_large" in [a["status"] for a in out["attachments"]]


def test_overlong_content_id_is_dropped_not_fatal():
    m = _EM()
    m["Message-ID"] = "<a@x>"
    m["From"] = "a@x.com"
    m["To"] = "b@x.com"
    m["Subject"] = "cid"
    m["Date"] = "Mon, 1 Jun 2026 10:00:00 +0000"
    m.set_content("hi")
    m.add_attachment(b"img", maintype="image", subtype="png", filename="i.png")
    [part] = list(m.iter_attachments())
    part["Content-ID"] = "<" + "c" * 2000 + "@x>"
    [att] = _parser.parse_message(m.as_bytes())["attachments"]
    assert att["contentId"] is None


def _envelope(subject):
    m = _EM()
    m["Message-ID"] = "<outer@x>"
    m["From"] = "a@x.com"
    m["To"] = "b@x.com"
    m["Subject"] = subject
    m["Date"] = "Mon, 1 Jun 2026 10:00:00 +0000"
    return m


def test_forwarded_message_is_one_attachment_and_not_walked_into():
    inner = _EM()
    inner["Message-ID"] = "<inner@x>"
    inner["From"] = "c@x.com"
    inner["Subject"] = "original"
    inner.set_content("INNER BODY")
    inner.add_attachment(b"%PDF", maintype="application", subtype="pdf", filename="inner.pdf")
    outer = _envelope("fwd")
    outer.set_content("<p>see below</p>", subtype="html")
    outer.add_attachment(inner)
    out = _parser.parse_message(outer.as_bytes())
    # The inner message's text is not the outer message's body...
    assert out["bodyText"] is None
    # ...and its PDF is not listed as the outer's: one .eml, nothing else.
    [att] = out["attachments"]
    assert att["contentType"] == "message/rfc822"
    assert att["filename"] == "forwarded.eml"
    assert b"INNER BODY" in _b64.b64decode(att["data"])


def test_named_inline_html_body_is_the_body_not_a_download():
    m = _envelope("named body")
    m.set_content("<p>hello</p>", subtype="html")
    m.replace_header("Content-Type", 'text/html; charset="utf-8"; name="message.htm"')
    out = _parser.parse_message(m.as_bytes())
    assert "hello" in out["bodyHtml"]
    assert out["attachments"] == []
