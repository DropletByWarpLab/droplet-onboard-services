"""WARP-218: db helpers for the BrainMemoryItem status surface.

Helpers run plain psycopg parametrised SQL — same style as upsert_chunk.
We mock the connection cursor so unit tests stay free of Postgres.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import db
from db import (
    select_queued_items,
    update_item_status,
    claim_attempt,
    reconcile_stuck_items,
    mark_brain_item_indexed,
)


def _fake_conn():
    conn = MagicMock()
    cursor = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    return conn, cursor


def test_select_queued_items_filters_by_status_and_orders_oldest_first():
    conn, cur = _fake_conn()
    cur.fetchall.return_value = []
    select_queued_items(conn, limit=50)
    sql = cur.execute.call_args[0][0]
    assert "status" in sql
    assert "queued_for_transcription" in sql
    assert "ORDER BY" in sql.upper()
    assert "uploadedAt" in sql or '"uploadedAt"' in sql


def test_update_item_status_writes_status_and_failure_reason():
    conn, cur = _fake_conn()
    update_item_status(
        conn,
        item_id="bmi-1",
        status="ready",
        failure_reason=None,
    )
    sql = cur.execute.call_args[0][0]
    binds = cur.execute.call_args[0][1]
    assert "UPDATE" in sql.upper()
    assert "status" in sql
    assert "ready" in binds
    assert "bmi-1" in binds


def test_update_item_status_sets_indexed_at_when_ready():
    """status='ready' transitions also set indexedAt + clear retry-window fields."""
    conn, cur = _fake_conn()
    update_item_status(
        conn,
        item_id="bmi-1",
        status="ready",
    )
    sql = cur.execute.call_args[0][0]
    assert "indexedAt" in sql
    assert "recentAttemptCount" in sql  # reset to 0


def test_claim_attempt_first_attempt_opens_window():
    """Fresh row → claim_attempt returns True, opens new window."""
    conn, cur = _fake_conn()
    cur.fetchone.return_value = (None, 0)
    ok = claim_attempt(conn, item_id="bmi-1")
    assert ok is True
    assert cur.execute.call_count >= 2
    update_sql = cur.execute.call_args_list[-1][0][0]
    assert "recentAttemptCount" in update_sql


def test_claim_attempt_within_window_increments():
    """Window open, count<3 → returns True."""
    conn, cur = _fake_conn()
    cur.fetchone.return_value = (
        datetime.now(tz=timezone.utc) - timedelta(minutes=10),
        2,
    )
    ok = claim_attempt(conn, item_id="bmi-1")
    assert ok is True


def test_claim_attempt_caps_out_at_3_within_window():
    """Window open, count=3 → returns False, no UPDATE fired."""
    conn, cur = _fake_conn()
    cur.fetchone.return_value = (
        datetime.now(tz=timezone.utc) - timedelta(minutes=10),
        3,
    )
    ok = claim_attempt(conn, item_id="bmi-1")
    assert ok is False
    # Only the SELECT, no UPDATE.
    assert cur.execute.call_count == 1


def test_claim_attempt_resets_window_after_1_hour():
    """Window opened 90 min ago → fresh window, count=1."""
    conn, cur = _fake_conn()
    cur.fetchone.return_value = (
        datetime.now(tz=timezone.utc) - timedelta(hours=2),
        3,
    )
    ok = claim_attempt(conn, item_id="bmi-1")
    assert ok is True


def test_reconcile_stuck_items_flips_indexing_older_than_6h_back_to_queued():
    conn, cur = _fake_conn()
    cur.rowcount = 2
    n = reconcile_stuck_items(conn, stuck_after_hours=6)
    sql = cur.execute.call_args[0][0]
    assert "UPDATE" in sql.upper()
    assert "queued_for_transcription" in sql
    assert "indexing" in sql
    assert "lastAttemptedAt" in sql
    assert n == 2


def test_fetch_item_returns_dict_for_known_row():
    conn, cur = _fake_conn()
    cur.fetchone.return_value = (
        "bmi-1",
        "alice",
        "/tmp/x.wav",
        "audio/wav",
    )
    from db import fetch_item

    item = fetch_item(conn, item_id="bmi-1")
    assert item == {
        "id": "bmi-1",
        "userId": "alice",
        "storagePath": "/tmp/x.wav",
        "mimeType": "audio/wav",
    }


def test_fetch_item_returns_none_for_missing_row():
    conn, cur = _fake_conn()
    cur.fetchone.return_value = None
    from db import fetch_item

    assert fetch_item(conn, item_id="missing") is None


# ── WARP-330: mark_brain_item_indexed must flip status, not just indexedAt ──
#
# Regression cover for the /context page bug where chat-attached files
# showed "never reached ready" for ~24h+ after upload. The synchronous
# brain_ingest path was writing indexedAt=NOW() but leaving the row at
# status='indexing' (the default). The dashboard's pipeline-health
# aggregate filters on `status='ready'`, so the rows never counted.
# Per CLAUDE.md: persistent state must live in explicit columns; do not
# leave the status column in a stale state and expect readers to derive
# it from indexedAt.


def test_mark_brain_item_indexed_default_writes_status_ready(monkeypatch):
    """Default call (no args beyond id/warnings) must set status='ready'
    atomically with indexedAt — single UPDATE, no separate round-trip."""
    conn, cur = _fake_conn()
    monkeypatch.setattr(db, "get_conn", lambda: conn)

    mark_brain_item_indexed("bmi-1", warnings=["w1"])

    assert cur.execute.call_count == 1, "must be a single UPDATE statement"
    sql, binds = cur.execute.call_args[0]
    sql_norm = " ".join(sql.split())
    assert "UPDATE" in sql_norm.upper()
    assert '"indexedAt" = NOW()' in sql_norm
    assert '"status" = \'ready\'' in sql_norm
    # Retry-window cleared on success, matching update_item_status('ready').
    assert '"recentAttemptCount" = 0' in sql_norm
    assert '"recentAttemptWindowStartedAt" = NULL' in sql_norm
    assert '"failureReason" = NULL' in sql_norm
    # Warnings + id passed through.
    assert "bmi-1" in binds
    assert ["w1"] in binds


def test_mark_brain_item_indexed_failed_writes_status_failed(monkeypatch):
    """status='failed' path must persist failure_reason + status, not just
    publish over MQTT. Without this, dashboard 'failed' counts under-report."""
    conn, cur = _fake_conn()
    monkeypatch.setattr(db, "get_conn", lambda: conn)

    mark_brain_item_indexed(
        "bmi-2",
        status="failed",
        failure_reason="extractor_unavailable",
        warnings=["extractor_unavailable"],
    )

    assert cur.execute.call_count == 1
    sql, binds = cur.execute.call_args[0]
    sql_norm = " ".join(sql.split())
    assert '"status" = \'failed\'' in sql_norm
    assert '"failureReason"' in sql_norm
    assert "extractor_unavailable" in binds
    assert "bmi-2" in binds


def test_mark_brain_item_indexed_failure_reason_truncated(monkeypatch):
    """Match update_item_status's 200-char failure_reason cap so the column
    width doesn't get blown out by a long traceback message."""
    conn, cur = _fake_conn()
    monkeypatch.setattr(db, "get_conn", lambda: conn)

    long_reason = "x" * 500
    mark_brain_item_indexed("bmi-3", status="failed", failure_reason=long_reason)

    binds = cur.execute.call_args[0][1]
    # The truncated reason (<=200 chars) must appear in the bind tuple;
    # the full 500-char string must not.
    assert any(isinstance(b, str) and b == "x" * 200 for b in binds)
    assert long_reason not in binds
