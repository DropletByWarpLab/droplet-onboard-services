"""WARP-465 D1 follow-up — read-only asyncpg helpers.

The indexer does NOT mutate the email tables directly — that's the
orchestrator's surface. We do read EmailAccount + EmailDraft from
postgres so the IDLE pool + outbound poller can pick up new accounts
and queued drafts without an HTTP round-trip per poll.

Connection: DATABASE_URL env var, same one Prisma uses. Pool of 4 is
generous for the indexer's workload (one query every 10s + one per
new account on dashboard add).
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import asyncpg

from idle import AccountConfig
from outbound import DraftToSend

logger = logging.getLogger(__name__)

DATABASE_URL = os.environ.get("DATABASE_URL", "")

_pool: Optional[asyncpg.Pool] = None


async def init_pool() -> None:
    """Open the pool. Idempotent."""
    global _pool
    if _pool is not None:
        return
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL not set")
    _pool = await asyncpg.create_pool(
        DATABASE_URL,
        min_size=1,
        max_size=4,
        command_timeout=10.0,
    )


async def close_pool() -> None:
    global _pool
    if _pool is None:
        return
    await _pool.close()
    _pool = None


async def list_accounts() -> list[AccountConfig]:
    """Return every EmailAccount as the IDLE loop's reduced shape."""
    if _pool is None:
        return []
    rows = await _pool.fetch(
        """
        SELECT id, address, "imapHost", "imapPort", "imapTls",
               username, "passwordEnc"
        FROM "EmailAccount"
        """,
    )
    return [
        AccountConfig(
            id=r["id"],
            address=r["address"],
            imap_host=r["imapHost"],
            imap_port=r["imapPort"],
            imap_tls=r["imapTls"],
            username=r["username"],
            password_enc=r["passwordEnc"],
        )
        for r in rows
    ]


async def list_queued_drafts() -> list[DraftToSend]:
    """Return every EmailDraft.status='queued' joined to the parent
    EmailAccount's SMTP config."""
    if _pool is None:
        return []
    rows = await _pool.fetch(
        """
        SELECT d.id, d."accountId", d."toAddrs", d."ccAddrs",
               d."bccAddrs", d.subject, d.body,
               d."threadId", d."attachmentIds",
               d."messageId", d."autoSubmitted",
               a."address" AS from_addr,
               a."smtpHost", a."smtpPort", a."smtpTls",
               a."username", a."passwordEnc"
        FROM "EmailDraft" d
        JOIN "EmailAccount" a ON a.id = d."accountId"
        WHERE d.status = 'queued'
        ORDER BY d."updatedAt" ASC
        LIMIT 32
        """,
    )
    out: list[DraftToSend] = []
    for r in rows:
        # WARP-3267 — the thread's Message-IDs (for In-Reply-To/References),
        # in ARRIVAL order (createdAt): a sender's skewed Date must not make
        # an older message the parent. And a forward's attachments, checked again to belong to this mailbox.
        # ponytail: loads attachment bytes for every queued draft each tick;
        # load after the claim if queues ever grow.
        thread_ids: list[str] = []
        if r["threadId"]:
            thread_ids = [
                m["messageId"]
                for m in await _pool.fetch(
                    """
                    SELECT "messageId" FROM "EmailMessage"
                    WHERE "threadId" = $1 AND "accountId" = $2
                    ORDER BY "createdAt" ASC, "receivedAt" ASC
                    """,
                    r["threadId"], r["accountId"],
                )
            ]
        wanted = list(r["attachmentIds"] or [])
        attachments: list[tuple[str, str, bytes]] = []
        if wanted:
            att_rows = await _pool.fetch(
                """
                SELECT id, filename, "contentType", data FROM "EmailAttachment"
                WHERE id = ANY($1::text[]) AND "accountId" = $2
                  AND status = 'stored' AND data IS NOT NULL
                """,
                wanted, r["accountId"],
            )
            by_id = {a["id"]: a for a in att_rows}
            attachments = [
                (by_id[i]["filename"], by_id[i]["contentType"], bytes(by_id[i]["data"]))
                for i in dict.fromkeys(wanted)
                if i in by_id
            ]
        out.append(
            DraftToSend(
                id=r["id"],
                account_id=r["accountId"],
                from_addr=r["from_addr"],
                smtp_host=r["smtpHost"],
                smtp_port=r["smtpPort"],
                smtp_tls=r["smtpTls"],
                username=r["username"],
                password_enc=r["passwordEnc"],
                to_addrs=list(r["toAddrs"] or []),
                cc_addrs=list(r["ccAddrs"]) if r["ccAddrs"] else None,
                bcc_addrs=list(r["bccAddrs"]) if r["bccAddrs"] else None,
                subject=r["subject"],
                body=r["body"] or "",
                thread_message_ids=thread_ids,
                attachments=attachments,
                attachments_missing=len(attachments) != len(set(wanted)),
                # WARP-3529 — the desk chose this draft's Message-ID and says
                # whether it is an automatic acknowledgement.
                message_id=r["messageId"],
                auto_submitted=bool(r["autoSubmitted"]),
            )
        )
    return out
