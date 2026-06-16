"""IDX-07 — `_fetch_and_ingest` must isolate one poison UID from the batch.

A single message that raises during fetch/parse/ingest must be skipped and
logged without aborting the remaining UIDs in the cycle. Previously the only
exception boundary was the session-level `except`, so a persistently-bad
message at the front of the batch could wedge progress.
"""

from __future__ import annotations

import pytest

import idle
from idle import AccountConfig, IdleDeps, _fetch_and_ingest


class _FakeFetchResp:
    def __init__(self, message_id: str):
        self.result = "OK"
        # index 1 is the RFC822 literal the code reads
        self.lines = [b"(UID x)", f"Message-ID: {message_id}".encode()]


class _FakeImap:
    async def uid(self, _cmd, uid, _what):
        return _FakeFetchResp(f"<{uid}@x.com>")


def _account():
    return AccountConfig(
        id="acct-1",
        address="me@example.com",
        imap_host="h",
        imap_port=993,
        imap_tls=True,
        username="u",
        password_enc="enc",
    )


@pytest.mark.asyncio
async def test_one_poison_uid_does_not_abort_batch(monkeypatch):
    # UID "2" blows up in parse_message; "1" and "3" parse fine.
    def fake_parse(raw, account_address=None):
        if b"<2@x.com>" in raw:
            raise ValueError("malformed Date header")
        mid = raw.split(b"Message-ID: ")[1].decode().strip().strip("<>")
        return {
            "messageId": mid, "inReplyTo": None, "fromAddr": "a@b.com",
            "fromName": None, "toAddrs": ["me@example.com"], "ccAddrs": None,
            "subject": "s", "bodyText": "b", "bodyHtml": None,
            "receivedAt": "2026-05-27T10:00:00+00:00", "threadKey": mid,
        }

    monkeypatch.setattr(idle, "parse_message", fake_parse)

    ingested: list[str] = []

    async def ingest(_account_id, payload):
        ingested.append(payload["messageId"])
        return True

    published: list[str] = []
    deps = IdleDeps(
        ingest=ingest,
        publish_new_mail=lambda a, t, m: published.append(m),
    )

    success = await _fetch_and_ingest(_FakeImap(), _account(), deps, ["1", "2", "3"])

    # The poison UID 2 is skipped; 1 and 3 still ingest.
    assert success == 2
    assert ingested == ["1@x.com", "3@x.com"]
    assert published == ["1@x.com", "3@x.com"]


@pytest.mark.asyncio
async def test_ingest_error_on_one_uid_is_isolated(monkeypatch):
    def fake_parse(raw, account_address=None):
        mid = raw.split(b"Message-ID: ")[1].decode().strip().strip("<>")
        return {
            "messageId": mid, "inReplyTo": None, "fromAddr": "a@b.com",
            "fromName": None, "toAddrs": ["me@example.com"], "ccAddrs": None,
            "subject": "s", "bodyText": "b", "bodyHtml": None,
            "receivedAt": "2026-05-27T10:00:00+00:00", "threadKey": mid,
        }

    monkeypatch.setattr(idle, "parse_message", fake_parse)

    async def ingest(_account_id, payload):
        if payload["messageId"] == "2@x.com":
            raise RuntimeError("transient orchestrator 500")
        return True

    deps = IdleDeps(ingest=ingest, publish_new_mail=lambda a, t, m: None)
    success = await _fetch_and_ingest(_FakeImap(), _account(), deps, ["1", "2", "3"])
    assert success == 2
