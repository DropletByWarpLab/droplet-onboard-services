"""WARP-1470 — outbound-pump gate for the email module toggle.

Pure logic (no I/O), mirroring backoff.py's BackoffState. The outbound poller
consults this each tick so that, when the orchestrator reports the email module
is DISABLED (a `module_disabled` 404 from reconcile-stale-sending), the indexer
stops hammering the gated route every 10s: it pauses the pump and only re-probes
every `reprobe_after_skips` ticks, auto-resuming when the module is re-enabled.

Logging is transition-only — one line when the pump pauses, one when it resumes —
instead of a warning every tick.
"""
from __future__ import annotations

from dataclasses import dataclass


# 30 skipped ticks * 10s OUTBOUND_POLL_SECONDS ~= 5 min between re-probes while
# the email module stays disabled.
DEFAULT_REPROBE_AFTER_SKIPS = 30


@dataclass
class OutboundGate:
    """Decide whether to run the outbound pump this tick, given the last probe.

    Held once by the poller. `should_probe()` gates the tick; feed the probe
    outcome back via `record(module_disabled=...)`, which returns a one-time log
    message on a state transition (else None).
    """

    reprobe_after_skips: int = DEFAULT_REPROBE_AFTER_SKIPS
    disabled: bool = False
    _skips: int = 0

    def should_probe(self) -> bool:
        """True if the poller should probe the orchestrator this tick. While the
        module is known-disabled, skip ticks until `reprobe_after_skips` have
        elapsed, then allow exactly one re-probe."""
        if not self.disabled:
            return True
        if self._skips >= self.reprobe_after_skips:
            self._skips = 0
            return True
        self._skips += 1
        return False

    def record(self, module_disabled: bool) -> str | None:
        """Record a probe outcome. Returns a one-time transition log message when
        the disabled/enabled state flips, else None."""
        if module_disabled and not self.disabled:
            self.disabled = True
            self._skips = 0
            return "email module disabled on the orchestrator — pausing outbound pump until re-enabled"
        if not module_disabled and self.disabled:
            self.disabled = False
            self._skips = 0
            return "email module re-enabled — resuming outbound pump"
        return None
