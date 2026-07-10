"""WARP-1139/WARP-1140 — watcher ingestion fixes + explicit index status.

Covers the four ingestion-side root causes behind "search finds nothing for a
file that visibly exists" (the droplet.local 'burrito' report):

  1. Extensionless files were skipped silently (mimetypes → None). Now they
     are sniffed for plain text, and a genuinely unknown type records an
     explicit `skipped` status instead of vanishing.
  2. Shared "Household" groupfolder content (physically under
     __groupfolders/<id>/, never in a user home) was never watched. Now it
     indexes under the __household__ sentinel with a /Household/… path.
  3. Nothing recorded per-file pipeline state — "not indexed yet" was
     indistinguishable from "no match" (CLAUDE.md no-guessing rule). Now
     every pipeline outcome upserts a FileIndexStatus row.
  4. Files that existed before the watcher started were never indexed
     (inotify only sees live events). `reconcile_index` walks the watched
     subtrees at startup and indexes what's missing/stale.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

import watcher
from watcher import WatchTarget


# ── helpers ──────────────────────────────────────────────────────────────


def _target(user="alice", stored="/note.txt", rel="note.txt", cache="files/note.txt", home="alice"):
    return WatchTarget(
        index_user=user,
        stored_path=stored,
        relpath=rel,
        cache_path=cache,
        home_user=home,
    )


@pytest.fixture
def nc_root(tmp_path, monkeypatch):
    """Point the watcher at a throwaway Nextcloud data root."""
    monkeypatch.setattr(watcher, "NEXTCLOUD_DATA_ROOT", str(tmp_path))
    return tmp_path


# ── _parse_watch_target ──────────────────────────────────────────────────


def test_parse_home_file(nc_root):
    p = nc_root / "alice" / "files" / "Docs" / "report.pdf"
    t = watcher._parse_watch_target(str(p))
    assert t is not None
    assert t.index_user == "alice"
    assert t.stored_path == "/Docs/report.pdf"
    assert t.cache_path == "files/Docs/report.pdf"
    assert t.home_user == "alice"


def test_parse_groupfolder_file(nc_root):
    p = nc_root / "__groupfolders" / "3" / "Trips" / "notes.txt"
    t = watcher._parse_watch_target(str(p))
    assert t is not None
    assert t.index_user == "__household__"
    assert t.stored_path == "/Household/Trips/notes.txt"
    assert t.cache_path == "__groupfolders/3/Trips/notes.txt"
    assert t.home_user is None


def test_parse_groupfolder_trash_and_versions_excluded(nc_root):
    assert watcher._parse_watch_target(str(nc_root / "__groupfolders" / "trash" / "1" / "x.txt")) is None
    assert watcher._parse_watch_target(str(nc_root / "__groupfolders" / "versions" / "y.txt")) is None


def test_parse_non_watched_paths_rejected(nc_root):
    # appdata / trashbin / bare user dirs are not "{user}/files/…".
    assert watcher._parse_watch_target(str(nc_root / "appdata_abc" / "preview" / "1.png")) is None
    assert watcher._parse_watch_target(str(nc_root / "alice" / "files_trashbin" / "a.txt")) is None


# ── _sniff_text_mime (extensionless files) ───────────────────────────────


def test_sniff_utf8_file_is_text_plain(tmp_path):
    f = tmp_path / "burrito"
    f.write_text("carne asada burrito recipe: tortilla, beans, salsa verde…")
    assert watcher._sniff_text_mime(str(f)) == "text/plain"


def test_sniff_binary_file_is_none(tmp_path):
    f = tmp_path / "blob"
    f.write_bytes(b"\x00\x01\x02\xff binary junk \x00")
    assert watcher._sniff_text_mime(str(f)) is None


def test_sniff_empty_file_is_none(tmp_path):
    f = tmp_path / "empty"
    f.write_bytes(b"")
    assert watcher._sniff_text_mime(str(f)) is None


# ── _index → explicit status transitions ─────────────────────────────────


def test_extensionless_text_file_is_indexed_and_marked_ready(nc_root):
    """The 'burrito' case: an extensionless UTF-8 file must be indexed."""
    d = nc_root / "alice" / "files"
    d.mkdir(parents=True)
    f = d / "burrito"
    f.write_text(
        "Family burrito night plan. Ingredients: tortillas, black beans, "
        "rice, salsa verde, guacamole. Prep starts at 6pm."
    )

    statuses: list[tuple] = []
    with (
        patch.object(watcher, "_resolve_nc_file_id", return_value=42),
        patch.object(watcher, "embed_texts", side_effect=lambda texts: [[0.0] * 3 for _ in texts]),
        patch.object(watcher, "upsert_chunk") as upsert,
        patch.object(watcher, "prune_excess_chunks"),
        patch.object(watcher, "publish"),
        patch.object(
            watcher, "set_index_status",
            side_effect=lambda u, p, s, **kw: statuses.append((u, p, s, kw)),
        ),
    ):
        watcher.IndexHandler()._index(str(f))

    assert upsert.called, "extensionless text file must produce chunks"
    first = upsert.call_args_list[0][0]
    assert first[0] == "alice"  # userId
    assert first[1] == 42  # ncFileId
    assert first[2] == "/burrito"  # stored path
    # Status trail: indexing → ready.
    assert [s[2] for s in statuses] == ["indexing", "ready"]
    assert statuses[-1][3].get("nc_file_id") == 42


def test_unknown_binary_records_skipped_status(nc_root):
    d = nc_root / "alice" / "files"
    d.mkdir(parents=True)
    f = d / "blob"
    f.write_bytes(b"\x00\xffbinary" * 10)

    statuses: list[tuple] = []
    with (
        patch.object(watcher, "upsert_chunk") as upsert,
        patch.object(
            watcher, "set_index_status",
            side_effect=lambda u, p, s, **kw: statuses.append((u, p, s, kw)),
        ),
    ):
        watcher.IndexHandler()._index(str(f))

    assert not upsert.called
    assert [s[2] for s in statuses] == ["indexing", "skipped"]
    assert statuses[-1][3].get("reason") == "unknown_type"


def test_unresolvable_file_id_records_failed_status(nc_root):
    d = nc_root / "bob" / "files"
    d.mkdir(parents=True)
    f = d / "notes.txt"
    f.write_text("meeting notes about the quarterly budget and roadmap")

    statuses: list[tuple] = []
    with (
        patch.object(watcher, "_resolve_nc_file_id", return_value=None),
        patch.object(watcher, "upsert_chunk") as upsert,
        patch.object(
            watcher, "set_index_status",
            side_effect=lambda u, p, s, **kw: statuses.append((u, p, s, kw)),
        ),
    ):
        watcher.IndexHandler()._index(str(f))

    assert not upsert.called
    assert [s[2] for s in statuses] == ["indexing", "failed"]
    assert statuses[-1][3].get("reason") == "nc_file_id_unresolved"


def test_status_write_failure_never_breaks_indexing(nc_root):
    """Best-effort contract: a missing FileIndexStatus table (pre-migration
    deploy) must not take down the pipeline."""
    d = nc_root / "alice" / "files"
    d.mkdir(parents=True)
    f = d / "notes.txt"
    f.write_text("some perfectly indexable text content for the pipeline")

    with (
        patch.object(watcher, "_resolve_nc_file_id", return_value=7),
        patch.object(watcher, "embed_texts", side_effect=lambda texts: [[0.0] * 3 for _ in texts]),
        patch.object(watcher, "upsert_chunk") as upsert,
        patch.object(watcher, "prune_excess_chunks"),
        patch.object(watcher, "publish"),
        patch.object(
            watcher, "set_index_status",
            side_effect=Exception('relation "FileIndexStatus" does not exist'),
        ),
    ):
        watcher.IndexHandler()._index(str(f))  # must not raise

    assert upsert.called


# ── groupfolder (Household) indexing ─────────────────────────────────────


def test_groupfolder_file_indexes_under_household_sentinel(nc_root):
    d = nc_root / "__groupfolders" / "1" / "Trips"
    d.mkdir(parents=True)
    f = d / "burrito-plan.txt"
    f.write_text("shared household plan: burrito ingredients shopping list")

    statuses: list[tuple] = []
    with (
        patch.object(watcher, "_resolve_gf_file_id", return_value=77) as gf_resolve,
        patch.object(watcher, "embed_texts", side_effect=lambda texts: [[0.0] * 3 for _ in texts]),
        patch.object(watcher, "upsert_chunk") as upsert,
        patch.object(watcher, "prune_excess_chunks"),
        patch.object(watcher, "publish") as pub,
        patch.object(
            watcher, "set_index_status",
            side_effect=lambda u, p, s, **kw: statuses.append((u, p, s, kw)),
        ),
    ):
        watcher.IndexHandler()._index(str(f))

    gf_resolve.assert_called_once_with("__groupfolders/1/Trips/burrito-plan.txt")
    first = upsert.call_args_list[0][0]
    assert first[0] == "__household__"
    assert first[1] == 77
    assert first[2] == "/Household/Trips/burrito-plan.txt"
    assert statuses[-1][0] == "__household__"
    assert statuses[-1][1] == "/Household/Trips/burrito-plan.txt"
    assert statuses[-1][2] == "ready"
    # MQTT topic carries the household owner.
    assert pub.call_args[0][0] == "droplet/index/__household__/indexed"


def test_on_deleted_groupfolder_uses_household_identity(nc_root):
    p = nc_root / "__groupfolders" / "1" / "old.txt"

    class _Event:
        is_directory = False

        def __init__(self, src_path):
            self.src_path = src_path

    with (
        patch.object(watcher, "_resolve_gf_file_id", return_value=None),
        patch.object(watcher, "delete_chunks_for_path", return_value=2) as del_by_path,
        patch.object(watcher, "delete_index_status") as del_status,
        patch.object(watcher, "publish"),
    ):
        watcher.IndexHandler().on_deleted(_Event(str(p)))

    del_by_path.assert_called_once_with("__household__", "/Household/old.txt")
    del_status.assert_called_once_with("__household__", "/Household/old.txt")


# ── reconcile_index (startup scan) ───────────────────────────────────────


def test_reconcile_indexes_files_with_no_status_row(nc_root):
    (nc_root / "alice" / "files").mkdir(parents=True)
    (nc_root / "alice" / "files" / "a.txt").write_text("hello world content")
    (nc_root / "__groupfolders" / "2").mkdir(parents=True)
    (nc_root / "__groupfolders" / "2" / "b.txt").write_text("shared content here")
    # Hidden + part files are filtered out.
    (nc_root / "alice" / "files" / ".hidden").write_text("x")
    (nc_root / "alice" / "files" / "up.part").write_text("x")

    handler = MagicMock()
    with patch.object(watcher, "fetch_index_status_map", return_value={}):
        result = watcher.reconcile_index(handler)

    indexed_paths = sorted(c[0][0] for c in handler._index.call_args_list)
    assert indexed_paths == sorted([
        str(nc_root / "alice" / "files" / "a.txt"),
        str(nc_root / "__groupfolders" / "2" / "b.txt"),
    ])
    assert result == {"scanned": 2, "processed": 2}


def test_reconcile_skips_ready_unchanged_and_retries_stuck(nc_root):
    files_dir = nc_root / "alice" / "files"
    files_dir.mkdir(parents=True)
    ready_unchanged = files_dir / "done.txt"
    ready_unchanged.write_text("already indexed")
    ready_stale = files_dir / "stale.txt"
    ready_stale.write_text("modified after last index")
    stuck = files_dir / "stuck.txt"
    stuck.write_text("crashed mid-run")
    failed = files_dir / "failed.txt"
    failed.write_text("worth a retry on restart")

    now = os.path.getmtime(str(ready_unchanged))
    status_map = {
        ("alice", "/done.txt"): ("ready", now + 3600),   # unchanged → skip
        ("alice", "/stale.txt"): ("ready", now - 3600),  # file newer → reindex
        ("alice", "/stuck.txt"): ("indexing", now + 3600),  # stuck → retry
        ("alice", "/failed.txt"): ("failed", now + 3600),   # failed → retry
    }

    handler = MagicMock()
    with patch.object(watcher, "fetch_index_status_map", return_value=status_map):
        result = watcher.reconcile_index(handler)

    indexed = sorted(os.path.basename(c[0][0]) for c in handler._index.call_args_list)
    assert indexed == ["failed.txt", "stale.txt", "stuck.txt"]
    assert result["scanned"] == 4


def test_reconcile_skips_scan_when_status_table_unreadable(nc_root):
    (nc_root / "alice" / "files").mkdir(parents=True)
    (nc_root / "alice" / "files" / "a.txt").write_text("hello")

    handler = MagicMock()
    with patch.object(
        watcher, "fetch_index_status_map",
        side_effect=Exception('relation "FileIndexStatus" does not exist'),
    ):
        result = watcher.reconcile_index(handler)

    handler._index.assert_not_called()
    assert result == {"scanned": 0, "processed": 0}


# ── db.set_index_status SQL shape ────────────────────────────────────────


def test_set_index_status_upserts_with_conflict_clause():
    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor

    with patch("db.get_conn", return_value=fake_conn):
        from db import set_index_status

        set_index_status(
            "alice", "/a.txt", "failed", nc_file_id=9, reason="x" * 300
        )

    sql = fake_cursor.execute.call_args[0][0]
    binds = fake_cursor.execute.call_args[0][1]
    assert 'INSERT INTO "FileIndexStatus"' in sql
    assert 'ON CONFLICT ("userId", "path")' in sql
    assert binds[0] == "alice"
    assert binds[1] == "/a.txt"
    assert binds[2] == 9
    assert binds[3] == "failed"
    assert len(binds[4]) == 200  # reason truncated like BrainMemoryItem


def test_delete_index_status_scopes_to_user_and_path():
    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor

    with patch("db.get_conn", return_value=fake_conn):
        from db import delete_index_status

        delete_index_status("alice", "/a.txt")

    sql = fake_cursor.execute.call_args[0][0]
    binds = fake_cursor.execute.call_args[0][1]
    assert 'DELETE FROM "FileIndexStatus"' in sql
    assert binds == ("alice", "/a.txt")
