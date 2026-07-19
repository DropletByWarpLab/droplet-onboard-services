"""Run-results visibility — the /runs and /baselines read surface.

Pins the three defects that hid runs from the /admin/rag-eval dashboard:
  - Failed runs (and finished bootstraps) had no durable trace, so a
    restart — or just finish() clearing current_run_id — made them vanish.
    GET /runs now merges record-<runId>.json files written at finish().
  - A single results-*.json containing literal NaN (the ragas runner used
    to write them) made FastAPI's JSONResponse (allow_nan=False) raise on
    EVERY GET /runs — one poisoned file hid ALL runs forever. Reads must
    map NaN/Infinity to null and return 200.
  - GET /runs/{id} must fall back to the record file after a restart
    (fresh in-memory store) instead of reporting "unknown".
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import config
import server
from run_state import RunStateStore, RunStatus


@pytest.fixture()
def env(monkeypatch, tmp_path):
    """Fresh store + tmp filesystem, wired into config at call-time paths."""
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    monkeypatch.setattr(config, "RUNS_DIR", runs_dir)
    monkeypatch.setattr(config, "RESULTS_DIR", tmp_path)
    monkeypatch.setattr(
        config, "BASELINES_CANDIDATE", tmp_path / "baselines.candidate.json"
    )
    store = RunStateStore()
    monkeypatch.setattr(server, "STORE", store)
    client = TestClient(server.create_app())
    return SimpleNamespace(
        client=client, store=store, runs_dir=runs_dir, monkeypatch=monkeypatch
    )


def _restart(env):
    """Simulate a rag-eval container restart: fresh in-memory store, same
    filesystem."""
    env.monkeypatch.setattr(server, "STORE", RunStateStore())


def _finish(store, run_id, status, error=None, kind="run", runs_total=None):
    ok, _ = store.try_begin(run_id, kind=kind, runs_total=runs_total)
    assert ok
    store.finish(run_id, status, error=error)


def test_failed_run_survives_restart_in_runs_list(env):
    _finish(
        env.store,
        "20260101T000000Z",
        RunStatus.FAILED,
        error="ragas_runner exited 2: judge exploded",
    )
    _restart(env)

    resp = env.client.get("/runs")
    assert resp.status_code == 200
    runs = resp.json()["runs"]
    assert len(runs) == 1
    assert runs[0]["runId"] == "20260101T000000Z"
    assert runs[0]["status"] == "failed"
    assert runs[0]["error"] == "ragas_runner exited 2: judge exploded"


def test_nan_results_file_yields_200_with_null_metrics(env):
    # Literal NaN tokens — what the pre-fix ragas runner wrote. json.load
    # accepts them; JSONResponse (allow_nan=False) does not. The read side
    # must map them to null so one poisoned file can't 500 the whole list.
    (env.runs_dir / "results-20260101T000000Z.json").write_text(
        '{"metrics": {"faithfulness": NaN, "answer_relevancy": 0.9}}'
    )

    resp = env.client.get("/runs")
    assert resp.status_code == 200
    runs = resp.json()["runs"]
    assert len(runs) == 1
    assert runs[0]["metrics"] == {
        "faithfulness": None,
        "answer_relevancy": 0.9,
    }

    resp = env.client.get("/runs/20260101T000000Z")
    assert resp.status_code == 200
    assert resp.json()["metrics"]["faithfulness"] is None


def test_bootstrap_terminal_record_appears_in_runs_list(env):
    # Finished bootstraps write results into RESULTS_DIR/bootstrap-<id>/ —
    # never RUNS_DIR — so before record files they NEVER appeared in /runs.
    ok, _ = env.store.try_begin(
        "20260101T010000Z", kind="bootstrap", runs_total=4
    )
    assert ok
    env.store.mark_bootstrap_progress("20260101T010000Z", 4)
    env.store.finish("20260101T010000Z", RunStatus.SUCCEEDED)
    _restart(env)

    resp = env.client.get("/runs")
    assert resp.status_code == 200
    runs = resp.json()["runs"]
    assert len(runs) == 1
    assert runs[0]["kind"] == "bootstrap"
    assert runs[0]["status"] == "succeeded"
    assert runs[0]["runsTotal"] == 4
    assert runs[0]["runsDone"] == 4


def test_get_run_falls_back_to_record_file_after_restart(env):
    _finish(
        env.store,
        "20260101T020000Z",
        RunStatus.FAILED,
        error="ragas_runner exited 1",
    )
    _restart(env)

    resp = env.client.get("/runs/20260101T020000Z")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["error"] == "ragas_runner exited 1"


def test_get_run_unknown_stays_explicit(env):
    resp = env.client.get("/runs/20990101T000000Z")
    assert resp.status_code == 200
    assert resp.json()["status"] == "unknown"


def test_legacy_results_file_without_record_still_listed(env):
    # Pre-upgrade successes only have results-*.json. Keep the documented
    # inferred-succeeded shape for those.
    (env.runs_dir / "results-20260101T030000Z.json").write_text(
        '{"metrics": {"faithfulness": 0.8}}'
    )

    resp = env.client.get("/runs")
    assert resp.status_code == 200
    runs = resp.json()["runs"]
    assert len(runs) == 1
    assert runs[0]["status"] == "succeeded"
    assert runs[0]["kind"] == "run"
    assert runs[0]["metrics"] == {"faithfulness": 0.8}
    assert runs[0]["resultsPath"].endswith("results-20260101T030000Z.json")


def test_record_takes_precedence_and_gets_metrics_attached(env):
    # A run with BOTH a record and a results file (the post-fix normal
    # case — runId == results stamp) shows once, from the record, with
    # resultsPath + metrics attached.
    _finish(env.store, "20260101T040000Z", RunStatus.SUCCEEDED)
    (env.runs_dir / "results-20260101T040000Z.json").write_text(
        '{"metrics": {"faithfulness": 0.7}}'
    )
    _restart(env)

    resp = env.client.get("/runs")
    runs = resp.json()["runs"]
    assert len(runs) == 1
    assert runs[0]["status"] == "succeeded"
    assert runs[0]["metrics"] == {"faithfulness": 0.7}
    assert runs[0]["resultsPath"].endswith("results-20260101T040000Z.json")


def test_in_flight_run_overlays_its_record(env):
    ok, _ = env.store.try_begin("20260101T050000Z", kind="run")
    assert ok

    resp = env.client.get("/runs")
    runs = resp.json()["runs"]
    assert len(runs) == 1
    assert runs[0]["status"] == "running"


def test_runs_list_newest_first_and_capped_at_20(env):
    for day in range(1, 26):
        stamp = f"202601{day:02d}T000000Z"
        (env.runs_dir / f"record-{stamp}.json").write_text(
            json.dumps(
                {
                    "runId": stamp,
                    "kind": "run",
                    "status": "succeeded",
                    "startedAt": f"2026-01-{day:02d}T00:00:00+00:00",
                    "finishedAt": f"2026-01-{day:02d}T00:10:00+00:00",
                }
            )
        )

    resp = env.client.get("/runs")
    runs = resp.json()["runs"]
    assert len(runs) == 20
    assert runs[0]["runId"] == "20260125T000000Z"
    assert runs[-1]["runId"] == "20260106T000000Z"


def test_baselines_with_nan_yields_200_with_nulls(env):
    config.BASELINES_CANDIDATE.write_text(
        '{"faithfulness": {"mean": NaN, "stdev": 0.1}}'
    )

    resp = env.client.get("/baselines")
    assert resp.status_code == 200
    assert resp.json() == {"faithfulness": {"mean": None, "stdev": 0.1}}
