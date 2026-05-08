"""Email extractor — .eml (RFC 822) + .msg (Outlook MAPI).

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.3
WARP-199.

Compose a structured text body (From/To/Cc/Subject/Date headers + body)
and recurse through registry.dispatch() for each attachment whose MIME
is supported. Recursion depth bounded by registry.MAX_RECURSION_DEPTH
(default 2).

Design notes:
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

_ATTACHMENT_SEPARATOR = "\n--- Attachment: {name} ---\n"


def _format_headers(msg: Message) -> str:
    """Compose the From/To/Cc/Subject/Date headers block."""
    lines = []
    for header in ("From", "To", "Cc", "Subject", "Date"):
        v = msg.get(header)
        if v:
            lines.append(f"{header}: {v}")
    return "\n".join(lines)


def _extract_body(msg: Message) -> str:
    """Pick the text/plain body if present; else strip HTML to text."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not _is_attachment(part):
                try:
                    return part.get_content().strip()
                except (LookupError, KeyError):
                    payload = part.get_payload(decode=True) or b""
                    return payload.decode(errors="replace").strip()
        for part in msg.walk():
            if part.get_content_type() == "text/html" and not _is_attachment(part):
                try:
                    html = part.get_content()
                except (LookupError, KeyError):
                    payload = part.get_payload(decode=True) or b""
                    html = payload.decode(errors="replace")
                # Crude HTML→text. readability-lxml is heavier than we need
                # for an attachment-stripped email body; a regex is fine.
                import re

                return re.sub(r"<[^>]+>", "", html).strip()
        return ""
    if msg.get_content_type() == "text/plain":
        try:
            return msg.get_content().strip()
        except (LookupError, KeyError):
            payload = msg.get_payload(decode=True) or b""
            return payload.decode(errors="replace").strip()
    if msg.get_content_type() == "text/html":
        try:
            html = msg.get_content()
        except (LookupError, KeyError):
            payload = msg.get_payload(decode=True) or b""
            html = payload.decode(errors="replace")
        # Mirrors the multipart HTML→text fallback above; a regex strip
        # is sufficient for body extraction (no full DOM needed).
        import re

        return re.sub(r"<[^>]+>", "", html).strip()
    return ""


def _is_attachment(part: Message) -> bool:
    cd = (part.get("Content-Disposition") or "").lower()
    if "attachment" in cd:
        return True
    return bool(part.get_filename())


def _dispatch_attachment(
    payload: bytes,
    filename: str,
    depth: int,
    parent_email_id: Optional[str],
    parent_filename: str = "(email)",
    parent_mime: str = "message/rfc822",
) -> tuple[list[str], list[str], Optional[list[dict]]]:
    """Write payload to a temp file, sniff its MIME, recurse via dispatch.

    Returns (text_parts, warnings, chain) — text_parts is empty and chain is
    None if the attachment couldn't be handled. WARP-214: the returned chain
    traces parent → (sub.metadata.chain, if any) → child so downstream
    chunkers can stamp each chunk with its recursion lineage.
    """
    # Local import avoids a circular dep at module load time
    # (registry imports extractors.email lazily inside _route + _cap_for_mime).
    from extractors import registry

    text_parts: list[str] = []
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
            return text_parts, warnings, None
        text_parts.append(_ATTACHMENT_SEPARATOR.format(name=filename))
        text_parts.append(sub.get("text", ""))
        for w in sub.get("warnings") or []:
            warnings.append(w)
        # Tag attachment metadata with the parent email's id when known.
        # We only thread the parent id through warnings/metadata at the
        # caller — sub already carries its own metadata for downstream
        # chunkers; the top-level email metadata captures parent linkage.
        if parent_email_id is not None:
            sub_meta = sub.get("metadata") or {}
            sub_meta["parent_email_id"] = parent_email_id
        # WARP-214: build the chain lineage. If the attachment itself was a
        # carrier (nested .eml or .zip) it may already carry a chain — splice
        # ours around it. Otherwise produce a 2-segment parent → child chain.
        sub_chain = (sub.get("metadata") or {}).get("chain") or []
        if sub_chain:
            chain = [
                {"filename": parent_filename, "mime": parent_mime},
                *sub_chain,
                {"filename": filename, "mime": mime},
            ]
        else:
            chain = [
                {"filename": parent_filename, "mime": parent_mime},
                {"filename": filename, "mime": mime},
            ]
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return text_parts, warnings, chain


def _walk_eml_attachments(
    msg: Message,
    depth: int,
    parent_email_id: Optional[str],
    parent_filename: str = "(email)",
) -> tuple[str, list[str], list[list[dict]]]:
    """Recursively dispatch each .eml attachment.

    Returns (text, warnings, chains) — chains is one chain[] per
    successfully-dispatched attachment so downstream callers can attach
    a parent-side chain to the ExtractedDoc metadata.
    """
    all_text: list[str] = []
    all_warnings: list[str] = []
    all_chains: list[list[dict]] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        if not _is_attachment(part):
            continue
        filename = part.get_filename() or "unnamed"
        payload = part.get_payload(decode=True) or b""
        if not payload:
            continue
        parts, warnings, chain = _dispatch_attachment(
            payload,
            filename,
            depth,
            parent_email_id,
            parent_filename=parent_filename,
            parent_mime="message/rfc822",
        )
        all_text.extend(parts)
        all_warnings.extend(warnings)
        if chain:
            all_chains.append(chain)
    return "\n".join(all_text), all_warnings, all_chains


def _extract_eml(path: str, depth: int, parent_email_id: Optional[str]) -> ExtractedDoc:
    with open(path, "rb") as f:
        # `policy.default` gives us EmailMessage with .get_content() / .iter_attachments().
        msg = stdlib_email.message_from_binary_file(f, policy=email.policy.default)
    headers = _format_headers(msg)
    body = _extract_body(msg)
    parent_filename = os.path.basename(path) or "(email)"
    attachments_text, attachment_warnings, attachment_chains = _walk_eml_attachments(
        msg, depth, parent_email_id, parent_filename=parent_filename
    )

    sections = [s for s in (headers, body, attachments_text) if s]
    full_text = "\n\n".join(sections)

    page_breaks: list[int] = []
    if headers and body:
        # Mark the boundary between the headers block and the body
        # (offset of the first body char in the combined string).
        page_breaks.append(len(headers) + 2)  # +2 for "\n\n"

    metadata: dict = {
        "extractor_name": "email",
        "extractor_version": "1.0",
        "from": msg.get("From"),
        "to": msg.get("To"),
        "subject": msg.get("Subject"),
        "date": msg.get("Date"),
    }
    # WARP-214: surface the first attachment's chain on the doc-level metadata
    # so the chunker propagates it to FileContentChunk.metadata.chain. Multiple
    # attachments produce multiple chains; chunk-level chain assignment is a
    # follow-up — the dashboard's depth-2 cap is satisfied by the first chain.
    if attachment_chains:
        metadata["chain"] = attachment_chains[0]

    return ExtractedDoc(
        text=full_text,
        page_breaks=page_breaks,
        language=None,
        metadata=metadata,
        warnings=attachment_warnings,
    )


def _extract_msg(path: str, depth: int, parent_email_id: Optional[str]) -> ExtractedDoc:
    """Outlook .msg via extract-msg (MAPI binary container)."""
    import extract_msg  # local import — module is heavy

    m = extract_msg.Message(str(path))

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
    body = (m.body or "").strip()

    attachments_text_parts: list[str] = []
    warnings: list[str] = []
    parent_filename = os.path.basename(str(path)) or "(email)"
    msg_chains: list[list[dict]] = []
    for att in m.attachments:
        filename = att.longFilename or att.shortFilename or "unnamed"
        payload = att.data
        if not payload:
            continue
        parts, sub_warnings, chain = _dispatch_attachment(
            payload,
            filename,
            depth,
            parent_email_id,
            parent_filename=parent_filename,
            parent_mime="application/vnd.ms-outlook",
        )
        attachments_text_parts.extend(parts)
        warnings.extend(sub_warnings)
        if chain:
            msg_chains.append(chain)

    attachments_text = "\n".join(attachments_text_parts)
    sections = [s for s in (headers, body, attachments_text) if s]
    full_text = "\n\n".join(sections)

    page_breaks: list[int] = []
    if headers and body:
        page_breaks.append(len(headers) + 2)

    metadata: dict = {
        "extractor_name": "email",
        "extractor_version": "1.0",
        "from": m.sender,
        "to": m.to,
        "subject": m.subject,
        "date": str(m.date) if m.date else None,
    }
    # WARP-214: see _extract_eml — first chain wins for doc-level metadata.
    if msg_chains:
        metadata["chain"] = msg_chains[0]

    return ExtractedDoc(
        text=full_text,
        page_breaks=page_breaks,
        language=None,
        metadata=metadata,
        warnings=warnings,
    )


def extract(
    path: str,
    mime: str,
    depth: int = 0,
    parent_email_id: Optional[str] = None,
) -> Optional[ExtractedDoc]:
    """Top-level entry point.

    `depth` is forwarded by registry.dispatch through the recursion
    contract (see registry._call_handler). `parent_email_id`, when
    provided, threads through to attachment metadata so downstream
    chunkers can link attachment chunks back to their parent email.
    """
    if mime not in SUPPORTED_MIMES:
        return None
    if mime in {"application/vnd.ms-outlook", "application/x-msmail"}:
        return _extract_msg(path, depth, parent_email_id)
    return _extract_eml(path, depth, parent_email_id)
