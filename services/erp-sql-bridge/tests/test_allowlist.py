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
    INTROSPECT,
    READS,
    STATEMENT_MISMATCH,
    UNKNOWN_STATEMENT,
    WRITES,
    check_introspection,
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
# WARP-2874. The AR/AP pair that shares a shape: seven columns, one `<> 0`
# predicate, two ORDER BY terms. Only the TABLE tells them apart.
OPEN_INVOICES_SQL = (
    'SELECT "invoice_id", "issued_at", "due_at", "customer_id", "amount", '
    '"balance", "status" FROM "dba"."invoice" WHERE "balance" <> 0 '
    'ORDER BY "due_at", "invoice_id"'
)
OPEN_BILLS_SQL = (
    'SELECT "bill_id", "issued_at", "due_at", "vendor_id", "amount", '
    '"balance", "status" FROM "dba"."bill" WHERE "balance" <> 0 '
    'ORDER BY "due_at", "bill_id"'
)
# WARP-2874. The catalog statements `/introspect` now accepts, written out the
# way `erp-connector/src/introspection.ts` emits them (the TS side picks the
# family per detected engine). Same reason the read statements above are
# written out: the registry is TypeScript, and the sync suite is what pins
# these two copies together.
LIST_TABLES_SQL = """SELECT t.table_name, u.user_name AS owner
FROM SYS.SYSTAB t
JOIN SYS.SYSUSER u ON t.creator = u.user_id
WHERE t.table_type = 1"""
LIST_COLUMNS_SQL = """SELECT c.column_name, d.domain_name AS type, c.nulls, c.width, c.scale
FROM SYS.SYSTABCOL c
JOIN SYS.SYSTAB t ON c.table_id = t.table_id
JOIN SYS.SYSDOMAIN d ON c.domain_id = d.domain_id
WHERE t.table_name = ?
ORDER BY c.column_id"""


class TestNormalization:
    def test_masks_every_identifier_but_the_table(self):
        # WARP-2874: the qualified `"owner"."table"` keeps its TABLE verbatim.
        # Columns stay masked (they are free within the registered table); the
        # owner stays masked (it genuinely varies per install).
        assert (
            normalize_statement('SELECT "a" FROM "dba"."patient" WHERE "b" = ?')
            == 'SELECT <id> FROM <id>."patient" WHERE <id> = ?'
        )

    def test_a_doubled_quote_stays_inside_one_identifier(self):
        # `"a""b"` is ONE identifier named `a"b` — not two.
        assert (
            normalize_statement('SELECT "a""b" FROM "dba"."t"')
            == 'SELECT <id> FROM <id>."t"'
        )

    def test_a_doubled_quote_stays_inside_one_table_name(self):
        # WARP-2874: the table is copied verbatim, so its own escaping must
        # survive intact — `"t""x"` is the table named `t"x`.
        assert (
            normalize_statement('SELECT "a" FROM "dba"."t""x"')
            == 'SELECT <id> FROM <id>."t""x"'
        )

    def test_an_unqualified_identifier_is_still_masked(self):
        # Only the RIGHT half of a qualified pair is a table. A bare
        # identifier is a column as the registries emit them, and stays
        # masked — which is also why a manifest skeleton that names no table
        # is refused at load (see TestManifestIntegrity).
        assert normalize_statement('SELECT "a" FROM "t"') == "SELECT <id> FROM <id>"

    def test_whitespace_runs_collapse_to_one_space(self):
        assert (
            normalize_statement('SELECT\n  "a"\t FROM   "dba"."t"')
            == 'SELECT <id> FROM <id>."t"'
        )

    def test_everything_outside_identifiers_survives_verbatim(self):
        # The one string literal a registry statement carries (`ESCAPE '\'`)
        # is part of the approved text, not maskable attacker room.
        assert normalize_statement(FIND_PATIENT_SQL) == (
            'SELECT <id>, <id>, <id> FROM <id>."patient" '
            "WHERE <id> LIKE ? ESCAPE '\\' ORDER BY <id>, <id>"
        )

    def test_an_unterminated_identifier_cannot_be_normalized(self):
        assert normalize_statement('SELECT "unterminated FROM x') is None

    def test_a_raw_mask_marker_in_the_input_is_refused(self):
        # `<id>` in raw SQL could only exist to impersonate a masked
        # identifier. It is not valid SQL either way; refuse outright.
        assert normalize_statement("SELECT <id> FROM <id>.<id>") is None

    def test_a_mask_never_runs_across_a_literal_boundary(self):
        # WARP-2570, and the sharp end of it: with two literals each holding a
        # `"`, a walker that tracks double-quote state alone opens an
        # "identifier" inside the first literal and closes it inside the
        # second, masking the SQL BETWEEN them. The pre-fix walker returned
        #     SELECT <id> FROM <id> WHERE <id> = 'x<id>d<id>q'
        # for the statement below — the whole `AND "d" = ` predicate absorbed
        # into masks and gone from the normalized form. Two statements with
        # DIFFERENT where-clauses can then normalize alike, which is an
        # allowlist collision: registering one admits the other. Note this is
        # a wrong ANSWER, not a refusal — the fail-closed path never runs.
        #
        # Mutation: delete the `elif ch == "'"` branch → red.
        assert (
            normalize_statement(
                """SELECT "a" FROM "t" WHERE "c" = 'x"y' AND "d" = 'p"q'"""
            )
            == """SELECT <id> FROM <id> WHERE <id> = 'x"y' AND <id> = 'p"q'"""
        )

    def test_a_double_quote_inside_a_literal_is_data_not_a_delimiter(self):
        # WARP-2570. A SQL engine reads the `"` in `'a"b'` as inert data. A
        # masker tracking double-quote state ALONE reads it as opening an
        # identifier and masks from there to the next `"` — which is in the
        # middle of the following identifier, producing a normalization that
        # does not describe the statement the database would run.
        #
        # Mutation: delete the `elif ch == "'"` branch → the walker swallows
        # `"b' AND "` into one `<id>` and this goes red.
        assert (
            normalize_statement("""SELECT "a" FROM "t" WHERE "c" = 'a"b'""")
            == """SELECT <id> FROM <id> WHERE <id> = 'a"b'"""
        )

    def test_a_doubled_quote_stays_inside_one_literal(self):
        # `'it''s'` is ONE literal containing `it's`. Ending the literal at the
        # first inner quote would leave the walker parsing `s'` as syntax.
        assert (
            normalize_statement("""SELECT "a" FROM "t" WHERE "c" = 'it''s'""")
            == """SELECT <id> FROM <id> WHERE <id> = 'it''s'"""
        )

    def test_an_unterminated_literal_cannot_be_normalized(self):
        # Fail closed, exactly as an unterminated identifier does. Returning a
        # best-effort normalization here would be the allowlist guessing.
        assert normalize_statement("SELECT \"a\" FROM \"t\" WHERE \"c\" = 'oops") is None

    def test_statements_differing_only_inside_a_literal_do_not_collide(self):
        # The property that matters: a literal is part of the approved text,
        # so two statements whose literals differ must NOT normalize alike —
        # otherwise registering one would admit the other.
        a = normalize_statement("""SELECT "x" FROM "t" WHERE "c" LIKE ? ESCAPE '\\'""")
        b = normalize_statement("""SELECT "x" FROM "t" WHERE "c" LIKE ? ESCAPE '#'""")
        assert a is not None and b is not None
        assert a != b

    def test_an_identifier_after_a_literal_still_masks(self):
        # Proves the literal branch RESUMES normal parsing rather than
        # swallowing the rest of the statement — the failure mode a naive
        # "skip to the next quote" fix would introduce.
        assert (
            normalize_statement('''SELECT 'lit' AS "label" FROM "dba"."t"''')
            == '''SELECT 'lit' AS <id> FROM <id>."t"'''
        )


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
        for table in (READS, WRITES, INTROSPECT):
            for name, skeletons in table.items():
                for s in skeletons:
                    # WARP-2874: a skeleton carries its table name verbatim, so
                    # `"` is expected now; what may never appear is an UNMASKED
                    # owner (`"dba"."patient"`), which would pin the skeleton to
                    # one install's owner and match nothing anywhere else.
                    assert '"."' not in s, f"{name}: unmasked owner in skeleton"
                    assert " ".join(s.split()) == s, f"{name}: not whitespace-normal"

    def test_every_read_and_write_skeleton_names_its_table(self):
        """WARP-2874. The bug this closes: `<id>.<id>` masked the table too, so
        `get_open_invoices` and `get_open_bills` — same shape, different table —
        normalized alike and either name admitted the other's SQL (and any other
        seven-column table `droplet_ro` can see). A skeleton that still carries
        `<id>.<id>` is one the allowlist cannot bind to a table.

        Mutation: mask the table again in `normalize_statement` → red."""
        for table in (READS, WRITES):
            for name, skeletons in table.items():
                for s in skeletons:
                    assert "<id>.<id>" not in s, f"{name}: table is still masked"
                    assert '<id>."' in s, f"{name}: skeleton names no table"

    def test_no_two_registered_names_share_a_shape(self):
        """The property that makes a statement NAME mean something: if two
        names normalize alike, registering one registers the other, and the
        route's `name` is decoration. Pre-WARP-2874 this was false for four
        groups — {get_open_invoices, get_open_bills} among them."""
        for table in (READS, WRITES):
            seen: dict[str, str] = {}
            for name, skeletons in table.items():
                for s in skeletons:
                    assert s not in seen, f"{name} shares a shape with {seen.get(s)}"
                    seen[s] = name

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

    def test_column_names_are_free_but_shape_is_not(self):
        # Columns are still free: the schema map resolves them per practice and
        # the server checks they exist. Shape may never vary.
        renamed = GET_PATIENT_SQL.replace('"patient_id"', '"pat_num"')
        assert check_statement("read", "get_patient", renamed) is None

    def test_the_owner_is_free_but_the_table_is_not(self):
        # WARP-2874. The owner varies per install ("dba" is only the stock
        # one), so it stays masked; the TABLE is what the name promises.
        assert (
            check_statement("read", "get_patient", GET_PATIENT_SQL.replace('"dba"', '"pm"'))
            is None
        )
        elsewhere = GET_PATIENT_SQL.replace('"dba"."patient"', '"dba"."payroll"')
        assert check_statement("read", "get_patient", elsewhere) == STATEMENT_MISMATCH

    @pytest.mark.parametrize(
        ("name", "sql"),
        [
            ("get_open_invoices", OPEN_BILLS_SQL),
            ("get_open_bills", OPEN_INVOICES_SQL),
        ],
    )
    def test_a_sibling_statement_is_refused_under_the_wrong_name(self, name, sql):
        """WARP-2874, the reported case. AR (`invoice`) and AP (`bill`) are the
        same seven-column shape, so before the table entered the skeleton
        `POST /read/get_open_invoices` carrying bill SQL passed the allowlist
        and the bridge logged an AR read while returning AP rows."""
        assert check_statement("read", name, sql) == STATEMENT_MISMATCH

    def test_both_siblings_still_pass_under_their_own_name(self):
        assert check_statement("read", "get_open_invoices", OPEN_INVOICES_SQL) is None
        assert check_statement("read", "get_open_bills", OPEN_BILLS_SQL) is None

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


class TestCheckIntrospection:
    """WARP-2874 — `/introspect` was the hole in the WARP-2540 allowlist: it
    ran whatever SELECT the wire carried, so anything `droplet_ro` can see was
    readable by a caller holding the service bearer, allowlist or not.

    Introspection is checked by SHAPE ONLY, with no name: the caller LABELS
    each query (the column pass labels by table name, which is data), so the
    label can carry no authority. The registered set is the catalog SQL
    `erp-connector/src/introspection.ts` emits — two families, because the
    dialect is detected at connect time."""

    def test_the_manifest_registers_both_catalog_families(self):
        assert set(INTROSPECT) == {
            "list_tables",
            "list_columns",
            "legacy_list_tables",
            "legacy_list_columns",
        }

    def test_a_registered_catalog_statement_passes(self):
        assert check_introspection(LIST_TABLES_SQL) is None
        assert check_introspection(LIST_COLUMNS_SQL) is None

    def test_whitespace_may_vary_because_normalization_collapses_it(self):
        assert check_introspection(LIST_TABLES_SQL.replace("\n", "  ")) is None

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT * FROM dba.patient",
            GET_PATIENT_SQL,
            LIST_TABLES_SQL + " AND t.table_name LIKE '%pay%'",
            LIST_TABLES_SQL.replace("t.table_name", "t.table_name, t.table_id"),
            LIST_TABLES_SQL + "; DROP TABLE patient",
        ],
    )
    def test_anything_else_is_refused(self, sql):
        assert check_introspection(sql) == STATEMENT_MISMATCH

    def test_every_registered_catalog_statement_is_a_single_select(self):
        for name, skeletons in INTROSPECT.items():
            for s in skeletons:
                assert main._is_single_statement(s), name
                assert main._is_select(s), name


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

    def test_an_unregistered_introspection_query_is_refused_before_the_pool(
        self, client, pool_sentinel
    ):
        """WARP-2874. The reported hole: `/introspect` never called the
        allowlist, so a service-bearer holder could read any table
        `droplet_ro` can see through it. It now refuses exactly as `/read/*`
        does, before the pool.

        Mutation: drop `_assert_introspection_registered` from the route → the
        sentinel is reached and this goes red."""
        r = client.post(
            "/introspect",
            json={
                "queries": {"tables": {"sql": "SELECT * FROM dba.patient", "params": []}},
                "target": self.TARGET,
            },
        )
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"
        assert "tables" in r.json()["message"]
        assert pool_sentinel == []

    def test_one_unregistered_query_refuses_the_whole_batch(self, client, pool_sentinel):
        """Every query in the batch is checked before any of them runs — a
        registered first query must not buy a connection for the rest."""
        r = client.post(
            "/introspect",
            json={
                "queries": {
                    "tables": {"sql": LIST_TABLES_SQL, "params": []},
                    "sneaky": {"sql": "SELECT * FROM dba.patient", "params": []},
                },
                "target": self.TARGET,
            },
        )
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"
        assert pool_sentinel == []

    def test_a_registered_introspection_query_gets_through_to_the_pool(
        self, client, pool_sentinel
    ):
        r = client.post(
            "/introspect",
            json={
                "queries": {
                    "tables": {"sql": LIST_TABLES_SQL, "params": []},
                    "appointment": {"sql": LIST_COLUMNS_SQL, "params": ["appointment"]},
                },
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
