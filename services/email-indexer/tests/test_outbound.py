"""WARP-465 D1 follow-up — outbound MIME assembly + recipients.

The SMTP transaction itself isn't exercised here (it needs a live
server); these tests pin the bits we can verify pure-Python.
"""
from __future__ import annotations

import pytest

from outbound import DraftToSend, build_message, envelope_recipients


def _draft(**overrides) -> DraftToSend:
    base = dict(
        id="d1",
        account_id="a1",
        from_addr="stefan@example.com",
        smtp_host="smtp.example.com",
        smtp_port=465,
        smtp_tls=True,
        username="stefan@example.com",
        password_enc="ignored-in-pure-tests",
        to_addrs=["alice@example.com"],
        cc_addrs=None,
        bcc_addrs=None,
        subject="Hi",
        body="Body line.",
    )
    base.update(overrides)
    return DraftToSend(**base)


def test_build_message_sets_basic_headers():
    msg = build_message(_draft())
    assert msg["From"] == "stefan@example.com"
    assert msg["To"] == "alice@example.com"
    assert msg["Subject"] == "Hi"
    # set_content gives us a text/plain body.
    assert "Body line." in msg.get_content()


def test_build_message_with_cc_emits_header():
    msg = build_message(_draft(cc_addrs=["bob@example.com", "carol@example.com"]))
    assert msg["Cc"] == "bob@example.com, carol@example.com"


def test_build_message_does_not_emit_bcc_header():
    msg = build_message(_draft(bcc_addrs=["bcc@example.com"]))
    assert msg.get("Bcc") is None  # bcc stays in envelope only


def test_envelope_recipients_includes_to_cc_bcc():
    draft = _draft(
        to_addrs=["a@x.com"],
        cc_addrs=["b@x.com"],
        bcc_addrs=["c@x.com"],
    )
    assert envelope_recipients(draft) == ["a@x.com", "b@x.com", "c@x.com"]


def test_envelope_recipients_to_only():
    assert envelope_recipients(_draft()) == ["alice@example.com"]


def test_build_message_handles_empty_body():
    msg = build_message(_draft(body=""))
    assert msg["Subject"] == "Hi"
    # set_content with empty string still produces a body part.
    assert msg.get_content() == "\n"
