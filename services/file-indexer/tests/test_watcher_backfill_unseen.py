"""WARP-3425 — company Workspace files that were never indexed.

On the test box every file in the company Workspace (the groupfolder mounted
at /Household) had NO FileIndexStatus row at all, while personal files indexed
normally. The only watcher branch that leaves no row is `_parse_watch_target`
returning None for a groupfolder whose id no Department row carries. The
startup reconcile is a single pass, so a file skipped that way was never looked
at again until the next restart.

`backfill_unseen` is the periodic sweep that turns the orchestrator's heal of
the Workspace's groupfolder id into indexed files: it queues every watched file
that has no status row, under the same identity the live path uses.
"""

from __future__ import annotations

import threading
from unittest.mock import MagicMock, patch

import pytest

import watcher

WORKSPACE = {"id": "hh-uuid", "kind": "HOUSEHOLD", "name": "Household"}


@pytest.fixture
def nc_root(tmp_path, monkeypatch):
    monkeypatch.setattr(watcher, "NEXTCLOUD_DATA_ROOT", str(tmp_path))
    return tmp_path


@pytest.fixture
def startup_done(monkeypatch):
    """A fresh, already-set startup event, so no other test's reconcile run
    leaks its state into these."""
    ev = threading.Event()
    ev.set()
    monkeypatch.setattr(watcher, "_startup_reconcile_done", ev)
    return ev


def _workspace_file(nc_root, gfid="4"):
    d = nc_root / "__groupfolders" / gfid / "Live test Q3"
    d.mkdir(parents=True)
    f = d / "Minutes.docx"
    f.write_bytes(b"PK\x03\x04 minutes of the Q3 planning meeting")
    return f


def test_backfill_waits_for_the_startup_reconcile(nc_root, monkeypatch):
    # The startup pass indexes never-seen files itself; a sweep racing it
    # would index the same files twice.
    monkeypatch.setattr(watcher, "_startup_reconcile_done", threading.Event())
    handler = MagicMock()
    with patch.object(watcher, "fetch_index_status_map") as fetch:
        assert watcher.backfill_unseen(handler) == 0
    fetch.assert_not_called()
    handler._enqueue_index.assert_not_called()


def test_backfill_queues_only_never_seen_files(nc_root, monkeypatch, startup_done):
    monkeypatch.setattr(watcher, "_lookup_department_for_groupfolder", lambda gfid: WORKSPACE)
    ws = _workspace_file(nc_root)
    home = nc_root / "alice" / "files"
    home.mkdir(parents=True)
    (home / "seen.txt").write_text("already indexed")
    (home / "new.txt").write_text("never indexed")
    (home / ".hidden").write_text("x")
    (home / "up.part").write_text("x")

    handler = MagicMock()
    with patch.object(
        watcher,
        "fetch_index_status_map",
        return_value={("alice", "/seen.txt"): ("ready", 0.0, None, None)},
    ):
        assert watcher.backfill_unseen(handler) == 2

    queued = sorted(c.args[0] for c in handler._enqueue_index.call_args_list)
    assert queued == sorted([str(ws), str(home / "new.txt")])


def test_backfill_keys_workspace_files_by_the_workspace_identity(nc_root, monkeypatch, startup_done):
    # A Workspace file already carrying its row under the Workspace sentinel
    # and display path is NOT re-queued — proving the sweep looks it up under
    # ("__household__", "/Household/…"), the identity search reads.
    monkeypatch.setattr(watcher, "_lookup_department_for_groupfolder", lambda gfid: WORKSPACE)
    _workspace_file(nc_root)

    handler = MagicMock()
    with patch.object(
        watcher,
        "fetch_index_status_map",
        return_value={
            ("__household__", "/Household/Live test Q3/Minutes.docx"): ("ready", 0.0, None, None)
        },
    ):
        assert watcher.backfill_unseen(handler) == 0
    handler._enqueue_index.assert_not_called()


def test_unmapped_workspace_files_are_picked_up_once_the_id_heals(nc_root, monkeypatch, startup_done):
    """The box scenario end to end on the indexer side: the Workspace's
    groupfolder id has no Department row, so nothing is queued (never guessed
    into a corpus); once the orchestrator re-discovers the id, the next sweep
    queues the file."""
    ws = _workspace_file(nc_root)
    mapping: dict = {"dept": None}
    monkeypatch.setattr(watcher, "_lookup_department_for_groupfolder", lambda gfid: mapping["dept"])

    handler = MagicMock()
    with patch.object(watcher, "fetch_index_status_map", return_value={}):
        assert watcher.backfill_unseen(handler) == 0
        handler._enqueue_index.assert_not_called()

        mapping["dept"] = WORKSPACE
        assert watcher.backfill_unseen(handler) == 1

    handler._enqueue_index.assert_called_once_with(str(ws))


def test_backfill_skips_the_sweep_when_status_cannot_be_read(nc_root, startup_done):
    handler = MagicMock()
    with patch.object(watcher, "fetch_index_status_map", side_effect=Exception("db down")):
        assert watcher.backfill_unseen(handler) == 0
    handler._enqueue_index.assert_not_called()


def test_reconcile_marks_the_startup_pass_done_even_when_it_cannot_scan(nc_root, monkeypatch):
    ev = threading.Event()
    monkeypatch.setattr(watcher, "_startup_reconcile_done", ev)
    with patch.object(watcher, "fetch_index_status_map", side_effect=Exception("db down")):
        watcher.reconcile_index(MagicMock())
    assert ev.is_set()
