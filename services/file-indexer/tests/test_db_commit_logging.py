"""WARP-3193 QUAL-15 — a failed commit is logged, not swallowed.

`update_item_status`, `claim_attempt` and `reconcile_stuck_items` wrap
`conn.commit()` in `except Exception`. On the module's autocommit connection
the commit is a no-op, so the fallback stays, but a real commit failure on a
non-autocommit connection used to vanish without a trace.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from unittest.mock import MagicMock

import db


def _conn(fetchone=None):
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchone.return_value = fetchone
    cur.rowcount = 2
    conn.commit.side_effect = RuntimeError("commit exploded")
    return conn


def _warned(caplog) -> bool:
    return any(
        r.levelno == logging.WARNING and "commit exploded" in r.getMessage()
        for r in caplog.records
    )


def test_update_item_status_logs_a_failed_commit(caplog):
    with caplog.at_level(logging.WARNING, logger="db"):
        db.update_item_status(_conn(), item_id="i1", status="queued_for_transcription")
    assert _warned(caplog)


def test_claim_attempt_logs_a_failed_commit(caplog):
    with caplog.at_level(logging.WARNING, logger="db"):
        assert db.claim_attempt(_conn(fetchone=(None, 0)), item_id="i1") is True
    assert _warned(caplog)


def test_claim_attempt_bump_path_logs_a_failed_commit(caplog):
    row = (datetime.now(tz=timezone.utc), 1)
    with caplog.at_level(logging.WARNING, logger="db"):
        assert db.claim_attempt(_conn(fetchone=row), item_id="i1") is True
    assert _warned(caplog)


def test_reconcile_stuck_items_logs_a_failed_commit(caplog):
    with caplog.at_level(logging.WARNING, logger="db"):
        assert db.reconcile_stuck_items(_conn()) == 2
    assert _warned(caplog)
