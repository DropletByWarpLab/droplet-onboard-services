"""WARP-2957 — `_refresh_accounts` stops the loop of a disconnected mailbox,
and `POST /accounts/refresh` runs it on demand behind the service token.

Before this, `stop_account_idle_loop` was written "for when the operator
removes an account" and nothing called it: a disconnected mailbox kept
logging in on schedule, with a credential the owner believed was gone, until
the next restart of the service.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import idle
import main
from idle import AccountConfig


class _FakeScheduler:
    def __init__(self):
        self.jobs: dict[str, object] = {}

    def add_job(self, func, _trigger, *, id, **_kw):
        self.jobs[id] = func

    def get_job(self, job_id):
        return self.jobs.get(job_id)

    def remove_job(self, job_id):
        del self.jobs[job_id]

    def reschedule_job(self, *_a, **_k):
        pass


def _acct(aid: str) -> AccountConfig:
    return AccountConfig(
        id=aid, address=f"{aid}@example.com", imap_host="h", imap_port=993,
        imap_tls=True, username="u", password_enc="enc",
    )


@pytest.fixture(autouse=True)
def _clean_registry():
    idle._reset_state_for_tests()
    yield
    idle._reset_state_for_tests()


@pytest.mark.asyncio
async def test_refresh_starts_new_accounts_and_stops_disconnected_ones(monkeypatch):
    sched = _FakeScheduler()
    monkeypatch.setattr(main, "_scheduler", sched)

    rows = [_acct("a"), _acct("b")]

    async def list_accounts():
        return rows

    monkeypatch.setattr(main.db, "list_accounts", list_accounts)

    assert await main._refresh_accounts() == 2
    assert set(idle.get_account_job_ids()) == {"a", "b"}
    assert set(sched.jobs) == {"email-idle-a", "email-idle-b"}

    # The operator disconnects "a": its job must be gone on the next refresh,
    # and "b" must NOT be re-registered (IDX-001 — same job object survives).
    b_job_before = sched.jobs["email-idle-b"]
    rows.pop(0)
    assert await main._refresh_accounts() == 1
    assert set(idle.get_account_job_ids()) == {"b"}
    assert set(sched.jobs) == {"email-idle-b"}
    assert sched.jobs["email-idle-b"] is b_job_before


@pytest.mark.asyncio
async def test_refresh_is_a_noop_before_the_scheduler_exists(monkeypatch):
    monkeypatch.setattr(main, "_scheduler", None)
    assert await main._refresh_accounts() == 0


def test_refresh_route_requires_the_service_token(monkeypatch):
    monkeypatch.setattr(main, "SERVICE_TOKEN_EMAIL", "tok")
    calls: list[int] = []

    async def fake_refresh():
        calls.append(1)
        return 3

    monkeypatch.setattr(main, "_refresh_accounts", fake_refresh)
    # No `with`: the lifespan (Fernet key, MQTT, asyncpg) must not run here —
    # the fake refresh stands in for the scheduler.
    client = TestClient(main.app, raise_server_exceptions=True)
    denied = client.post("/accounts/refresh")
    assert denied.status_code == 401
    assert calls == []

    ok = client.post("/accounts/refresh", headers={"Authorization": "Bearer tok"})
    assert ok.status_code == 200
    assert ok.json() == {"active": 3}
    assert calls == [1]
