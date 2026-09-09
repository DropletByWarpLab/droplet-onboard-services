"""Route guards and the request contract (main.py, schemas.py).

The REAL boundary is the database grant — `droplet_ro` holds SELECT and nothing
else, so a read connection physically cannot write. These guards sit on top of
that so a caller bug fails here, immediately and by name, instead of arriving
as a server-side permission error three layers down. `test_live_bridge.py`
proves the grant half against a real server.
"""
from __future__ import annotations

import time

import pytest

from main import _bare, _is_select, _is_single_statement
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

    @pytest.mark.parametrize(
        "sql",
        [
            "UPDATE dba.appointment SET status = ?;",
            "UPDATE dba.appointment SET status = ?;;;",
            "UPDATE dba.appointment SET status = ? ; ; ",
            "SELECT 1 ;\n;\t",
        ],
    )
    def test_trailing_terminators_are_empty_statements_not_a_second_one(self, sql):
        """All spellings of "nothing after the statement" agree.

        A plain `.rstrip(';')` collapsed `;;;` but left `; ; ` holding a
        semicolon, so two inputs with identical meaning got opposite verdicts
        purely on spacing (review nit). Neither form is a second statement, so
        both are accepted — the point is that they cannot disagree.
        """
        assert _is_single_statement(sql) is True

    @pytest.mark.parametrize(
        "sql",
        [
            "UPDATE dba.appointment SET status = ?; DROP TABLE dba.patient;",
            "UPDATE dba.appointment SET status = ?;;DROP TABLE dba.patient",
            "SELECT 1 ; ; DROP TABLE dba.patient ; ;",
        ],
    )
    def test_stripping_trailing_terminators_never_swallows_a_real_second_statement(self, sql):
        """Only the END is stripped. An interior semicolon is precisely the
        separator being looked for, and no amount of trailing punctuation may
        hide one."""
        assert _is_single_statement(sql) is False


class TestLiteralsShieldComments:
    """A comment marker INSIDE a string literal is data, not a comment.

    The regex version stripped comments first and masked literals second, so
    `'--'` swallowed the rest of the line — semicolon included — before the
    literal mask ran, and a stacked write read as one statement. `_bare` now
    lexes literals and comments in one pass (CodeQL py/polynomial-redos fix,
    alerts #63/#64), which closes that as a side effect. These pin it.
    """

    @pytest.mark.parametrize(
        "sql",
        [
            "UPDATE dba.appointment SET reason = '--' WHERE appt_id = ?; DROP TABLE dba.patient",
            "UPDATE dba.appointment SET reason = '/*' WHERE appt_id = ?; DROP TABLE dba.patient",
            "SELECT '--x' FROM dba.patient; DELETE FROM dba.patient",
            # A quote inside a comment does not open a literal either.
            "SELECT 1 /* it's */; DROP TABLE dba.patient",
            "SELECT 1 -- don't\n; DROP TABLE dba.patient",
        ],
    )
    def test_a_comment_marker_inside_a_literal_cannot_hide_a_separator(self, sql):
        assert _is_single_statement(sql) is False

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT '--' FROM dba.patient",
            "SELECT '/* not a comment */' FROM dba.patient",
            "SELECT 'it''s -- fine; really' FROM dba.patient",
            "-- it's\nSELECT 1",
        ],
    )
    def test_a_comment_marker_inside_a_literal_is_plain_data(self, sql):
        assert _is_single_statement(sql) is True
        assert _is_select(sql) is True

    def test_bare_masks_literals_and_replaces_comments_with_a_space(self):
        assert _bare("SELECT 'a;b' /* c */ -- tail\n") == "SELECT ''"
        assert _bare("SELECT 1 /* x */; ; ") == "SELECT 1"

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT 1 /* never closed; DROP TABLE dba.patient",
            "SELECT 'never closed; DROP TABLE dba.patient",
        ],
    )
    def test_unterminated_constructs_fail_closed(self, sql):
        """An unterminated comment or literal is left visible, so a `;` inside
        it still counts as a separator — refusing is the safe verdict."""
        assert _is_single_statement(sql) is False


class TestBareIsLinear:
    """CodeQL py/polynomial-redos (alerts #63/#64).

    `_bare` used to be `/\\*.*?\\*/|--[^\\n]*` plus `[\\s;]+$`, both applied to
    request-controlled SQL and both quadratic: an unclosed `/*` followed by many
    `a/*` re-scanned to the end for every opener, and a long run of tabs or
    `; ` before a non-terminator backtracked on `$`. Measured at 50k chars the
    old code took ~2 s and ~7 s respectively. The scanner is linear; these
    inputs must come back essentially instantly, and the 50k cases are there so
    a regression cannot hide inside a generous bound.
    """

    @staticmethod
    def _cases(n):
        return [
            "SELECT 1" + "\t" * n + "x",          # many '\t' before a non-terminator
            "/*" + "a/*" * (n // 3),               # unclosed '/*' with many openers
            "SELECT 1" + "; " * (n // 2) + "x",    # many '; ' before a non-terminator
        ]

    @pytest.mark.parametrize("sql", _cases.__func__(5_000) + _cases.__func__(50_000))
    def test_pathological_input_returns_promptly(self, sql):
        started = time.perf_counter()
        _bare(sql)
        assert time.perf_counter() - started < 0.5

    def test_pathological_input_still_gets_the_right_verdict(self):
        assert _is_single_statement("SELECT 1" + "\t" * 5_000 + "x") is True
        assert _is_single_statement("SELECT 1" + "; " * 2_500 + "x") is False
        assert _is_select("/*" + "a/*" * 1_666) is False


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
