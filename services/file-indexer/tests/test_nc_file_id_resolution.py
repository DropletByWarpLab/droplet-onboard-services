"""WARP-1327 — the Nextcloud-DB connection URL was derived with
``DATABASE_URL.replace("/droplet", "/nextcloud")``, which also rewrites the
USERNAME (``//droplet:`` → ``//nextcloud:``), so file-id resolution connected
as a nonexistent role and every file failed ``nc_file_id_unresolved``
(reproduced on the staging box: password authentication failed for user
"nextcloud"). The derivation must swap only the trailing database name, be
overridable via NEXTCLOUD_DATABASE_URL, query the oc_* tables
schema-qualified, and log resolution failures at WARNING (they were
debug-invisible — WARP-1329's finding D).
"""

from __future__ import annotations

import importlib
import logging
from unittest.mock import MagicMock

import config
import watcher


# ── URL derivation ───────────────────────────────────────────────────────


def test_derivation_swaps_only_the_database_name():
    assert (
        config.derive_nextcloud_db_url("postgresql://droplet:s3cret@db:5432/droplet")
        == "postgresql://droplet:s3cret@db:5432/nextcloud"
    )


def test_derivation_preserves_username_equal_to_db_name():
    # The exact WARP-1327 bug case: user, password, and db all "droplet".
    assert (
        config.derive_nextcloud_db_url(
            "postgresql://droplet:droplet@localhost:5432/droplet"
        )
        == "postgresql://droplet:droplet@localhost:5432/nextcloud"
    )


def test_derivation_preserves_query_params():
    # Production DATABASE_URL carries ?sslmode=require (WARP-233) — the db
    # name is the PATH component only; the query string must survive.
    assert (
        config.derive_nextcloud_db_url(
            "postgresql://droplet:pw@db:5432/droplet?sslmode=require"
        )
        == "postgresql://droplet:pw@db:5432/nextcloud?sslmode=require"
    )


def test_env_override_wins(monkeypatch):
    monkeypatch.setenv(
        "NEXTCLOUD_DATABASE_URL", "postgresql://indexer_ro:x@db:5432/nextcloud"
    )
    importlib.reload(config)
    try:
        assert (
            config.NEXTCLOUD_DATABASE_URL
            == "postgresql://indexer_ro:x@db:5432/nextcloud"
        )
    finally:
        monkeypatch.delenv("NEXTCLOUD_DATABASE_URL")
        importlib.reload(config)


def test_default_is_derived_from_database_url():
    assert config.NEXTCLOUD_DATABASE_URL == config.derive_nextcloud_db_url(
        config.DATABASE_URL
    )


# ── resolver behaviour ───────────────────────────────────────────────────


def _mock_conn(fetchone_results):
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchone.side_effect = fetchone_results
    return conn, cur


def test_resolver_queries_are_schema_qualified(monkeypatch):
    """Unqualified oc_* lookups silently miss when the connecting role lacks
    schema USAGE (Postgres skips schemas it can't use) — qualify them."""
    conn, cur = _mock_conn([(7,), (4242,)])
    monkeypatch.setattr(watcher, "_get_nc_conn", lambda: conn)
    assert watcher._resolve_nc_file_id("alice", "Docs/x.txt") == 4242
    sqls = [call.args[0] for call in cur.execute.call_args_list]
    assert "public.oc_storages" in sqls[0]
    assert "public.oc_filecache" in sqls[1]


def test_groupfolder_resolver_query_is_schema_qualified(monkeypatch):
    conn, cur = _mock_conn([(4243,)])
    monkeypatch.setattr(watcher, "_get_nc_conn", lambda: conn)
    assert watcher._resolve_gf_file_id("__groupfolders/1/Docs/x.txt") == 4243
    (sql,) = [call.args[0] for call in cur.execute.call_args_list]
    assert "public.oc_filecache" in sql


def test_resolver_failure_logs_warning(monkeypatch, caplog):
    def boom():
        raise RuntimeError("password authentication failed")

    monkeypatch.setattr(watcher, "_get_nc_conn", boom)
    with caplog.at_level(logging.WARNING, logger="watcher"):
        assert watcher._resolve_nc_file_id("alice", "x.txt") is None
    assert any(
        r.levelno == logging.WARNING and "resolve" in r.message.lower()
        for r in caplog.records
    )
