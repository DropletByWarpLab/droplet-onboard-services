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
  - Multipart traversal walks recursively but skips attachments.

Attachments (WARP-3267):
  - Any leaf part that is not a text/plain or text/html body — or that says
    `attachment` or carries a file name — is an attachment, inline `cid:`
    images included.
  - The limits mirror the orchestrator's `EMAIL_ATTACHMENT_LIMITS`: a part is
    stored when it fits (10 MiB each, 20 MiB and 20 parts per message); one
    that does not is still LISTED, without bytes, as `too_large` or
    `over_limit`, so the reader knows it existed. Past 50 parts, nothing more
    is listed.
  - Bytes travel base64 in the ingest payload. Nothing here opens, renders or
    runs them; the content type is the sender's claim, recorded as is.
"""
from __future__ import annotations

import base64
import email
import email.header
import email.utils
import hashlib
import json
from email.message import Message
from typing import Optional, TypedDict

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_STORED_ATTACHMENTS = 20
MAX_LISTED_ATTACHMENTS = 50
#: The whole ingest body, serialised, must stay under this. The orchestrator
#: parses the route with a 48 MB limit, so any message this parser emits fits:
#: a part that would push the payload over it is demoted to `too_large`
#: before it is sent. Without the budget, a message with 20 MiB of
#: attachments AND large bodies was refused with a 413 and lost.
MAX_INGEST_PAYLOAD_BYTES = 30 * 1024 * 1024


def _json_size(value: object) -> int:
    """Serialised size, upper bound: ASCII-escaped JSON is never smaller than
    the UTF-8 httpx sends."""
    return len(json.dumps(value))


def _fit_utf16(value: str, limit: int) -> str:
    """Cut to `limit` UTF-16 code units — what the orchestrator's zod `max`
    counts — so an astral-heavy name can't fail the whole ingest."""
    while len(value.encode("utf-16-le")) // 2 > limit:
        value = value[:-1]
    return value


class ParsedAttachment(TypedDict, total=False):
    filename: str
    contentType: str
    size: int
    sha256: str
    contentId: Optional[str]
    status: str  # stored | too_large | over_limit
    data: str  # base64, only when status == "stored"


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
    attachments: list[ParsedAttachment]


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


def _parse_date_header(value: Optional[str]):
    """Parse an RFC 5322 `Date:` header to a datetime, tolerating garbage.

    `email.utils.parsedate_to_datetime` returns None for some malformed inputs
    but *raises* (ValueError/TypeError) for others (e.g. an empty/whitespace
    string, or a value with a parseable date but an out-of-range field). A
    single bad header must not bubble up and abort the whole IDLE batch
    (IDX-07) — treat any unparseable Date as "no timestamp" → None, same as a
    missing header.
    """
    if not value:
        return None
    try:
        return email.utils.parsedate_to_datetime(value)
    except (ValueError, TypeError):
        return None


def _is_attachment(part: Message) -> bool:
    """A leaf part that is not one of the message's text bodies."""
    ctype = part.get_content_type()
    if part.is_multipart() or ctype.startswith("message/"):
        return False
    disp = (part.get("Content-Disposition") or "").lower()
    if "attachment" in disp or part.get_filename():
        return True
    return ctype not in ("text/plain", "text/html")


def _extract_attachments(msg: Message, budget: int) -> list[ParsedAttachment]:
    """`budget`: bytes of serialised payload the attachment list may use."""
    out: list[ParsedAttachment] = []
    stored = 0
    total = 0
    used = 2  # the list's brackets
    for part in msg.walk():
        if not _is_attachment(part):
            continue
        if len(out) >= MAX_LISTED_ATTACHMENTS:
            break  # ponytail: parts past 50 are dropped silently; list a count if anyone asks
        payload = part.get_payload(decode=True)
        data = payload if isinstance(payload, bytes) else b""
        name = _decode_header(part.get_filename()) or f"attachment-{len(out) + 1}"
        cid = _normalize_msgid(part.get("Content-ID"))
        att: ParsedAttachment = {
            "filename": _fit_utf16(name, 255),
            "contentType": _fit_utf16(part.get_content_type(), 255),
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            # An over-long Content-ID is junk; drop it rather than fail the
            # message (the orchestrator caps it at 998).
            "contentId": cid if cid and _fit_utf16(cid, 998) == cid else None,
        }
        if stored >= MAX_STORED_ATTACHMENTS:
            att["status"] = "over_limit"
        elif len(data) > MAX_ATTACHMENT_BYTES or total + len(data) > MAX_TOTAL_ATTACHMENT_BYTES:
            att["status"] = "too_large"
        else:
            att["status"] = "stored"
            att["data"] = base64.b64encode(data).decode("ascii")
            stored += 1
            total += len(data)
        cost = _json_size(att) + 2  # comma and slack
        if att["status"] == "stored" and used + cost > budget:
            # Would push the ingest body past its limit: list it, don't send it.
            del att["data"]
            att["status"] = "too_large"
            stored -= 1
            total -= len(data)
            cost = _json_size(att) + 2
        used += cost
        out.append(att)
    return out


def _extract_bodies(msg: Message) -> tuple[Optional[str], Optional[str]]:
    """Walk a (possibly multipart) message; return (text, html)."""
    text: Optional[str] = None
    html: Optional[str] = None
    for part in msg.walk():
        ctype = part.get_content_type()
        if _is_attachment(part):
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


def parse_message(
    raw: bytes,
    *,
    account_address: Optional[str] = None,
) -> Optional[ParsedMessage]:
    """Parse a raw RFC 5322 byte string. Returns None when the
    message lacks the minimum we need (Message-ID + From + a Date we
    can read).

    `account_address` is the IMAP account's own address — passed by
    the caller so we can fall back to it when To: is missing (BCC-only
    delivery, list mail). The orchestrator's ingest schema enforces
    toAddrs.min(1), so without this fallback every BCC-only message
    would 400 and be permanently lost.
    """
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
        # mail) but the orchestrator's ingest schema requires
        # toAddrs.min(1). Fall back to the account's own address so
        # BCC-only mail doesn't 400 and get permanently lost. When no
        # account_address is wired (unit tests, dev), drop the message
        # rather than synthesize a placeholder.
        if account_address:
            to_addrs = [account_address]
        else:
            return None
    cc_addrs = _split_address_list(_decode_header(msg.get("Cc")))
    subject = _decode_header(msg.get("Subject"))
    received_at = _parse_date_header(msg.get("Date"))
    if received_at is None:
        return None

    text, html = _extract_bodies(msg)
    thread_key = derive_thread_key(message_id, in_reply_to, references)

    out = ParsedMessage(
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
        attachments=[],
    )
    out["attachments"] = _extract_attachments(
        msg, MAX_INGEST_PAYLOAD_BYTES - _json_size(out)
    )
    return out
