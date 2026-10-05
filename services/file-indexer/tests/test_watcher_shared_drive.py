"""SMB content has its own corpus and resolves only its external storage."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest
from watchdog.events import FileDeletedEvent, FileMovedEvent

import watcher
from anchor_schema import NoneAnchor
from extractors.spans import Span


@pytest.fixture
def share_root(tmp_path, monkeypatch):
    root = tmp_path / "share"
    root.mkdir()
    monkeypatch.setattr(watcher, "DROPLET_SHARE_ROOT", str(root))
    monkeypatch.setattr(watcher, "NEXTCLOUD_DATA_ROOT", str(tmp_path / "nextcloud"))
    done = threading.Event()
    done.set()
    monkeypatch.setattr(watcher, "_startup_reconcile_done", done)
    return root


def test_share_has_no_personal_owner_and_uses_home_visible_path(share_root):
    target = watcher._parse_watch_target(str(share_root / "Reports" / "note.pdf"))
    assert target.index_user == "__droplet_share__"
    assert target.home_user is None
    assert target.stored_path == "/Droplet/Reports/note.pdf"
    assert target.cache_path == "Reports/note.pdf"
    assert target.storage_id == "local::/droplet-share/"
    assert watcher._parse_watch_target(str(share_root / ".." / "other.txt")) is None


def test_share_file_id_is_scoped_to_exact_storage_and_relative_path(share_root, monkeypatch):
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = (42,)
    monkeypatch.setattr(watcher, "_get_nc_conn", lambda: connection)
    target = watcher._parse_watch_target(str(share_root / "note.pdf"))
    assert watcher._resolve_file_id(target) == 42
    sql, values = cursor.execute.call_args.args
    assert "JOIN public.oc_storages" in sql
    assert "s.id = %s AND f.path = %s" in sql
    assert values == ("local::/droplet-share/", "note.pdf")


def test_startup_scan_includes_share_when_nextcloud_root_is_absent(share_root, monkeypatch):
    file = share_root / "note.txt"
    file.write_text("A report uploaded before the indexer starts.")
    monkeypatch.setattr(watcher, "fetch_index_status_map", lambda: {})
    handler = MagicMock()
    result = watcher.reconcile_index(handler)
    assert result == {"scanned": 1, "processed": 1}
    handler._index.assert_called_once_with(str(file))


def test_unresolved_share_files_resume_after_nextcloud_discovers_them(share_root, monkeypatch):
    file = share_root / "note.txt"
    file.write_text("SMB writes initially have no Nextcloud filecache ID.")
    monkeypatch.setattr(watcher, "fetch_index_status_map", lambda: {
        ("__droplet_share__", "/Droplet/note.txt"): ("failed", 0, "nc_file_id_unresolved"),
        ("alice", "/note.txt"): ("failed", 0, "nc_file_id_unresolved"),
    })
    handler = MagicMock()
    monkeypatch.setattr(watcher, "_resolve_file_id", lambda target: None)
    assert watcher.retry_shared_files(handler) == 0
    handler._enqueue_index.assert_not_called()
    monkeypatch.setattr(watcher, "_resolve_file_id", lambda target: 42)
    assert watcher.retry_shared_files(handler) == 1
    handler._enqueue_index.assert_called_once_with(str(file))


def test_retry_does_not_repeat_permanent_extraction_failures(share_root, monkeypatch):
    (share_root / "note.txt").write_text("Unrelated failures are not retried every 30 seconds.")
    monkeypatch.setattr(watcher, "fetch_index_status_map", lambda: {
        ("__droplet_share__", "/Droplet/note.txt"): ("failed", 0, "extractor failed"),
    })
    handler = MagicMock()
    assert watcher.retry_shared_files(handler) == 0
    handler._enqueue_index.assert_not_called()


def test_retry_purges_shared_files_deleted_while_watcher_was_offline(share_root, monkeypatch):
    monkeypatch.setattr(watcher, "fetch_index_status_map", lambda: {
        ("__droplet_share__", "/Droplet/gone.pdf"): ("ready", 0, None),
        ("alice", "/personal.pdf"): ("ready", 0, None),
    })
    handler = MagicMock()
    assert watcher.retry_shared_files(handler) == 0
    event = handler.on_deleted.call_args.args[0]
    assert event.src_path == str(share_root / "gone.pdf")
    assert handler.on_deleted.call_count == 1


def test_delete_without_nextcloud_cache_row_purges_by_shared_identity(share_root, monkeypatch):
    monkeypatch.setattr(watcher, "_resolve_file_id", lambda target: None)
    deleted = MagicMock(return_value=2)
    status_deleted = MagicMock()
    monkeypatch.setattr(watcher, "delete_chunks_for_path", deleted)
    monkeypatch.setattr(watcher, "delete_index_status", status_deleted)
    monkeypatch.setattr(watcher, "publish", MagicMock())
    watcher.IndexHandler().on_deleted(FileDeletedEvent(str(share_root / "gone.pdf")))
    deleted.assert_called_once_with("__droplet_share__", "/Droplet/gone.pdf")
    status_deleted.assert_called_once_with("__droplet_share__", "/Droplet/gone.pdf")


def test_share_rename_removes_old_path_and_indexes_new_path(share_root, monkeypatch):
    handler = watcher.IndexHandler()
    handler.on_deleted = MagicMock()
    handler._schedule = MagicMock()
    handler.on_moved(FileMovedEvent(str(share_root / "old.pdf"), str(share_root / "new.pdf")))
    assert handler.on_deleted.call_args.args[0].src_path == str(share_root / "old.pdf")
    handler._schedule.assert_called_once_with(str(share_root / "new.pdf"))


def test_share_pipeline_persists_same_file_id_under_distinct_corpus(share_root, monkeypatch):
    file = share_root / "note.txt"
    file.write_text("This shared document contains useful searchable text.")
    @contextmanager
    def captured(root, relative):
        assert root == str(share_root)
        assert relative == "note.txt"
        yield str(file)
    monkeypatch.setattr(watcher, "shared_file_snapshot", captured)
    monkeypatch.setattr(watcher, "_resolve_file_id", lambda target: 42)
    span = Span(text=file.read_text(), anchor=NoneAnchor(kind="none"))
    monkeypatch.setattr(watcher, "dispatch", lambda path, mime: {"spans": [span], "metadata": {}})
    chunk = MagicMock(text=span.text, anchor=span.anchor, section_path=[])
    monkeypatch.setattr(watcher, "chunk_spans", lambda spans: [chunk])
    monkeypatch.setattr(watcher, "format_chunk_with_header", lambda text, name, section: text)
    monkeypatch.setattr(watcher, "embed_texts", lambda texts: [[0.1, 0.2]])
    upsert = MagicMock()
    status = MagicMock()
    monkeypatch.setattr(watcher, "upsert_chunk", upsert)
    monkeypatch.setattr(watcher, "prune_excess_chunks", MagicMock())
    monkeypatch.setattr(watcher, "_set_status", status)
    monkeypatch.setattr(watcher, "publish", MagicMock())
    watcher.IndexHandler()._index(str(file))
    assert upsert.call_args.args[:4] == ("__droplet_share__", 42, "/Droplet/note.txt", 0)
    assert status.call_args.args[1] == "ready"


@pytest.mark.parametrize("subsequent_ids", [(43,), (None,), (42, 43)])
def test_share_identity_change_never_indexes_snapshot_under_new_or_unresolved_id(
    share_root, monkeypatch, subsequent_ids
):
    file = share_root / "note.txt"
    file.write_text("The captured descriptor still contains the previous file bytes.")

    @contextmanager
    def captured(root, relative):
        assert root == str(share_root)
        assert relative == "note.txt"
        # Model a stable private snapshot of file ID 42 while Nextcloud's
        # current path lookup changes to a new file-cache row during extract.
        yield str(file)

    ids = iter((42, *subsequent_ids))
    monkeypatch.setattr(watcher, "shared_file_snapshot", captured)
    monkeypatch.setattr(watcher, "_resolve_file_id", lambda target: next(ids))
    span = Span(text=file.read_text(), anchor=NoneAnchor(kind="none"))
    monkeypatch.setattr(
        watcher, "dispatch", lambda path, mime: {"spans": [span], "metadata": {}}
    )
    monkeypatch.setattr(watcher, "chunk_spans", lambda spans: [MagicMock(
        text=span.text, anchor=span.anchor, section_path=[]
    )])
    monkeypatch.setattr(watcher, "format_chunk_with_header", lambda text, name, section: text)
    monkeypatch.setattr(watcher, "embed_texts", lambda texts: [[0.1, 0.2]])
    upsert = MagicMock()
    purge = MagicMock()
    status = MagicMock()
    monkeypatch.setattr(watcher, "upsert_chunk", upsert)
    monkeypatch.setattr(watcher, "delete_chunks_for_path", purge)
    monkeypatch.setattr(watcher, "prune_excess_chunks", MagicMock())
    monkeypatch.setattr(watcher, "_set_status", status)
    monkeypatch.setattr(watcher, "publish", MagicMock())

    watcher.IndexHandler()._index(str(file))

    upsert.assert_not_called()
    purge.assert_called_once_with("__droplet_share__", "/Droplet/note.txt")
    assert status.call_args.args[1] == "failed"
    assert status.call_args.kwargs["reason"] == "shared_file_changed"


def test_share_path_replacement_before_chunk_writes_purges_stale_content(
    share_root, monkeypatch
):
    file = share_root / "note.txt"
    file.write_text("The captured inode must still match the shared path before writes.")

    class CapturedSnapshot(str):
        source_identity = (1, 2, 70, 3)

    @contextmanager
    def captured(root, relative):
        yield CapturedSnapshot(str(file))

    monkeypatch.setattr(watcher, "shared_file_snapshot", captured)
    monkeypatch.setattr(watcher, "_resolve_file_id", lambda target: 42)
    monkeypatch.setattr(watcher, "shared_file_identity_matches", lambda *args: False)
    span = Span(text=file.read_text(), anchor=NoneAnchor(kind="none"))
    monkeypatch.setattr(
        watcher, "dispatch", lambda path, mime: {"spans": [span], "metadata": {}}
    )
    monkeypatch.setattr(watcher, "chunk_spans", lambda spans: [MagicMock(
        text=span.text, anchor=span.anchor, section_path=[]
    )])
    monkeypatch.setattr(watcher, "format_chunk_with_header", lambda text, name, section: text)
    monkeypatch.setattr(watcher, "embed_texts", lambda texts: [[0.1, 0.2]])
    upsert = MagicMock()
    purge = MagicMock()
    status = MagicMock()
    monkeypatch.setattr(watcher, "upsert_chunk", upsert)
    monkeypatch.setattr(watcher, "delete_chunks_for_path", purge)
    monkeypatch.setattr(watcher, "prune_excess_chunks", MagicMock())
    monkeypatch.setattr(watcher, "_set_status", status)
    monkeypatch.setattr(watcher, "publish", MagicMock())

    watcher.IndexHandler()._index(str(file))

    upsert.assert_not_called()
    purge.assert_called_once_with("__droplet_share__", "/Droplet/note.txt")
    assert status.call_args.kwargs["reason"] == "shared_file_changed"


def test_unsafe_shared_file_never_reaches_extractor_and_purges_old_text(share_root, monkeypatch):
    (share_root / "link.txt").write_text("This path is rejected by the secure capture.")
    @contextmanager
    def refused(*args):
        raise watcher.UnsafeSharedFile("symbolic link refused")
        yield
    monkeypatch.setattr(watcher, "shared_file_snapshot", refused)
    monkeypatch.setattr(watcher, "_resolve_file_id", lambda target: 42)
    extractor = MagicMock()
    purge = MagicMock()
    status = MagicMock()
    monkeypatch.setattr(watcher, "dispatch", extractor)
    monkeypatch.setattr(watcher, "delete_chunks_for_path", purge)
    monkeypatch.setattr(watcher, "_set_status", status)
    watcher.IndexHandler()._index(str(share_root / "link.txt"))
    extractor.assert_not_called()
    purge.assert_called_once_with("__droplet_share__", "/Droplet/link.txt")
    assert status.call_args.kwargs["reason"] == "unsafe_shared_file"


def test_empty_shared_file_does_not_stay_in_the_unresolved_retry_queue(share_root, monkeypatch):
    file = share_root / "empty.txt"
    file.write_text("")
    status = MagicMock()
    resolve = MagicMock()
    monkeypatch.setattr(watcher, "_set_status", status)
    monkeypatch.setattr(watcher, "_resolve_file_id", resolve)
    monkeypatch.setattr(watcher, "delete_chunks_for_path", MagicMock())
    watcher.IndexHandler()._index(str(file))
    resolve.assert_not_called()
    assert status.call_args.args[1] == "skipped"
    assert status.call_args.kwargs["reason"] == "empty_file"


def test_unfinished_shared_capture_is_retried(share_root, monkeypatch):
    file = share_root / "copy.txt"
    file.write_text("An SMB copy changes while it is being read.")
    @contextmanager
    def changed(*args):
        raise watcher.SharedFileChanged("copy in progress")
        yield
    status = MagicMock()
    monkeypatch.setattr(watcher, "shared_file_snapshot", changed)
    monkeypatch.setattr(watcher, "_resolve_file_id", lambda target: 42)
    monkeypatch.setattr(watcher, "_set_status", status)
    monkeypatch.setattr(watcher, "delete_chunks_for_path", MagicMock())
    watcher.IndexHandler()._index(str(file))
    assert status.call_args.args[1] == "failed"
    assert status.call_args.kwargs["reason"] == "shared_file_changed"
    monkeypatch.setattr(watcher, "fetch_index_status_map", lambda: {
        ("__droplet_share__", "/Droplet/copy.txt"): ("failed", 0, "shared_file_changed"),
    })
    handler = MagicMock()
    assert watcher.retry_shared_files(handler) == 1
    handler._enqueue_index.assert_called_once_with(str(file))


def test_shared_observer_and_retry_are_registered(share_root, monkeypatch):
    observer = MagicMock()
    scheduler = MagicMock()
    monkeypatch.setattr(watcher, "Observer", lambda: observer)
    monkeypatch.setattr(watcher, "_get_debounce_scheduler", lambda: scheduler)
    monkeypatch.delenv("WATCHER_MODE", raising=False)
    watcher.start_watcher()
    assert observer.schedule.call_args_list[1].args[1] == str(share_root)
    job = next(call for call in scheduler.add_job.call_args_list if call.kwargs["id"] == "droplet-share-retry")
    assert job.args[0] is watcher.retry_shared_files
    assert job.kwargs["seconds"] == 30
