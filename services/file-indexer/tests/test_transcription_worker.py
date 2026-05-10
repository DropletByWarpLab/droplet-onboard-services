"""WARP-218: transcription worker — daily run + manual override.

Mocks db helpers + the registry dispatch so we can test the worker's
state transitions without spinning up the full Compose stack.
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import transcription_worker as worker


def _fake_dispatch_returns_doc():
    """Stub registry.dispatch returning a minimal ExtractedDoc."""
    return MagicMock(return_value={
        "text": "transcript",
        "page_breaks": [],
        "language": "en",
        "metadata": {},
        "warnings": [],
    })


def _fake_dispatch_raises(exc=RuntimeError("boom")):
    return MagicMock(side_effect=exc)


def test_run_one_happy_path_transitions_queued_to_ready():
    """Successful run flips status to ready + publishes MQTT."""
    conn = MagicMock()
    publish = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "claim_attempt", return_value=True), \
         patch.object(worker, "fetch_item", return_value={
             "id": "bmi-1", "userId": "alice",
             "storagePath": "/tmp/x.wav", "mimeType": "audio/wav",
         }), \
         patch.object(worker, "update_item_status") as upd, \
         patch.object(worker, "_dispatch_and_index", _fake_dispatch_returns_doc()), \
         patch.object(worker.mqtt_client, "publish", publish):
        worker.run_one("bmi-1")

    # Two updates: queued→indexing, then indexing→ready.
    statuses = [c.kwargs["status"] for c in upd.call_args_list]
    assert statuses == ["indexing", "ready"]
    # _publish_status is called twice (once per status transition).
    # Each call publishes to two topics: brain/indexed + context-stats/invalidate.
    # Find the brain-indexed call with status=ready.
    ready_publishes = [
        c for c in publish.call_args_list
        if c[0][0] == "droplet/files/alice/brain/indexed"
        and c[0][1].get("status") == "ready"
    ]
    assert len(ready_publishes) == 1, "expected exactly one brain/indexed status=ready publish"


def test_run_one_extractor_raises_transitions_to_failed():
    """Exception in dispatch flips status to failed + records reason."""
    conn = MagicMock()
    publish = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "claim_attempt", return_value=True), \
         patch.object(worker, "fetch_item", return_value={
             "id": "bmi-1", "userId": "alice",
             "storagePath": "/tmp/x.wav", "mimeType": "audio/wav",
         }), \
         patch.object(worker, "update_item_status") as upd, \
         patch.object(worker, "_dispatch_and_index",
                      _fake_dispatch_raises(RuntimeError("ffmpeg fail"))), \
         patch.object(worker.mqtt_client, "publish", publish):
        worker.run_one("bmi-1")

    failed_call = [c for c in upd.call_args_list if c.kwargs["status"] == "failed"][0]
    assert "ffmpeg fail" in (failed_call.kwargs.get("failure_reason") or "")
    # Two brain-indexed publishes: indexing then failed. Find the failed one.
    failed_publishes = [
        c for c in publish.call_args_list
        if c[0][0] == "droplet/files/alice/brain/indexed"
        and c[0][1].get("status") == "failed"
    ]
    assert len(failed_publishes) == 1, "expected exactly one brain/indexed status=failed publish"


def test_run_one_skips_when_claim_attempt_returns_false():
    """Cap-hit → no status update, no dispatch, log only."""
    conn = MagicMock()
    publish = MagicMock()
    upd = MagicMock()
    dispatch = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "claim_attempt", return_value=False), \
         patch.object(worker, "fetch_item", return_value={
             "id": "bmi-1", "userId": "alice",
             "storagePath": "/tmp/x.wav", "mimeType": "audio/wav",
         }), \
         patch.object(worker, "update_item_status", upd), \
         patch.object(worker, "_dispatch_and_index", dispatch), \
         patch.object(worker.mqtt_client, "publish", publish):
        worker.run_one("bmi-1")

    upd.assert_not_called()
    dispatch.assert_not_called()
    publish.assert_not_called()


def test_run_one_handles_missing_item_gracefully():
    """fetch_item returns None → log + return without crashing."""
    conn = MagicMock()
    upd = MagicMock()
    dispatch = MagicMock()
    publish = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "fetch_item", return_value=None), \
         patch.object(worker, "claim_attempt") as claim, \
         patch.object(worker, "update_item_status", upd), \
         patch.object(worker, "_dispatch_and_index", dispatch), \
         patch.object(worker.mqtt_client, "publish", publish):
        worker.run_one("bmi-missing")
    claim.assert_not_called()
    upd.assert_not_called()
    dispatch.assert_not_called()
    publish.assert_not_called()


def test_run_pass_processes_all_queued_items_oldest_first():
    """run_pass() iterates select_queued_items and calls run_one for each."""
    conn = MagicMock()
    items = [
        {"id": "bmi-1", "userId": "alice", "storagePath": "/tmp/a.wav", "mimeType": "audio/wav"},
        {"id": "bmi-2", "userId": "bob",   "storagePath": "/tmp/b.mp4", "mimeType": "video/mp4"},
    ]
    run_one_calls: list[str] = []
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "select_queued_items", return_value=items), \
         patch.object(worker, "run_one", side_effect=lambda i: run_one_calls.append(i)):
        worker.run_pass()
    assert run_one_calls == ["bmi-1", "bmi-2"]


def test_run_pass_no_items_logs_and_returns():
    conn = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "select_queued_items", return_value=[]), \
         patch.object(worker, "run_one") as ro:
        worker.run_pass()
    ro.assert_not_called()


def test_reconcile_runs_at_startup():
    """reconcile_stuck_items() flips indexing→queued for items >6h old."""
    conn = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "reconcile_stuck_items", return_value=3) as rec:
        worker.reconcile_at_startup()
    rec.assert_called_once()
    assert rec.call_args.kwargs["stuck_after_hours"] == 6
