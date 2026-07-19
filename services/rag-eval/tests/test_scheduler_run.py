"""Scheduler path — runId must equal the results-file stamp, and a failed
scheduled run must leave a durable record carrying the subprocess tail.

_scheduled_run() mints the run_id at admission; before this change
runner.run_once() stamped the results file with its OWN clock read seconds
later, so results-<runId>.json lookups (GET /runs/{id}, metrics attach)
could miss. The scheduler now passes its run_id as the stamp.
"""

from __future__ import annotations

import asyncio
import json
import subprocess

import pytest

import config
import runner
import scheduler_service
from run_state import RunStateStore, RunStatus

_RUN_ID = "20260101T000000Z"


@pytest.fixture()
def store(monkeypatch, tmp_path):
    """Fresh store wired into the scheduler + a tmp RUNS_DIR for records,
    with the minted run_id pinned so tests can address it."""
    monkeypatch.setattr(config, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(runner, "_utc_stamp", lambda: _RUN_ID)
    fresh = RunStateStore()
    monkeypatch.setattr(scheduler_service, "STORE", fresh)
    return fresh


def test_scheduled_run_passes_run_id_as_results_stamp(monkeypatch, store):
    seen = {}

    def fake_run_once(target_dir=None, stamp=None):
        seen["stamp"] = stamp

    monkeypatch.setattr(runner, "run_once", fake_run_once)
    asyncio.run(scheduler_service._scheduled_run())

    assert seen["stamp"] == _RUN_ID
    rec = store.get(_RUN_ID)
    assert rec is not None
    assert rec.status is RunStatus.SUCCEEDED


def test_scheduled_failure_persists_record_with_output_tail(
    monkeypatch, store, tmp_path
):
    def fake_run_once(target_dir=None, stamp=None):
        raise subprocess.CalledProcessError(
            3, ["ragas"], output="judge exploded"
        )

    monkeypatch.setattr(runner, "run_once", fake_run_once)
    asyncio.run(scheduler_service._scheduled_run())

    rec = store.get(_RUN_ID)
    assert rec is not None
    assert rec.status is RunStatus.FAILED
    assert rec.error == "ragas_runner exited 3: judge exploded"
    # The durable record on disk carries the same cause — this is what a
    # fresh process (post-restart GET /runs) will surface.
    data = json.loads(
        (tmp_path / "runs" / f"record-{_RUN_ID}.json").read_text()
    )
    assert data["status"] == "failed"
    assert data["error"] == "ragas_runner exited 3: judge exploded"
