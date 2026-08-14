"""Connection-string assembly and secret hygiene (db.py).

No database is needed for any of this — these are the parts that decide WHO we
connect as and WHAT ends up in a log line, and both are worth pinning
independently of whether a server is reachable.
"""
from __future__ import annotations

import pytest

from db import (
    BridgeConfigError,
    Target,
    _credentials,
    build_connection_string,
    default_target,
    redact,
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Start every test from a known-empty bridge environment.

    The live lane exports real values, so without this the assertions below
    would depend on which lane is running.
    """
    for key in (
        "ERP_DB_HOST",
        "ERP_DB_PORT",
        "ERP_DB_NAME",
        "ERP_DB_SERVER_NAME",
        "ERP_DB_RO_USER",
        "ERP_DB_RO_PASSWORD",
        "ERP_DB_RW_USER",
        "ERP_DB_RW_PASSWORD",
        "ERP_ODBC_DRIVER",
        "ERP_DB_ENCRYPTION",
    ):
        monkeypatch.delenv(key, raising=False)


class TestCredentials:
    def test_read_and_write_identities_are_separate_accounts(self, monkeypatch):
        monkeypatch.setenv("ERP_DB_RO_PASSWORD", "ro-pw")
        monkeypatch.setenv("ERP_DB_RW_PASSWORD", "rw-pw")
        assert _credentials("read") == ("droplet_ro", "ro-pw")
        assert _credentials("write") == ("droplet_rw", "rw-pw")

    def test_missing_write_password_is_a_config_error_not_a_fallback(self, monkeypatch):
        """Writes are opt-in. A bridge with only a read credential must refuse
        to write, never quietly reuse the read account (which would then be
        refused by the server for a much less obvious reason)."""
        monkeypatch.setenv("ERP_DB_RO_PASSWORD", "ro-pw")
        with pytest.raises(BridgeConfigError, match="ERP_DB_RW_PASSWORD"):
            _credentials("write")

    def test_missing_read_password_is_a_config_error(self, monkeypatch):
        with pytest.raises(BridgeConfigError, match="ERP_DB_RO_PASSWORD"):
            _credentials("read")

    def test_unknown_identity_is_rejected(self, monkeypatch):
        monkeypatch.setenv("ERP_DB_RO_PASSWORD", "ro-pw")
        with pytest.raises(BridgeConfigError, match="unknown identity"):
            _credentials("admin")


class TestDefaultTarget:
    def test_absent_host_is_a_config_error_not_localhost(self, monkeypatch):
        """An unconfigured bridge must say so. Defaulting to localhost would
        make it try to connect to itself and report a connection failure, which
        sends an installer looking for a network problem that isn't there."""
        with pytest.raises(BridgeConfigError, match="ERP_DB_HOST"):
            default_target()

    def test_defaults_match_a_stock_eaglesoft_install(self, monkeypatch):
        monkeypatch.setenv("ERP_DB_HOST", "10.0.0.5")
        t = default_target()
        assert (t.port, t.server_name, t.database_name) == (2638, "PattersonPM", "PattersonPM")

    def test_every_field_is_overridable(self, monkeypatch):
        monkeypatch.setenv("ERP_DB_HOST", "10.0.0.5")
        monkeypatch.setenv("ERP_DB_PORT", "2639")
        monkeypatch.setenv("ERP_DB_SERVER_NAME", "PPMSRV")
        monkeypatch.setenv("ERP_DB_NAME", "PPM")
        t = default_target()
        assert t == Target(host="10.0.0.5", port=2639, server_name="PPMSRV", database_name="PPM")


class TestSqlAnywhereConnectionString:
    """The production branch. It cannot be executed here (the SAP client is
    license-gated), so its exact keyword vocabulary is pinned instead —
    a typo'd keyword is the difference between a working install and a
    3-hour on-site debug."""

    @pytest.fixture
    def cs(self, monkeypatch):
        monkeypatch.setenv("ERP_DB_RO_PASSWORD", "ro-pw")
        return build_connection_string(Target(host="10.0.0.5"), "read")

    def test_uses_the_sap_driver_by_default(self, cs):
        assert "DRIVER={SQL Anywhere 17};" in cs

    def test_host_carries_the_port_and_commlinks_is_absent(self, cs):
        """SQL Anywhere accepts Host= XOR CommLinks= — emitting both is a
        documented connection failure, so only Host= is ever produced."""
        assert "Host=10.0.0.5:2638" in cs
        assert "CommLinks" not in cs

    def test_names_both_the_server_and_the_database(self, cs):
        assert "ServerName=PattersonPM" in cs
        assert "DatabaseName=PattersonPM" in cs

    def test_encryption_defaults_to_none_and_is_overridable(self, monkeypatch, cs):
        assert "Encryption=NONE" in cs
        monkeypatch.setenv("ERP_DB_ENCRYPTION", "TLS")
        assert "Encryption=TLS" in build_connection_string(Target(host="10.0.0.5"), "read")

    def test_write_identity_selects_the_write_account(self, monkeypatch):
        monkeypatch.setenv("ERP_DB_RW_PASSWORD", "rw-pw")
        cs = build_connection_string(Target(host="10.0.0.5"), "write")
        assert "UID=droplet_rw" in cs
        assert "UID=droplet_ro" not in cs


class TestPostgresConnectionString:
    """The test-lane branch. Selected by DRIVER NAME, so production can never
    take it by accident."""

    def test_postgres_driver_switches_keyword_vocabulary(self, monkeypatch):
        monkeypatch.setenv("ERP_DB_RO_PASSWORD", "ro-pw")
        monkeypatch.setenv("ERP_ODBC_DRIVER", "PostgreSQL Unicode")
        cs = build_connection_string(Target(host="127.0.0.1", port=55433, database_name="ppm"), "read")
        assert "SERVER=127.0.0.1;PORT=55433" in cs
        assert "DATABASE=ppm" in cs
        # SQL Anywhere's keywords must not leak into the psqlODBC string —
        # psqlODBC ignores unknown keywords, so a leak would fail silently by
        # connecting to the wrong place.
        assert "ServerName=" not in cs
        assert "Host=" not in cs

    def test_a_driver_name_without_postgres_takes_the_sap_branch(self, monkeypatch):
        monkeypatch.setenv("ERP_DB_RO_PASSWORD", "ro-pw")
        monkeypatch.setenv("ERP_ODBC_DRIVER", "SQL Anywhere 12")
        cs = build_connection_string(Target(host="10.0.0.5"), "read")
        assert "DRIVER={SQL Anywhere 12};" in cs
        assert "ServerName=PattersonPM" in cs


class TestRedact:
    """pyodbc puts the whole connection string into some error messages, so
    this runs over anything that could reach a log or an HTTP response."""

    def test_password_value_is_replaced(self):
        out = redact("DRIVER={X};UID=droplet_ro;PWD=hunter2;Host=a:1")
        assert "hunter2" not in out
        assert "PWD=***" in out

    def test_long_form_keyword_is_also_caught(self):
        assert "s3cret" not in redact("Password=s3cret;Host=a")

    def test_is_case_and_whitespace_insensitive(self):
        assert "s3cret" not in redact("  pwd=s3cret ;Host=a")
        assert "s3cret" not in redact("PWD=s3cret;Host=a")

    def test_everything_else_survives_so_the_error_stays_useful(self):
        out = redact("DRIVER={SQL Anywhere 17};Host=10.0.0.5:2638;PWD=x")
        assert "10.0.0.5:2638" in out
        assert "SQL Anywhere 17" in out

    def test_a_string_with_no_password_is_unchanged(self):
        assert redact("connection timed out") == "connection timed out"
