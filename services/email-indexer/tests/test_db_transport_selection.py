"""Execute transport selection SQL to keep Graph mail out of IMAP and SMTP."""
from __future__ import annotations

import json
import sqlite3

import pytest

import db


class SqlPool:
    """The selection queries use SQL shared by SQLite and PostgreSQL."""

    def __init__(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript('''
            CREATE TABLE "EmailAccount" (
                id TEXT PRIMARY KEY, address TEXT, "imapHost" TEXT,
                "imapPort" INTEGER, "imapTls" INTEGER, username TEXT,
                "passwordEnc" TEXT, "authMode" TEXT, "smtpHost" TEXT,
                "smtpPort" INTEGER, "smtpTls" INTEGER
            );
            CREATE TABLE "EmailDraft" (
                id TEXT PRIMARY KEY, "accountId" TEXT, "toAddrs" TEXT,
                "ccAddrs" TEXT, "bccAddrs" TEXT, subject TEXT, body TEXT,
                "threadId" TEXT, "attachmentIds" TEXT, "messageId" TEXT,
                "autoSubmitted" INTEGER, status TEXT, "updatedAt" INTEGER
            );
        ''')
        for index, mode in enumerate(("PASSWORD", "GOOGLE_OAUTH", "M365_GRAPH")):
            account_id = mode.lower()
            self.connection.execute(
                'INSERT INTO "EmailAccount" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (account_id, f"{account_id}@example.test", "imap.example.test", 993,
                 1, account_id, "sealed-password" if mode == "PASSWORD" else None,
                 mode, "smtp.example.test", 465, 1),
            )
            self.connection.execute(
                'INSERT INTO "EmailDraft" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (f"draft-{account_id}", account_id, '["to@example.test"]', None,
                 None, "Subject", "Body", None, "[]", None, 0, "queued", index),
            )
        # A supported transport's completed draft must still be excluded.
        self.connection.execute('''
            INSERT INTO "EmailDraft" VALUES (
                'sent-draft', 'password', '["to@example.test"]', NULL, NULL,
                'Subject', 'Body', NULL, '[]', NULL, 0, 'sent', 4
            )
        ''')

    async def fetch(self, query, *args):
        rows = [dict(row) for row in self.connection.execute(query, args)]
        for row in rows:
            for field in ("toAddrs", "ccAddrs", "bccAddrs", "attachmentIds"):
                if row.get(field) is not None:
                    row[field] = json.loads(row[field])
        return rows


@pytest.fixture
def pool(monkeypatch):
    pool = SqlPool()
    monkeypatch.setattr(db, "_pool", pool)
    yield pool
    pool.connection.close()


@pytest.mark.asyncio
async def test_only_password_and_google_mailboxes_start_imap_workers(pool):
    accounts = await db.list_accounts()
    assert {account.id for account in accounts} == {"password", "google_oauth"}
    assert {account.auth_mode for account in accounts} == {"PASSWORD", "GOOGLE_OAUTH"}
    assert next(a for a in accounts if a.auth_mode == "GOOGLE_OAUTH").password_enc is None


@pytest.mark.asyncio
async def test_read_only_graph_and_completed_drafts_never_reach_smtp(pool):
    drafts = await db.list_queued_drafts()
    assert [draft.id for draft in drafts] == ["draft-password", "draft-google_oauth"]
    assert {draft.auth_mode for draft in drafts} == {"PASSWORD", "GOOGLE_OAUTH"}
