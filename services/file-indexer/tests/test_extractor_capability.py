"""A `skipped` verdict must expire when the extractors that made it change.

The reconcile has always treated `skipped` as terminal on the premise that
the outcome "cannot change". That holds only while the extractors don't —
and healing live boxes after an extractor change has now required a manual
DELETE of status rows three times (WARP-1842 Office MIMEs, WARP-2051 PDF
OCR, WARP-2055 spreadsheet/ODF/legacy-Word).
"""
from __future__ import annotations

import pytest

from extractors.registry import EXTRACTOR_CAPABILITY, _route
from watcher import RECONCILE_RETRY_SKIP_REASONS, _skip_verdict_is_stale


def test_current_generation_is_not_stale():
    assert _skip_verdict_is_stale(EXTRACTOR_CAPABILITY) is False


def test_an_older_generation_is_stale():
    assert _skip_verdict_is_stale("2") is True


def test_rows_predating_the_column_are_stale():
    """NULL capability = written before WARP-2056; give it one pass."""
    assert _skip_verdict_is_stale(None) is True


# Every MIME the registry routes to a real extractor. Pinned so that adding
# a format without bumping EXTRACTOR_CAPABILITY fails here: without the bump,
# boxes that already skipped those files would never retry them, and the new
# extractor would only ever apply to newly-uploaded content.
EXPECTED_ROUTED_MIMES = {
    # documents
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/vnd.ms-word",
    # spreadsheets
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "application/vnd.ms-excel",
    "application/msexcel",
    # presentations
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    # OpenDocument
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/vnd.oasis.opendocument.graphics",
    # structured text
    "application/json",
    "application/xml",
}


@pytest.mark.parametrize("mime", sorted(EXPECTED_ROUTED_MIMES))
def test_every_pinned_mime_still_routes(mime):
    assert _route(mime) is not None, f"{mime} lost its extractor"


def test_capability_was_bumped_for_the_current_format_set():
    """Tripwire, not a truth: if you added a routed MIME, add it above AND
    bump EXTRACTOR_CAPABILITY so live boxes re-examine their skipped files."""
    assert EXTRACTOR_CAPABILITY == "3", (
        "EXTRACTOR_CAPABILITY changed — update EXPECTED_ROUTED_MIMES and this "
        "assertion together, and confirm the bump is intentional"
    )


def test_unknown_type_stays_retryable_for_legacy_rows():
    """WARP-1842's reason-based trigger still covers rows whose capability
    happens to match but whose MIME was unresolvable at the time."""
    assert "unknown_type" in RECONCILE_RETRY_SKIP_REASONS


def test_an_unroutable_mime_returns_none():
    assert _route("application/x-msdownload") is None
