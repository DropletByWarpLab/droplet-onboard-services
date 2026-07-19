"""WARP-1359 — newly created files were never live-indexed.

Nextcloud WebDAV writes are atomic: the upload lands as
`<name>.ocTransferId….part` (whose create event is correctly filtered by
`_is_ignored_basename`), then a rename moves it onto the final path. That
rename reaches watchdog as `on_moved` — which `IndexHandler` did not
implement, so a brand-new file produced no indexing at all until it was
modified again or a restart ran `reconcile_index`. Verified on the staging
box: new upload → no FileIndexStatus row ever; re-upload of the same file →
processed within the debounce window.
"""

from __future__ import annotations

from unittest.mock import patch

from watchdog.events import DirMovedEvent, FileMovedEvent

import watcher


def test_part_rename_schedules_indexing_of_destination():
    """The canonical Nextcloud upload: .part source renamed to final name."""
    handler = watcher.IndexHandler()
    event = FileMovedEvent(
        "/data/alice/files/Docs/report.pdf.ocTransferId1234.part",
        "/data/alice/files/Docs/report.pdf",
    )
    with patch.object(handler, "_schedule") as schedule, \
         patch.object(handler, "on_deleted") as deleted:
        handler.on_moved(event)
    schedule.assert_called_once_with("/data/alice/files/Docs/report.pdf")
    # The .part source never had an index — no delete round-trip for it.
    deleted.assert_not_called()


def test_real_rename_drops_source_index_and_schedules_destination():
    """A genuine rename moves the file away from src: old index must go."""
    handler = watcher.IndexHandler()
    event = FileMovedEvent(
        "/data/alice/files/old-name.md",
        "/data/alice/files/new-name.md",
    )
    with patch.object(handler, "_schedule") as schedule, \
         patch.object(handler, "on_deleted") as deleted:
        handler.on_moved(event)
    schedule.assert_called_once_with("/data/alice/files/new-name.md")
    deleted.assert_called_once()
    (delete_event,), _ = deleted.call_args
    assert delete_event.src_path == "/data/alice/files/old-name.md"


def test_directory_moves_are_ignored():
    handler = watcher.IndexHandler()
    event = DirMovedEvent("/data/alice/files/A", "/data/alice/files/B")
    with patch.object(handler, "_schedule") as schedule, \
         patch.object(handler, "on_deleted") as deleted:
        handler.on_moved(event)
    schedule.assert_not_called()
    deleted.assert_not_called()
