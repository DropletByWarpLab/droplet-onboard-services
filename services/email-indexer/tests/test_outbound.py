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


class _FakeCallback:
    """Records claim / mark calls so the send path is assertable without SMTP."""

    def __init__(self, claim_result: bool) -> None:
        self.claim_result = claim_result
        self.claimed: list[str] = []
        self.sent: list[str] = []
        self.failed: list[tuple[str, str]] = []

    async def claim(self, draft_id: str) -> bool:
        self.claimed.append(draft_id)
        return self.claim_result

    async def mark_sent(self, draft_id: str) -> bool:
        self.sent.append(draft_id)
        return True

    async def mark_failed(self, draft_id: str, error: str) -> bool:
        self.failed.append((draft_id, error))
        return True


@pytest.mark.asyncio
async def test_send_one_draft_skips_when_claim_lost():
    """WARP-890: if the atomic claim is lost (the draft is already in-flight /
    no longer queued), send_one_draft must NOT send or mark anything. This is
    the guard that prevents a duplicate re-send after a lost terminal callback."""
    from outbound import send_one_draft

    cb = _FakeCallback(claim_result=False)
    sent_ok = await send_one_draft(_draft(), cb)

    assert sent_ok is False
    assert cb.claimed == ["d1"]  # it attempted the claim first
    assert cb.sent == []  # but did not send
    assert cb.failed == []  # and did not mark failed — it simply skipped


# WARP-3267 — threading headers and forwarded attachments.


def test_reply_sets_in_reply_to_and_references_from_the_thread():
    msg = build_message(_draft(thread_message_ids=["root@x", "mid@x", "newest@x"]))
    assert msg["In-Reply-To"] == "<newest@x>"
    assert msg["References"] == "<root@x> <mid@x> <newest@x>"
    assert msg["Message-ID"].endswith("@example.com>")
    assert msg["Date"]


def test_new_message_has_no_threading_headers():
    msg = build_message(_draft())
    assert msg.get("In-Reply-To") is None
    assert msg.get("References") is None
    assert msg["Message-ID"]


def test_injected_message_id_is_left_out_of_the_headers():
    msg = build_message(_draft(thread_message_ids=["ok@x", "bad@x>\r\nBcc: evil@x"]))
    assert msg["In-Reply-To"] == "<ok@x>"
    assert "evil" not in msg.as_string()


def test_references_keep_root_and_newest_when_long():
    ids = [f"m{i}@x" for i in range(30)]
    refs = build_message(_draft(thread_message_ids=ids))["References"].split()
    assert len(refs) == 20 and refs[0] == "<m0@x>" and refs[-1] == "<m29@x>"


def test_forward_carries_attachments_as_multipart_mixed():
    msg = build_message(
        _draft(attachments=[
            ("quote.pdf", "application/pdf", b"%PDF-1.4"),
            ("weird", "multipart/evil", b"x"),
        ])
    )
    assert msg.get_content_type() == "multipart/mixed"
    parts = list(msg.iter_attachments())
    assert [p.get_filename() for p in parts] == ["quote.pdf", "weird"]
    assert parts[0].get_content_type() == "application/pdf"
    assert parts[0].get_payload(decode=True) == b"%PDF-1.4"
    assert parts[1].get_content_type() == "application/octet-stream"
    # Plain text stays the body.
    assert msg.get_body(preferencelist=("plain",)).get_content().strip() == "Body line."


def test_forwarded_filename_cannot_break_a_header():
    msg = build_message(_draft(attachments=[("a\r\nBcc: x@y/../b.pdf", "application/pdf", b"1")]))
    [part] = list(msg.iter_attachments())
    assert "\n" not in part.get_filename() and "/" not in part.get_filename()
    assert "Bcc: x@y" not in msg.as_string().split("\n\n", 1)[0]


def test_forwarded_filename_loses_bidi_overrides():
    msg = build_message(_draft(attachments=[("invoice‮fdp.exe", "application/pdf", b"1")]))
    [part] = list(msg.iter_attachments())
    assert part.get_filename() == "invoice_fdp.exe"


@pytest.mark.asyncio
async def test_oauth_smtp_uses_lazy_generator_and_never_password(monkeypatch):
    import aiosmtplib
    import creds
    from outbound import send_one_draft

    cb = _FakeCallback(claim_result=True)
    token_calls = []

    async def token(account_id):
        assert cb.claimed == ["d1"]
        token_calls.append(account_id)
        return "short-lived-access-token"

    async def send(_message, **kwargs):
        assert token_calls == []  # the library requests the token before AUTH
        assert "password" not in kwargs
        assert kwargs["username"] == "stefan@example.com"
        assert kwargs["use_tls"] is True
        assert await kwargs["oauth_token_generator"]() == "short-lived-access-token"

    monkeypatch.setattr(aiosmtplib, "send", send)
    monkeypatch.setattr(creds, "decrypt", lambda _: pytest.fail("password fallback"))
    assert await send_one_draft(_draft(auth_mode="GOOGLE_OAUTH", password_enc=None), cb, token)
    assert token_calls == ["a1"]
    assert cb.sent == ["d1"] and cb.failed == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["missing", "empty", "reconnect", "temporary", "exception"])
async def test_oauth_smtp_token_refusal_has_no_password_fallback(monkeypatch, caplog, failure):
    import aiosmtplib
    import creds
    from errors import OAuthTokenUnavailable
    from outbound import send_one_draft

    cb = _FakeCallback(claim_result=True)
    secret = "smtp-secret-must-stay-private"

    async def token(_):
        if failure == "reconnect":
            raise OAuthTokenUnavailable(needs_reconnect=True)
        if failure == "temporary":
            raise OAuthTokenUnavailable()
        if failure == "exception":
            raise RuntimeError(secret)
        return None

    async def send(_message, **kwargs):
        assert "password" not in kwargs
        await kwargs["oauth_token_generator"]()
        pytest.fail("send cannot continue without a token")

    monkeypatch.setattr(aiosmtplib, "send", send)
    monkeypatch.setattr(creds, "decrypt", lambda _: pytest.fail("password fallback"))
    getter = None if failure == "missing" else token
    assert await send_one_draft(_draft(auth_mode="GOOGLE_OAUTH"), cb, getter) is False
    assert cb.sent == [] and len(cb.failed) == 1
    assert secret not in caplog.text and secret not in cb.failed[0][1]
    if failure == "temporary":
        assert "temporarily" in cb.failed[0][1]


@pytest.mark.asyncio
async def test_oauth_smtp_provider_exception_is_redacted(monkeypatch, caplog):
    import aiosmtplib
    from outbound import send_one_draft

    cb = _FakeCallback(claim_result=True)
    secret = "never-log-the-smtp-access-token"

    async def token(_):
        return secret

    async def send(_message, **kwargs):
        access = await kwargs["oauth_token_generator"]()
        raise RuntimeError(f"SMTP provider echoed {access}")

    monkeypatch.setattr(aiosmtplib, "send", send)
    assert await send_one_draft(_draft(auth_mode="GOOGLE_OAUTH"), cb, token) is False
    assert secret not in caplog.text and secret not in cb.failed[0][1]


@pytest.mark.asyncio
async def test_password_smtp_preserves_existing_authentication(monkeypatch):
    import aiosmtplib
    import creds
    from outbound import send_one_draft

    cb = _FakeCallback(claim_result=True)

    async def send(_message, **kwargs):
        assert kwargs["password"] == "manual-password"
        assert "oauth_token_generator" not in kwargs

    monkeypatch.setattr(aiosmtplib, "send", send)
    monkeypatch.setattr(creds, "decrypt", lambda _: "manual-password")
    assert await send_one_draft(_draft(), cb)
    assert cb.sent == ["d1"]


@pytest.mark.asyncio
async def test_oauth_draft_cannot_fetch_a_token_before_claim_or_with_missing_attachment(monkeypatch):
    from outbound import send_one_draft

    async def token(_):
        pytest.fail("denied draft cannot obtain a token")

    assert await send_one_draft(_draft(auth_mode="GOOGLE_OAUTH"), _FakeCallback(False), token) is False
    cb = _FakeCallback(True)
    assert await send_one_draft(_draft(auth_mode="GOOGLE_OAUTH", attachments_missing=True), cb, token) is False
    assert cb.failed == [("d1", "attachment no longer on the box")]
