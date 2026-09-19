"""Shared pytest fixtures for services/doc-render.

Nothing here touches the network or the filesystem: the renderers are pure
(spec in, bytes out), so the tests assert on the returned bytes directly.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# --- Pre-import env setup ---
# `main` reads DOC_RENDER_SERVICE_TOKEN at module import time, so the default
# has to be in os.environ *before* main is imported. Tests that need a
# different value monkeypatch main.DOC_RENDER_SERVICE_TOKEN directly (the
# module global is looked up at call time inside require_bearer).
os.environ.setdefault("DOC_RENDER_SERVICE_TOKEN", "pytest-fake-token")

# Make `import main` / `import renderers` work when pytest runs from the repo
# root as well as from the service directory.
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
