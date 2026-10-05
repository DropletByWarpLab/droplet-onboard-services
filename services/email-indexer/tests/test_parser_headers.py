"""WARP-3529 — the headers the service desk's loop protection reads.

The ingest payload used to carry `inReplyTo` and nothing else about how a
message was sent. A help desk that answers mail by itself needs to tell a person
from a machine, and a thread from a stranger: `References` for threading, and
`Auto-Submitted` / `Precedence` / `X-Autoreply` / `X-Autorespond` / `Return-Path`
(plus a delivery-status report) for the messages that must never get an
auto-acknowledgement.
"""
from __future__ import annotations

import json

import pytest

from parser import MAX_REFERENCES, parse_message


def _raw(
    extra: list[str] | None = None,
    *,
    msg_id: str = "<m1@customer.com>",
    from_hdr: str = "Dana <dana@customer.com>",
    content_type: str = "text/plain; charset=utf-8",
    body: str = "Hello.",
) -> bytes:
    headers = [
        f"Message-ID: {msg_id}",
        f"From: {from_hdr}",
        "To: support@acme.example",
        "Subject: Printer",
        "Date: Wed, 27 May 2026 10:00:00 +0000",
        "MIME-Version: 1.0",
        f"Content-Type: {content_type}",
        *(extra or []),
    ]
    return ("\r\n".join(headers) + f"\r\n\r\n{body}\r\n").encode("utf-8")


def _headers(extra: list[str] | None = None, **kw) -> dict:
    parsed = parse_message(_raw(extra, **kw))
    assert parsed is not None
    return parsed["headers"]


class TestDefaults:
    def test_a_plain_message_carries_an_empty_headers_object(self):
        assert _headers() == {
            "references": [],
            "autoSubmitted": None,
            "precedence": None,
            "xAutoreply": None,
            "xAutorespond": None,
            "returnPath": None,
            "reportType": None,
        }

    def test_the_headers_serialise_to_json(self):
        parsed = parse_message(_raw(["Auto-Submitted: auto-replied", "References: <a@x>"]))
        assert parsed is not None
        assert json.loads(json.dumps(parsed))["headers"]["autoSubmitted"] == "auto-replied"


class TestReferences:
    def test_every_id_is_kept_oldest_first_without_brackets(self):
        h = _headers(["References: <a@x.com> <b@x.com>\r\n <c@x.com>"])
        assert h["references"] == ["a@x.com", "b@x.com", "c@x.com"]

    def test_an_unbracketed_token_is_accepted(self):
        assert _headers(["References: a@x.com <b@x.com>"])["references"] == ["a@x.com", "b@x.com"]

    def test_a_repeated_header_is_joined_not_dropped(self):
        h = _headers(["References: <a@x.com>", "References: <b@x.com>"])
        assert h["references"] == ["a@x.com", "b@x.com"]

    def test_a_long_chain_keeps_the_root_and_the_newest(self):
        ids = [f"<m{i}@x.com>" for i in range(MAX_REFERENCES + 50)]
        h = _headers(["References: " + " ".join(ids)])
        assert len(h["references"]) == MAX_REFERENCES
        assert h["references"][0] == "m0@x.com"
        assert h["references"][-1] == f"m{MAX_REFERENCES + 49}@x.com"

    def test_an_overlong_id_is_dropped_rather_than_failing_the_message(self):
        h = _headers([f"References: <{'a' * 1000}@x.com> <ok@x.com>"])
        assert h["references"] == ["ok@x.com"]

    def test_the_thread_key_is_still_the_first_reference(self):
        parsed = parse_message(_raw(["References: <root@x.com> <b@x.com>", "In-Reply-To: <b@x.com>"]))
        assert parsed is not None
        assert parsed["threadKey"] == "root@x.com"
        assert parsed["inReplyTo"] == "b@x.com"


class TestAutoSubmitted:
    @pytest.mark.parametrize(
        ("raw", "kept"),
        [
            ("auto-replied", "auto-replied"),
            ("Auto-Generated", "auto-generated"),
            ('auto-replied; owner-email="boss@x.com"', "auto-replied"),
            ("  no  ", "no"),
        ],
    )
    def test_only_the_keyword_is_kept_lowercased(self, raw, kept):
        assert _headers([f"Auto-Submitted: {raw}"])["autoSubmitted"] == kept

    def test_header_names_are_case_insensitive(self):
        assert _headers(["AUTO-SUBMITTED: auto-notified"])["autoSubmitted"] == "auto-notified"


class TestPrecedence:
    @pytest.mark.parametrize(("raw", "kept"), [("bulk", "bulk"), (" Junk ", "junk"), ("LIST", "list")])
    def test_value_is_trimmed_and_lowercased(self, raw, kept):
        assert _headers([f"Precedence: {raw}"])["precedence"] == kept


class TestAutoReplyHeaders:
    def test_x_autoreply_and_x_autorespond_keep_their_value(self):
        h = _headers(["X-Autoreply: yes", "X-Autorespond: Vacation"])
        assert h["xAutoreply"] == "yes"
        assert h["xAutorespond"] == "vacation"

    def test_a_present_but_empty_header_is_not_absent(self):
        h = _headers(["X-Autoreply:", "X-Autorespond: "])
        assert h["xAutoreply"] == ""
        assert h["xAutorespond"] == ""


class TestReturnPath:
    def test_the_null_reverse_path_of_a_bounce_is_the_empty_string(self):
        assert _headers(["Return-Path: <>"])["returnPath"] == ""

    def test_an_address_is_reduced_to_the_bare_address(self):
        assert _headers(["Return-Path: <bounce+42@mta.example>"])["returnPath"] == "bounce+42@mta.example"

    def test_absent_is_none(self):
        assert _headers()["returnPath"] is None


class TestDeliveryStatusReport:
    def test_a_multipart_report_exposes_its_report_type(self):
        raw = (
            "Message-ID: <dsn@mta.example>\r\n"
            "From: MAILER-DAEMON@mta.example\r\n"
            "To: support@acme.example\r\n"
            "Subject: Undelivered Mail Returned to Sender\r\n"
            "Date: Wed, 27 May 2026 10:00:00 +0000\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: multipart/report; report-type=delivery-status; boundary="b"\r\n'
            "\r\n"
            "--b\r\nContent-Type: text/plain\r\n\r\nCould not deliver.\r\n--b--\r\n"
        ).encode("utf-8")
        parsed = parse_message(raw)
        assert parsed is not None
        assert parsed["headers"]["reportType"] == "delivery-status"

    def test_an_ordinary_message_has_none(self):
        assert _headers()["reportType"] is None
