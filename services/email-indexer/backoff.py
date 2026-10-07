"""WARP-465 D1 follow-up — exponential backoff state machine.

Pure logic — no I/O, no IMAP. The IDLE loop calls into this on each
disconnect / reconnect event; the resulting delay drives the next
apscheduler tick. Capped at 60s per the ticket so reconnect storms
don't take minutes to recover.
"""
from __future__ import annotations

from dataclasses import dataclass


INITIAL_DELAY_SECONDS = 1.0
MAX_DELAY_SECONDS = 60.0
GROWTH_FACTOR = 2.0
# Exponent is clamped so a backend that stays down for days can never
# push `GROWTH_FACTOR ** n` past float range (OverflowError at n~1024).
# Once the delay has saturated at MAX the exact exponent is irrelevant.
_MAX_EXPONENT = 64


@dataclass
class BackoffState:
    """Track consecutive failures and current delay.

    The IDLE loop holds one of these per account. `on_success` resets;
    `on_failure` doubles the delay (capped). Inspect `delay_seconds`
    to schedule the next attempt.
    """

    consecutive_failures: int = 0
    delay_seconds: float = INITIAL_DELAY_SECONDS

    def on_success(self) -> None:
        self.consecutive_failures = 0
        self.delay_seconds = INITIAL_DELAY_SECONDS

    def on_failure(self) -> float:
        self.consecutive_failures += 1
        # Geometric growth from INITIAL up to MAX. Computed fresh each time
        # so a hand-edited delay (tests, debugging) doesn't stick. The
        # exponent is clamped (see _MAX_EXPONENT); `consecutive_failures`
        # itself keeps counting as a diagnostics counter.
        exponent = min(self.consecutive_failures - 1, _MAX_EXPONENT)
        target = INITIAL_DELAY_SECONDS * (GROWTH_FACTOR ** exponent)
        self.delay_seconds = min(MAX_DELAY_SECONDS, target)
        return self.delay_seconds
