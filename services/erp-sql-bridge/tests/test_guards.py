"""Route guards and the request contract (main.py, schemas.py).

The REAL boundary is the database grant — `droplet_ro` holds SELECT and nothing
else, so a read connection physically cannot write. These guards sit on top of
that so a caller bug fails here, immediately and by name, instead of arriving
as a server-side permission error three layers down. `test_live_bridge.py`
proves the grant half against a real server.
"""
from __future__ import annotations

import pytest

from main import _looks_like_single_select
from schemas import ExecRequest, IntrospectRequest, Statement, TargetSpec


class TestSingleSelectDetection:
    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT 1",
            "select appt_id from dba.appointment where appt_time >= ?",
            "  SELECT 1  ",
            "SELECT 1;",
            # A literal containing a semicolon is not a statement separator.
            "SELECT 'a;b' FROM dba.patient WHERE last_name LIKE ? ESCAPE '\\'",
        ],
    )
    def test_accepts_a_single_select(self, sql):
        assert _looks_like_single_select(sql) is True

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
    def test_rejects_a_non_select(self, sql):
        assert _looks_like_single_select(sql) is False

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
        assert _looks_like_single_select(sql) is False

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT 1; DROP TABLE dba.patient",
            "SELECT 1; UPDATE dba.appointment SET status = 'x'",
            "SELECT 1;SELECT 2",
        ],
    )
    def test_a_stacked_statement_is_not_a_read(self, sql):
        """Anchoring on `SELECT` alone would wave through anything appended
        after a semicolon."""
        assert _looks_like_single_select(sql) is False

    def test_a_semicolon_inside_a_quoted_literal_is_not_a_separator(self):
        assert _looks_like_single_select("SELECT * FROM t WHERE c = 'x;y'") is True

    def test_an_escaped_quote_does_not_unbalance_literal_stripping(self):
        assert _looks_like_single_select("SELECT * FROM t WHERE c = 'it''s; fine'") is True


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
