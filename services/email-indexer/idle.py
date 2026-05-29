"""WARP-465 D1 follow-up — per-account IMAP IDLE loop.

One async task per EmailAccount, driven by apscheduler's
AsyncIOScheduler — no `while True` per droplet-architecture-guard
rule 9. The task does:

  1. Decrypt the account password (creds.decrypt).
  2. Open an IMAP connection (aioimaplib).
  3. SELECT INBOX, then ENTER IDLE.
  4. On every EXISTS notification: fetch the new UIDs, parse the
     bytes via parser.parse_message, POST to orchestrator's
     /messages-ingest, publish the MQTT signal.
  5. On disconnect / error: BackoffState.on_failure() picks the next
     delay; reschedule the task `delay_seconds` from now.
  6. On a clean success cycle: BackoffState.on_success() resets.

aioimaplib is async — the loop awaits IDLE responses natively;
apscheduler's role is purely to (a) own the run-task primitive and
(b) reschedule on backoff. No timer abuse, no polling loops.

This module exposes `start_account_idle_loop(scheduler, account, deps)`
so the FastAPI lifespan iterates over EmailAccount rows at boot and
starts one task per account. New accounts (added via the dashboard
after boot) are picked up by the periodic refresh in main.py.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional, Protocol

import aioimaplib
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from backoff import BackoffState
from creds import decrypt
from parser import parse_message

logger = logging.getLogger(__name__)


@dataclass
class AccountConfig:
    """Just the fields the IDLE loop needs. The full EmailAccount row
    lives in postgres; this is the cached subset."""

    id: str
    address: str
    imap_host: str
    imap_port: int
    imap_tls: bool
    username: str
    password_enc: str


class IngestFn(Protocol):
    async def __call__(self, account_id: str, payload: dict) -> bool: ...


class MqttPublishFn(Protocol):
    def __call__(self, account_id: str, thread_id: str, message_id: str) -> None: ...


@dataclass
class IdleDeps:
    """Pluggable boundary for tests — injects ingest + mqtt without
    standing up a real orchestrator + broker."""

    ingest: IngestFn
    publish_new_mail: MqttPublishFn


# Track scheduled per-account jobs so we can cancel + reschedule on
# backoff cycles.
_account_jobs: dict[str, str] = {}


async def _fetch_and_ingest(
    imap: aioimaplib.IMAP4_SSL,
    account: AccountConfig,
    deps: IdleDeps,
    uids: list[str],
) -> int:
    """Fetch each UID, parse, POST. Returns the count of successful
    ingests so the caller can log a summary."""
    success = 0
    for uid in uids:
        # `(UID RFC822)` returns the raw bytes; aioimaplib delivers them
        # as a list where index 1 is the literal we want.
        resp = await imap.uid("fetch", uid, "(RFC822)")
        if resp.result != "OK" or len(resp.lines) < 2:
            logger.warning("uid %s fetch failed: %s", uid, resp.result)
            continue
        raw = resp.lines[1]
        if not isinstance(raw, (bytes, bytearray)):
            continue
        # Pass the account's own address so BCC-only deliveries (To:
        # missing) don't fail the orchestrator's `toAddrs.min(1)` schema
        # and get permanently lost.
        parsed = parse_message(bytes(raw), account_address=account.address)
        if parsed is None:
            logger.debug("uid %s parse returned None — skipping", uid)
            continue
        ok = await deps.ingest(account.id, dict(parsed))
        if ok:
            success += 1
            # The orchestrator's ingest response carries threadId but
            # we don't decode it here — MQTT consumers re-query for
            # the row they care about. Pass the messageId so the
            # dashboard can dedupe the refresh.
            deps.publish_new_mail(account.id, "", parsed["messageId"])
    return success


async def run_idle_session(
    account: AccountConfig,
    deps: IdleDeps,
) -> bool:
    """One IDLE session for one account. Returns True on a clean
    session, False on any error (caller advances backoff state)."""
    plaintext = decrypt(account.password_enc)
    if plaintext is None:
        logger.warning("account %s: password decrypt failed; skipping cycle", account.address)
        return False

    imap = (
        aioimaplib.IMAP4_SSL(account.imap_host, account.imap_port)
        if account.imap_tls
        else aioimaplib.IMAP4(account.imap_host, account.imap_port)
    )
    try:
        await imap.wait_hello_from_server()
        login = await imap.login(account.username, plaintext)
        if login.result != "OK":
            logger.warning("account %s: LOGIN failed: %s", account.address, login.result)
            return False
        select = await imap.select("INBOX")
        if select.result != "OK":
            logger.warning("account %s: SELECT failed: %s", account.address, select.result)
            return False

        # One IDLE cycle. aioimaplib's IDLE helper waits up to
        # `idle_timeout` seconds for a server-side notification; we
        # poll once and then refresh state. The outer scheduler
        # re-runs us on the next tick.
        idle_resp = await imap.idle_start(timeout=540.0)
        await imap.wait_server_push(timeout=540.0)
        await imap.idle_done()
        _ = idle_resp  # noqa: F841 — kept for traceability

        # After IDLE returns, SEARCH for unseen UIDs and ingest them.
        search = await imap.uid("search", "UNSEEN")
        if search.result != "OK" or len(search.lines) < 1:
            return True
        uids_line = search.lines[0]
        if isinstance(uids_line, (bytes, bytearray)):
            uids = uids_line.decode("ascii", errors="replace").split()
        else:
            uids = str(uids_line).split()
        if not uids:
            return True
        success = await _fetch_and_ingest(imap, account, deps, uids)
        logger.info(
            "account %s: ingested %d/%d UIDs", account.address, success, len(uids),
        )
        return True
    except Exception as exc:  # noqa: BLE001 — IDLE failures must never crash the service
        logger.warning("account %s: IDLE session failed: %s", account.address, exc)
        return False
    finally:
        try:
            await imap.logout()
        except Exception:  # noqa: BLE001 — logout best-effort
            pass


def start_account_idle_loop(
    scheduler: AsyncIOScheduler,
    account: AccountConfig,
    deps: IdleDeps,
) -> None:
    """Register the IDLE driver as a recurring apscheduler job. The
    driver itself decides via BackoffState when the next tick should
    fire — we reschedule the job after each cycle so apscheduler owns
    the wait."""
    state = BackoffState()
    job_id = f"email-idle-{account.id}"

    async def _tick() -> None:
        ok = await run_idle_session(account, deps)
        if ok:
            state.on_success()
        else:
            state.on_failure()
        # Reschedule the next run. Apscheduler accepts `replace_existing`
        # to re-arm the same job id with new trigger seconds.
        scheduler.reschedule_job(
            job_id,
            trigger="interval",
            seconds=state.delay_seconds,
        )

    scheduler.add_job(
        _tick,
        "interval",
        seconds=1,  # First tick fires ~immediately after boot
        id=job_id,
        max_instances=1,
        coalesce=True,
        replace_existing=True,
    )
    _account_jobs[account.id] = job_id


def stop_account_idle_loop(scheduler: AsyncIOScheduler, account_id: str) -> None:
    """Used when the operator removes an account from the dashboard."""
    job_id = _account_jobs.pop(account_id, None)
    if job_id is not None:
        try:
            scheduler.remove_job(job_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("remove_job %s failed: %s", job_id, exc)


def _reset_state_for_tests() -> None:
    """Test-only — clear the per-process job registry."""
    _account_jobs.clear()


def get_account_job_ids() -> dict[str, str]:
    """Read-only — returns a copy for tests to assert."""
    return dict(_account_jobs)
