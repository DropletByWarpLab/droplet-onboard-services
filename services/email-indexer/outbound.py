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
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
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


class StatusCallback(Protocol):
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
    msg.set_content(draft.body or "")
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
    """Dispatch one draft via SMTP, then notify the orchestrator.
    Returns True on success."""
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
