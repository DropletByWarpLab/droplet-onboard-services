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
