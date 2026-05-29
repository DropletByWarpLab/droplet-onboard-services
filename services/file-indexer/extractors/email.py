"""Email extractor — .eml (RFC 822) + .msg (Outlook MAPI).

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.3
WARP-199, WARP-287.

Emits one `Span` per text-bearing MIME part with an `EmailPartAnchor`
whose `partIndex` is the position of the emitted span (0-indexed,
sequential) and whose `messageId` is the `Message-ID` header (with
`<>` brackets preserved).

Layout (each becomes one span when non-empty):
  - partIndex 0: combined From/To/Cc/Subject/Date headers block
  - partIndex 1..n: one span per text-bearing MIME part (text/plain,
    text/html stripped to text); html-only messages still emit a part.
  - For each attachment we can dispatch, the attachment's *outer* doc
    (its text content joined) becomes one further span. We do NOT
    recursively wrap inner attachment anchors — partIndex is enough
    for v1; archive-style anchor-nesting recursion is the archive
    extractor's concern (WARP-287 Task 8).

Design notes preserved from Phase 2:
  - The MIME of each attachment is sniffed from the bytes via
    python-magic — we don't trust the email's stated Content-Type alone
    because malicious or malformed messages routinely lie about it.
  - Attachments whose sniffed MIME isn't in the registry are skipped
    silently with a `unsupported_attachment:<filename>:<mime>` warning
    appended to the parent ExtractedDoc.
  - When dispatch() returns None (oversized / unknown handler) we treat
    that the same as unsupported.
"""
from __future__ import annotations

import email as stdlib_email
import email.policy
import logging
import os
import tempfile
from email.message import Message
from pathlib import Path
from typing import Optional

import magic

from anchor_schema import EmailPartAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)

# Spec §4.3 lists the three MIMEs we accept. RFC 822 covers `.eml`; the
# two Outlook variants both correspond to `.msg` MAPI containers.
SUPPORTED_MIMES = frozenset(
    {
        "message/rfc822",
        "application/vnd.ms-outlook",
        "application/x-msmail",
    }
)


def _format_headers(msg: Message) -> str:
    """Compose the From/To/Cc/Subject/Date headers block."""
    lines = []
    for header in ("From", "To", "Cc", "Subject", "Date"):
        v = msg.get(header)
        if v:
            lines.append(f"{header}: {v}")
    return "\n".join(lines)


def _decode_part(part: Message) -> str:
    """Best-effort decode of a single MIME part to a text string."""
    try:
        content = part.get_content()
    except (LookupError, KeyError):
        payload = part.get_payload(decode=True) or b""
        content = payload.decode(errors="replace")
    if not isinstance(content, str):
        # bytes / message / etc. — coerce to repr-safe string
        try:
            content = content.decode(errors="replace")  # type: ignore[union-attr]
        except Exception:  # pragma: no cover — defensive
            content = str(content)
    return content


def _strip_html(html: str) -> str:
    import re

    return re.sub(r"<[^>]+>", "", html).strip()


def _is_attachment(part: Message) -> bool:
    cd = (part.get("Content-Disposition") or "").lower()
    if "attachment" in cd:
        return True
    return bool(part.get_filename())


def _message_id(msg: Message, path: str) -> tuple[str, list[str]]:
    """Return (message_id_with_brackets, warnings).

    Preserves angle brackets when the header already has them; wraps a
    bare id; falls back to a stable synthetic id derived from the file
    path when the header is missing and emits a warning.
    """
    raw = msg.get("Message-ID")
    if raw:
        raw = raw.strip()
        if not raw.startswith("<"):
            raw = f"<{raw}"
        if not raw.endswith(">"):
            raw = f"{raw}>"
        return raw, []
    synthetic = f"<no-id-{hash(path)}@local>"
    return synthetic, ["missing_message_id"]


def _dispatch_attachment(
    payload: bytes,
    filename: str,
    depth: int,
    parent_email_id: Optional[str],
    parent_filename: str = "(email)",
    parent_mime: str = "message/rfc822",
) -> tuple[str, list[str], Optional[list[dict]]]:
    """Write payload to a temp file, sniff its MIME, recurse via dispatch.

    Returns (joined_text, warnings, chain) — joined_text is empty and
    chain is None if the attachment couldn't be handled. Chain follows
    the WARP-214 lineage convention.
    """
    # Local import avoids a circular dep at module load time.
    from extractors import registry

    warnings: list[str] = []

    mime = magic.from_buffer(payload, mime=True) or "application/octet-stream"
    fd, tmp = tempfile.mkstemp(suffix=os.path.splitext(filename)[1] or "")
    try:
        os.write(fd, payload)
    finally:
        os.close(fd)
    try:
        sub = registry.dispatch(tmp, mime, depth=depth + 1)
        if sub is None:
            warnings.append(f"unsupported_attachment:{filename}:{mime}")
            return "", warnings, None
        # Join all sub-spans into a single text block, prefixed by an
        # attachment marker. We do NOT recursively wrap anchors here —
        # partIndex on the outer email span is sufficient (see module
        # docstring). Archives handle inner-anchor recursion.
        sub_spans = sub.get("spans") or []
        sub_text = "\n\n".join(s.text for s in sub_spans if s.text)
        sub_warnings = list(sub.get("warnings") or [])
        warnings.extend(sub_warnings)
        if parent_email_id is not None:
            sub_meta = sub.get("metadata") or {}
            sub_meta["parent_email_id"] = parent_email_id
        sub_chain = (sub.get("metadata") or {}).get("chain") or []
        if sub_chain:
            chain = [
                {"filename": parent_filename, "mime": parent_mime},
                *sub_chain,
            ]
        else:
            chain = [
                {"filename": parent_filename, "mime": parent_mime},
                {"filename": filename, "mime": mime},
            ]
        body = f"--- Attachment: {filename} ---\n{sub_text}" if sub_text else f"--- Attachment: {filename} ---"
        return body, warnings, chain
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _extract_eml(path: str, depth: int, parent_email_id: Optional[str]) -> ExtractedDoc:
    with open(path, "rb") as f:
        msg = stdlib_email.message_from_binary_file(f, policy=email.policy.default)

    message_id, id_warnings = _message_id(msg, path)
    parent_filename = os.path.basename(path) or "(email)"

    spans: list[Span] = []
    warnings: list[str] = list(id_warnings)
    attachment_chains: list[list[dict]] = []

    def _emit(text: str) -> None:
        if not text or not text.strip():
            return
        anchor = EmailPartAnchor(messageId=message_id, partIndex=len(spans))
        spans.append(
            Span(text=text, anchor=anchor, section_path=[parent_filename])
        )

    # PartIndex 0: headers block.
    headers = _format_headers(msg)
    _emit(headers)

    # Text-bearing body parts.
    if msg.is_multipart():
        for part in msg.walk():
            if part.is_multipart():
                continue
            if _is_attachment(part):
                continue
            ctype = part.get_content_type()
            if ctype == "text/plain":
                _emit(_decode_part(part).strip())
            elif ctype == "text/html":
                _emit(_strip_html(_decode_part(part)))
    else:
        ctype = msg.get_content_type()
        if ctype == "text/plain":
            _emit(_decode_part(msg).strip())
        elif ctype == "text/html":
            _emit(_strip_html(_decode_part(msg)))

    # Attachments — each becomes one further span.
    for part in msg.walk():
        if part.is_multipart():
            continue
        if not _is_attachment(part):
            continue
        filename = part.get_filename() or "unnamed"
        payload = part.get_payload(decode=True) or b""
        if not payload:
            continue
        body, sub_warnings, chain = _dispatch_attachment(
            payload,
            filename,
            depth,
            parent_email_id,
            parent_filename=parent_filename,
            parent_mime="message/rfc822",
        )
        warnings.extend(sub_warnings)
        if chain:
            attachment_chains.append(chain)
        _emit(body)

    metadata: dict = {
        "extractor_name": "email",
        "extractor_version": "2",
        "message_id": message_id,
        "from": msg.get("From"),
        "to": msg.get("To"),
        "subject": msg.get("Subject"),
        "date": msg.get("Date"),
        # WARP-435: emails have no in-body structural hierarchy comparable
        # to PDF/DOCX — the headers + body + attachments live in a flat
        # stream. Each Span carries ``[filename]`` as its section path (set
        # in ``_emit``); the chain[] breadcrumb in ``metadata.chain`` still
        # carries the attachment lineage for nested .eml/.zip/etc. cases.
    }
    if attachment_chains:
        metadata["chain"] = attachment_chains[0]

    return ExtractedDoc(
        spans=spans,
        language=None,
        metadata=metadata,
        warnings=warnings,
    )


def _extract_msg(path: str, depth: int, parent_email_id: Optional[str]) -> ExtractedDoc:
    """Outlook .msg via extract-msg (MAPI binary container)."""
    import extract_msg  # local import — module is heavy

    m = extract_msg.Message(str(path))

    # Build a synthetic Message-ID for .msg — MAPI rarely exposes a clean
    # RFC822 Message-ID. Use the file path hash for stability.
    raw_id = getattr(m, "messageId", None)
    if raw_id:
        raw_id = str(raw_id).strip()
        if not raw_id.startswith("<"):
            raw_id = f"<{raw_id}"
        if not raw_id.endswith(">"):
            raw_id = f"{raw_id}>"
        message_id = raw_id
        id_warnings: list[str] = []
    else:
        message_id = f"<no-id-{hash(str(path))}@local>"
        id_warnings = ["missing_message_id"]

    parent_filename = os.path.basename(str(path)) or "(email)"

    spans: list[Span] = []
    warnings: list[str] = list(id_warnings)
    msg_chains: list[list[dict]] = []

    def _emit(text: str) -> None:
        if not text or not text.strip():
            return
        anchor = EmailPartAnchor(messageId=message_id, partIndex=len(spans))
        spans.append(
            Span(text=text, anchor=anchor, section_path=[parent_filename])
        )

    headers_lines: list[str] = []
    if m.sender:
        headers_lines.append(f"From: {m.sender}")
    if m.to:
        headers_lines.append(f"To: {m.to}")
    if getattr(m, "cc", None):
        headers_lines.append(f"Cc: {m.cc}")
    if m.subject:
        headers_lines.append(f"Subject: {m.subject}")
    if m.date:
        headers_lines.append(f"Date: {m.date}")
    headers = "\n".join(headers_lines)
    _emit(headers)

    body = (m.body or "").strip()
    _emit(body)

    for att in m.attachments:
        filename = att.longFilename or att.shortFilename or "unnamed"
        payload = att.data
        if not payload:
            continue
        body_text, sub_warnings, chain = _dispatch_attachment(
            payload,
            filename,
            depth,
            parent_email_id,
            parent_filename=parent_filename,
            parent_mime="application/vnd.ms-outlook",
        )
        warnings.extend(sub_warnings)
        if chain:
            msg_chains.append(chain)
        _emit(body_text)

    metadata: dict = {
        "extractor_name": "email",
        "extractor_version": "2",
        "message_id": message_id,
        "from": m.sender,
        "to": m.to,
        "subject": m.subject,
        "date": str(m.date) if m.date else None,
        # WARP-435: see _extract_eml — each Span carries ``[filename]`` as
        # its section path (set in ``_emit``).
    }
    if msg_chains:
        metadata["chain"] = msg_chains[0]

    return ExtractedDoc(
        spans=spans,
        language=None,
        metadata=metadata,
        warnings=warnings,
    )


def extract(
    path: str,
    mime: Optional[str] = None,
    depth: int = 0,
    parent_email_id: Optional[str] = None,
) -> Optional[ExtractedDoc]:
    """Top-level entry point.

    `mime` defaults to None for direct callers (tests, ad-hoc use); in
    that case we infer message/rfc822 unless the path ends in `.msg`.
    `depth` is forwarded by registry.dispatch through the recursion
    contract (see registry._call_handler). `parent_email_id`, when
    provided, threads through to attachment metadata so downstream
    chunkers can link attachment chunks back to their parent email.
    """
    if mime is None:
        ext = os.path.splitext(str(path))[1].lower()
        mime = "application/vnd.ms-outlook" if ext == ".msg" else "message/rfc822"
    if mime not in SUPPORTED_MIMES:
        return None
    if mime in {"application/vnd.ms-outlook", "application/x-msmail"}:
        return _extract_msg(path, depth, parent_email_id)
    return _extract_eml(path, depth, parent_email_id)
