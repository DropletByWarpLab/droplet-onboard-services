"""Pure state/decision logic (issuance/state.py) — no DB, no network.

Covers the bits that are easy to get subtly wrong: nonce TTL math,
status-enum transitions, the per-device rate-limit window predicate, and
the renewal-selection predicate (<= RENEW_BEFORE_DAYS).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from issuance import state
from schemas import CertStatus


def _now():
    return datetime(2026, 6, 13, 12, 0, 0, tzinfo=timezone.utc)


# --- nonce expiry ---

def test_nonce_not_expired_within_ttl():
    expires = _now() + timedelta(seconds=10)
    assert state.is_nonce_expired(expires, now=_now()) is False


def test_nonce_expired_after_ttl():
    expires = _now() - timedelta(seconds=1)
    assert state.is_nonce_expired(expires, now=_now()) is True


def test_nonce_expired_exactly_at_boundary_is_expired():
    # At/after expiry counts as expired — fail closed.
    assert state.is_nonce_expired(_now(), now=_now()) is True


# --- status transitions ---

@pytest.mark.parametrize("frm,to", [
    (CertStatus.PENDING, CertStatus.ACTIVE),
    (CertStatus.PENDING, CertStatus.FAILED),
    (CertStatus.ACTIVE, CertStatus.RENEWING),
    (CertStatus.RENEWING, CertStatus.ACTIVE),
    (CertStatus.RENEWING, CertStatus.FAILED),
    (CertStatus.ACTIVE, CertStatus.REVOKED),
    (CertStatus.FAILED, CertStatus.PENDING),  # retry an order
])
def test_allowed_transitions(frm, to):
    assert state.is_valid_transition(frm, to) is True


@pytest.mark.parametrize("frm,to", [
    (CertStatus.REVOKED, CertStatus.ACTIVE),   # revoked is terminal-ish
    (CertStatus.ACTIVE, CertStatus.PENDING),
    (CertStatus.PENDING, CertStatus.RENEWING),
])
def test_disallowed_transitions(frm, to):
    assert state.is_valid_transition(frm, to) is False


def test_revoke_allowed_from_any_live_state():
    for frm in (CertStatus.PENDING, CertStatus.ACTIVE, CertStatus.RENEWING,
                CertStatus.FAILED):
        assert state.is_valid_transition(frm, CertStatus.REVOKED) is True


# --- rate limit window ---

def test_rate_limit_allows_under_threshold():
    # 4 prior attempts in the window, limit 5 -> allowed.
    times = [_now() - timedelta(seconds=s) for s in (1, 5, 10, 30)]
    assert state.within_rate_limit(times, limit=5, window_sec=60, now=_now()) is True


def test_rate_limit_blocks_at_threshold():
    times = [_now() - timedelta(seconds=s) for s in (1, 5, 10, 30, 50)]
    assert state.within_rate_limit(times, limit=5, window_sec=60, now=_now()) is False


def test_rate_limit_ignores_attempts_outside_window():
    # 5 attempts, but 4 are older than the 60s window -> only 1 counts.
    times = [_now() - timedelta(seconds=s) for s in (5, 120, 200, 300, 400)]
    assert state.within_rate_limit(times, limit=5, window_sec=60, now=_now()) is True


# --- renewal selection predicate ---

def test_renewal_selects_within_threshold():
    not_after = _now() + timedelta(days=20)
    assert state.needs_renewal(not_after, renew_before_days=30, now=_now()) is True


def test_renewal_skips_outside_threshold():
    not_after = _now() + timedelta(days=45)
    assert state.needs_renewal(not_after, renew_before_days=30, now=_now()) is False


def test_renewal_selects_already_expired():
    not_after = _now() - timedelta(days=1)
    assert state.needs_renewal(not_after, renew_before_days=30, now=_now()) is True


def test_renewal_handles_none_not_after():
    # A row with no not_after (e.g. never finished issuing) is not renewable
    # by this predicate — it's the order/retry path's problem, not renewal's.
    assert state.needs_renewal(None, renew_before_days=30, now=_now()) is False
