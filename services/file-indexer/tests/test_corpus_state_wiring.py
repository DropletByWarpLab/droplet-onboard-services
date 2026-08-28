"""WARP-2196 — the staleness guard is actually WIRED IN, and fails closed.

QA finding: `corpus_state` itself was well tested, but the code that INVOKES
it was not. Deleting the whole startup block from `main()` left the suite
green, and the block's own `except` swallowed the failure without blocking
writes — fail-OPEN on the escape path of a guard whose entire job is to fail
closed.

These tests defend the wiring rather than the logic:

  * the startup check runs, and runs BEFORE any write path starts
  * every failure route out of it blocks writes
  * `brain_ingest.reindex_one` — the one write path that bypasses
    `db.upsert_chunk` by opening its own connection — carries the gate too
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

import corpus_state as cs


@pytest.fixture(autouse=True)
def _clear_block():
    cs.clear_write_block()
    yield
    cs.clear_write_block()


# ---------------------------------------------------------------------------
# main._enforce_corpus_state — every escape route must block writes
# ---------------------------------------------------------------------------


def test_a_crash_in_the_check_blocks_writes(monkeypatch):
    """`check_corpus_model` fail-closes internally, but a throw from anywhere
    else in the block used to land in a bare `except` that only logged."""
    import main

    def _boom(_conn):
        raise RuntimeError("something unexpected")

    monkeypatch.setattr(cs, "check_corpus_model", _boom)

    main._enforce_corpus_state(lambda: MagicMock())

    assert cs.writes_blocked(), "a crashed startup check must block writes"
    assert "scripts/rag-re-embed.sh" in cs.write_block_reason()


def test_a_failing_connection_factory_blocks_writes(monkeypatch):
    """`get_conn()` re-probes the connection and can reconnect, so it can
    throw here even though the earlier connectivity check passed."""
    import main

    def _no_db():
        raise RuntimeError("could not connect to server")

    main._enforce_corpus_state(_no_db)

    assert cs.writes_blocked()
    assert "could not connect to server" in cs.write_block_reason()


def test_a_failing_stamp_blocks_writes(monkeypatch):
    """The fresh-corpus path WRITES the marker. If that write fails we have
    neither a marker nor a right to assume the corpus is ours."""
    import main

    conn = MagicMock()
    cur = MagicMock()
    cur.fetchone.side_effect = [None, (0,)]  # no marker, empty corpus
    conn.cursor.return_value.__enter__.return_value = cur

    def _boom(_conn, _model):
        raise RuntimeError("read-only transaction")

    monkeypatch.setattr(cs, "stamp_corpus_model", _boom)

    main._enforce_corpus_state(lambda: conn)

    assert cs.writes_blocked()


def test_a_clean_box_leaves_writes_open(monkeypatch):
    """The guard must not be a permanent brake on a healthy box."""
    import main

    conn = MagicMock()
    cur = MagicMock()
    cur.fetchone.side_effect = [None, (0,)]  # fresh corpus
    conn.cursor.return_value.__enter__.return_value = cur

    main._enforce_corpus_state(lambda: conn)

    assert not cs.writes_blocked()


def test_a_mismatch_blocks_writes_through_the_wiring(monkeypatch):
    import main

    conn = MagicMock()
    cur = MagicMock()
    cur.fetchone.side_effect = [("all-MiniLM-L6-v2",), (500,)]
    conn.cursor.return_value.__enter__.return_value = cur

    main._enforce_corpus_state(lambda: conn)

    assert cs.writes_blocked()
    assert "scripts/rag-re-embed.sh" in cs.write_block_reason()


# ---------------------------------------------------------------------------
# Ordering: the verdict is in before any write path starts
# ---------------------------------------------------------------------------


class _StopMain(BaseException):
    """Aborts main() at a chosen point.

    Derives from BaseException, not Exception, precisely so main()'s
    `except Exception` handlers cannot swallow it.
    """


def test_main_checks_the_corpus_before_starting_brain_ingest(monkeypatch, tmp_path):
    """Order matters: brain-ingest subscribes to an MQTT topic and starts
    WRITING chunks. If the verdict is not in first, a stale box can accept an
    upload and mix vector spaces before it ever decides it was not allowed to.
    """
    import brain_ingest
    import db
    import main
    import mqtt_client

    calls: list[str] = []

    monkeypatch.setattr(main, "_run_fips_boot_self_test", lambda: None)
    monkeypatch.setattr(main.os.path, "isdir", lambda _p: True)
    monkeypatch.setattr(mqtt_client, "connect", lambda *a, **k: None)
    monkeypatch.setattr(db, "get_conn", lambda: MagicMock())

    def _check(_conn):
        calls.append("check_corpus_model")
        return cs.VERDICT_MATCH

    def _start_brain_ingest():
        calls.append("start_brain_ingest")
        raise _StopMain()

    monkeypatch.setattr(cs, "check_corpus_model", _check)
    monkeypatch.setattr(brain_ingest, "start_brain_ingest", _start_brain_ingest)

    with pytest.raises(_StopMain):
        main.main()

    assert calls == ["check_corpus_model", "start_brain_ingest"], calls


# ---------------------------------------------------------------------------
# reindex_one — the write path that bypasses db.upsert_chunk
# ---------------------------------------------------------------------------


def test_reindex_one_refuses_to_write_while_blocked(monkeypatch):
    """`reindex_one` opens its OWN psycopg2 connection and INSERTs directly,
    so `db.upsert_chunk`'s gate never sees it. Without its own guard, the
    admin re-index route is a way to slip a second model's vectors into the
    corpus while the rest of the service is correctly refusing.
    """
    import brain_ingest

    conn = MagicMock()
    cur = MagicMock()
    cur.fetchone.side_effect = [("all-MiniLM-L6-v2",), (42,)]
    conn.cursor.return_value.__enter__.return_value = cur
    cs.check_corpus_model(conn, model="bge-small-en-v1.5")
    assert cs.writes_blocked()

    # `reindex_one` does `from db import fetch_item` locally, so the module
    # attribute to patch is db's. If the guard is absent, execution reaches it.
    def _must_not_run(*a, **k):
        raise AssertionError("reindex_one proceeded past the corpus guard")

    monkeypatch.setattr("db.fetch_item", _must_not_run)

    with pytest.raises(cs.CorpusModelMismatch) as exc:
        brain_ingest.reindex_one("bmi-123")
    assert "scripts/rag-re-embed.sh" in str(exc.value)


def test_reindex_one_proceeds_when_the_corpus_matches(monkeypatch):
    """The guard must not brick the admin re-index on a healthy box."""
    import brain_ingest

    cs.clear_write_block()

    reached = {}

    def _fetch(_conn, *, item_id):
        reached["item_id"] = item_id
        raise _StopMain()

    monkeypatch.setattr("db.fetch_item", _fetch)
    monkeypatch.setattr("db.get_conn", lambda: MagicMock())

    with pytest.raises(_StopMain):
        brain_ingest.reindex_one("bmi-123")

    assert reached["item_id"] == "bmi-123"
