"""Pure state/decision logic for issuance — no DB, no network.

Extracted so the easy-to-get-wrong bits (nonce TTL math, status-enum
transitions, rate-limit windowing, renewal selection) are unit-testable
without a live Postgres. The repository layer calls these; routes call
the repository.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from schemas import CertStatus


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --- nonce expiry -----------------------------------------------------------

def is_nonce_expired(expires_at: datetime, *, now: Optional[datetime] = None) -> bool:
    """True if the nonce is at/after its expiry. Boundary counts as
    expired — fail closed."""
    now = now or _utcnow()
    return now >= expires_at


# --- status transitions -----------------------------------------------------

# Allowed transitions. REVOKED is reachable from any live state
# (deregistration), and is otherwise terminal. FAILED -> PENDING permits a
# retry of a failed order.
_ALLOWED: dict[CertStatus, set[CertStatus]] = {
    CertStatus.PENDING: {CertStatus.ACTIVE, CertStatus.FAILED, CertStatus.REVOKED},
    CertStatus.ACTIVE: {CertStatus.RENEWING, CertStatus.REVOKED},
    CertStatus.RENEWING: {CertStatus.ACTIVE, CertStatus.FAILED, CertStatus.REVOKED},
    CertStatus.FAILED: {CertStatus.PENDING, CertStatus.REVOKED},
    CertStatus.REVOKED: set(),  # terminal
}


def is_valid_transition(frm: CertStatus, to: CertStatus) -> bool:
    """True if ``frm -> to`` is a legal certificate-status transition."""
    return to in _ALLOWED.get(frm, set())


# --- per-device rate limit --------------------------------------------------

def within_rate_limit(
    recent_attempt_times: Iterable[datetime],
    *,
    limit: int,
    window_sec: int,
    now: Optional[datetime] = None,
) -> bool:
    """True if a NEW attempt is allowed: fewer than ``limit`` attempts in
    the trailing ``window_sec`` window. Attempts older than the window are
    ignored."""
    now = now or _utcnow()
    cutoff = now - timedelta(seconds=window_sec)
    in_window = sum(1 for t in recent_attempt_times if t > cutoff)
    return in_window < limit


# --- renewal selection ------------------------------------------------------

def needs_renewal(
    not_after: Optional[datetime],
    *,
    renew_before_days: int,
    now: Optional[datetime] = None,
) -> bool:
    """True if a cert expiring at ``not_after`` is within (or past) the
    renewal window. A row with no ``not_after`` is NOT renewable here —
    that's the order/retry path's concern, not the renewal job's."""
    if not_after is None:
        return False
    now = now or _utcnow()
    return not_after <= now + timedelta(days=renew_before_days)
