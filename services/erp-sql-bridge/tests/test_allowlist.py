"""The statement allowlist (allowlist.py + statement_manifest.json) — WARP-2540.

CodeQL flagged the two execute sites (`/read/{name}`, `/write/{name}`) as
executing a caller-supplied SQL string. The design always intended the wire to
carry only registry-built statements (@droplet/erp-connector), but the bridge
had no way to CHECK that — it trusted the wire. The allowlist is that check:
every incoming statement is normalized (identifiers masked, whitespace
collapsed) and must match a registered skeleton for its route + name, before
any pool acquire. Unknown or mismatched statements are refused fail-closed.

The manifest is pinned to the TypeScript registries by
services/erp-connector/__tests__/statement-manifest-sync.test.ts — a registry
change that is not reflected here fails that suite, not a customer.

The route-level tests at the bottom are deliberate MUTATION tests: they are
built so that removing the allowlist check from a route, or downgrading it to
advisory (log-only), turns at least one of them red.
"""
from __future__ import annotations

import pytest

import main
from allowlist import (
    READS,
    STATEMENT_MISMATCH,
    UNKNOWN_STATEMENT,
    WRITES,
    check_statement,
    normalize_statement,
)
from db import UpstreamUnavailable

# Registry-shaped statements: exactly what @droplet/erp-connector emits for
# these names, with the identifiers a stock harness schema resolves to.
GET_PATIENT_SQL = (
    'SELECT "patient_id", "first_name", "last_name" '
    'FROM "dba"."patient" '
    'WHERE "patient_id" = ?'
)
FIND_PATIENT_SQL = (
    'SELECT "patient_id", "first_name", "last_name" '
    'FROM "dba"."patient" '
    "WHERE \"last_name\" LIKE ? ESCAPE '\\' "
    'ORDER BY "last_name", "first_name"'
)
RESCHEDULE_SQL = (
    'UPDATE "dba"."appointment" '
    'SET "status" = ? '
    'WHERE "appt_id" = ? AND "last_modified" = ?'
)


class TestNormalization:
    def test_masks_every_quoted_identifier(self):
        assert (
            normalize_statement('SELECT "a" FROM "dba"."patient" WHERE "b" = ?')
            == "SELECT <id> FROM <id>.<id> WHERE <id> = ?"
        )

    def test_a_doubled_quote_stays_inside_one_identifier(self):
        # `"a""b"` is ONE identifier named `a"b` — not two.
        assert (
            normalize_statement('SELECT "a""b" FROM "dba"."t"')
            == "SELECT <id> FROM <id>.<id>"
        )

    def test_whitespace_runs_collapse_to_one_space(self):
        assert (
            normalize_statement('SELECT\n  "a"\t FROM   "dba"."t"')
            == "SELECT <id> FROM <id>.<id>"
        )

    def test_everything_outside_identifiers_survives_verbatim(self):
        # The one string literal a registry statement carries (`ESCAPE '\'`)
        # is part of the approved text, not maskable attacker room.
        assert normalize_statement(FIND_PATIENT_SQL) == (
            "SELECT <id>, <id>, <id> FROM <id>.<id> "
            "WHERE <id> LIKE ? ESCAPE '\\' ORDER BY <id>, <id>"
        )

    def test_an_unterminated_identifier_cannot_be_normalized(self):
        assert normalize_statement('SELECT "unterminated FROM x') is None

    def test_a_raw_mask_marker_in_the_input_is_refused(self):
        # `<id>` in raw SQL could only exist to impersonate a masked
        # identifier. It is not valid SQL either way; refuse outright.
        assert normalize_statement("SELECT <id> FROM <id>.<id>") is None


class TestManifestIntegrity:
    """The manifest ships in the image; a broken one must fail tests, not a
    practice. These assertions also tie the layers together: every approved
    read is a single SELECT and every approved write a single non-SELECT, so
    the second-layer guards can never disagree with the first."""

    def test_the_manifest_registers_reads_and_writes(self):
        assert READS and WRITES
        assert "get_patient" in READS
        assert "reschedule_appointment" in WRITES

    def test_every_skeleton_is_in_normal_form(self):
        for table in (READS, WRITES):
            for name, skeletons in table.items():
                for s in skeletons:
                    assert '"' not in s, f"{name}: unmasked identifier in skeleton"
                    assert " ".join(s.split()) == s, f"{name}: not whitespace-normal"

    def test_every_read_skeleton_is_a_single_select(self):
        for name, skeletons in READS.items():
            for s in skeletons:
                assert main._is_single_statement(s), name
                assert main._is_select(s), name

    def test_every_write_skeleton_is_a_single_non_select(self):
        for name, skeletons in WRITES.items():
            for s in skeletons:
                assert main._is_single_statement(s), name
                assert not main._is_select(s), name

    def test_the_write_command_registers_all_four_set_widths(self):
        # reschedule_appointment may SET 1..4 of its allowlisted columns; the
        # registry emits a different skeleton per width.
        assert len(WRITES["reschedule_appointment"]) == 4


class TestCheckStatement:
    def test_a_registry_built_read_passes(self):
        assert check_statement("read", "get_patient", GET_PATIENT_SQL) is None

    def test_a_registry_built_write_passes_at_every_set_width(self):
        for width in range(1, 5):
            sets = ", ".join(f'"col_{i}" = ?' for i in range(width))
            sql = (
                f'UPDATE "dba"."appointment" SET {sets} '
                'WHERE "appt_id" = ? AND "last_modified" = ?'
            )
            assert check_statement("write", "reschedule_appointment", sql) is None

    def test_identifier_names_are_free_but_shape_is_not(self):
        # The schema map resolves physical identifiers per practice, so names
        # vary; the server still checks they exist. Shape may never vary.
        renamed = GET_PATIENT_SQL.replace('"patient_id"', '"pat_num"')
        assert check_statement("read", "get_patient", renamed) is None

    def test_an_unknown_read_name_is_refused(self):
        assert check_statement("read", "drop_everything", "SELECT 1") == UNKNOWN_STATEMENT

    def test_an_unknown_write_name_is_refused(self):
        assert (
            check_statement("write", "rogue_ar_write", RESCHEDULE_SQL)
            == UNKNOWN_STATEMENT
        )

    def test_reads_and_writes_are_separate_namespaces(self):
        # A read name on the write route is unknown there, whatever the SQL.
        assert check_statement("write", "get_patient", GET_PATIENT_SQL) == UNKNOWN_STATEMENT

    @pytest.mark.parametrize(
        "tampered",
        [
            GET_PATIENT_SQL + " OR 1=1",
            GET_PATIENT_SQL + " UNION SELECT "
            '"patient_id", "first_name", "last_name" FROM "dba"."patient"',
            GET_PATIENT_SQL + "; DELETE FROM patient",
            GET_PATIENT_SQL.replace("SELECT", "select"),
            GET_PATIENT_SQL.replace("WHERE", "/*x*/ WHERE"),
            GET_PATIENT_SQL.replace(" = ?", " = 1003"),
            'SELECT "a", "b", "c", "d" FROM "dba"."patient" WHERE "a" = ?',
            "SELECT * FROM patient",
        ],
    )
    def test_any_deviation_from_the_registered_shape_is_refused(self, tampered):
        assert check_statement("read", "get_patient", tampered) == STATEMENT_MISMATCH

    def test_a_write_shaped_statement_is_refused_on_the_read_side(self):
        assert check_statement("read", "get_patient", RESCHEDULE_SQL) == STATEMENT_MISMATCH


class TestRoutesFailClosed:
    """Mutation tests. The pool sentinel raises if it is ever reached, so a
    refused statement PROVABLY never acquires a connection — and if the
    allowlist check is removed or made advisory, the refused cases fall
    through to the sentinel's 503 (or blow up on it) and go red."""

    TARGET = {"host": "127.0.0.1", "port": 9}

    @pytest.fixture
    def pool_sentinel(self, monkeypatch):
        calls: list[tuple] = []

        def sentinel(*args, **kwargs):
            calls.append(args)
            raise UpstreamUnavailable("sentinel: the pool was reached")

        monkeypatch.setattr(main.POOL, "acquire", sentinel)
        return calls

    def test_a_mismatched_read_is_refused_before_the_pool(self, client, pool_sentinel):
        r = client.post(
            "/read/get_patient",
            json={"sql": "SELECT * FROM patient", "params": [], "target": self.TARGET},
        )
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"
        assert "get_patient" in r.json()["message"]
        assert pool_sentinel == []

    def test_an_unknown_read_name_is_refused_before_the_pool(self, client, pool_sentinel):
        r = client.post(
            "/read/drop_everything",
            json={"sql": GET_PATIENT_SQL, "params": [], "target": self.TARGET},
        )
        assert r.status_code == 400
        assert r.json()["code"] == "UNKNOWN_STATEMENT"
        assert pool_sentinel == []

    def test_a_mismatched_write_is_refused_before_the_pool(self, client, pool_sentinel):
        r = client.post(
            "/write/reschedule_appointment",
            json={
                "sql": 'UPDATE "dba"."appointment" SET "status" = ?',  # guard gone
                "params": ["x"],
                "target": self.TARGET,
            },
        )
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"
        assert pool_sentinel == []

    def test_an_unknown_write_name_is_refused_before_the_pool(self, client, pool_sentinel):
        r = client.post(
            "/write/pwn_test",
            json={"sql": RESCHEDULE_SQL, "params": [], "target": self.TARGET},
        )
        assert r.status_code == 400
        assert r.json()["code"] == "UNKNOWN_STATEMENT"
        assert pool_sentinel == []

    def test_a_registry_built_read_gets_through_to_the_pool(self, client, pool_sentinel):
        """The mutation detector's other half: the SAME route and name with a
        conforming statement reaches the pool (and fails on the sentinel with
        an honest 503) — so the 400s above are the allowlist refusing, not
        some other guard."""
        r = client.post(
            "/read/get_patient",
            json={"sql": GET_PATIENT_SQL, "params": [1003], "target": self.TARGET},
        )
        assert r.status_code == 503
        assert r.json()["code"] == "UPSTREAM_UNAVAILABLE"
        assert len(pool_sentinel) == 1

    def test_a_registry_built_write_gets_through_to_the_pool(self, client, pool_sentinel):
        r = client.post(
            "/write/reschedule_appointment",
            json={
                "sql": RESCHEDULE_SQL,
                "params": ["confirmed", 5001, "2026-01-01T00:00:00"],
                "target": self.TARGET,
            },
        )
        assert r.status_code == 503
        assert r.json()["code"] == "UPSTREAM_UNAVAILABLE"
        assert len(pool_sentinel) == 1

    def test_the_allowlist_is_the_first_layer(self, client, pool_sentinel):
        """A stacked statement under a registered name refuses as a shape
        mismatch, not as a batch: the allowlist runs before the second-layer
        guards, so tampering is named for what it is."""
        r = client.post(
            "/read/get_patient",
            json={"sql": GET_PATIENT_SQL + "; DROP TABLE patient", "target": self.TARGET},
        )
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"
        assert pool_sentinel == []

    def test_an_unconfigured_box_with_no_target_says_so(self, client, env, pool_sentinel):
        """Adjacent fix, same routes: `_target_from` used to run OUTSIDE the
        try, so an unconfigured box with no per-request target answered a raw
        500 instead of the honest NOT_CONFIGURED the health route gives."""
        env(ERP_DB_HOST=None)
        r = client.post("/read/get_patient", json={"sql": GET_PATIENT_SQL, "params": [1003]})
        assert r.status_code == 503
        assert r.json()["code"] == "NOT_CONFIGURED"
        assert pool_sentinel == []
