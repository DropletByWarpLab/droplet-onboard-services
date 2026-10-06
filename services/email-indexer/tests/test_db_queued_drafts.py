"""WARP-3529 — the sender gets the desk's Message-ID and auto-submitted flag.

`db.list_queued_drafts` is the one place a queued `EmailDraft` becomes the
`DraftToSend` the SMTP transaction is built from. The two columns the service
desk added (`messageId`, `autoSubmitted`) have to survive that hop, or the
Message-ID the orchestrator stored is never the one that is sent.

`db` imports asyncpg and (through `idle`) aioimaplib at module level. Both are in
requirements.txt and present in CI; where they are not installed the fixture
puts empty stand-ins in `sys.modules` for the length of one test, because
nothing here opens a connection — the pool is a fake.
"""
from __future__ import annotations

import importlib
import sys
import types

import pytest


@pytest.fixture
def db_module(monkeypatch):
    for name in ("aioimaplib", "asyncpg"):
        try:
            importlib.import_module(name)
        except ImportError:
            monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    for name in ("db", "idle"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    module = importlib.import_module("db")
    yield module
    # Drop what was imported against the stand-ins, so no other test sees it.
    sys.modules.pop("db", None)
    sys.modules.pop("idle", None)


class _Pool:
    def __init__(self, drafts, thread_rows=()):
        self.drafts = drafts
        self.thread_rows = list(thread_rows)
        self.sql: list[str] = []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        if 'FROM "EmailDraft"' in sql:
            return self.drafts
        if 'FROM "EmailMessage"' in sql:
            return self.thread_rows
        return []


def _row(**over):
    base = {
        "id": "d1",
        "accountId": "a1",
        "toAddrs": ["dana@customer.com"],
        "ccAddrs": None,
        "bccAddrs": None,
        "subject": "Re: [SUP-12] Printer",
        "body": "We are on it.",
        "threadId": None,
        "attachmentIds": [],
        "messageId": None,
        "autoSubmitted": False,
        "from_addr": "support@acme.example",
        "smtpHost": "smtp.acme.example",
        "smtpPort": 465,
        "smtpTls": True,
        "username": "support@acme.example",
        "passwordEnc": "x",
        "authMode": "PASSWORD",
    }
    base.update(over)
    return base


async def test_the_desks_message_id_and_flag_reach_the_draft(db_module):
    db_module._pool = _Pool(
        [_row(messageId="7f3a9c1e5b2d4f60@acme.example", autoSubmitted=True)]
    )
    [draft] = await db_module.list_queued_drafts()
    assert draft.message_id == "7f3a9c1e5b2d4f60@acme.example"
    assert draft.auto_submitted is True


async def test_a_draft_the_desk_did_not_make_has_neither(db_module):
    db_module._pool = _Pool([_row()])
    [draft] = await db_module.list_queued_drafts()
    assert draft.message_id is None
    assert draft.auto_submitted is False


async def test_the_query_asks_for_both_columns(db_module):
    pool = _Pool([_row()])
    db_module._pool = pool
    await db_module.list_queued_drafts()
    drafts_sql = next(s for s in pool.sql if 'FROM "EmailDraft"' in s)
    assert 'd."messageId"' in drafts_sql
    assert 'd."autoSubmitted"' in drafts_sql


async def test_reply_references_include_the_ticket_messages_the_indexer_did_not_send_itself(db_module):
    pool = _Pool(
        [_row(threadId="th1")],
        [
            {"messageId": "customer@x"},
            {"messageId": "desk-reply@acme.example"},
            {"messageId": "ack@acme.example"},
        ],
    )
    db_module._pool = pool
    [draft] = await db_module.list_queued_drafts()
    assert draft.thread_message_ids == ["customer@x", "desk-reply@acme.example", "ack@acme.example"]
    assert any('FROM "PmTicketEmailLink"' in sql for sql in pool.sql)
