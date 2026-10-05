"""WARP-3529 — what the service desk needs from an outbound message.

The desk enqueues an `EmailDraft` itself and generates the RFC 5322 Message-ID
in the orchestrator, so it knows — before anything is sent — the id a customer's
reply will carry in `In-Reply-To` / `References`. Without that, the reply to a
conversation the desk started could only be matched by the `[KEY-123]` subject
token. And an automatic acknowledgement is marked as one (RFC 3834), so another
help desk, an out-of-office responder or this box's own intake does not answer it.
"""
from __future__ import annotations

import email.utils

from outbound import DraftToSend, build_message


def _draft(**overrides) -> DraftToSend:
    base = dict(
        id="d1",
        account_id="a1",
        from_addr="support@acme.example",
        smtp_host="smtp.example.com",
        smtp_port=465,
        smtp_tls=True,
        username="support@acme.example",
        password_enc="ignored-in-pure-tests",
        to_addrs=["dana@customer.com"],
        cc_addrs=None,
        bcc_addrs=None,
        subject="Re: [SUP-12] Printer",
        body="We are on it.",
    )
    base.update(overrides)
    return DraftToSend(**base)


class TestMessageId:
    def test_the_id_the_orchestrator_generated_is_the_one_that_is_sent(self):
        msg = build_message(_draft(message_id="7f3a9c1e5b2d4f60@acme.example"))
        assert msg["Message-ID"] == "<7f3a9c1e5b2d4f60@acme.example>"

    def test_a_draft_without_one_still_gets_a_message_id_from_the_account_domain(self):
        msg = build_message(_draft())
        mid = msg["Message-ID"]
        assert mid.startswith("<") and mid.endswith("@acme.example>")

    def test_the_id_is_sent_exactly_once(self):
        msg = build_message(_draft(message_id="abc@acme.example"))
        assert msg.get_all("Message-ID") == ["<abc@acme.example>"]

    def test_an_id_that_could_inject_a_header_is_not_sent(self):
        evil = "x@acme.example>\r\nBcc: attacker@evil.example\r\nX: <y"
        msg = build_message(_draft(message_id=evil))
        assert msg.get("Bcc") is None
        assert "attacker@evil.example" not in msg.as_string()
        # ... and the message still has a good id of its own.
        assert msg["Message-ID"].endswith("@acme.example>")

    def test_an_id_with_whitespace_or_brackets_falls_back_to_a_generated_one(self):
        for bad in ("has space@acme.example", "<already@bracketed>", "a@b>c", ""):
            msg = build_message(_draft(message_id=bad))
            assert msg["Message-ID"] != f"<{bad}>"
            assert msg["Message-ID"].endswith("@acme.example>")

    def test_the_id_survives_a_round_trip_through_the_wire_format(self):
        import email

        wire = build_message(_draft(message_id="rt-1@acme.example")).as_bytes()
        assert email.message_from_bytes(wire)["Message-ID"] == "<rt-1@acme.example>"


class TestThreading:
    def test_a_reply_keeps_its_threading_headers_next_to_the_desks_id(self):
        msg = build_message(
            _draft(
                message_id="out-2@acme.example",
                thread_message_ids=["root@customer.com", "m2@customer.com"],
            )
        )
        assert msg["In-Reply-To"] == "<m2@customer.com>"
        assert msg["References"] == "<root@customer.com> <m2@customer.com>"
        assert msg["Message-ID"] == "<out-2@acme.example>"

    def test_the_ticket_key_in_the_subject_is_passed_through_untouched(self):
        msg = build_message(_draft(subject="Re: [SUP-12] Printer"))
        assert msg["Subject"] == "Re: [SUP-12] Printer"

    def test_the_date_header_is_set_here(self):
        msg = build_message(_draft())
        assert email.utils.parsedate_to_datetime(msg["Date"]) is not None


class TestAutomaticAcknowledgement:
    def test_an_automatic_message_says_so(self):
        msg = build_message(_draft(auto_submitted=True))
        assert msg["Auto-Submitted"] == "auto-replied"
        assert msg["X-Auto-Response-Suppress"] == "All"

    def test_a_person_s_reply_does_not(self):
        msg = build_message(_draft())
        assert msg.get("Auto-Submitted") is None
        assert msg.get("X-Auto-Response-Suppress") is None
