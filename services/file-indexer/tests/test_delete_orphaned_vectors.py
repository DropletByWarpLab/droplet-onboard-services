"""IDX-09 — file delete must drop chunks even when the Nextcloud filecache row
is already gone, so no orphaned vectors linger in search.

Covers the db-level delete-by-path helper and the watcher's on_deleted
fallback path (fileId resolved → delete by fileId; fileId None → delete by
(userId, path)).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


# --- db.delete_chunks_for_path ---

def test_delete_chunks_for_path_scopes_to_user_and_path():
    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_cursor.rowcount = 3
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor

    with patch("db.get_conn", return_value=fake_conn):
        from db import delete_chunks_for_path

        deleted = delete_chunks_for_path("alice", "/notes/todo.md")

    assert deleted == 3
    sql = fake_cursor.execute.call_args[0][0]
    binds = fake_cursor.execute.call_args[0][1]
    assert '"userId"' in sql and '"path"' in sql
    assert "DELETE FROM" in sql
    assert binds == ("alice", "/notes/todo.md")


# --- watcher.on_deleted fallback ---

class _Event:
    is_directory = False

    def __init__(self, src_path):
        self.src_path = src_path


@pytest.fixture
def handler():
    import watcher
    return watcher.IndexHandler()


def _nc_path(user, relpath):
    # Matches what _parse_nc_path expects; resolve via the module's own parser.
    import watcher
    # Build a path the regex accepts by reusing the configured data root.
    from config import NEXTCLOUD_DATA_ROOT
    return f"{NEXTCLOUD_DATA_ROOT}/{user}/files/{relpath}"


def test_on_deleted_uses_fileid_when_resolved(handler):
    import watcher

    with (
        patch.object(watcher, "_resolve_nc_file_id", return_value=99),
        patch.object(watcher, "delete_chunks_for_file") as del_by_id,
        patch.object(watcher, "delete_chunks_for_path") as del_by_path,
        patch.object(watcher, "publish") as pub,
    ):
        handler.on_deleted(_Event(_nc_path("bob", "report.pdf")))

    del_by_id.assert_called_once_with(99)
    del_by_path.assert_not_called()
    pub.assert_called_once()
    assert pub.call_args[0][1]["ncFileId"] == 99


def test_on_deleted_falls_back_to_path_when_fileid_gone(handler):
    import watcher

    with (
        patch.object(watcher, "_resolve_nc_file_id", return_value=None),
        patch.object(watcher, "delete_chunks_for_file") as del_by_id,
        patch.object(watcher, "delete_chunks_for_path", return_value=2) as del_by_path,
        patch.object(watcher, "publish") as pub,
    ):
        handler.on_deleted(_Event(_nc_path("bob", "report.pdf")))

    del_by_id.assert_not_called()
    # Stored path form is "/<relpath>".
    del_by_path.assert_called_once_with("bob", "/report.pdf")
    pub.assert_called_once()
    assert pub.call_args[0][1]["ncFileId"] is None


def test_on_deleted_path_fallback_no_rows_does_not_publish(handler):
    import watcher

    with (
        patch.object(watcher, "_resolve_nc_file_id", return_value=None),
        patch.object(watcher, "delete_chunks_for_path", return_value=0) as del_by_path,
        patch.object(watcher, "publish") as pub,
    ):
        handler.on_deleted(_Event(_nc_path("bob", "ghost.txt")))

    del_by_path.assert_called_once_with("bob", "/ghost.txt")
    pub.assert_not_called()
