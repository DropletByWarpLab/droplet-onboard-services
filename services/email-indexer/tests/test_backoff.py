"""WARP-465 D1 follow-up — BackoffState semantics."""
from __future__ import annotations

import pytest

from backoff import BackoffState, INITIAL_DELAY_SECONDS, MAX_DELAY_SECONDS


def test_initial_state_is_initial_delay():
    s = BackoffState()
    assert s.consecutive_failures == 0
    assert s.delay_seconds == INITIAL_DELAY_SECONDS


def test_first_failure_returns_initial_delay():
    s = BackoffState()
    assert s.on_failure() == INITIAL_DELAY_SECONDS
    assert s.consecutive_failures == 1


def test_geometric_growth_until_cap():
    s = BackoffState()
    # 1, 2, 4, 8, 16, 32, 60 (capped from 64)
    expected = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, MAX_DELAY_SECONDS]
    for want in expected:
        assert s.on_failure() == want


def test_cap_holds_for_subsequent_failures():
    s = BackoffState()
    for _ in range(20):
        s.on_failure()
    assert s.delay_seconds == MAX_DELAY_SECONDS


def test_success_resets():
    s = BackoffState()
    s.on_failure()
    s.on_failure()
    s.on_failure()
    assert s.delay_seconds > INITIAL_DELAY_SECONDS
    s.on_success()
    assert s.consecutive_failures == 0
    assert s.delay_seconds == INITIAL_DELAY_SECONDS
