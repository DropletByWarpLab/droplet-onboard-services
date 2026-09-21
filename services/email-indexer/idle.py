"""WARP-465 D1 follow-up — per-account IMAP IDLE loop.

One async task per EmailAccount, driven by apscheduler's
AsyncIOScheduler — no `while True` per droplet-architecture-guard
rule 9. The task does:

  1. Decrypt the account password (creds.decrypt).
  2. Open an IMAP connection (aioimaplib).
  3. SELECT INBOX, then SYNC — search for mail newer than the watermark,
     fetch, parse via parser.parse_message, POST to orchestrator's
     /messages-ingest, publish the MQTT signal.
  4. ENTER IDLE and wait for a server push (or the idle timeout).
  5. SYNC again, so whatever arrived during IDLE lands in the same cycle.
  6. Report the cycle's outcome to the orchestrator (WARP-2957), which is
     the only writer of `EmailAccount.imapStatus / lastIdleAt / lastError`.
  7. On disconnect / error: BackoffState.on_failure() picks the next
     delay; reschedule the task `delay_seconds` from now.
  8. On a clean cycle: BackoffState.on_success() resets.

aioimaplib is async — the loop awaits IDLE responses natively;
apscheduler's role is purely to (a) own the run-task primitive and
(b) reschedule on backoff. No timer abuse, no polling loops.

── WARP-2957: sync BEFORE idle, and a watermark instead of UNSEEN ───────────

The first shape of this loop entered IDLE first and searched `UNSEEN` after
IDLE returned. Two consequences, both reported as "I connected Gmail and
nothing showed up":

  * The first look at a freshly connected mailbox came up to nine minutes
    after the loop started (the IDLE timeout), on top of the five-minute
    account-refresh cron — so a new mailbox was silent for up to a quarter
    of an hour with no signal that anything was happening.
  * `UNSEEN` means "unread". A mailbox the owner reads on their phone has
    nothing unread, ever, so nothing was ever ingested from it.

Now: the first cycle for an account BACKFILLS — `UID SEARCH SINCE <30 days>`,
capped at the newest `INITIAL_BACKFILL_MAX` — and every later cycle asks for
`UID <watermark+1>:*`. The orchestrator's ingest route dedupes on
`(accountId, messageId)` and answers 200 `duplicate: true`, so a restart
(which re-backfills, because the watermark is in-process) costs bandwidth
and nothing else.

── WARP-2957: a quiet mailbox is not a failure ──────────────────────────────

`wait_server_push` raises `asyncio.TimeoutError` when nothing arrives within
the idle timeout. The old blanket `except` turned that into `return False`,
so a mailbox with no new mail for nine minutes logged "IDLE session failed",
advanced the backoff, and was reported as broken. A push timeout is now a
clean cycle.

This module exposes `start_account_idle_loop(scheduler, account, deps)`
so the FastAPI lifespan iterates over EmailAccount rows at boot and
starts one task per account. New accounts (added via the dashboard
after boot) are picked up by the periodic refresh in main.py and by the
orchestrator's explicit `POST /accounts/refresh` right after provisioning.
"""
from __future__ import annotations

import asyncio
import logging
import re
import ssl
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional, Protocol

import aioimaplib
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from backoff import BackoffState
from creds import decrypt
from parser import parse_message

logger = logging.getLogger(__name__)

#: How long one IDLE waits for a server push before the cycle ends and the
#: loop re-syncs. RFC 2177 asks clients to re-issue IDLE at least every 29
#: minutes; nine keeps NAT state alive on the cheap routers this box sits
#: behind.
IDLE_TIMEOUT_SECONDS = 540.0

#: First-contact backfill window and cap. Thirty days is what a person means
#: by "my recent mail"; the cap keeps a busy shared inbox from turning the
#: first cycle into a multi-thousand-message fetch that starves every other
#: account's loop.
INITIAL_BACKFILL_DAYS = 30
INITIAL_BACKFILL_MAX = 200

#: The reasons this loop reports, as a closed set (WARP-2957).
#:
#: 🔴 Closed on purpose, same rule as provision.py: an IMAP server's own text
#: is attacker-influenced and routinely echoes the account name. The
#: orchestrator turns each member into one owner-facing sentence; nothing
#: here ever forwards `resp.lines`.
REASONS = {
    "auth_failed": "auth_failed",
    "unreachable": "unreachable",
    "tls_failed": "tls_failed",
    "timeout": "timeout",
    "decrypt_failed": "decrypt_failed",
    "mailbox_unavailable": "mailbox_unavailable",
    "unknown": "unknown",
}

_UIDNEXT_RE = re.compile(r"\[UIDNEXT (\d+)\]")


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


class ReportStatusFn(Protocol):
    async def __call__(
        self, account_id: str, status: str, reason: Optional[str]
    ) -> bool: ...


@dataclass
class IdleDeps:
    """Pluggable boundary for tests — injects ingest + mqtt without
    standing up a real orchestrator + broker."""

    ingest: IngestFn
    publish_new_mail: MqttPublishFn
    #: WARP-2957 — how a cycle's outcome reaches the `EmailAccount` row.
    #: Optional so an ingest-only test fixture still constructs; production
    #: wiring (main.py) always sets it.
    report_status: Optional[ReportStatusFn] = None


@dataclass
class SyncState:
    """Per-account, in-process sync position.

    `last_uid` is None until the first cycle has looked at the mailbox. It is
    deliberately NOT persisted: a restart re-backfills thirty days, the
    orchestrator dedupes, and there is no column to keep in step with — the
    row's `lastIdleAt` is a health fact, not a cursor.
    """

    last_uid: Optional[int] = None
    #: Bookkeeping for tests and the log line.
    cycles: int = field(default=0)


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
        # One poison message (malformed MIME/headers, a parser edge case, a
        # transient ingest error) must be skipped without aborting the rest of
        # the batch — otherwise a persistently-bad UID at the front of the
        # batch wedges progress every cycle (IDX-07). Each UID is isolated.
        try:
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
        except Exception as exc:  # noqa: BLE001 — isolate one bad UID, keep the batch
            # Connection-level exceptions (IMAP socket drop, timeout) must
            # propagate so run_idle_session's outer handler returns False and
            # backoff.on_failure() fires. Only swallow message-level errors
            # (parse/ingest failures for a single bad UID).
            if isinstance(exc, (asyncio.TimeoutError, ConnectionError, OSError)):
                raise
            logger.warning("uid %s skipped (ingest error): %s", uid, exc)
            continue
    return success


def _uids_from(resp: object) -> list[int]:
    """Decode a `UID SEARCH` response into ints, ascending. Tolerates the
    empty-line and bytes-vs-str shapes aioimaplib produces."""
    lines = getattr(resp, "lines", None) or []
    if not lines:
        return []
    first = lines[0]
    text = (
        first.decode("ascii", errors="replace")
        if isinstance(first, (bytes, bytearray))
        else str(first)
    )
    out: list[int] = []
    for tok in text.split():
        if tok.isdigit():
            out.append(int(tok))
    return sorted(out)


def _uidnext_from(select_resp: object) -> Optional[int]:
    """Pull `[UIDNEXT n]` out of a SELECT response, if the server sent it."""
    lines = getattr(select_resp, "lines", None) or []
    for line in lines:
        text = (
            line.decode("ascii", errors="replace")
            if isinstance(line, (bytes, bytearray))
            else str(line)
        )
        m = _UIDNEXT_RE.search(text)
        if m:
            return int(m.group(1))
    return None


def _imap_date(when: datetime) -> str:
    """RFC 3501 date: `01-Jan-2026`; month abbreviations are locale-free."""
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return f"{when.day:02d}-{months[when.month - 1]}-{when.year}"


async def _sync_new_mail(
    imap: aioimaplib.IMAP4_SSL,
    account: AccountConfig,
    deps: IdleDeps,
    state: SyncState,
    uidnext: Optional[int],
) -> int:
    """Ingest everything newer than the watermark, then advance it.

    First contact (`state.last_uid is None`): a bounded backfill of the last
    `INITIAL_BACKFILL_DAYS`, newest `INITIAL_BACKFILL_MAX` only. Afterwards:
    `UID <last+1>:*`. Note the RFC 3501 quirk — `UID n:*` where n exceeds the
    highest UID still returns that highest UID — so the answer is filtered
    against the watermark rather than trusted.
    """
    if state.last_uid is None:
        since = datetime.now(timezone.utc) - timedelta(days=INITIAL_BACKFILL_DAYS)
        resp = await imap.uid("search", "SINCE", _imap_date(since))
        if resp.result != "OK":
            raise aioimaplib.Abort(f"UID SEARCH failed: {resp.result}")
        found = _uids_from(resp)
        uids = found[-INITIAL_BACKFILL_MAX:]
        # The watermark after a backfill is the newest UID we saw, or — when
        # the window is empty — one below UIDNEXT, so the next cycle does not
        # ask for the whole mailbox. Without UIDNEXT, 0 is the honest floor.
        if found:
            state.last_uid = found[-1]
        elif uidnext is not None and uidnext > 0:
            state.last_uid = uidnext - 1
        else:
            state.last_uid = 0
    else:
        resp = await imap.uid("search", "UID", f"{state.last_uid + 1}:*")
        if resp.result != "OK":
            raise aioimaplib.Abort(f"UID SEARCH failed: {resp.result}")
        uids = [u for u in _uids_from(resp) if u > state.last_uid]
        if uids:
            state.last_uid = uids[-1]

    if not uids:
        return 0
    success = await _fetch_and_ingest(imap, account, deps, [str(u) for u in uids])
    logger.info("account %s: ingested %d/%d UIDs", account.address, success, len(uids))
    return success


def _classify(exc: BaseException) -> str:
    """Map a connection-level failure onto `REASONS`. Never returns text."""
    if isinstance(exc, asyncio.TimeoutError):
        return REASONS["timeout"]
    if isinstance(exc, ssl.SSLError):
        return REASONS["tls_failed"]
    if isinstance(exc, (OSError, aioimaplib.Abort, ConnectionError)):
        return REASONS["unreachable"]
    return REASONS["unknown"]


async def _report(
    deps: IdleDeps, account: AccountConfig, status: str, reason: Optional[str]
) -> None:
    """Best-effort status hop. A failed report is logged and never turns a
    healthy cycle into a failed one — the next cycle reports again."""
    if deps.report_status is None:
        return
    try:
        await deps.report_status(account.id, status, reason)
    except Exception as exc:  # noqa: BLE001 — a lost status report is not a lost cycle
        logger.warning("account %s: status report failed: %s", account.address, exc)


async def run_idle_session(
    account: AccountConfig,
    deps: IdleDeps,
    state: Optional[SyncState] = None,
) -> bool:
    """One sync + IDLE cycle for one account. Returns True on a clean
    cycle, False on any error (caller advances backoff state).

    Reports the outcome through `deps.report_status` either way: `idle` on
    success, `error` with a closed-set reason on failure.
    """
    state = state if state is not None else SyncState()
    plaintext = decrypt(account.password_enc)
    if plaintext is None:
        logger.warning("account %s: password decrypt failed; skipping cycle", account.address)
        await _report(deps, account, "error", REASONS["decrypt_failed"])
        return False

    imap = (
        aioimaplib.IMAP4_SSL(account.imap_host, account.imap_port)
        if account.imap_tls
        else aioimaplib.IMAP4(account.imap_host, account.imap_port)
    )
    reason: Optional[str] = None
    try:
        await imap.wait_hello_from_server()
        login = await imap.login(account.username, plaintext)
        if login.result != "OK":
            # `login.lines` can echo the username. The result token only.
            logger.warning("account %s: LOGIN failed: %s", account.address, login.result)
            reason = REASONS["auth_failed"]
            return False
        select = await imap.select("INBOX")
        if select.result != "OK":
            logger.warning("account %s: SELECT failed: %s", account.address, select.result)
            reason = REASONS["mailbox_unavailable"]
            return False
        uidnext = _uidnext_from(select)

        # 1. Sync FIRST. A freshly connected mailbox shows its recent mail on
        #    the first cycle, not after the first IDLE timeout.
        await _sync_new_mail(imap, account, deps, state, uidnext)
        state.cycles += 1

        # 2. One IDLE cycle. aioimaplib's IDLE helper waits up to
        #    `idle_timeout` seconds for a server-side notification; we
        #    poll once and then refresh state. The outer scheduler
        #    re-runs us on the next tick. The library's own timer (set by
        #    idle_start) ends the wait with a STOP sentinel a few seconds
        #    before our wait_for would; both shapes are "no push", not
        #    "failure".
        await imap.idle_start(timeout=IDLE_TIMEOUT_SECONDS)
        try:
            await imap.wait_server_push(timeout=IDLE_TIMEOUT_SECONDS + 5.0)
        except asyncio.TimeoutError:
            pass  # a quiet mailbox — WARP-2957
        finally:
            if imap.has_pending_idle():
                imap.idle_done()

        # 3. Sync again: whatever the push announced (or arrived just before
        #    the timeout) lands in this cycle rather than the next.
        await _sync_new_mail(imap, account, deps, state, uidnext)
        return True
    except Exception as exc:  # noqa: BLE001 — IDLE failures must never crash the service
        # The exception TYPE and our classification only — an IMAP error's
        # text can carry the server greeting, which names the host, or a
        # LOGIN reply, which names the account.
        reason = _classify(exc)
        logger.warning(
            "account %s: IDLE session failed (%s: %s)",
            account.address, reason, type(exc).__name__,
        )
        return False
    finally:
        try:
            await imap.logout()
        except Exception:  # noqa: BLE001 — logout best-effort
            pass
        # Reported AFTER logout so the socket is closed before the HTTP hop —
        # and in `finally`, so the early `return False` branches report too.
        await _report(deps, account, "error" if reason else "idle", reason)


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
    sync = SyncState()
    job_id = f"email-idle-{account.id}"

    # IDX-001: if this account already has a live job, do NOT re-register.
    # add_job(replace_existing=True) below would discard the live BackoffState
    # and re-ramp exponential backoff from scratch — the 5-min refresh cron
    # calls this for EVERY account, so a persistently-failing account re-ramps
    # 1→2→…→60s every 5 min, ~doubling the failed-IMAP-login rate (provider
    # lockout risk). The refresh should only start genuinely-new accounts.
    if account.id in _account_jobs and scheduler.get_job(job_id) is not None:
        return

    async def _tick() -> None:
        ok = await run_idle_session(account, deps, sync)
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
