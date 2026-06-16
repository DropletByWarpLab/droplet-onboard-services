"""Renewal job (ADR-023 §Consequences — renewal must run reliably).

An apscheduler daily job (NO `while True`) scans active rows whose
not_after is within RENEW_BEFORE_DAYS and re-orders each. Unattended
renewal reuses the box's STORED CSR (the box keeps the same serving
keypair across renewals — ADR-023 §Decision 5: the LE cert overwrites the
same files, same key), so no box interaction is needed for a routine
renew.

This module owns the SELECTION + the renewing->active|failed transition.
The actual re-order delegates to a ``renew_one`` callback (production
wires it to run_order_flow against the stored CSR) so the cycle is
unit-testable without ACME.
"""

from __future__ import annotations

import datetime
import logging
from typing import Any, Awaitable, Callable, Optional

from issuance import state

logger = logging.getLogger(__name__)


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


async def select_renewable(
    repo: Any,
    *,
    renew_before_days: int,
    now: Optional[datetime.datetime] = None,
) -> list:
    """Return active certs within (or past) the renewal window."""
    now = now or _utcnow()
    before = now + datetime.timedelta(days=renew_before_days)
    return await repo.list_renewable(before=before)


async def run_renewal_cycle(
    repo: Any,
    *,
    renew_before_days: int,
    renew_one: Callable[..., Awaitable[None]],
    now: Optional[datetime.datetime] = None,
) -> int:
    """Renew every due cert. Returns the count attempted. A failure on one
    row is logged and swallowed so it never aborts the rest of the cycle."""
    due = await select_renewable(repo, renew_before_days=renew_before_days, now=now)
    attempted = 0
    for cert in due:
        attempted += 1
        try:
            await renew_one(repo=repo, device_id=cert.device_id)
        except Exception as exc:  # noqa: BLE001 — one bad row must not stop the cycle
            logger.error("renewal: %s failed: %s", cert.device_id, exc)
    logger.info("renewal cycle complete: %d cert(s) attempted", attempted)
    return attempted


def assert_renewing_allowed(cert) -> bool:
    """Guard: only an active cert may move to renewing."""
    return state.is_valid_transition(cert.status, cert.status.RENEWING)
