"""Shared fixtures for the ERP SQL bridge suite.

Two lanes live here:

* PURE tests run anywhere, with no database and no ODBC driver. They cover the
  connection-string assembly, redaction, and the route guards.
* LIVE tests run only when `ERP_BRIDGE_LIVE_DB=1` — set by
  `scripts/test-erp-sql-bridge.sh`, which boots a throwaway Postgres seeded
  with the synthetic PattersonPM schema and drives the bridge through the
  psqlODBC driver. See that script for why Postgres stands in for SQL Anywhere.

Skipping (rather than failing) without the env is deliberate: a contributor
running `pytest` in this directory should get the pure suite, not an error
about a database they were never told to start.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# main.py / db.py are top-level modules in the service root (they are copied to
# /app in the image and imported flat), so the service root has to be
# importable before anything below is collected.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

LIVE = os.environ.get("ERP_BRIDGE_LIVE_DB") == "1"

requires_live_db = pytest.mark.skipif(
    not LIVE,
    reason="needs a live database — run scripts/test-erp-sql-bridge.sh",
)


@pytest.fixture
def client():
    """FastAPI TestClient over the real app, with the real pool.

    Nothing is mocked: the app under test opens actual ODBC connections. The
    pool is drained between tests so a test that poisons a connection cannot
    leak it into the next one.
    """
    from fastapi.testclient import TestClient

    import main

    main.POOL.close_all()
    with TestClient(main.app) as c:
        yield c
    main.POOL.close_all()


@pytest.fixture
def env(monkeypatch):
    """Set bridge environment variables for one test.

    Credentials are resolved from the process environment on every connect
    (db._credentials), so overriding them here is enough to exercise the
    misconfiguration paths without restarting anything.
    """

    def _set(**kwargs: str | None) -> None:
        for key, value in kwargs.items():
            if value is None:
                monkeypatch.delenv(key, raising=False)
            else:
                monkeypatch.setenv(key, value)

    return _set
