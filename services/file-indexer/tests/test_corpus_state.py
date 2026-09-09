"""WARP-2196 — the corpus-staleness guard.

WHY THIS EXISTS
---------------
The MiniLM -> bge re-embed is operator-gated, not an auto-running migration.
That is only SAFER than auto-run if skipping the step fails LOUD. If a box
takes the update and never runs the re-embed, new chunks are embedded with bge
while the existing corpus is MiniLM. Both models are 384-dimensional, so
Postgres stores and compares them side by side without complaint, cosine
distance across the two spaces is noise, and there is no way to tell the two
apart after the fact. Search would be confidently wrong, permanently —
strictly worse than a scheduled outage.

So the box records WHICH model built the current corpus and refuses to add to
a corpus it did not build.

Fail-closed on WRITES, not reads: a stale box keeps answering from its
existing (self-consistent) corpus and refuses to mix new vectors in. Going
dark on reads would turn a recoverable "you owe us a maintenance window" into
a total search outage for a box whose data is still perfectly usable.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

import corpus_state as cs


def _conn(marker, chunk_count):
    """Fake psycopg2 connection: one SELECT for the marker, one for the count."""
    cur = MagicMock()
    cur.fetchone.side_effect = [
        None if marker is None else (marker,),
        (chunk_count,),
    ]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    return conn, cur


@pytest.fixture(autouse=True)
def _clear_block():
    """The write block is module state; never let it leak between tests."""
    cs.clear_write_block()
    yield
    cs.clear_write_block()


# ---------------------------------------------------------------------------
# Fresh box — an appliance's first boot cannot require an operator step
# ---------------------------------------------------------------------------


def test_fresh_box_no_marker_no_chunks_passes_and_stamps():
    conn, cur = _conn(marker=None, chunk_count=0)

    verdict = cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    assert verdict == cs.VERDICT_STAMPED
    assert not cs.writes_blocked()
    upserts = [c for c in cur.execute.call_args_list if "INSERT INTO" in str(c[0][0])]
    assert upserts, "fresh box must stamp the marker"
    assert cs.CORPUS_MODEL_KEY in str(upserts[0])
    assert "bge-small-en-v1.5" in str(upserts[0])


def test_empty_corpus_with_stale_marker_restamps_and_passes():
    """This is how the operator re-embed COMPLETES.

    scripts/rag-re-embed.sh deletes every chunk; on the next file-indexer
    start the corpus is empty, so the marker is simply re-stamped to the
    configured model and indexing proceeds. No separate "mark it done" step
    for the operator to forget.
    """
    conn, _cur = _conn(marker="all-MiniLM-L6-v2", chunk_count=0)

    verdict = cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    assert verdict == cs.VERDICT_STAMPED
    assert not cs.writes_blocked()


# ---------------------------------------------------------------------------
# Steady state
# ---------------------------------------------------------------------------


def test_marker_matches_configured_model_passes():
    conn, _cur = _conn(marker="bge-small-en-v1.5", chunk_count=12345)

    verdict = cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    assert verdict == cs.VERDICT_MATCH
    assert not cs.writes_blocked()


# ---------------------------------------------------------------------------
# The cases that must BLOCK
# ---------------------------------------------------------------------------


def test_marker_differs_with_chunks_present_blocks_writes():
    conn, _cur = _conn(marker="all-MiniLM-L6-v2", chunk_count=12345)

    verdict = cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    assert verdict == cs.VERDICT_BLOCKED
    assert cs.writes_blocked()


def test_legacy_corpus_with_no_marker_blocks_writes():
    """The upgrade path, and the single most important case.

    A box that indexed its corpus before this guard existed has chunks and no
    marker. Their provenance is unknown and — on any box upgrading through
    WARP-2196 — is MiniLM. Treating "no marker" as "probably fine" would let
    exactly the mixed-space corpus this guard exists to prevent build up
    silently on every existing appliance.
    """
    conn, _cur = _conn(marker=None, chunk_count=12345)

    verdict = cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    assert verdict == cs.VERDICT_BLOCKED
    assert cs.writes_blocked()


def test_a_blocked_box_does_not_stamp_the_marker():
    """Stamping while blocked would erase the evidence and unblock the box."""
    conn, cur = _conn(marker="all-MiniLM-L6-v2", chunk_count=99)

    cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    upserts = [c for c in cur.execute.call_args_list if "INSERT INTO" in str(c[0][0])]
    assert upserts == []


# ---------------------------------------------------------------------------
# The error has to be ACTIONABLE — an unactionable error is the failure mode
# ---------------------------------------------------------------------------


def test_block_message_names_the_recovery_command_and_runbook():
    conn, _cur = _conn(marker="all-MiniLM-L6-v2", chunk_count=12345)
    cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    msg = cs.write_block_reason()
    assert msg
    # The exact command to run, not a vague "see the docs".
    assert "scripts/rag-re-embed.sh" in msg
    assert "docs/RAG_RE_EMBED_RUNBOOK.md" in msg
    # Both sides of the mismatch, so the operator can tell which way to go.
    assert "all-MiniLM-L6-v2" in msg
    assert "bge-small-en-v1.5" in msg
    # The scale of what is stuck.
    assert "12345" in msg


def test_block_is_logged_at_error_not_warning(caplog):
    """A warning scrolls past. This has to stop someone."""
    conn, _cur = _conn(marker="all-MiniLM-L6-v2", chunk_count=7)

    with caplog.at_level("WARNING"):
        cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    errors = [r for r in caplog.records if r.levelname == "ERROR"]
    assert errors, "a blocked corpus must log at ERROR"
    assert "scripts/rag-re-embed.sh" in errors[0].getMessage()


def test_legacy_no_marker_message_explains_the_unknown_provenance():
    conn, _cur = _conn(marker=None, chunk_count=500)
    cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    msg = cs.write_block_reason()
    assert "scripts/rag-re-embed.sh" in msg
    assert "bge-small-en-v1.5" in msg
    # Names the situation rather than pretending it knows the old model.
    assert "unknown" in msg.lower()


# ---------------------------------------------------------------------------
# The gate itself
# ---------------------------------------------------------------------------


def test_raise_if_write_blocked_is_a_noop_when_clear():
    cs.clear_write_block()
    cs.raise_if_write_blocked()  # must not raise


def test_raise_if_write_blocked_raises_with_the_actionable_message():
    conn, _cur = _conn(marker="all-MiniLM-L6-v2", chunk_count=3)
    cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    with pytest.raises(cs.CorpusModelMismatch) as exc:
        cs.raise_if_write_blocked()
    assert "scripts/rag-re-embed.sh" in str(exc.value)


def test_upsert_chunk_refuses_to_write_while_blocked():
    """The gate lives at the db chokepoint, not in each caller.

    watcher.py, brain_ingest.py and transcription_worker.py all funnel through
    ``db.upsert_chunk``; gating there means a future write path cannot forget
    to ask.
    """
    conn, _cur = _conn(marker="all-MiniLM-L6-v2", chunk_count=3)
    cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    import db

    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor

    with patch("db.get_conn", return_value=fake_conn):
        with pytest.raises(cs.CorpusModelMismatch):
            db.upsert_chunk(
                user_id="alice",
                nc_file_id=1,
                path="/a.txt",
                chunk_idx=0,
                text="hello",
                embedding=[0.0] * 384,
            )

    assert fake_cursor.execute.call_args_list == [], "no SQL may reach the DB"


def test_reads_and_deletes_are_never_blocked():
    """Fail-closed on writes only — a stale box keeps serving its corpus.

    Deletes stay usable too: they are how the operator script's work lands,
    and how the watcher retires a file the user removed.
    """
    conn, _cur = _conn(marker="all-MiniLM-L6-v2", chunk_count=3)
    cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    import db

    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_cursor.rowcount = 4
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor

    with patch("db.get_conn", return_value=fake_conn):
        db.delete_chunks_for_file(42)

    assert fake_cursor.execute.called


# ---------------------------------------------------------------------------
# Degradation
# ---------------------------------------------------------------------------


def test_a_db_failure_during_the_check_blocks_rather_than_assuming_health():
    """If we cannot prove the corpus matches, we do not get to assume it does."""
    conn = MagicMock()
    conn.cursor.side_effect = RuntimeError("db down")

    verdict = cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    assert verdict == cs.VERDICT_BLOCKED
    assert cs.writes_blocked()


# ---------------------------------------------------------------------------
# The marker ROUND-TRIP — write half and read half must agree
# ---------------------------------------------------------------------------
#
# `stamp_corpus_model` writes `json.dumps(model)::jsonb`, so the stored text is
# `"bge-small-en-v1.5"` WITH quotes. psycopg2 normally decodes jsonb back to a
# str, and every other fake cursor in this file models that decoded case — so
# without these tests the raw-text branch of `read_corpus_model` is never
# exercised and deleting it leaves the suite green.
#
# It must not be deleted. If the marker reads back quoted it can never equal
# EMBEDDING_MODEL, and the result is a loop with no exit: writes blocked ->
# operator runs scripts/rag-re-embed.sh -> emptied corpus is re-stamped ->
# re-stamp reads back quoted -> blocked again. The guard bricks the box it
# exists to protect and the documented remedy changes nothing.
#
# This is also the closest thing we have to the live-Postgres round-trip,
# which cannot be exercised in this suite.


def _stamped_bind(model):
    """Return exactly what `stamp_corpus_model` binds for ``model``.

    Derived from the real call, not re-implemented here — otherwise the test
    would agree with a copy of the write half rather than the write half.
    """
    conn = MagicMock()
    cur = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    cs.stamp_corpus_model(conn, model)
    _sql, binds = cur.execute.call_args[0]
    key, value = binds
    assert key == cs.CORPUS_MODEL_KEY
    return value


def _reader(stored):
    """Fake connection whose marker SELECT returns ``stored`` verbatim."""
    cur = MagicMock()
    cur.fetchone.return_value = (stored,)
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    return conn


def test_the_write_half_really_does_store_quoted_json():
    """Pins the premise the rest of these tests rest on."""
    assert _stamped_bind("bge-small-en-v1.5") == '"bge-small-en-v1.5"'


def test_read_unwraps_raw_jsonb_text():
    """A driver that hands back the raw JSON text, not a decoded str."""
    assert cs.read_corpus_model(_reader('"bge-small-en-v1.5"')) == "bge-small-en-v1.5"


def test_read_accepts_an_already_decoded_value():
    """psycopg2 with the jsonb adapter registered — the common case."""
    assert cs.read_corpus_model(_reader("bge-small-en-v1.5")) == "bge-small-en-v1.5"


def test_marker_round_trips_through_the_raw_jsonb_path():
    """Write half -> storage -> read half, with no decoding in between."""
    stored = _stamped_bind("bge-small-en-v1.5")
    assert cs.read_corpus_model(_reader(stored)) == "bge-small-en-v1.5"


def test_a_quoted_marker_does_not_block_a_matching_corpus():
    """The loop, stated as the assertion that breaks it.

    Non-empty corpus, marker stored exactly as `stamp_corpus_model` writes it,
    configured model identical: the verdict must be MATCH. If the unwrap is
    gone this is BLOCKED, the operator re-embeds, the re-stamp round-trips
    through the same bug, and it is BLOCKED again — forever.
    """
    stored = _stamped_bind("bge-small-en-v1.5")
    cur = MagicMock()
    cur.fetchone.side_effect = [(stored,), (124312,)]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur

    verdict = cs.check_corpus_model(conn, model="bge-small-en-v1.5")

    assert verdict == cs.VERDICT_MATCH, (
        "a correctly-stamped corpus read back through the raw-jsonb path was "
        "rejected — this is the un-exitable block/re-embed/block loop"
    )
    assert not cs.writes_blocked()


def test_a_non_json_marker_is_taken_verbatim():
    """Someone set the row by hand with plain text. Honour it."""
    assert cs.read_corpus_model(_reader("bge-small-en-v1.5\x00not-json")) == (
        "bge-small-en-v1.5\x00not-json"
    )


def test_an_empty_marker_reads_as_absent():
    assert cs.read_corpus_model(_reader("")) is None
    assert cs.read_corpus_model(_reader(None)) is None
