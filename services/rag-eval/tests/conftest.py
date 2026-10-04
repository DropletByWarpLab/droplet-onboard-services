"""Pytest path setup for services/rag-eval.

Adds the service dir to sys.path so `import run_state` resolves without
installing the heavy RAGAS/torch dependency stack — run_state is pure stdlib.
Also adds services/ so `_shared.internal_tls` (a stdlib-only helper imported
by config.py, which server.py / runner.py / run-record persistence pull in)
resolves the same way it does in the image.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

_SERVICES_DIR = _SERVICE_DIR.parent
if str(_SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICES_DIR))


@pytest.fixture(autouse=True)
def _service_bearer_open_for_route_tests(monkeypatch):
    """WARP-3625: create_app() now requires RAG_EVAL_SERVICE_TOKEN on every
    route but /health. The existing route tests exercise behaviour, not auth,
    so apps built through create_app() get the dependency overridden;
    tests/test_server_bearer.py clears the override to pin the real gate.
    """
    try:
        import server
    except Exception:  # pragma: no cover — stdlib-only suites without fastapi
        yield
        return
    real = server.create_app

    def open_app():
        app = real()
        app.dependency_overrides[server.require_bearer] = lambda: None
        return app

    monkeypatch.setattr(server, "create_app", open_app)
    yield
