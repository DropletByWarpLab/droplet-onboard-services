"""WARP-2957 — the IDLE cycle syncs first, walks a watermark, treats a quiet
mailbox as healthy, and reports every outcome home.

The original shape entered IDLE first, searched `UNSEEN` afterwards, and
reported nothing — so a freshly connected Gmail mailbox that the owner reads
on their phone showed nothing for a quarter of an hour and then nothing ever,
while the dashboard said "Connected" from the schema default. Every test here
is one of those claims, made against a fake IMAP server that records the
order of what the loop asked it.
"""

from __future__ import annotations

import asyncio
from typing import Optional

import pytest

import idle
from idle import AccountConfig, IdleDeps, SyncState, run_idle_session


class _Resp:
    def __init__(self, result: str = "OK", lines: Optional[list] = None):
        self.result = result
        self.lines = lines if lines is not None else []


class _FakeImap:
    """Enough of aioimaplib's IMAP4_SSL for one cycle.

    `search_answers` is consulted per `UID SEARCH` call in order; each entry
    is the space-separated UID line the server returns. `push` decides what
    `wait_server_push` does: a value returns it, `TimeoutError` raises.
    """

    def __init__(
        self,
        *,
        login_result: str = "OK",
        select_lines: Optional[list] = None,
        search_answers: Optional[list[str]] = None,
        push: object = TimeoutError,
        hello_raises: Optional[BaseException] = None,
    ):
        self.calls: list[tuple] = []
        self.login_result = login_result
        self.select_lines = select_lines if select_lines is not None else [b"OK [UIDNEXT 501] Predicted next UID"]
        self.search_answers = list(search_answers or [])
        self.push = push
        self.hello_raises = hello_raises
        self._idle_pending = False

    async def wait_hello_from_server(self):
        self.calls.append(("hello",))
        if self.hello_raises is not None:
            raise self.hello_raises

    async def login(self, user, password):
        self.calls.append(("login", user))
        return _Resp(self.login_result, [b"[AUTHENTICATIONFAILED] Invalid credentials for " + user.encode()])

    async def select(self, mailbox="INBOX"):
        self.calls.append(("select", mailbox))
        return _Resp("OK", self.select_lines)

    async def uid(self, command, *criteria):
        self.calls.append(("uid", command, *criteria))
        if command == "search":
            line = self.search_answers.pop(0) if self.search_answers else ""
            return _Resp("OK", [line.encode()])
        if command == "fetch":
            uid = criteria[0]
            return _Resp("OK", [b"(UID x)", f"Message-ID: <{uid}@x.com>".encode()])
        raise AssertionError(command)

    async def idle_start(self, timeout=None):
        self.calls.append(("idle_start", timeout))
        self._idle_pending = True
        return asyncio.Future()

    async def wait_server_push(self, timeout=None):
        self.calls.append(("wait_server_push", timeout))
        if self.push is TimeoutError:
            raise asyncio.TimeoutError()
        return self.push

    def has_pending_idle(self):
        return self._idle_pending

    def idle_done(self):
        self.calls.append(("idle_done",))
        self._idle_pending = False

    async def logout(self):
        self.calls.append(("logout",))
        return _Resp("OK")


def _account() -> AccountConfig:
    return AccountConfig(
        id="acct-1",
        address="me@example.com",
        imap_host="h",
        imap_port=993,
        imap_tls=True,
        username="me@example.com",
        password_enc="enc",
    )


@pytest.fixture
def harness(monkeypatch):
    """Wire a fake IMAP client, a passing decrypt, a recording parser, and
    recording deps. Returns (make, ingested, reports)."""
    monkeypatch.setattr(idle, "decrypt", lambda _enc: "plaintext")

    def fake_parse(raw, account_address=None):
        mid = raw.split(b"Message-ID: ")[1].decode().strip().strip("<>")
        return {
            "messageId": mid, "inReplyTo": None, "fromAddr": "a@b.com",
            "fromName": None, "toAddrs": [account_address], "ccAddrs": None,
            "subject": "s", "bodyText": "b", "bodyHtml": None,
            "receivedAt": "2026-09-19T10:00:00+00:00", "threadKey": mid,
        }

    monkeypatch.setattr(idle, "parse_message", fake_parse)

    ingested: list[str] = []
    reports: list[tuple[str, str, Optional[str]]] = []

    async def ingest(_account_id, payload):
        ingested.append(payload["messageId"])
        return True

    async def report(account_id, status, reason):
        reports.append((account_id, status, reason))
        return True

    deps = IdleDeps(ingest=ingest, publish_new_mail=lambda a, t, m: None, report_status=report)

    def make(**kw) -> _FakeImap:
        fake = _FakeImap(**kw)
        monkeypatch.setattr(idle.aioimaplib, "IMAP4_SSL", lambda *_a, **_k: fake)
        monkeypatch.setattr(idle.aioimaplib, "IMAP4", lambda *_a, **_k: fake)
        return fake

    return make, deps, ingested, reports


# ── sync BEFORE idle, backfill on first contact ─────────────────────────────

@pytest.mark.asyncio
async def test_first_cycle_backfills_with_SINCE_before_entering_idle(harness):
    make, deps, ingested, reports = harness
    imap = make(search_answers=["401 402 403", ""])
    state = SyncState()

    ok = await run_idle_session(_account(), deps, state)

    assert ok is True
    names = [c[0] for c in imap.calls]
    # The FIRST search happens before idle_start — the whole point.
    assert names.index("uid") < names.index("idle_start")
    first_search = next(c for c in imap.calls if c[0] == "uid" and c[1] == "search")
    assert first_search[2] == "SINCE"
    assert "UNSEEN" not in str(imap.calls)
    assert ingested == ["401@x.com", "402@x.com", "403@x.com"]
    assert state.last_uid == 403
    assert reports == [("acct-1", "idle", None)]


@pytest.mark.asyncio
async def test_later_cycles_walk_the_uid_watermark_and_ignore_the_star_quirk(harness):
    make, deps, ingested, reports = harness
    # RFC 3501: `UID 404:*` on a mailbox whose highest UID is 403 answers
    # "403". The loop must not re-ingest it.
    imap = make(search_answers=["403", "403 404 405"])
    state = SyncState(last_uid=403)

    ok = await run_idle_session(_account(), deps, state)

    assert ok is True
    searches = [c for c in imap.calls if c[0] == "uid" and c[1] == "search"]
    assert searches[0][2:] == ("UID", "404:*")
    # Pre-idle sync: only the quirk echo → nothing ingested. Post-idle sync:
    # 404 and 405 are new.
    assert ingested == ["404@x.com", "405@x.com"]
    assert state.last_uid == 405
    assert searches[1][2:] == ("UID", "404:*")


@pytest.mark.asyncio
async def test_empty_backfill_pins_the_watermark_below_uidnext(harness):
    make, deps, ingested, reports = harness
    make(select_lines=[b"OK [UIDNEXT 900] Predicted next UID"], search_answers=["", ""])
    state = SyncState()

    await run_idle_session(_account(), deps, state)

    # Nothing in the window, so the next cycle must ask from UIDNEXT — not
    # from 1, which would pull the whole mailbox.
    assert state.last_uid == 899
    assert ingested == []


@pytest.mark.asyncio
async def test_backfill_is_capped_to_the_newest_messages(harness, monkeypatch):
    make, deps, ingested, reports = harness
    monkeypatch.setattr(idle, "INITIAL_BACKFILL_MAX", 3)
    make(search_answers=[" ".join(str(u) for u in range(1, 11)), ""])
    state = SyncState()

    await run_idle_session(_account(), deps, state)

    assert ingested == ["8@x.com", "9@x.com", "10@x.com"]
    assert state.last_uid == 10


# ── a quiet mailbox is not a failure ────────────────────────────────────────

@pytest.mark.asyncio
async def test_idle_timeout_is_a_clean_cycle_not_a_failure(harness):
    make, deps, ingested, reports = harness
    imap = make(search_answers=["", ""], push=TimeoutError)

    ok = await run_idle_session(_account(), deps, SyncState(last_uid=5))

    assert ok is True
    assert ("idle_done",) in imap.calls
    assert imap.calls[-1] == ("logout",)
    assert reports == [("acct-1", "idle", None)]


@pytest.mark.asyncio
async def test_a_server_push_leads_to_a_second_sync_in_the_same_cycle(harness):
    make, deps, ingested, reports = harness
    imap = make(search_answers=["", "7"], push=[b"1 EXISTS"])

    ok = await run_idle_session(_account(), deps, SyncState(last_uid=6))

    assert ok is True
    searches = [c for c in imap.calls if c[0] == "uid" and c[1] == "search"]
    assert len(searches) == 2
    assert ingested == ["7@x.com"]


# ── every outcome is reported, as a closed-set reason ───────────────────────

@pytest.mark.asyncio
async def test_login_failure_reports_auth_failed_without_the_server_line(harness, caplog):
    make, deps, ingested, reports = harness
    imap = make(login_result="NO")

    ok = await run_idle_session(_account(), deps, SyncState())

    assert ok is False
    assert reports == [("acct-1", "error", idle.REASONS["auth_failed"])]
    assert ("logout",) in imap.calls
    # The server's rejection line (which names the account) reaches nothing.
    assert "AUTHENTICATIONFAILED" not in caplog.text
    assert "Invalid credentials" not in caplog.text


@pytest.mark.asyncio
async def test_connection_failure_reports_unreachable(harness):
    make, deps, ingested, reports = harness
    make(hello_raises=OSError("connection refused"))

    ok = await run_idle_session(_account(), deps, SyncState())

    assert ok is False
    assert reports == [("acct-1", "error", idle.REASONS["unreachable"])]


@pytest.mark.asyncio
async def test_decrypt_failure_reports_decrypt_failed(harness, monkeypatch):
    make, deps, ingested, reports = harness
    make()
    monkeypatch.setattr(idle, "decrypt", lambda _enc: None)

    ok = await run_idle_session(_account(), deps, SyncState())

    assert ok is False
    assert reports == [("acct-1", "error", idle.REASONS["decrypt_failed"])]


@pytest.mark.asyncio
async def test_a_failed_status_report_does_not_fail_a_healthy_cycle(harness):
    make, deps, ingested, reports = harness
    make(search_answers=["", ""])

    async def broken_report(_a, _s, _r):
        raise RuntimeError("orchestrator down")

    deps.report_status = broken_report
    ok = await run_idle_session(_account(), deps, SyncState(last_uid=1))

    assert ok is True


@pytest.mark.asyncio
async def test_cycle_still_works_with_no_report_hop_wired(harness):
    make, deps, ingested, reports = harness
    make(search_answers=["", ""])
    deps.report_status = None

    ok = await run_idle_session(_account(), deps, SyncState(last_uid=1))

    assert ok is True


@pytest.mark.parametrize("reason", sorted(idle.REASONS))
def test_every_reason_is_a_closed_set_member(reason):
    # The orchestrator's zod enum for PATCH /api/email/accounts/:id/status
    # mirrors this set. Add a member there before adding one here.
    assert idle.REASONS[reason] == reason


def test_uid_search_response_shapes_are_tolerated():
    assert idle._uids_from(_Resp("OK", [b"3 1 2"])) == [1, 2, 3]
    assert idle._uids_from(_Resp("OK", ["7"])) == [7]
    assert idle._uids_from(_Resp("OK", [b""])) == []
    assert idle._uids_from(_Resp("OK", [])) == []
    assert idle._uidnext_from(_Resp("OK", [b"FLAGS ()", b"OK [UIDNEXT 42] next"])) == 42
    assert idle._uidnext_from(_Resp("OK", [b"FLAGS ()"])) is None


def test_imap_date_is_rfc3501_and_locale_free():
    from datetime import datetime, timezone

    assert idle._imap_date(datetime(2026, 8, 5, tzinfo=timezone.utc)) == "05-Aug-2026"
