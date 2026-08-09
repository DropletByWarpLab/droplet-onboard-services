"""End-to-end bridge behaviour against a REAL database.

Run via `scripts/test-erp-sql-bridge.sh`, which boots a throwaway Postgres
seeded with the synthetic PattersonPM schema and its least-privilege grants,
and points ERP_ODBC_DRIVER at psqlODBC. That script's header explains why
Postgres stands in for SQL Anywhere; the short version is that everything after
`pyodbc.connect` is driver-independent, and the SAP client is license-gated.

Nothing here is mocked. Every assertion below went through unixODBC, a real
connection, and a real server-side privilege check.
"""
from __future__ import annotations

import pyodbc
import pytest

from conftest import requires_live_db
from db import ConnectionPool, default_target

pytestmark = requires_live_db

# Registry-shaped statements. They are written out rather than imported because
# the registry is TypeScript — `erp-connector/__tests__/sql-bridge.live.test.ts`
# is what proves the real generated SQL runs through this service. Here they are
# stand-ins with the same shape, exercising the bridge's own behaviour.
SCHEDULE_SQL = (
    "SELECT dba.appointment.appt_id, dba.appointment.appt_time, dba.appointment.status "
    "FROM dba.appointment WHERE dba.appointment.appt_time >= ? AND dba.appointment.appt_time < ? "
    "ORDER BY dba.appointment.appt_time"
)
FIND_PATIENT_SQL = (
    "SELECT dba.patient.patient_id, dba.patient.first_name, dba.patient.last_name "
    "FROM dba.patient WHERE dba.patient.last_name LIKE ? ESCAPE '\\' "
    "ORDER BY dba.patient.last_name"
)


def _post(client, path, **body):
    return client.post(path, json=body)


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
        rows = _post(
            client,
            "/read/get_ar_summary",
            sql="SELECT COUNT(account_id) AS account_count, SUM(balance) AS total_balance FROM dba.account",
        ).json()["rows"]
        assert rows == [{"account_count": 5, "total_balance": 634.5}]

    def test_dates_and_timestamps_come_back_as_iso_strings(self, client):
        rows = _post(
            client,
            "/read/get_patient",
            sql="SELECT date_of_birth FROM dba.patient WHERE patient_id = ?",
            params=[1003],
        ).json()["rows"]
        assert rows == [{"date_of_birth": "1985-11-02"}]

    def test_a_non_select_is_refused_before_it_reaches_the_database(self, client):
        r = _post(client, "/read/get_patient", sql="UPDATE dba.patient SET phone = ?", params=["x"])
        assert r.status_code == 400
        assert r.json()["code"] == "NOT_A_READ"
        assert "get_patient" in r.json()["message"]

    def test_a_stacked_read_is_refused_as_a_batch(self, client):
        r = _post(client, "/read/get_patient", sql="SELECT 1; DROP TABLE dba.patient")
        assert r.status_code == 400
        assert r.json()["code"] == "NOT_A_SINGLE_STATEMENT"

    def test_a_broken_statement_is_a_query_error_not_a_connection_error(self, client):
        """The distinction matters: UPSTREAM_UNAVAILABLE degrades the whole ERP
        integration honestly, while QUERY_FAILED is our bug and must stay
        loud rather than being laundered into 'not connected'."""
        r = _post(client, "/read/get_patient", sql="SELECT no_such_column FROM dba.patient")
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
            sql="SELECT no_such_column FROM dba.patient WHERE patient_id = ?",
            params=[1003],
        )
        assert "1003" not in r.json()["message"]

    def test_an_unreachable_target_degrades_honestly(self, client):
        r = _post(
            client,
            "/read/get_patient",
            sql="SELECT patient_id FROM dba.patient",
            target={"host": "127.0.0.1", "port": 9, "serverName": "x", "databaseName": "x"},
        )
        assert r.status_code == 503
        assert r.json()["code"] == "UPSTREAM_UNAVAILABLE"

    def test_a_missing_read_credential_reports_not_configured(self, client, env):
        env(ERP_DB_RO_PASSWORD=None)
        r = _post(client, "/read/get_patient", sql="SELECT patient_id FROM dba.patient")
        assert r.status_code == 503
        assert r.json()["code"] == "NOT_CONFIGURED"


class TestGrantsAreTheRealBoundary:
    """The route guards are belt-and-braces. THIS is the actual safety
    property: even with every check in main.py removed, a read connection
    cannot write, because `droplet_ro` was never granted the privilege."""

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

    def test_the_write_account_is_refused_on_a_forbidden_table(self, client):
        """`account` is in FORBIDDEN_WRITE_TABLES (write-commands.ts) and was
        never granted to droplet_rw. Even if a write command were added that
        targeted it, the server refuses."""
        r = _post(
            client,
            "/write/rogue_ar_write",
            sql="UPDATE dba.account SET balance = ? WHERE account_id = ?",
            params=[0, 7004],
        )
        assert r.status_code == 502
        assert r.json()["code"] == "WRITE_FAILED"

    def test_the_write_account_is_refused_on_a_column_outside_the_allowlist(self, client):
        """The grant is column-scoped: UPDATE on appointment's four scheduling
        columns only. `reason` is not one of them."""
        r = _post(
            client,
            "/write/rogue_column_write",
            sql="UPDATE dba.appointment SET reason = ? WHERE appt_id = ?",
            params=["x", 5001],
        )
        assert r.status_code == 502
        assert r.json()["code"] == "WRITE_FAILED"


class TestWrite:
    def _last_modified(self, client, appt_id):
        rows = _post(
            client,
            "/read/get_appt",
            sql="SELECT last_modified FROM dba.appointment WHERE appt_id = ?",
            params=[appt_id],
        ).json()["rows"]
        return rows[0]["last_modified"]

    def test_applies_the_change_and_reports_the_row_count(self, client):
        guard = self._last_modified(client, 5002)
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql="UPDATE dba.appointment SET status = ? WHERE appt_id = ? AND last_modified = ?",
            params=["confirmed", 5002, guard],
        )
        assert r.status_code == 200
        assert r.json() == {"rowCount": 1, "applied": True}

        rows = _post(
            client,
            "/read/get_appt",
            sql="SELECT status FROM dba.appointment WHERE appt_id = ?",
            params=[5002],
        ).json()["rows"]
        assert rows == [{"status": "confirmed"}]

    def test_the_change_is_committed_not_left_in_an_open_transaction(self, client):
        """The read runs on a DIFFERENT connection (different identity, its own
        pool bucket), so seeing the new value proves the write committed."""
        guard = self._last_modified(client, 5003)
        _post(
            client,
            "/write/reschedule_appointment",
            sql="UPDATE dba.appointment SET operatory_id = ? WHERE appt_id = ? AND last_modified = ?",
            params=[1, 5003, guard],
        )
        rows = _post(
            client,
            "/read/get_appt",
            sql="SELECT operatory_id FROM dba.appointment WHERE appt_id = ?",
            params=[5003],
        ).json()["rows"]
        assert rows == [{"operatory_id": 1}]

    def test_a_stale_guard_applies_nothing_and_is_not_an_error(self, client):
        """The row moved under us. Reporting success would be a lie; throwing
        would invite a blind retry over a front-desk edit. Zero rows, HTTP 200,
        and the caller decides."""
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql="UPDATE dba.appointment SET status = ? WHERE appt_id = ? AND last_modified = ?",
            params=["cancelled", 5001, "1999-01-01T00:00:00"],
        )
        assert r.status_code == 200
        assert r.json() == {"rowCount": 0, "applied": False}

        rows = _post(
            client,
            "/read/get_appt",
            sql="SELECT status FROM dba.appointment WHERE appt_id = ?",
            params=[5001],
        ).json()["rows"]
        assert rows == [{"status": "confirmed"}]  # untouched by the missed guard

    def test_the_watermark_moves_so_a_replayed_guard_cannot_apply_twice(self, client):
        before = self._last_modified(client, 5005)
        _post(
            client,
            "/write/reschedule_appointment",
            sql="UPDATE dba.appointment SET status = ? WHERE appt_id = ? AND last_modified = ?",
            params=["confirmed", 5005, before],
        )
        assert self._last_modified(client, 5005) != before

        replay = _post(
            client,
            "/write/reschedule_appointment",
            sql="UPDATE dba.appointment SET status = ? WHERE appt_id = ? AND last_modified = ?",
            params=["cancelled", 5005, before],
        )
        assert replay.json() == {"rowCount": 0, "applied": False}

    def test_a_select_is_refused_on_the_write_route(self, client):
        r = _post(client, "/write/reschedule_appointment", sql="SELECT 1")
        assert r.status_code == 400
        assert r.json()["code"] == "NOT_A_WRITE"

    def test_a_stacked_write_is_refused_and_nothing_is_applied(self, client):
        """Review's reproduction, verbatim. Before the guard was made
        unconditional this returned 200 {"rowCount":1,"applied":true} and
        mutated BOTH rows — neither carrying an optimistic guard — because the
        write route only knew how to reject a SELECT, and the stacking check
        lived behind an is-a-SELECT short-circuit that a write never reached.
        The `rowCount` was the LAST statement's, so the response understated
        what it had changed."""
        r = _post(
            client,
            "/write/pwn_test",
            sql=(
                "UPDATE dba.appointment SET status = 'HACKED-5001' WHERE appt_id = 5001; "
                "UPDATE dba.appointment SET status = 'HACKED-5002' WHERE appt_id = 5002"
            ),
        )
        assert r.status_code == 400
        assert r.json()["code"] == "NOT_A_SINGLE_STATEMENT"

        # Neither row moved — the batch never reached a connection at all.
        rows = _post(
            client,
            "/read/get_appt",
            sql="SELECT appt_id, status FROM dba.appointment WHERE appt_id IN (5001, 5002) "
            "ORDER BY appt_id",
        ).json()["rows"]
        assert not any(str(row["status"]).startswith("HACKED") for row in rows)

    def test_a_batch_appended_to_a_legitimate_write_is_refused(self, client):
        """The realistic shape of the same bug: a correct, guarded UPDATE with
        a second statement tacked on. The first statement alone would have been
        accepted, so this fails only because the batch check runs first."""
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql=(
                "UPDATE dba.appointment SET status = ? WHERE appt_id = ? AND last_modified = ?; "
                "DELETE FROM dba.recall"
            ),
            params=["confirmed", 5001, "1999-01-01T00:00:00"],
        )
        assert r.status_code == 400
        assert r.json()["code"] == "NOT_A_SINGLE_STATEMENT"

    def test_a_semicolon_inside_a_bound_value_does_not_block_a_real_write(self, client):
        """The guard must not become a denial-of-service on legitimate data:
        parameters are not part of the statement text at all, and a literal
        containing a semicolon is not a separator."""
        guard = self._last_modified(client, 5003)
        r = _post(
            client,
            "/write/reschedule_appointment",
            sql="UPDATE dba.appointment SET status = ? WHERE appt_id = ? AND last_modified = ?",
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
            sql="UPDATE dba.appointment SET status = ? WHERE appt_id = ?",
            params=["x", 5001],
        )
        assert r.status_code == 503
        assert r.json()["code"] == "NOT_CONFIGURED"

    def test_a_failed_write_leaves_the_row_untouched(self, client):
        _post(
            client,
            "/write/rogue_column_write",
            sql="UPDATE dba.appointment SET reason = ? WHERE appt_id = ?",
            params=["should not stick", 5004],
        )
        rows = _post(
            client,
            "/read/get_appt",
            sql="SELECT reason FROM dba.appointment WHERE appt_id = ?",
            params=[5004],
        ).json()["rows"]
        assert rows == [{"reason": "Bitewings"}]


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
        _post(client, "/read/get_ar_summary", sql="SELECT COUNT(*) AS n FROM dba.account")
        first = client.get("/health").json()["pool"]["idle"]
        assert sum(first.values()) >= 1

        _post(client, "/read/get_ar_summary", sql="SELECT COUNT(*) AS n FROM dba.account")
        second = client.get("/health").json()["pool"]["idle"]
        # Reuse, not growth: a second read must not open a second connection.
        assert sum(second.values()) == sum(first.values())

    def test_read_and_write_identities_never_share_a_connection(self, client):
        _post(client, "/read/get_ar_summary", sql="SELECT COUNT(*) AS n FROM dba.account")
        guard = _post(
            client,
            "/read/get_appt",
            sql="SELECT last_modified FROM dba.appointment WHERE appt_id = ?",
            params=[5004],
        ).json()["rows"][0]["last_modified"]
        _post(
            client,
            "/write/reschedule_appointment",
            sql="UPDATE dba.appointment SET status = ? WHERE appt_id = ? AND last_modified = ?",
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

        r = _post(client, "/read/get_ar_summary", sql="SELECT COUNT(*) AS n FROM dba.account")
        assert r.status_code == 200
