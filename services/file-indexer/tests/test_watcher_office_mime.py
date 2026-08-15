"""WARP-1842 — Office/ODF documents must index: explicit MIME registration
+ reconcile healing for `skipped/unknown_type` rows.

Root cause (verified live on the lab box, 2026-08-10): the shipped image
(python:3.12-slim) has NO system MIME tables — every path in
`mimetypes.knownfiles` is absent — and Python 3.12's built-in table lacks
OOXML/ODF. `mimetypes.guess_type("a.docx")` returned `(None, None)`, the
zip magic (NUL bytes) correctly defeated `_sniff_text_mime`, and every
.docx/.xlsx/.pptx/.odt landed `skipped/unknown_type` BEFORE
`extractors.registry.dispatch()` could route to the existing docx/pptx
extractors. Compounding defect: `reconcile_index()` never retried
`skipped` rows with unchanged mtime, so fixing the guess alone could not
heal an already-skipped corpus.

Dev machines and CI runners DO have OS MIME tables (Windows registry,
/etc/mime.types), which is exactly why this bug never reproduced outside
the container — so the tests here simulate the container's bare-table
state with a pristine ``mimetypes.MimeTypes(filenames=())`` DB instead of
trusting whatever the host happens to ship.
"""

from __future__ import annotations

import mimetypes
import os
import shutil
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import watcher
from anchor_schema import NoneAnchor
from extractors.registry import EXTRACTOR_CAPABILITY
from extractors.spans import Span


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
ODT_MIME = "application/vnd.oasis.opendocument.text"

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def nc_root(tmp_path, monkeypatch):
    """Point the watcher at a throwaway Nextcloud data root."""
    monkeypatch.setattr(watcher, "NEXTCLOUD_DATA_ROOT", str(tmp_path))
    return tmp_path


@pytest.fixture
def bare_mime_db(monkeypatch):
    """Simulate the shipped container: no OS MIME tables at all.

    ``MimeTypes(filenames=())`` seeds ONLY Python's built-in table — no
    ``mimetypes.knownfiles`` read, no Windows-registry read — which is
    precisely the state proven live on the lab box (WARP-1842). The
    module-level ``mimetypes.guess_type`` / ``add_type`` delegate to the
    swapped-in ``_db``, so `watcher._index` sees the container condition.
    """
    fresh = mimetypes.MimeTypes(filenames=())
    monkeypatch.setattr(mimetypes, "_db", fresh)
    return fresh


# ── MIME registration ────────────────────────────────────────────────────


def test_register_office_mime_types_fixes_bare_container_tables(bare_mime_db):
    if sys.version_info < (3, 13):
        # Premise (the live-verified bug): on Python 3.12 — the shipped
        # container + CI pin — the built-in table cannot guess OOXML/ODF.
        # (3.13+ added these upstream; the explicit registration then
        # becomes harmless belt-and-suspenders, so don't assert absence.)
        assert mimetypes.guess_type("report.docx") == (None, None)
        assert mimetypes.guess_type("notes.odt") == (None, None)

    watcher.register_office_mime_types()

    assert mimetypes.guess_type("report.docx")[0] == DOCX_MIME
    assert mimetypes.guess_type("budget.xlsx")[0] == XLSX_MIME
    assert mimetypes.guess_type("deck.pptx")[0] == PPTX_MIME
    assert mimetypes.guess_type("legacy.doc")[0] == "application/msword"
    assert mimetypes.guess_type("notes.odt")[0] == ODT_MIME
    assert (
        mimetypes.guess_type("sheet.ods")[0]
        == "application/vnd.oasis.opendocument.spreadsheet"
    )
    assert (
        mimetypes.guess_type("slides.odp")[0]
        == "application/vnd.oasis.opendocument.presentation"
    )
    assert (
        mimetypes.guess_type("draw.odg")[0]
        == "application/vnd.oasis.opendocument.graphics"
    )


def test_register_office_mime_types_is_idempotent(bare_mime_db):
    """Repeat registration converges — no error, no duplicate inverse
    entries (`add_type` overwrites + de-dupes)."""
    watcher.register_office_mime_types()
    watcher.register_office_mime_types()
    assert mimetypes.guess_type("report.docx")[0] == DOCX_MIME
    assert mimetypes.guess_all_extensions(DOCX_MIME).count(".docx") == 1


def test_watcher_import_registers_ooxml_and_odf_globally():
    """Ticket contract: importing `watcher` makes the GLOBAL table guess
    OOXML/ODF no matter what the OS ships. (On hosts with OS MIME tables
    this can pass pre-fix; the bare-table tests above are the ones that
    pin the container condition.)"""
    assert mimetypes.guess_type("x.docx")[0] == DOCX_MIME
    assert mimetypes.guess_type("x.xlsx")[0] == XLSX_MIME
    assert mimetypes.guess_type("x.pptx")[0] == PPTX_MIME
    assert mimetypes.guess_type("x.odt")[0] == ODT_MIME


# ── _index routing under the container condition ─────────────────────────


def test_index_docx_reaches_docx_extractor_not_unknown_type(
    nc_root, bare_mime_db, monkeypatch
):
    """End-to-endish: with bare container tables + the import-time
    registration re-applied (exactly what happens on container boot), a
    .docx must route through dispatch() to the docx extractor and land
    `ready` — not `skipped/unknown_type`."""
    watcher.register_office_mime_types()

    d = nc_root / "alice" / "files"
    d.mkdir(parents=True)
    f = d / "report.docx"
    shutil.copyfile(FIXTURES / "sample.docx", f)

    seen: dict = {}

    def fake_docx_extract(path):
        seen["path"] = path
        return {
            "spans": [
                Span(
                    text="Quarterly report body — plenty of content to index.",
                    anchor=NoneAnchor(),
                )
            ],
            "language": None,
            "metadata": {"extractor_name": "docx"},
            "warnings": [],
        }

    # The registry lazy-imports `extractors.docx.extract` at route time, so
    # patching the module attribute intercepts the real dispatch path.
    monkeypatch.setattr("extractors.docx.extract", fake_docx_extract)

    statuses: list[tuple] = []
    with (
        patch.object(watcher, "_resolve_nc_file_id", return_value=42),
        patch.object(
            watcher, "embed_texts", side_effect=lambda texts: [[0.0] * 3 for _ in texts]
        ),
        patch.object(watcher, "upsert_chunk") as upsert,
        patch.object(watcher, "prune_excess_chunks"),
        patch.object(watcher, "publish"),
        patch.object(
            watcher,
            "set_index_status",
            side_effect=lambda u, p, s, **kw: statuses.append((u, p, s, kw)),
        ),
    ):
        watcher.IndexHandler()._index(str(f))

    assert seen.get("path") == str(f), "docx extractor was never reached"
    assert upsert.called
    assert [s[2] for s in statuses] == ["indexing", "ready"]
    assert statuses[-1][3].get("nc_file_id") == 42


def test_index_xlsx_lands_unsupported_not_unknown_type(nc_root, bare_mime_db):
    """Types registered WITHOUT an extractor (.xlsx — deliberately out of
    WARP-1842 scope) must take the honest
    `skipped/unsupported_or_failed_extraction` path via dispatch()
    returning None — no longer `unknown_type`."""
    watcher.register_office_mime_types()

    d = nc_root / "alice" / "files"
    d.mkdir(parents=True)
    f = d / "budget.xlsx"
    # Zip magic + NUL padding: the plain-text sniffer must not claim it.
    f.write_bytes(b"PK\x03\x04" + b"\x00" * 64)

    statuses: list[tuple] = []
    with (
        patch.object(watcher, "upsert_chunk") as upsert,
        patch.object(
            watcher,
            "set_index_status",
            side_effect=lambda u, p, s, **kw: statuses.append((u, p, s, kw)),
        ),
    ):
        watcher.IndexHandler()._index(str(f))

    assert not upsert.called
    assert [s[2] for s in statuses] == ["indexing", "skipped"]
    assert statuses[-1][3].get("reason") == "unsupported_or_failed_extraction"


# ── reconcile heals `skipped/unknown_type` (and ONLY that skip reason) ───


def test_reconcile_retries_skipped_unknown_type_but_not_other_skips(nc_root):
    """With the CURRENT extractor generation stamped on every row, only
    `skipped/unknown_type` is re-processed (the MIME fix genuinely resolves
    it); `empty_extraction` and `unsupported_or_failed_extraction` stay
    terminal — retrying those would churn the skipped corpus on every
    restart for an outcome the same extractors cannot change.

    WARP-2056 narrowed the premise to "the same extractors": see
    `test_reconcile_retries_every_skip_from_an_older_generation`.
    """
    files_dir = nc_root / "alice" / "files"
    files_dir.mkdir(parents=True)
    stuck_docx = files_dir / "report.docx"
    stuck_docx.write_bytes(b"PK\x03\x04docx-ish")
    empty_note = files_dir / "empty-note.txt"
    empty_note.write_text("x")
    unsupported = files_dir / "model.blend"
    unsupported.write_bytes(b"\x00binary")

    # updatedAt AFTER each file's mtime — nothing is stale on disk, so only
    # the reason-based retry can explain a re-run.
    later = os.path.getmtime(str(stuck_docx)) + 3600
    cap = EXTRACTOR_CAPABILITY
    status_map = {
        ("alice", "/report.docx"): ("skipped", later, "unknown_type", cap),
        ("alice", "/empty-note.txt"): ("skipped", later, "empty_extraction", cap),
        ("alice", "/model.blend"): (
            "skipped", later, "unsupported_or_failed_extraction", cap,
        ),
    }

    handler = MagicMock()
    with patch.object(watcher, "fetch_index_status_map", return_value=status_map):
        result = watcher.reconcile_index(handler)

    retried = sorted(os.path.basename(c[0][0]) for c in handler._index.call_args_list)
    assert retried == ["report.docx"]
    assert result["scanned"] == 3
    assert result["processed"] == 1


def test_reconcile_retries_every_skip_from_an_older_generation(nc_root):
    """WARP-2056 — a skip recorded by extractors that have since changed is
    re-examined whatever its reason.

    This is the case that kept needing a manual `DELETE FROM
    "FileIndexStatus"` on live boxes: the PDF OCR fallback turned
    `empty_extraction` scans into indexed documents, and the spreadsheet/ODF
    extractors turned `unsupported_or_failed_extraction` into real text —
    but the reconcile went on treating both as permanent.
    """
    files_dir = nc_root / "alice" / "files"
    files_dir.mkdir(parents=True)
    scan = files_dir / "referral.pdf"
    scan.write_bytes(b"%PDF-1.4 scanned")
    sheet = files_dir / "referrals.xlsx"
    sheet.write_bytes(b"PK\x03\x04xlsx-ish")

    later = os.path.getmtime(str(scan)) + 3600
    status_map = {
        # Stamped by an older generation — verdicts no longer trustworthy.
        ("alice", "/referral.pdf"): ("skipped", later, "empty_extraction", "1"),
        ("alice", "/referrals.xlsx"): (
            "skipped", later, "unsupported_or_failed_extraction", "2",
        ),
    }

    handler = MagicMock()
    with patch.object(watcher, "fetch_index_status_map", return_value=status_map):
        result = watcher.reconcile_index(handler)

    retried = sorted(os.path.basename(c[0][0]) for c in handler._index.call_args_list)
    assert retried == ["referral.pdf", "referrals.xlsx"]
    assert result["processed"] == 2


def test_reconcile_leaves_ready_rows_alone_across_a_generation_bump(nc_root):
    """Only `skipped` verdicts expire. A generation bump must not re-index
    the whole ready corpus — that would be a full re-embed on every
    release."""
    files_dir = nc_root / "alice" / "files"
    files_dir.mkdir(parents=True)
    done = files_dir / "notes.txt"
    done.write_text("already indexed")

    status_map = {
        ("alice", "/notes.txt"): (
            "ready", os.path.getmtime(str(done)) + 3600, None, "1",
        ),
    }

    handler = MagicMock()
    with patch.object(watcher, "fetch_index_status_map", return_value=status_map):
        result = watcher.reconcile_index(handler)

    handler._index.assert_not_called()
    assert result == {"scanned": 1, "processed": 0}


def test_reconcile_tolerates_short_legacy_status_tuples(nc_root):
    """Backward-safe: shorter map tuples (the pre-WARP-1842 2-tuple and the
    pre-WARP-2056 3-tuple) must not crash the scan on the missing elements.

    A row carrying no generation is treated as pre-stamp and therefore
    stale, so it gets one pass — which is the intended heal, not a churn:
    `_index` re-stamps it with the current generation, and the next
    reconcile leaves it alone."""
    files_dir = nc_root / "alice" / "files"
    files_dir.mkdir(parents=True)
    two = files_dir / "old.bin"
    two.write_bytes(b"\x00")
    three = files_dir / "older.bin"
    three.write_bytes(b"\x00")

    status_map = {
        ("alice", "/old.bin"): ("skipped", os.path.getmtime(str(two)) + 3600),
        ("alice", "/older.bin"): (
            "skipped", os.path.getmtime(str(three)) + 3600, "empty_extraction",
        ),
    }

    handler = MagicMock()
    with patch.object(watcher, "fetch_index_status_map", return_value=status_map):
        result = watcher.reconcile_index(handler)

    assert result["scanned"] == 2
    assert result["processed"] == 2


# ── db.fetch_index_status_map carries the reason ─────────────────────────


def test_fetch_index_status_map_includes_reason_and_capability():
    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor
    fake_cursor.fetchall.return_value = [
        ("alice", "/a.docx", "skipped", 1000.0, "unknown_type", "2"),
        ("alice", "/b.txt", "ready", 2000.0, None, "3"),
        # Written before the column existed.
        ("alice", "/c.pdf", "skipped", 3000.0, "empty_extraction", None),
    ]

    with patch("db.get_conn", return_value=fake_conn):
        from db import fetch_index_status_map

        status_map = fetch_index_status_map()

    sql = fake_cursor.execute.call_args[0][0]
    assert '"reason"' in sql
    assert '"extractorCapability"' in sql
    assert status_map[("alice", "/a.docx")] == ("skipped", 1000.0, "unknown_type", "2")
    assert status_map[("alice", "/b.txt")] == ("ready", 2000.0, None, "3")
    assert status_map[("alice", "/c.pdf")] == (
        "skipped", 3000.0, "empty_extraction", None,
    )
