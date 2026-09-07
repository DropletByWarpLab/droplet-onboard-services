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


#: WARP-2590. The service bearer every fixture below presents. It is a test
#: constant, not a secret — the real one is minted per box by
#: scripts/lib/secrets.sh.
TEST_SERVICE_TOKEN = "test-erp-bridge-token"


@pytest.fixture
def authed_token(monkeypatch):
    """Provision the bridge with a known service bearer for one test.

    `auth.SERVICE_TOKEN` is read at import, so the middleware resolves the
    module global on every request — patching the attribute is what makes a
    provisioned bridge testable without re-importing the app.
    """
    import auth

    monkeypatch.setattr(auth, "SERVICE_TOKEN", TEST_SERVICE_TOKEN)
    return TEST_SERVICE_TOKEN


@pytest.fixture
def client(authed_token):
    """FastAPI TestClient over the real app, with the real pool.

    Nothing is mocked: the app under test opens actual ODBC connections. The
    pool is drained between tests so a test that poisons a connection cannot
    leak it into the next one.

    WARP-2590: this client is AUTHENTICATED. Every route except /health now
    requires the service bearer, and the suites that predate the gate are
    about the guards BEHIND it (allowlist, statement shape, connection
    string) — making them carry the header keeps them testing what they were
    written to test. `unauthenticated_client` is the fixture for the gate
    itself.
    """
    from fastapi.testclient import TestClient

    import main

    main.POOL.close_all()
    with TestClient(main.app, headers={"Authorization": f"Bearer {authed_token}"}) as c:
        yield c
    main.POOL.close_all()


@pytest.fixture
def unauthenticated_client(authed_token):
    """Same app, same provisioned token — but the caller presents nothing.

    Used by test_auth.py to prove the gate refuses before any route body or
    pool acquire runs.
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
