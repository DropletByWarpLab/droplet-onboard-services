"""IDX-08 — RunStateStore history must be bounded.

The hourly cron would otherwise add a RunRecord forever (~8,760/year) despite
the "bounded history" docstring. These tests pin the cap + eviction order and
that the in-flight run is never evicted.
"""

from __future__ import annotations

import run_state
from run_state import RunStateStore, RunStatus


def _begin_and_finish(store: RunStateStore, run_id: str) -> None:
    ok, _ = store.try_begin(run_id, kind="run")
    assert ok
    store.finish(run_id, RunStatus.SUCCEEDED)


def test_records_capped_at_max(monkeypatch):
    monkeypatch.setattr(run_state, "_MAX_RECORDS", 10)
    store = RunStateStore()
    for i in range(25):
        _begin_and_finish(store, f"run-{i:03d}")
    # never exceeds the cap
    assert len(store._records) <= 10


def test_eviction_drops_oldest_keeps_newest(monkeypatch):
    monkeypatch.setattr(run_state, "_MAX_RECORDS", 5)
    store = RunStateStore()
    for i in range(8):
        _begin_and_finish(store, f"run-{i}")
    # oldest evicted, newest retained
    assert store.get("run-0") is None
    assert store.get("run-7") is not None
    assert len(store._records) == 5


def test_in_flight_run_is_never_evicted(monkeypatch):
    monkeypatch.setattr(run_state, "_MAX_RECORDS", 3)
    store = RunStateStore()
    # Start a long-running bootstrap and leave it in flight.
    ok, _ = store.try_begin("bootstrap-long", kind="bootstrap", runs_total=100)
    assert ok
    store.finish("bootstrap-long", RunStatus.SUCCEEDED)  # free the busy flag for the loop

    # Re-open it as the current run and DON'T finish it, then churn others.
    # Simulate by starting it, then adding many finished runs around it.
    ok, _ = store.try_begin("current-inflight", kind="run")
    assert ok
    # Manually churn finished records via direct begin/finish on new ids; the
    # busy flag is held by current-inflight, so try_begin would 409 — drive
    # _evict_locked directly through internal records to simulate overflow.
    for i in range(10):
        store._records[f"filler-{i}"] = store._records["current-inflight"]
    store._evict_locked()
    # The in-flight run survived the trim even though it's not newest.
    assert store.get("current-inflight") is not None
    assert store.is_busy() is True


def test_under_cap_keeps_everything(monkeypatch):
    monkeypatch.setattr(run_state, "_MAX_RECORDS", 100)
    store = RunStateStore()
    for i in range(5):
        _begin_and_finish(store, f"run-{i}")
    assert len(store._records) == 5
    assert store.get("run-0") is not None
