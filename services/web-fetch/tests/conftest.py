"""Shared pytest fixtures for services/web-fetch.

No live network calls anywhere: every outbound httpx call goes through
providers.create_client(), which the mock_transport fixture replaces with an
httpx.MockTransport-backed client.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# --- Pre-import env setup ---
# `main` reads WEB_FETCH_SERVICE_TOKEN at module import time, so the default
# has to be in os.environ *before* main is imported below. Tests that need a
# different value monkeypatch main.WEB_FETCH_SERVICE_TOKEN directly (the
# module global is looked up at call time inside require_bearer).
os.environ.setdefault("WEB_FETCH_SERVICE_TOKEN", "pytest-fake-token")

# Make `import main` work when pytest is invoked from the repo root.
_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
import providers  # noqa: E402

TOKEN = "pytest-fake-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client() -> TestClient:
    return TestClient(main.app)


@pytest.fixture
def mock_transport(monkeypatch: pytest.MonkeyPatch):
    """Install a MockTransport behind providers.create_client for one test.

    Usage: `mock_transport(handler)` where handler(request) -> httpx.Response
    (or raises an httpx exception to simulate network failures).
    """

    def _install(handler) -> None:
        transport = httpx.MockTransport(handler)
        monkeypatch.setattr(
            providers,
            "create_client",
            lambda: httpx.AsyncClient(
                transport=transport, timeout=providers.HTTP_TIMEOUT_SECONDS
            ),
        )

    return _install
