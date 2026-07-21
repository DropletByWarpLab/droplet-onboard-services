"""WARP-1470 — OutboundGate state machine (pure logic)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # email-indexer root

from outbound_gate import OutboundGate


def test_runs_every_tick_when_enabled():
    g = OutboundGate(reprobe_after_skips=3)
    assert all(g.should_probe() for _ in range(10))


def test_pause_transition_logs_once_then_skips():
    g = OutboundGate(reprobe_after_skips=3)
    msg = g.record(module_disabled=True)
    assert msg is not None and "pausing" in msg
    assert g.record(module_disabled=True) is None  # no repeat log
    assert g.should_probe() is False  # skip 1
    assert g.should_probe() is False  # skip 2
    assert g.should_probe() is False  # skip 3
    assert g.should_probe() is True   # re-probe


def test_reprobe_interval_length():
    g = OutboundGate(reprobe_after_skips=30)
    g.record(module_disabled=True)
    skips = 0
    while not g.should_probe():
        skips += 1
    assert skips == 30


def test_resume_transition_logs_once_then_runs_every_tick():
    g = OutboundGate(reprobe_after_skips=3)
    g.record(module_disabled=True)
    msg = g.record(module_disabled=False)
    assert msg is not None and "resuming" in msg
    assert g.record(module_disabled=False) is None
    assert all(g.should_probe() for _ in range(5))


def test_still_disabled_on_reprobe_stays_quiet():
    g = OutboundGate(reprobe_after_skips=2)
    g.record(module_disabled=True)
    while not g.should_probe():
        pass
    assert g.record(module_disabled=True) is None  # still disabled → no new log
    assert g.should_probe() is False               # keeps skipping
