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
# The git store (WARP-2896) defaults to /var/lib paths that must not exist on
# a dev checkout; the workspace fixture re-points them per test.
_STORE_ROOT = tempfile.mkdtemp(prefix="sandbox-store-")
os.environ.setdefault("SANDBOX_REPOS_DIR", os.path.join(_STORE_ROOT, "git"))
os.environ.setdefault("SANDBOX_WORK_DIR", os.path.join(_STORE_ROOT, "work"))
os.environ.setdefault(
    "SANDBOX_TEMPLATES_SRC",
    str(Path(__file__).resolve().parents[3] / "extensions" / "templates"),
)

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

import pytest


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    import main

    return TestClient(main.app)


@pytest.fixture()
def auth():
    return {"Authorization": "Bearer pytest-fake-token"}


@pytest.fixture()
def store(tmp_path: Path, monkeypatch):
    """A fresh git store per test, seeded with the repo's real templates."""
    import gitstore

    monkeypatch.setattr(gitstore, "REPOS_DIR", tmp_path / "git")
    monkeypatch.setattr(gitstore, "WORK_DIR", tmp_path / "work")
    assert gitstore.seed_templates() is True
    return gitstore
