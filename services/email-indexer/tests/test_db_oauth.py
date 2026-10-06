"""WARP-3788 — database reads carry explicit auth mode and nullable password."""
import pytest

import db


@pytest.mark.asyncio
async def test_account_read_preserves_oauth_mode_without_password(monkeypatch):
    class Pool:
        async def fetch(self, query):
            assert '"authMode"' in query
            return [{
                "id": "a1", "address": "me@example.com", "imapHost": "mail-server",
                "imapPort": 993, "imapTls": True, "username": "me@example.com",
                "passwordEnc": None, "authMode": "GOOGLE_OAUTH",
            }]

    monkeypatch.setattr(db, "_pool", Pool())
    [account] = await db.list_accounts()
    assert account.auth_mode == "GOOGLE_OAUTH" and account.password_enc is None


@pytest.mark.asyncio
async def test_draft_read_preserves_oauth_mode_without_password(monkeypatch):
    class Pool:
        async def fetch(self, query):
            assert 'a."authMode"' in query
            return [{
                "id": "d1", "accountId": "a1", "from_addr": "me@example.com",
                "smtpHost": "mail-server", "smtpPort": 465, "smtpTls": True,
                "username": "me@example.com", "passwordEnc": None, "authMode": "GOOGLE_OAUTH",
                "toAddrs": ["you@example.com"], "ccAddrs": None, "bccAddrs": None,
                "subject": "Hello", "body": "Body", "threadId": None, "attachmentIds": [],
                "messageId": None, "autoSubmitted": False,
            }]

    monkeypatch.setattr(db, "_pool", Pool())
    [draft] = await db.list_queued_drafts()
    assert draft.auth_mode == "GOOGLE_OAUTH" and draft.password_enc is None
