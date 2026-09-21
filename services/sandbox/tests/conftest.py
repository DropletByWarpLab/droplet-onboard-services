"""Shared pytest fixtures for services/sandbox.

`main` reads SANDBOX_SERVICE_TOKEN at import, so the default has to be in
os.environ before it is imported (doc-render / web-fetch precedent). Tests
that need a different value monkeypatch main.SANDBOX_SERVICE_TOKEN.

The transform tests spawn a REAL child interpreter (runner.py) — that is the
thing under test — with a scratch dir under the platform temp so the suite
runs on a Windows dev checkout as well as the Linux CI runner.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SANDBOX_SERVICE_TOKEN", "pytest-fake-token")
os.environ.setdefault("SANDBOX_SCRATCH_DIR", tempfile.gettempdir())

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

import pytest  # noqa: E402


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    import main  # noqa: E402

    return TestClient(main.app)


@pytest.fixture()
def auth():
    return {"Authorization": "Bearer pytest-fake-token"}
