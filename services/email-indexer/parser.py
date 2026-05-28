"""WARP-465 D1 follow-up — MIME parser.

Pure-function module: takes a raw RFC 5322 byte string and returns
the canonical dict the orchestrator's `/api/email/:accountId/messages-ingest`
expects. No I/O, no database, no IMAP — fully unit-testable.

Thread-key derivation:
  - If the message has References, the first ID wins (RFC 5322 root).
  - Else if it has In-Reply-To, that ID is the thread key.
  - Else the message's own Message-ID is the thread key (a new thread).

Body extraction:
  - text/plain part wins for bodyText (UTF-8 decoded; charset-aware
    via the email stdlib `get_content`).
  - text/html part wins for bodyHtml.
  - Multipart traversal walks recursively but skips attachments
    (Content-Disposition: attachment).
"""
from __future__ import annotations

import email
import email.utils
from email.message import Message
from typing import Optional, TypedDict


class ParsedMessage(TypedDict):
    messageId: str
    inReplyTo: Optional[str]
    fromAddr: str
    fromName: Optional[str]
    toAddrs: list[str]
    ccAddrs: Optional[list[str]]
    subject: str
    bodyText: Optional[str]
    bodyHtml: Optional[str]
    receivedAt: str  # ISO 8601
    threadKey: str


def _decode_header(value: Optional[str]) -> str:
    """Decode an RFC 2047 encoded-word header to a plain string."""
    if not value:
        return ""
    parts = email.header.decode_header(value)
    out = []
    for chunk, charset in parts:
        if isinstance(chunk, bytes):
            try:
                out.append(chunk.decode(charset or "utf-8", errors="replace"))
            except (LookupError, TypeError):
                out.append(chunk.decode("utf-8", errors="replace"))
        else:
            out.append(chunk)
    return "".join(out).strip()


def _split_address_list(value: Optional[str]) -> list[str]:
    """Return a clean list of address strings, dropping the display names."""
    if not value:
        return []
    parsed = email.utils.getaddresses([value])
    out: list[str] = []
    for _name, addr in parsed:
        addr = addr.strip()
        if addr and "@" in addr:
            out.append(addr)
    return out


def _split_address_with_name(value: Optional[str]) -> tuple[str, Optional[str]]:
    """Return (addr, name) for a single From header. name may be empty."""
    if not value:
        return ("", None)
    parsed = email.utils.getaddresses([value])
    if not parsed:
        return ("", None)
    name, addr = parsed[0]
    return (addr.strip(), name.strip() or None)


def _normalize_msgid(value: Optional[str]) -> Optional[str]:
    """Strip surrounding `<>` from a Message-ID-style header."""
    if not value:
        return None
    s = value.strip()
    if s.startswith("<") and s.endswith(">"):
        return s[1:-1]
    return s or None


def _first_reference(value: Optional[str]) -> Optional[str]:
    """References is whitespace-separated <id> list. First one wins."""
    if not value:
        return None
    tokens = value.split()
    for tok in tokens:
        norm = _normalize_msgid(tok)
        if norm:
            return norm
    return None


def _extract_bodies(msg: Message) -> tuple[Optional[str], Optional[str]]:
    """Walk a (possibly multipart) message; return (text, html)."""
    text: Optional[str] = None
    html: Optional[str] = None
    for part in msg.walk():
        ctype = part.get_content_type()
        disp = (part.get("Content-Disposition") or "").lower()
        if "attachment" in disp:
            continue
        if ctype == "text/plain" and text is None:
            payload = part.get_payload(decode=True)
            if isinstance(payload, bytes):
                charset = part.get_content_charset() or "utf-8"
                try:
                    text = payload.decode(charset, errors="replace")
                except LookupError:
                    text = payload.decode("utf-8", errors="replace")
        elif ctype == "text/html" and html is None:
            payload = part.get_payload(decode=True)
            if isinstance(payload, bytes):
                charset = part.get_content_charset() or "utf-8"
                try:
                    html = payload.decode(charset, errors="replace")
                except LookupError:
                    html = payload.decode("utf-8", errors="replace")
    return (text, html)


def derive_thread_key(
    message_id: str,
    in_reply_to: Optional[str],
    references: Optional[str],
) -> str:
    """Pure helper — exported so tests can pin the derivation rule
    independently of the full parser."""
    root_ref = _first_reference(references)
    if root_ref:
        return root_ref
    if in_reply_to:
        return in_reply_to
    return message_id


def parse_message(raw: bytes) -> Optional[ParsedMessage]:
    """Parse a raw RFC 5322 byte string. Returns None when the
    message lacks the minimum we need (Message-ID + From + a Date we
    can read)."""
    msg = email.message_from_bytes(raw)
    message_id = _normalize_msgid(msg.get("Message-ID"))
    if not message_id:
        return None

    in_reply_to = _normalize_msgid(msg.get("In-Reply-To"))
    references = msg.get("References")
    from_addr, from_name = _split_address_with_name(_decode_header(msg.get("From")))
    if not from_addr:
        return None
    to_addrs = _split_address_list(_decode_header(msg.get("To")))
    if not to_addrs:
        # RFC 5322 allows To to be missing (bcc-only delivery, list
        # mail) but for our surface we need at least one recipient.
        # The original delivery envelope is lost by IDLE so fall back
        # to the account's own address — the caller has it.
        to_addrs = []
    cc_addrs = _split_address_list(_decode_header(msg.get("Cc")))
    subject = _decode_header(msg.get("Subject"))
    date_header = msg.get("Date")
    received_at = email.utils.parsedate_to_datetime(date_header) if date_header else None
    if received_at is None:
        return None

    text, html = _extract_bodies(msg)
    thread_key = derive_thread_key(message_id, in_reply_to, references)

    return ParsedMessage(
        messageId=message_id,
        inReplyTo=in_reply_to,
        fromAddr=from_addr,
        fromName=from_name,
        toAddrs=to_addrs,
        ccAddrs=cc_addrs if cc_addrs else None,
        subject=subject,
        bodyText=text,
        bodyHtml=html,
        receivedAt=received_at.isoformat(),
        threadKey=thread_key,
    )
