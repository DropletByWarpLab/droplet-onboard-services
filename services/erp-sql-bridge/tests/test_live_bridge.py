"""End-to-end bridge behaviour against a REAL database.

Run via `scripts/test-erp-sql-bridge.sh`, which boots a throwaway Postgres
seeded with the synthetic PattersonPM schema and its least-privilege grants,
and points ERP_ODBC_DRIVER at psqlODBC. That script's header explains why
Postgres stands in for SQL Anywhere; the short version is that everything after
`pyodbc.connect` is driver-independent, and the SAP client is license-gated.

Nothing here is mocked. Every assertion below went through unixODBC, a real
connection, and a real server-side privilege check.

Since WARP-2540 the routes accept ONLY statements whose normalized shape
matches the registered skeleton for their name (see allowlist.py), so the
stand-ins below are written exactly the way the TypeScript registries emit
them: double-quoted identifiers, values as `?`. They are written out rather
than imported because the registry is TypeScript —
`erp-connector/__tests__/sql-bridge.live.test.ts` is what proves the real
generated SQL runs through this service. Where a test needs to see database
state the routes have no registered read for (a guard watermark, a row a
refused write must not have touched), it reads OUT OF BAND on a direct
connection — the same bypass `TestGrantsAreTheRealBoundary` has always used —
rather than poking a hole in the allowlist for scaffolding.
"""
from __future__ import annotations

import datetime

import pyodbc
import pytest

from conftest import requires_live_db
from db import ConnectionPool, default_target, rows_to_dicts

pytestmark = requires_live_db

SCHEDULE_SQL = (
    'SELECT "appt_id", "appt_time", "provider_id", "operatory_id", "status", "patient_id" '
    'FROM "dba"."appointment" '
    'WHERE "appt_time" >= ? AND "appt_time" < ? '
    'ORDER BY "appt_time"'
)
FIND_PATIENT_SQL = (
    'SELECT "patient_id", "first_name", "last_name" '
    'FROM "dba"."patient" '
    "WHERE \"last_name\" LIKE ? ESCAPE '\\' "
    'ORDER BY "last_name", "first_name"'
)
GET_PATIENT_SQL = (
    'SELECT "patient_id", "first_name", "last_name" '
    'FROM "dba"."patient" '
    'WHERE "patient_id" = ?'
)
AR_SUMMARY_SQL = (
    'SELECT COUNT("account_id") AS account_count, SUM("balance") AS total_balance '
    'FROM "dba"."account"'
)


def _reschedule_sql(column: str) -> str:
    """The one-column shape of the registered reschedule_appointment write."""
    return (
        f'UPDATE "dba"."appointment" SET "{column}" = ? '
        'WHERE "appt_id" = ? AND "last_modified" = ?'
    )


def _post(client, path, **body):
    return client.post(path, json=body)


def _direct_rows(sql: str, params: tuple = (), identity: str = "read") -> list[dict]:
    """Out-of-band database access for test scaffolding and grant proofs.

    Deliberately NOT through the routes: the bridge only executes registered
    statements now, and scaffolding must not become a reason to loosen that.
    """
    pool = ConnectionPool()
    target = default_target()
    conn = pool.acquire(target, identity)
    try:
        cursor = conn.cursor()
        cursor.execute(sql, *params)
        rows = rows_to_dicts(cursor)
        conn.rollback()
        return rows
    finally:
        pool.release(target, identity, conn, discard=True)


def _last_modified(appt_id: int) -> str:
    rows = _direct_rows(
        'SELECT last_modified FROM dba.appointment WHERE appt_id = ?', (appt_id,)
    )
    return rows[0]["last_modified"]


def _appt(appt_id: int) -> dict:
    rows = _direct_rows(
        'SELECT status, operatory_id, reason FROM dba.appointment WHERE appt_id = ?',
        (appt_id,),
    )
    return rows[0]


class TestHealth:
    def test_reports_ok_against_a_reachable_database(self, client):
        body = client.get("/health").json()
        assert body["ok"] is True
        assert body["target"].endswith("/pattersonpm_mock")

    def test_reports_not_ok_when_the_practice_server_is_unreachable(self, client, env):
        """The failure mode this guards against is a dashboard showing a green
        light over a dead connection. A running bridge is not a working one."""
        env(ERP_DB_PORT="9")  # nothing listens on discard/9
        body = client.get("/health").json()
        assert body["ok"] is False
        assert body["reason"] == "UPSTREAM_UNAVAILABLE"

    def test_reports_not_ok_when_no_database_is_configured(self, client, env):
        env(ERP_DB_HOST=None)
        body = client.get("/health").json()
        assert body["ok"] is False
        assert body["reason"] == "NOT_CONFIGURED"
        assert "ERP_DB_HOST" in body["message"]

    def test_never_leaks_the_password_in_a_failure_message(self, client, env):
        env(ERP_DB_PORT="9", ERP_DB_RO_PASSWORD="hunter2-unmistakable")
        body = client.get("/health").json()
        assert "hunter2-unmistakable" not in str(body)


class TestRead:
    def test_returns_real_rows_from_the_seeded_schedule(self, client):
        r = _post(
            client,
            "/read/get_schedule_today",
            sql=SCHEDULE_SQL,
            params=["2000-01-01T00:00:00", "2100-01-01T00:00:00"],
        )
        assert r.status_code == 200
        rows = r.json()["rows"]
        # The seed has five appointments spanning yesterday/today/tomorrow.
        assert [row["appt_id"] for row in rows] == [5004, 5001, 5002, 5003, 5005]
        assert r.json()["rowCount"] == 5

    def test_the_time_window_is_bound_not_interpolated(self, client):
        """A narrow window really narrows the result — proof the `?` values
        reached the server as parameters and were applied."""
        rows = _post(
            client,
            "/read/get_schedule_today",
            sql=SCHEDULE_SQL,
            params=["2000-01-01T00:00:00", "2000-01-02T00:00:00"],
        ).json()["rows"]
        assert rows == []

    def test_a_sql_fragment_in_a_parameter_is_data_not_syntax(self, client):
        """The classic injection string is matched as a literal last name and
        finds nobody — it does not become part of the statement."""
        rows = _post(
            client, "/read/find_patient", sql=FIND_PATIENT_SQL, params=["' OR 1=1 --%"]
        ).json()["rows"]
        assert rows == []

    def test_a_prefix_search_finds_the_expected_patient(self, client):
        rows = _post(client, "/read/find_patient", sql=FIND_PATIENT_SQL, params=["Lis%"]).json()["rows"]
        assert [r["last_name"] for r in rows] == ["Liskov"]

    def test_an_escaped_wildcard_cannot_match_every_patient(self, client):
        """`escapeLike` (read-queries.ts) turns a `%` search term into `\\%%`,
        which must match a patient whose last name literally starts with `%` —
        i.e. nobody. This proves the `ESCAPE '\\'` clause survives the ODBC
        round trip with the term BOUND rather than concatenated; if it did not,
        the term would degrade to a bare `%` and return the whole table, which
        is a PHI over-fetch rather than an error anyone would notice."""
        rows = _post(client, "/read/find_patient", sql=FIND_PATIENT_SQL, params=["\\%%"]).json()["rows"]
        assert rows == []

    def test_aggregates_come_back_as_json_numbers(self, client):
        """Postgres NUMERIC and SQL Anywhere NUMERIC both arrive as Decimal,
        which is not JSON-serializable — rows_to_dicts normalizes it."""
        rows = _post(client, "/read/get_ar_summary", sql=AR_SUMMARY_SQL).json()["rows"]
        assert rows == [{"account_count": 5, "total_balance": 634.5}]

    def test_timestamps_come_back_as_iso_strings(self, client):
        rows = _post(
            client,
            "/read/get_schedule_today",
            sql=SCHEDULE_SQL,
            params=["2000-01-01T00:00:00", "2100-01-01T00:00:00"],
        ).json()["rows"]
        assert rows
        for row in rows:
            assert isinstance(row["appt_time"], str)
            datetime.datetime.fromisoformat(row["appt_time"])  # must parse

    def test_an_unregistered_statement_is_refused_before_the_database(self, client):
        """WARP-2540, the first layer live: the ad-hoc scaffolding read this
        suite itself used to send is exactly what the routes refuse now."""
        r = _post(
            client,
            "/read/get_appt",
            sql="SELECT last_modified FROM dba.appointment WHERE appt_id = ?",
            params=[5001],
        )
        assert r.status_code == 400
        assert r.json()["code"] == "UNKNOWN_STATEMENT"

    def test_a_reshaped_statement_under_a_registered_name_is_refused(self, client):
        r = _post(
            client,
            "/read/get_patient",
            sql=GET_PATIENT_SQL + ' OR "last_name" = ?',
            params=[1003, "Liskov"],
        )
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"

    def test_a_non_select_is_refused_before_it_reaches_the_database(self, client):
        """A write on the read route is a shape mismatch before it is anything
        else; NOT_A_READ remains the second layer (unit-pinned in
        test_guards.py) for statements the allowlist has no say over."""
        r = _post(client, "/read/get_patient", sql='UPDATE "dba"."patient" SET "phone" = ?', params=["x"])
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"
        assert "get_patient" in r.json()["message"]

    def test_a_stacked_read_is_refused(self, client):
        r = _post(client, "/read/get_patient", sql=GET_PATIENT_SQL + "; DROP TABLE dba.patient")
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"

    def test_a_broken_statement_is_a_query_error_not_a_connection_error(self, client):
        """Identifier NAMES stay free under the allowlist — the schema map
        resolves them per practice and the SERVER checks they exist. So a
        registered shape naming a column that does not exist still reaches the
        database and comes back as QUERY_FAILED: our bug, kept loud, not
        laundered into 'not connected'."""
        r = _post(
            client,
            "/read/get_patient",
            sql='SELECT "no_such_column", "first_name", "last_name" '
            'FROM "dba"."patient" WHERE "patient_id" = ?',
            params=[1003],
        )
        assert r.status_code == 502
        assert r.json()["code"] == "QUERY_FAILED"

    def test_a_query_error_does_not_echo_bound_parameter_values(self, client):
        """On this track a bound value is a patient identifier, so an error
        response must be built from the driver's message and the query NAME —
        never from the request. Whether a given driver quotes offending values
        into its own text is outside our control; what is pinned here is that
        the bridge does not add them itself."""
        r = _post(
            client,
            "/read/get_patient",
            sql='SELECT "no_such_column", "first_name", "last_name" '
            'FROM "dba"."patient" WHERE "patient_id" = ?',
            params=[1003],
        )
        assert "1003" not in r.json()["message"]

    def test_an_unreachable_target_degrades_honestly(self, client):
        r = _post(
            client,
            "/read/get_patient",
            sql=GET_PATIENT_SQL,
            params=[1003],
            target={"host": "127.0.0.1", "port": 9, "serverName": "x", "databaseName": "x"},
        )
        assert r.status_code == 503
        assert r.json()["code"] == "UPSTREAM_UNAVAILABLE"

    def test_a_missing_read_credential_reports_not_configured(self, client, env):
        env(ERP_DB_RO_PASSWORD=None)
        r = _post(client, "/read/get_patient", sql=GET_PATIENT_SQL, params=[1003])
        assert r.status_code == 503
        assert r.json()["code"] == "NOT_CONFIGURED"


class TestGrantsAreTheRealBoundary:
    """The route guards are belt-and-braces. THIS is the actual safety
    property: even with every check in main.py removed, a read connection
    cannot write, because `droplet_ro` was never granted the privilege.

    The rogue-write cases used to be driven through `/write/*` under made-up
    names; the WARP-2540 allowlist refuses those before the server ever sees
    them (pinned in TestWrite below), so the grant proofs now drive the
    connection directly — the property they establish is unchanged."""

    def test_the_read_account_cannot_update_even_bypassing_the_route(self):
        pool = ConnectionPool()
        conn = pool.acquire(default_target(), "read")
        try:
            with pytest.raises(pyodbc.Error) as exc:
                conn.cursor().execute("UPDATE dba.appointment SET status = 'x' WHERE appt_id = 5001")
            assert "permission denied" in str(exc.value).lower()
        finally:
            pool.release(default_target(), "read", conn, discard=True)

    def test_the_read_account_cannot_delete(self):
        pool = ConnectionPool()
        conn = pool.acquire(default_target(), "read")
        try:
            with pytest.raises(pyodbc.Error):
                conn.cursor().execute("DELETE FROM dba.patient WHERE patient_id = 1005")
        finally:
            pool.release(default_target(), "read", conn, discard=True)

    def test_the_write_account_is_refused_on_a_forbidden_table(self):
        """`account` is in FORBIDDEN_WRITE_TABLES (write-commands.ts) and was
        never granted to droplet_rw. Even code holding the write connection
        itself is refused by the server."""
        pool = ConnectionPool()
        conn = pool.acquire(default_target(), "write")
        try:
            with pytest.raises(pyodbc.Error) as exc:
                conn.cursor().execute("UPDATE dba.account SET balance = 0 WHERE account_id = 7004")
            assert "permission denied" in str(exc.value).lower()
            conn.rollback()
        finally:
            pool.release(default_target(), "write", conn, discard=True)

    def test_the_write_account_is_refused_on_a_column_outside_the_allowlist(self):
        """The grant is column-scoped: UPDATE on appointment's four scheduling
        columns only. `reason` is not one of them."""
        pool = ConnectionPool()
        conn = pool.acquire(default_target(), "write")
        try:
            with pytest.raises(pyodbc.Error):
                conn.cursor().execute(
                    "UPDATE dba.appointment SET reason = 'x' WHERE appt_id = 5004"
                )
            conn.rollback()
        finally:
            pool.release(default_target(), "write", conn, discard=True)
        assert _appt(5004)["reason"] == "Bitewings"  # seeded value, untouched


class TestWrite:
    def test_applies_the_change_and_reports_the_row_count(self, client):
        guard = _last_modified(5002)
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql=_reschedule_sql("status"),
            params=["confirmed", 5002, guard],
        )
        assert r.status_code == 200
        assert r.json() == {"rowCount": 1, "applied": True}
        assert _appt(5002)["status"] == "confirmed"

    def test_the_change_is_committed_not_left_in_an_open_transaction(self, client):
        """The verification read runs on a DIFFERENT connection (the direct
        read identity, its own pool), so seeing the new value proves the write
        committed."""
        guard = _last_modified(5003)
        _post(
            client,
            "/write/reschedule_appointment",
            sql=_reschedule_sql("operatory_id"),
            params=[1, 5003, guard],
        )
        assert _appt(5003)["operatory_id"] == 1

    def test_a_stale_guard_applies_nothing_and_is_not_an_error(self, client):
        """The row moved under us. Reporting success would be a lie; throwing
        would invite a blind retry over a front-desk edit. Zero rows, HTTP 200,
        and the caller decides."""
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql=_reschedule_sql("status"),
            params=["cancelled", 5001, "1999-01-01T00:00:00"],
        )
        assert r.status_code == 200
        assert r.json() == {"rowCount": 0, "applied": False}
        assert _appt(5001)["status"] == "confirmed"  # untouched by the missed guard

    def test_the_watermark_moves_so_a_replayed_guard_cannot_apply_twice(self, client):
        before = _last_modified(5005)
        _post(
            client,
            "/write/reschedule_appointment",
            sql=_reschedule_sql("status"),
            params=["confirmed", 5005, before],
        )
        assert _last_modified(5005) != before

        replay = _post(
            client,
            "/write/reschedule_appointment",
            sql=_reschedule_sql("status"),
            params=["cancelled", 5005, before],
        )
        assert replay.json() == {"rowCount": 0, "applied": False}

    def test_a_select_is_refused_on_the_write_route(self, client):
        """A SELECT can never match a registered write skeleton, so this is a
        shape mismatch at the first layer; NOT_A_WRITE remains the second
        (unit-pinned in test_guards.py)."""
        r = _post(client, "/write/reschedule_appointment", sql="SELECT 1")
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"

    def test_an_unregistered_write_name_is_refused_outright(self, client):
        """Review's reproduction, upgraded: before WARP-2540 this rogue write
        pair reached the server and only the batch guard stood in the way. Now
        the NAME is refused before any connection exists."""
        r = _post(
            client,
            "/write/pwn_test",
            sql=(
                "UPDATE dba.appointment SET status = 'HACKED-5001' WHERE appt_id = 5001; "
                "UPDATE dba.appointment SET status = 'HACKED-5002' WHERE appt_id = 5002"
            ),
        )
        assert r.status_code == 400
        assert r.json()["code"] == "UNKNOWN_STATEMENT"
        # Neither row moved — the batch never reached a connection at all.
        assert not str(_appt(5001)["status"]).startswith("HACKED")
        assert not str(_appt(5002)["status"]).startswith("HACKED")

    def test_a_batch_appended_to_a_legitimate_write_is_refused(self, client):
        """The realistic shape of the same bug: a correct, guarded UPDATE with
        a second statement tacked on, under the REGISTERED name. The first
        statement alone would have been accepted; the appended batch changes
        the shape and the allowlist refuses the whole thing."""
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql=_reschedule_sql("status") + "; DELETE FROM dba.recall",
            params=["confirmed", 5001, "1999-01-01T00:00:00"],
        )
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"

    def test_a_semicolon_inside_a_bound_value_does_not_block_a_real_write(self, client):
        """The guard must not become a denial-of-service on legitimate data:
        parameters are not part of the statement text at all, and a literal
        containing a semicolon is not a separator."""
        guard = _last_modified(5003)
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql=_reschedule_sql("status"),
            params=["a;b", 5003, guard],
        )
        assert r.status_code == 200
        assert r.json() == {"rowCount": 1, "applied": True}

    def test_a_missing_write_credential_reports_not_configured(self, client, env):
        """Writes are opt-in: a box that never enabled a write capability has
        no ERP_DB_RW_PASSWORD, and must say so rather than trying the read
        account."""
        env(ERP_DB_RW_PASSWORD=None)
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql=_reschedule_sql("status"),
            params=["x", 5001, "1999-01-01T00:00:00"],
        )
        assert r.status_code == 503
        assert r.json()["code"] == "NOT_CONFIGURED"

    def test_a_refused_write_leaves_the_row_untouched(self, client):
        """A write reshaped to touch a column outside the registered shape
        never reaches the database at all now — the row cannot have moved."""
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql='UPDATE "dba"."appointment" SET "reason" = ? WHERE "appt_id" = ?',
            params=["should not stick", 5004],
        )
        assert r.status_code == 400
        assert r.json()["code"] == "STATEMENT_MISMATCH"
        assert _appt(5004)["reason"] == "Bitewings"


class TestIntrospect:
    def test_runs_every_labelled_query_and_keys_the_results(self, client):
        r = client.post(
            "/introspect",
            json={
                "queries": {
                    "tables": {
                        "sql": "SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema = ? ORDER BY table_name",
                        "params": ["dba"],
                    },
                    "columns": {
                        "sql": "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
                        "params": ["dba", "appointment"],
                    },
                }
            },
        )
        assert r.status_code == 200
        results = r.json()["results"]
        assert [t["table_name"] for t in results["tables"]] == [
            "account",
            "appointment",
            "operatory",
            "patient",
            "provider",
            "recall",
            "serv_trans",
            "service",
        ]
        assert [c["column_name"] for c in results["columns"]][:3] == [
            "appt_id",
            "patient_id",
            "provider_id",
        ]

    def test_a_bad_catalog_query_is_a_query_error(self, client):
        r = client.post("/introspect", json={"queries": {"tables": {"sql": "SELECT * FROM SYS.SYSTAB"}}})
        assert r.status_code == 502
        assert r.json()["code"] == "QUERY_FAILED"

    def test_a_non_select_is_refused_on_the_introspect_route_too(self, client):
        """This route also runs on the read connection, so it carries the same
        guard — otherwise it would be the one way to hand a write to
        `droplet_ro` and get a server-side permission error instead of a
        by-name refusal."""
        r = client.post(
            "/introspect",
            json={
                "queries": {
                    "tables": {"sql": "SELECT table_name FROM information_schema.tables"},
                    "sneaky": {"sql": "UPDATE dba.appointment SET status = 'x'"},
                }
            },
        )
        assert r.status_code == 400
        assert r.json()["code"] == "NOT_A_READ"
        assert "sneaky" in r.json()["message"]

    def test_a_batch_is_refused_on_the_introspect_route_too(self, client):
        r = client.post(
            "/introspect",
            json={"queries": {"t": {"sql": "SELECT 1; UPDATE dba.appointment SET status = 'x'"}}},
        )
        assert r.status_code == 400
        assert r.json()["code"] == "NOT_A_SINGLE_STATEMENT"

    def test_introspection_uses_the_read_identity(self, client, env):
        env(ERP_DB_RO_PASSWORD=None)
        r = client.post("/introspect", json={"queries": {"t": {"sql": "SELECT 1"}}})
        assert r.json()["code"] == "NOT_CONFIGURED"


class TestPool:
    def test_a_connection_is_returned_to_the_pool_and_reused(self, client):
        _post(client, "/read/get_ar_summary", sql=AR_SUMMARY_SQL)
        first = client.get("/health").json()["pool"]["idle"]
        assert sum(first.values()) >= 1

        _post(client, "/read/get_ar_summary", sql=AR_SUMMARY_SQL)
        second = client.get("/health").json()["pool"]["idle"]
        # Reuse, not growth: a second read must not open a second connection.
        assert sum(second.values()) == sum(first.values())

    def test_read_and_write_identities_never_share_a_connection(self, client):
        _post(client, "/read/get_ar_summary", sql=AR_SUMMARY_SQL)
        guard = _last_modified(5004)
        _post(
            client,
            "/write/reschedule_appointment",
            sql=_reschedule_sql("status"),
            params=["complete", 5004, guard],
        )
        idle = client.get("/health").json()["pool"]["idle"]
        keys = sorted(k.split("@", 1)[0] for k in idle)
        assert keys == ["read", "write"]

    def test_a_dead_connection_is_discarded_rather_than_handed_out(self, client):
        """A practice server restarting overnight is the normal case. The pool
        validates before reuse, so the next read reconnects instead of failing
        on a stale handle."""
        import main

        target = default_target()
        conn = main.POOL.acquire(target, "read")
        conn.close()  # simulate the server dropping the link
        main.POOL.release(target, "read", conn)

        r = _post(client, "/read/get_ar_summary", sql=AR_SUMMARY_SQL)
        assert r.status_code == 200
