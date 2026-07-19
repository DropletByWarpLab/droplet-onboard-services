"""WARP-1381-adjacent run-results visibility — finish() must leave a durable trace.

Before this change a FAILED run had no filesystem artifact at all:
RunStateStore.finish() cleared current_run_id (so GET /runs stopped
overlaying it) and a container restart wiped the in-memory record — the
dashboard could never show that (or why) a run failed. finish() now
persists RUNS_DIR/record-<runId>.json atomically for EVERY terminal run —
succeeded and failed, kinds "run" and "bootstrap" — and does so
best-effort: a persistence failure must never block the busy-flag clear.
"""

from __future__ import annotations

import json

import config
from run_state import RunStateStore, RunStatus


def _record_path(runs_dir, run_id):
    return runs_dir / f"record-{run_id}.json"


def _patch_runs_dir(monkeypatch, tmp_path):
    runs_dir = tmp_path / "runs"
    monkeypatch.setattr(config, "RUNS_DIR", runs_dir)
    return runs_dir


def test_failed_run_persists_record_file(monkeypatch, tmp_path):
    runs_dir = _patch_runs_dir(monkeypatch, tmp_path)
    store = RunStateStore()
    ok, _ = store.try_begin("20260101T000000Z", kind="run")
    assert ok
    store.finish(
        "20260101T000000Z", RunStatus.FAILED, error="ragas_runner exited 2: boom"
    )

    data = json.loads(_record_path(runs_dir, "20260101T000000Z").read_text())
    assert data["runId"] == "20260101T000000Z"
    assert data["kind"] == "run"
    assert data["status"] == "failed"
    assert data["error"] == "ragas_runner exited 2: boom"
    assert data["startedAt"]
    assert data["finishedAt"]
    # runsTotal/runsDone are bootstrap-only fields.
    assert "runsTotal" not in data
    # Atomic write leaves no tmp litter behind.
    assert list(runs_dir.glob("*.tmp")) == []


def test_succeeded_run_persists_record_file(monkeypatch, tmp_path):
    runs_dir = _patch_runs_dir(monkeypatch, tmp_path)
    store = RunStateStore()
    ok, _ = store.try_begin("20260101T010000Z", kind="run")
    assert ok
    store.finish("20260101T010000Z", RunStatus.SUCCEEDED)

    data = json.loads(_record_path(runs_dir, "20260101T010000Z").read_text())
    assert data["status"] == "succeeded"
    assert "error" not in data


def test_bootstrap_record_includes_progress(monkeypatch, tmp_path):
    runs_dir = _patch_runs_dir(monkeypatch, tmp_path)
    store = RunStateStore()
    ok, _ = store.try_begin("20260101T020000Z", kind="bootstrap", runs_total=5)
    assert ok
    store.mark_bootstrap_progress("20260101T020000Z", 3)
    store.finish(
        "20260101T020000Z", RunStatus.FAILED, error="all bootstrap runs failed"
    )

    data = json.loads(_record_path(runs_dir, "20260101T020000Z").read_text())
    assert data["kind"] == "bootstrap"
    assert data["status"] == "failed"
    assert data["runsTotal"] == 5
    assert data["runsDone"] == 3


def test_persist_failure_never_raises_and_still_clears_busy(
    monkeypatch, tmp_path
):
    # RUNS_DIR's parent is a FILE, so mkdir() inside persistence blows up.
    # finish() must swallow that (log-only) and still clear the busy flag —
    # otherwise a full disk would wedge the service permanently busy.
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    monkeypatch.setattr(config, "RUNS_DIR", blocker / "runs")
    store = RunStateStore()
    ok, _ = store.try_begin("20260101T030000Z", kind="run")
    assert ok
    store.finish("20260101T030000Z", RunStatus.FAILED, error="boom")
    assert store.is_busy() is False
    rec = store.get("20260101T030000Z")
    assert rec is not None
    assert rec.status is RunStatus.FAILED
