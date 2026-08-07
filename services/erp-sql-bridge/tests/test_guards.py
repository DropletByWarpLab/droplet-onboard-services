"""Route guards and the request contract (main.py, schemas.py).

The REAL boundary is the database grant — `droplet_ro` holds SELECT and nothing
else, so a read connection physically cannot write. These guards sit on top of
that so a caller bug fails here, immediately and by name, instead of arriving
as a server-side permission error three layers down. `test_live_bridge.py`
proves the grant half against a real server.
"""
from __future__ import annotations

import pytest

from main import _is_select, _is_single_statement
from schemas import ExecRequest, IntrospectRequest, Statement, TargetSpec


class TestSingleStatementDetection:
    """`_is_single_statement` is deliberately independent of statement KIND.

    Folding it into the is-a-SELECT check is exactly the bug review found: a
    non-SELECT short-circuited out of the combined helper before the stacking
    test ran, so `/write/*` — whose only guard was "reject if it IS a select" —
    accepted `UPDATE ...; UPDATE ...` and executed both, reporting the last
    statement's rowcount as if one row had changed. These cases pin the
    property on non-SELECTs specifically, which is where it was missing.
    """

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT 1",
            "SELECT 1;",
            "  UPDATE dba.appointment SET status = ?  ",
            "DELETE FROM dba.patient WHERE patient_id = ?",
            "SELECT 'a;b' FROM dba.patient",
            "UPDATE dba.appointment SET reason = 'a;b' WHERE appt_id = ?",
            "SELECT * FROM t WHERE c = 'it''s; fine'",
        ],
    )
    def test_accepts_exactly_one_statement(self, sql):
        assert _is_single_statement(sql) is True

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT 1; DROP TABLE dba.patient",
            "SELECT 1;SELECT 2",
            # The reproduction from review: two UPDATEs, neither carrying the
            # optimistic guard, in one call.
            "UPDATE dba.appointment SET status = 'a' WHERE appt_id = 5001; "
            "UPDATE dba.appointment SET status = 'b' WHERE appt_id = 5002",
            "UPDATE dba.appointment SET status = 'a'; DROP TABLE dba.patient",
            "DELETE FROM dba.patient; DELETE FROM dba.account",
            # A comment must not hide the separator either.
            "UPDATE dba.appointment SET status = 'a' /* x */; DROP TABLE dba.patient",
        ],
    )
    def test_rejects_a_batch_whatever_it_starts_with(self, sql):
        assert _is_single_statement(sql) is False


class TestSelectDetection:
    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT 1",
            "select appt_id from dba.appointment where appt_time >= ?",
            "  SELECT 1  ",
            "SELECT 1;",
        ],
    )
    def test_recognises_a_select(self, sql):
        assert _is_select(sql) is True

    @pytest.mark.parametrize(
        "sql",
        [
            "UPDATE dba.appointment SET status = ?",
            "DELETE FROM dba.patient",
            "INSERT INTO dba.patient VALUES (?)",
            "CALL some_proc(?)",
            "GRANT SELECT ON dba.patient TO droplet_ro",
        ],
    )
    def test_recognises_a_non_select(self, sql):
        assert _is_select(sql) is False

    @pytest.mark.parametrize(
        "sql",
        [
            "/* SELECT */ UPDATE dba.appointment SET status = ?",
            "-- SELECT\nDELETE FROM dba.patient",
            "/*x*/UPDATE dba.appointment SET status = ?",
        ],
    )
    def test_a_comment_cannot_disguise_a_write_as_a_read(self, sql):
        """Comments are stripped before the anchor check, so a leading
        `/* SELECT */` cannot get a write onto the read route."""
        assert _is_select(sql) is False


class TestRequestContract:
    """What a caller is allowed to say. It may name the box; it may never name
    the identity — the credentials come from this container's own environment
    and are chosen by ROUTE."""

    def test_a_statement_carries_sql_and_positional_params(self):
        s = Statement(sql="SELECT ?", params=[1])
        assert (s.sql, s.params) == ("SELECT ?", [1])

    def test_params_default_to_empty(self):
        assert Statement(sql="SELECT 1").params == []

    def test_empty_sql_is_rejected(self):
        with pytest.raises(ValueError):
            Statement(sql="")

    @pytest.mark.parametrize("field", ["uid", "user", "username", "pwd", "password", "identity"])
    def test_no_credential_field_exists_on_any_request_model(self, field):
        """Regression guard for the whole design: if someone ever adds a
        username/password to the wire contract, this fails."""
        for model in (Statement, ExecRequest, IntrospectRequest, TargetSpec):
            assert field not in model.model_fields

    def test_a_credential_supplied_by_a_caller_is_dropped_not_honoured(self):
        req = ExecRequest.model_validate(
            {"sql": "SELECT 1", "params": [], "uid": "dba", "pwd": "sql"}
        )
        assert not hasattr(req, "uid")
        assert not hasattr(req, "pwd")

    def test_target_defaults_to_a_stock_eaglesoft_install(self):
        t = TargetSpec(host="10.0.0.5")
        assert (t.port, t.serverName, t.databaseName) == (2638, "PattersonPM", "PattersonPM")

    @pytest.mark.parametrize("port", [0, 65536, -1])
    def test_an_out_of_range_port_is_rejected(self, port):
        with pytest.raises(ValueError):
            TargetSpec(host="10.0.0.5", port=port)

    def test_target_is_optional_so_a_single_practice_box_needs_no_per_request_config(self):
        assert ExecRequest(sql="SELECT 1").target is None
