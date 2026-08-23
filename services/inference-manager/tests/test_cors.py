"""Tests for CORS wiring on the gated inference-manager app.

CORS is off by default and configured at import time from env vars. These
tests reload the `main` module under monkeypatched env to exercise each
branch, then restore the default (CORS-off) module so the rest of the suite
is unaffected. See LLM-11.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _reload_main():
    import main
    return importlib.reload(main)


@pytest.fixture
def restore_main():
    """Reload `main` with CORS disabled after the test, restoring the default."""
    yield
    import os
    os.environ.pop("ENABLE_CORS", None)
    os.environ.pop("CORS_ALLOW_ORIGINS", None)
    _reload_main()


def _has_wildcard_cors(app) -> bool:
    from starlette.middleware.cors import CORSMiddleware
    for mw in app.user_middleware:
        if mw.cls is CORSMiddleware:
            origins = mw.kwargs.get("allow_origins", [])
            return "*" in origins
    return False


def test_cors_disabled_by_default(restore_main, monkeypatch):
    monkeypatch.delenv("ENABLE_CORS", raising=False)
    main = _reload_main()
    from starlette.middleware.cors import CORSMiddleware
    assert not any(mw.cls is CORSMiddleware for mw in main.app.user_middleware)


def test_cors_never_wildcards_origin(restore_main, monkeypatch):
    """Enabling CORS must not produce a wildcard origin."""
    monkeypatch.setenv("ENABLE_CORS", "1")
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "https://dash.example,https://ops.example")
    main = _reload_main()
    assert not _has_wildcard_cors(main.app)

    client = TestClient(main.app)
    allowed = client.get("/health", headers={"Origin": "https://dash.example"})
    assert allowed.headers.get("access-control-allow-origin") == "https://dash.example"

    # An origin not on the list gets no allow-origin header (browser blocks it).
    denied = client.get("/health", headers={"Origin": "https://evil.example"})
    assert denied.headers.get("access-control-allow-origin") is None


def test_cors_enabled_without_origins_fails_closed(restore_main, monkeypatch):
    """ENABLE_CORS=1 with no CORS_ALLOW_ORIGINS must not re-open the wildcard;
    it permits no cross-origin request."""
    monkeypatch.setenv("ENABLE_CORS", "1")
    monkeypatch.delenv("CORS_ALLOW_ORIGINS", raising=False)
    main = _reload_main()
    assert not _has_wildcard_cors(main.app)

    client = TestClient(main.app)
    resp = client.get("/health", headers={"Origin": "https://dash.example"})
    assert resp.headers.get("access-control-allow-origin") is None
