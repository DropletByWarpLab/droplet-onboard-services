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
  - Multipart traversal walks recursively but skips parts whose
    Content-Disposition says `attachment`, and never enters a forwarded
    `message/rfc822`: its body is not this message's body.

Attachments (WARP-3267):
  - Any leaf part that is not a text/plain or text/html body — or that says
    `attachment` or carries a file name — is an attachment, inline `cid:`
    images included. The parts picked as the message's own bodies never are.
  - A forwarded message (`message/rfc822`) is ONE attachment, stored as its
    `.eml`; its inner parts are not listed as this message's.
  - The limits mirror the orchestrator's `EMAIL_ATTACHMENT_LIMITS`: a part is
    stored when it fits (10 MiB each, 20 MiB and 20 parts per message); one
    that does not is still LISTED, without bytes, as `too_large` or
    `over_limit`, so the reader knows it existed. Past 50 parts, nothing more
    is listed.
  - Bytes travel base64 in the ingest payload. Nothing here opens, renders or
    runs them; the content type is the sender's claim, recorded as is.

Headers (WARP-3529):
  - `headers` carries the few header facts the orchestrator's service desk
    needs and the payload used to lack: every `References` id (threading) and
    the markers of a message no person wrote — `Auto-Submitted`, `Precedence`,
    `X-Autoreply`, `X-Autorespond`, `Return-Path` and the `report-type` of a
    delivery-status report. They are RECORDED as the sender wrote them
    (keywords lowercased, nothing interpreted): what to do about them is the
    desk's decision, written down there as an explicit reason. `None` means the
    header was absent; `""` means present and empty — `Return-Path: <>` (the
    null reverse path of a bounce) is exactly that.
"""
from __future__ import annotations

import base64
import email
import email.header
import email.utils
import hashlib
import json
import re
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
#: `References` ids sent per message — the orchestrator's zod `max`. A longer
#: chain keeps its root (what the thread key is) and its newest ids (what a reply
#: is matched by); the middle is the part nothing reads.
MAX_REFERENCES = 100
#: One Message-ID, in UTF-16 code units — the orchestrator's zod `max`.
MAX_MESSAGE_ID_LENGTH = 998


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


class ParsedHeaders(TypedDict):
    references: list[str]  # oldest first, brackets stripped
    autoSubmitted: Optional[str]  # RFC 3834 keyword, lowercased
    precedence: Optional[str]
    xAutoreply: Optional[str]
    xAutorespond: Optional[str]
    returnPath: Optional[str]  # bare address; "" is the null path of a bounce
    reportType: Optional[str]  # `multipart/report`'s report-type; "" if it names none


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
    headers: ParsedHeaders


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


def _is_forwarded(part: Message) -> bool:
    return part.get_content_type() == "message/rfc822"


def _parts(msg: Message):
    """`msg.walk()`, except a forwarded `message/rfc822` is yielded as one
    part and not entered: its inner body and files are not this message's."""
    yield msg
    if _is_forwarded(msg) or not msg.is_multipart():
        return
    for sub in msg.get_payload():
        if isinstance(sub, Message):
            yield from _parts(sub)


def _is_attachment(part: Message) -> bool:
    """A leaf part that is not one of the message's text bodies."""
    if _is_forwarded(part):
        return True
    ctype = part.get_content_type()
    if part.is_multipart() or ctype.startswith("message/"):
        return False
    disp = (part.get("Content-Disposition") or "").lower()
    if "attachment" in disp or part.get_filename():
        return True
    return ctype not in ("text/plain", "text/html")


def _part_bytes(part: Message) -> bytes:
    if _is_forwarded(part):
        inner = part.get_payload()
        if isinstance(inner, list) and inner and isinstance(inner[0], Message):
            return inner[0].as_bytes()
        return b""
    payload = part.get_payload(decode=True)
    return payload if isinstance(payload, bytes) else b""


def _extract_attachments(
    msg: Message, budget: int, bodies: tuple[Optional[Message], Optional[Message]] = (None, None)
) -> list[ParsedAttachment]:
    """`budget`: bytes of serialised payload the attachment list may use.
    `bodies`: the parts already shown as the message's text, never listed."""
    out: list[ParsedAttachment] = []
    stored = 0
    total = 0
    used = 2  # the list's brackets
    for part in _parts(msg):
        if not _is_attachment(part) or any(part is b for b in bodies):
            continue
        if len(out) >= MAX_LISTED_ATTACHMENTS:
            break  # ponytail: parts past 50 are dropped silently; list a count if anyone asks
        data = _part_bytes(part)
        fallback = "forwarded.eml" if _is_forwarded(part) else f"attachment-{len(out) + 1}"
        name = _decode_header(part.get_filename()) or fallback
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


def _body_parts(msg: Message) -> tuple[Optional[Message], Optional[Message]]:
    """The first text/plain and text/html parts that are not explicit
    `attachment`s. A NAMED inline body (`text/html; name="message.htm"`) is
    still the body — skipping every named part left such mail empty."""
    text: Optional[Message] = None
    html: Optional[Message] = None
    for part in _parts(msg):
        if "attachment" in (part.get("Content-Disposition") or "").lower():
            continue
        ctype = part.get_content_type()
        if ctype == "text/plain" and text is None:
            text = part
        elif ctype == "text/html" and html is None:
            html = part
    return (text, html)


def _decode_body(part: Optional[Message]) -> Optional[str]:
    if part is None:
        return None
    payload = part.get_payload(decode=True)
    if not isinstance(payload, bytes):
        return None
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


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


def _reference_ids(msg: Message) -> list[str]:
    """Every Message-ID in `References`, oldest first, brackets stripped. An id
    that is over the length the orchestrator accepts is dropped — one junk id
    must not fail the whole message."""
    raw = " ".join(str(v) for v in (msg.get_all("References") or []))
    ids: list[str] = []
    for tok in raw.split():
        norm = _normalize_msgid(tok)
        if norm and _fit_utf16(norm, MAX_MESSAGE_ID_LENGTH) == norm:
            ids.append(norm)
    if len(ids) > MAX_REFERENCES:
        ids = ids[:1] + ids[-(MAX_REFERENCES - 1):]
    return ids


def _header_keyword(msg: Message, name: str) -> Optional[str]:
    """The first word of a header's value, lowercased — `auto-replied` out of
    `Auto-Replied; owner-email="x@y"`. None when the header is absent, "" when
    it is there and says nothing."""
    value = msg.get(name)
    if value is None:
        return None
    text = str(value).strip().lower()
    return re.split(r"[;\s]", text, maxsplit=1)[0][:64] if text else ""


def _return_path(msg: Message) -> Optional[str]:
    """The bare address of `Return-Path`; "" for `<>`, the null reverse path an
    MTA gives a bounce; None when the header is absent."""
    value = msg.get("Return-Path")
    if value is None:
        return None
    _name, addr = email.utils.parseaddr(str(value).strip())
    return addr.strip()[:320]


def _report_type(msg: Message) -> Optional[str]:
    """`report-type` of a `multipart/report` (a delivery-status or disposition
    notification — a machine's report either way); None for any other message.
    A report that names no type is still a report: ""."""
    if msg.get_content_type() != "multipart/report":
        return None
    value = msg.get_param("report-type")
    if not value:
        return ""
    return str(email.utils.collapse_rfc2231_value(value)).strip().lower()[:64]


def extract_headers(msg: Message) -> ParsedHeaders:
    return ParsedHeaders(
        references=_reference_ids(msg),
        autoSubmitted=_header_keyword(msg, "Auto-Submitted"),
        precedence=_header_keyword(msg, "Precedence"),
        xAutoreply=_header_keyword(msg, "X-Autoreply"),
        xAutorespond=_header_keyword(msg, "X-Autorespond"),
        returnPath=_return_path(msg),
        reportType=_report_type(msg),
    )


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

    bodies = _body_parts(msg)
    text, html = _decode_body(bodies[0]), _decode_body(bodies[1])
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
        headers=extract_headers(msg),
    )
    out["attachments"] = _extract_attachments(
        msg, MAX_INGEST_PAYLOAD_BYTES - _json_size(out), bodies
    )
    return out
