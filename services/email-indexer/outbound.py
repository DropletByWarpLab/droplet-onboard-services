"""WARP-465 D1 follow-up — outbound SMTP poller.

Every 10s scans EmailDraft rows with status=queued, dispatches each
via SMTP, and PATCHes the orchestrator with `sent` / `failed`. Single
apscheduler interval job — no `while True` per rule 9.

The poller is intentionally simple: one send at a time per account.
That's fine for the throughput a household / SMB email box produces.
If we ever need higher throughput we'll move to a queue worker, but
that's premature today.

SMTP uses `aiosmtplib` for an async transaction matching the rest of
the service. STARTTLS vs implicit TLS is decided by the account's
smtpTls boolean + smtpPort heuristic (465 = implicit, 587 = STARTTLS).

WARP-3267:
  - A draft on a thread (a reply, or a forward started from one) carries
    `In-Reply-To` (the thread's newest Message-ID) and `References` (the
    thread's Message-IDs, oldest first), so the recipient's client threads it.
    `Date` and `Message-ID` are set here rather than left to the SMTP server.
  - Ruling: outbound mail stays plain text. The box does not compose HTML —
    an HTML body is a second rendering of the same text with its own escaping
    bugs, and every client shows text/plain. A forward carries the original's
    attachments, picked by id (`EmailDraft.attachmentIds`), as
    `multipart/mixed`.

WARP-3529 (the service desk):
  - The orchestrator generates the Message-ID of a desk reply, stores it on the
    draft (`EmailDraft.messageId`) and this module sends exactly that, so the
    desk knows the id a customer's reply will carry in `In-Reply-To` /
    `References` before anything leaves the box. A draft with none — every
    draft the mail screen and the assistant create — still gets one made here.
  - A draft the desk marks `autoSubmitted` (its automatic acknowledgement) goes
    out as `Auto-Submitted: auto-replied` (RFC 3834) so no other responder, and
    not this box's own intake, answers it.
"""
from __future__ import annotations

import email.utils
import logging
import re
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Optional, Protocol

logger = logging.getLogger(__name__)


@dataclass
class DraftToSend:
    """The fields the SMTP transaction needs. Loaded from postgres by
    main.py's poller helper."""

    id: str
    account_id: str
    from_addr: str
    smtp_host: str
    smtp_port: int
    smtp_tls: bool
    username: str
    password_enc: str
    to_addrs: list[str]
    cc_addrs: Optional[list[str]]
    bcc_addrs: Optional[list[str]]
    subject: str
    body: str
    #: Message-IDs of the draft's thread, oldest first, without brackets.
    thread_message_ids: list[str] = field(default_factory=list)
    #: (filename, content type, bytes) of each forwarded attachment.
    attachments: list[tuple[str, str, bytes]] = field(default_factory=list)
    #: A picked attachment is no longer on the box (its message or mailbox is
    #: gone). Sending without it would send something the owner did not
    #: approve, so the draft fails instead.
    attachments_missing: bool = False
    #: WARP-3529 — the RFC 5322 Message-ID (no brackets) the orchestrator chose.
    #: None for a draft nothing chose one for; `build_message` makes its own.
    message_id: Optional[str] = None
    #: WARP-3529 — an automatic reply (the desk's acknowledgement), not a
    #: person's: sent with `Auto-Submitted: auto-replied`.
    auto_submitted: bool = False


#: A Message-ID we are willing to echo into a header. They come from inbound
#: mail, so anything with whitespace or brackets (a header-injection attempt,
#: or just junk) is left out rather than failing the whole send.
_MSGID_RE = re.compile(r"[^\s<>]{1,900}")
#: The ids the orchestrator generates are `<hex>@<domain>`. Anything outside this
#: dot-atom alphabet is not echoed into a header — the draft row is data this
#: process did not write, and a CR/LF in it would be a header injection.
_OWN_MSGID_RE = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,200}@[A-Za-z0-9.-]{1,255}")
_CTYPE_RE = re.compile(r"([a-z0-9][a-z0-9.+-]*)/([a-z0-9][a-z0-9.+-]*)")
_UNSAFE_NAME_RE = re.compile(
    "[\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069\"<>:|?*/\\\\]"
)
#: RFC 5322 lets References be trimmed; keep the root and the newest ones.
MAX_REFERENCES = 20


def _thread_headers(ids: list[str]) -> tuple[Optional[str], Optional[str]]:
    """(In-Reply-To, References) for a thread's Message-IDs, oldest first."""
    ids = [i for i in ids if _MSGID_RE.fullmatch(i)]
    if not ids:
        return (None, None)
    if len(ids) > MAX_REFERENCES:
        ids = ids[:1] + ids[-(MAX_REFERENCES - 1):]
    return (f"<{ids[-1]}>", " ".join(f"<{i}>" for i in ids))


class StatusCallback(Protocol):
    async def claim(self, draft_id: str) -> bool: ...
    async def mark_sent(self, draft_id: str) -> bool: ...
    async def mark_failed(self, draft_id: str, error: str) -> bool: ...


def build_message(draft: DraftToSend) -> EmailMessage:
    """Pure helper — assemble an EmailMessage from the draft. Exported
    so tests can pin the MIME structure without sending."""
    msg = EmailMessage()
    msg["From"] = draft.from_addr
    msg["To"] = ", ".join(draft.to_addrs)
    if draft.cc_addrs:
        msg["Cc"] = ", ".join(draft.cc_addrs)
    # bcc_addrs are NOT serialized into headers — they live only in
    # the envelope (RCPT TO). aiosmtplib accepts them via `recipients`.
    msg["Subject"] = draft.subject
    msg["Date"] = email.utils.formatdate(usegmt=True)
    domain = draft.from_addr.rpartition("@")[2] or None
    if draft.message_id and _OWN_MSGID_RE.fullmatch(draft.message_id):
        msg["Message-ID"] = f"<{draft.message_id}>"
    else:
        msg["Message-ID"] = email.utils.make_msgid(domain=domain)
    if draft.auto_submitted:
        msg["Auto-Submitted"] = "auto-replied"
        # Exchange's own "do not auto-respond to this" marker; harmless elsewhere.
        msg["X-Auto-Response-Suppress"] = "All"
    in_reply_to, references = _thread_headers(draft.thread_message_ids)
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = references
    msg.set_content(draft.body or "")
    for filename, content_type, data in draft.attachments:
        m = _CTYPE_RE.fullmatch(content_type.lower())
        maintype, subtype = m.groups() if m else ("application", "octet-stream")
        if maintype in ("multipart", "message"):
            maintype, subtype = "application", "octet-stream"
        # The name came from a stranger's mail: no line breaks into a header,
        # no directory part for the recipient's client to honour.
        # Same character class as the orchestrator's sanitizeAttachmentFilename,
        # bidi overrides included (`invoice\u202Efdp.exe`).
        safe_name = _UNSAFE_NAME_RE.sub("_", filename).lstrip(". ") or "attachment"
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=safe_name)
    return msg


def envelope_recipients(draft: DraftToSend) -> list[str]:
    """All RCPT TO addresses, including bcc. Exported for tests."""
    out: list[str] = list(draft.to_addrs)
    if draft.cc_addrs:
        out.extend(draft.cc_addrs)
    if draft.bcc_addrs:
        out.extend(draft.bcc_addrs)
    return out


async def send_one_draft(
    draft: DraftToSend,
    callback: StatusCallback,
) -> bool:
    """Claim, dispatch one draft via SMTP, then notify the orchestrator.
    Returns True on success."""
    # WARP-890: atomically claim the draft (queued -> sending) BEFORE doing any
    # work, so a subsequent poll tick can't re-select and re-send it if the
    # terminal status callback below is lost. If we don't win the claim (already
    # in-flight / no longer queued), skip without sending.
    if not await callback.claim(draft.id):
        logger.debug(
            "draft %s not claimed (already in-flight or not queued); skipping",
            draft.id,
        )
        return False
    if draft.attachments_missing:
        await callback.mark_failed(draft.id, "attachment no longer on the box")
        return False
    # Lazy import so the unit tests for build_message / envelope_recipients
    # don't need aiosmtplib installed in the test environment.
    try:
        import aiosmtplib
    except ImportError as exc:
        logger.error("aiosmtplib not available; cannot send: %s", exc)
        await callback.mark_failed(draft.id, "aiosmtplib not installed")
        return False

    from creds import decrypt

    plaintext = decrypt(draft.password_enc)
    if plaintext is None:
        await callback.mark_failed(draft.id, "password decrypt failed")
        return False

    msg = build_message(draft)
    recipients = envelope_recipients(draft)

    # Heuristic: 465 → implicit TLS; anything else with smtp_tls → STARTTLS.
    use_tls = draft.smtp_tls and draft.smtp_port == 465
    start_tls = draft.smtp_tls and not use_tls

    try:
        await aiosmtplib.send(
            msg,
            hostname=draft.smtp_host,
            port=draft.smtp_port,
            username=draft.username,
            password=plaintext,
            use_tls=use_tls,
            start_tls=start_tls,
            recipients=recipients,
        )
    except Exception as exc:  # noqa: BLE001 — surface all SMTP failures
        logger.warning("smtp send failed for draft %s: %s", draft.id, exc)
        await callback.mark_failed(draft.id, str(exc)[:1024])
        return False

    await callback.mark_sent(draft.id)
    logger.info("draft %s sent", draft.id)
    return True
