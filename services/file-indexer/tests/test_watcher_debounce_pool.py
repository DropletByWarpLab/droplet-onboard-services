"""WARP-3193 PERF-4 — the watcher's debounce is bounded.

`_schedule` used to start one `threading.Timer` (an OS thread) per changed
path, and each timer ran the whole pipeline (extraction, OCR, ffmpeg,
embedding) on its own thread. A 5k-file copy or restore meant 5k threads all
indexing at once: pids limit, OOM, and a flood of ai-gateway calls.

Debounce semantics are unchanged (a path is indexed once, DEBOUNCE_SECONDS
after its LAST event), but the waiting is done by one scheduler and the
indexing by a small fixed pool.
"""

from __future__ import annotations

import threading
import time

import pytest

import watcher


@pytest.fixture
def fast_debounce(monkeypatch):
    monkeypatch.setattr(watcher, "DEBOUNCE_SECONDS", 0.05)


def _wait_for(pred, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


def test_a_burst_of_paths_is_indexed_by_a_bounded_pool(fast_debounce, monkeypatch):
    handler = watcher.IndexHandler()
    active = 0
    peak = 0
    done: list[str] = []
    guard = threading.Lock()

    def slow_index(path):
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        time.sleep(0.02)
        with guard:
            active -= 1
            done.append(path)

    monkeypatch.setattr(handler, "_index", slow_index)
    threads_before = threading.active_count()

    paths = [f"/data/alice/files/burst/{i}.txt" for i in range(200)]
    for p in paths:
        handler._schedule(p)

    # Scheduling 200 paths must not have spawned anything like 200 threads.
    assert threading.active_count() - threads_before <= watcher.INDEX_WORKERS + 4

    assert _wait_for(lambda: len(done) == len(paths))
    assert sorted(done) == sorted(paths)
    assert peak <= watcher.INDEX_WORKERS


def test_repeat_events_for_one_path_index_it_once(fast_debounce, monkeypatch):
    handler = watcher.IndexHandler()
    calls: list[str] = []
    monkeypatch.setattr(handler, "_index", calls.append)

    for _ in range(10):
        handler._schedule("/data/alice/files/one.txt")

    assert _wait_for(lambda: len(calls) == 1)
    time.sleep(0.2)
    assert calls == ["/data/alice/files/one.txt"]


def test_each_new_event_resets_the_debounce_window(monkeypatch):
    monkeypatch.setattr(watcher, "DEBOUNCE_SECONDS", 0.3)
    handler = watcher.IndexHandler()
    calls: list[float] = []
    monkeypatch.setattr(handler, "_index", lambda _p: calls.append(time.monotonic()))

    start = time.monotonic()
    handler._schedule("/data/alice/files/reset.txt")
    time.sleep(0.2)
    last = time.monotonic()
    handler._schedule("/data/alice/files/reset.txt")

    assert _wait_for(lambda: len(calls) == 1)
    assert calls[0] - last >= 0.25
    assert calls[0] - start >= 0.45


def test_an_index_failure_is_recorded_and_the_pool_keeps_going(fast_debounce, monkeypatch):
    handler = watcher.IndexHandler()
    done: list[str] = []

    def index(path):
        if path.endswith("bad.txt"):
            raise RuntimeError("boom")
        done.append(path)

    statuses = []
    monkeypatch.setattr(handler, "_index", index)
    monkeypatch.setattr(watcher, "_parse_watch_target", lambda _p: object())
    monkeypatch.setattr(watcher, "_set_status", lambda t, s, **kw: statuses.append(s))

    handler._schedule("/data/alice/files/bad.txt")
    handler._schedule("/data/alice/files/good.txt")

    assert _wait_for(lambda: done == ["/data/alice/files/good.txt"] and statuses == ["failed"])
