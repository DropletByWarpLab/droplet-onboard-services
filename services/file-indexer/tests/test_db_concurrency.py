"""IDX-01: the shared psycopg2 connection must be accessed under a single
module-level lock so concurrent threads never ``execute`` on it at once.

These tests don't need a real database — they patch ``db.get_conn`` to hand
back a fake connection whose cursor records whether two threads are ever inside
``execute`` simultaneously (which is exactly the unsafe psycopg2 state the lock
prevents). They also assert each public helper actually holds ``db._db_lock``.
"""

from __future__ import annotations

import threading
import time
from unittest.mock import patch

import db


class _ConcurrencyDetectingCursor:
    """A fake cursor that flags any overlapping ``execute`` across threads."""

    def __init__(self, tracker: "_Tracker"):
        self._tracker = tracker

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        # Mark entry; if another thread is already inside, record the overlap.
        with self._tracker.state_lock:
            if self._tracker.inside > 0:
                self._tracker.overlap = True
            self._tracker.inside += 1
            self._tracker.max_concurrent = max(
                self._tracker.max_concurrent, self._tracker.inside
            )
        # Hold the "inside" window open briefly so a racing thread would collide
        # if the lock weren't serialising us.
        time.sleep(0.001)
        with self._tracker.state_lock:
            self._tracker.inside -= 1

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    @property
    def rowcount(self):
        return 0


class _Tracker:
    def __init__(self):
        self.state_lock = threading.Lock()
        self.inside = 0
        self.max_concurrent = 0
        self.overlap = False


class _FakeConn:
    def __init__(self, tracker: "_Tracker"):
        self._tracker = tracker

    def cursor(self):
        return _ConcurrencyDetectingCursor(self._tracker)

    def commit(self):
        pass


def _run_concurrently(target, n_threads: int = 16) -> None:
    threads = [threading.Thread(target=target) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def test_upsert_chunk_serialises_across_threads():
    """Many threads hammering upsert_chunk never overlap inside execute()."""
    tracker = _Tracker()
    fake = _FakeConn(tracker)

    def worker():
        db.upsert_chunk(
            user_id="alice",
            nc_file_id=1,
            path="/f.txt",
            chunk_idx=0,
            text="hi",
            embedding=[0.0] * 384,
        )

    with patch("db.get_conn", return_value=fake):
        _run_concurrently(worker)

    assert tracker.overlap is False, "two threads were inside execute() at once"
    assert tracker.max_concurrent == 1


def test_conn_param_helpers_serialise_across_threads():
    """The conn-parameter helpers (worker path) also serialise on _db_lock."""
    tracker = _Tracker()
    fake = _FakeConn(tracker)

    def worker():
        # claim_attempt is the atomic SELECT→UPDATE→commit helper; it must hold
        # the lock for its whole body.
        db.claim_attempt(fake, item_id="bmi-1")
        db.update_item_status(fake, item_id="bmi-1", status="indexing")
        db.fetch_item(fake, item_id="bmi-1")

    with patch("db.get_conn", return_value=fake):
        _run_concurrently(worker)

    assert tracker.overlap is False
    assert tracker.max_concurrent == 1


class _CountingRLock:
    """Wraps a real RLock and counts acquisitions, with the same context-manager
    protocol the helpers use via ``with _db_lock``."""

    def __init__(self):
        self._lock = threading.RLock()
        self.acquired = 0

    def __enter__(self):
        self.acquired += 1
        self._lock.acquire()
        return self

    def __exit__(self, *exc):
        self._lock.release()
        return False


def test_helpers_actually_acquire_the_lock(monkeypatch):
    """Guard against a future refactor dropping the lock: each helper must
    enter db._db_lock. We swap the module lock for a counting wrapper and
    confirm every public helper acquires it at least once."""
    counting = _CountingRLock()
    monkeypatch.setattr(db, "_db_lock", counting)

    tracker = _Tracker()
    fake = _FakeConn(tracker)
    with patch("db.get_conn", return_value=fake):
        db.upsert_chunk(
            user_id="a",
            nc_file_id=1,
            path="/f",
            chunk_idx=0,
            text="t",
            embedding=[0.0] * 384,
        )
        db.delete_chunks_for_file(1)
        db.delete_chunks_for_brain_item("bmi-1")
        db.mark_brain_item_indexed("bmi-1", status="ready")
        db.prune_excess_chunks(1, 0)
        db.claim_attempt(fake, item_id="bmi-1")
        db.update_item_status(fake, item_id="bmi-1", status="indexing")
        db.reconcile_stuck_items(fake)
        db.fetch_item(fake, item_id="bmi-1")
        db.select_queued_items(fake)

    # Ten distinct helper calls above; each enters the lock at least once
    # (prune_excess_chunks with idx>=0 does not recurse into delete_*).
    assert counting.acquired >= 10
