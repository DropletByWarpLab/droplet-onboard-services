"""WARP-1510 — exponential backoff state machine for the OpenWrt reconnect.

Pure logic — no I/O. Mirrors services/email-indexer/backoff.py's shape
(same problem: don't hammer a backend that stays down). `reconnect.py`'s
background retry calls `on_failure()` to compute the next apscheduler
reschedule interval, capped so a router that's down for hours never gets
polled more often than once every MAX_DELAY_SECONDS.
"""
from __future__ import annotations

from dataclasses import dataclass


INITIAL_DELAY_SECONDS = 1.0
MAX_DELAY_SECONDS = 60.0
GROWTH_FACTOR = 2.0


@dataclass
class BackoffState:
    """Track consecutive failures and the current retry delay.

    `on_success` resets; `on_failure` doubles the delay (capped). Inspect
    `delay_seconds` to schedule the next attempt.
    """

    consecutive_failures: int = 0
    delay_seconds: float = INITIAL_DELAY_SECONDS

    def on_success(self) -> None:
        self.consecutive_failures = 0
        self.delay_seconds = INITIAL_DELAY_SECONDS

    def on_failure(self) -> float:
        self.consecutive_failures += 1
        # Geometric growth from INITIAL up to MAX. Computed fresh each time
        # so a hand-edited delay (tests, debugging) doesn't stick.
        target = INITIAL_DELAY_SECONDS * (
            GROWTH_FACTOR ** (self.consecutive_failures - 1)
        )
        self.delay_seconds = min(MAX_DELAY_SECONDS, target)
        return self.delay_seconds
