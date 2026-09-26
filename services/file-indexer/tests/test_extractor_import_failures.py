"""WARP-3193 QUAL-11 — a missing extractor dependency is loud, not silent.

The registry wraps each optional extractor import in `try/except ImportError`.
Those used to `pass`: without libmagic or `srt` in the image, every email or
video file was skipped with no log line and a green /health. Now the failure
is logged and recorded, and /health reports it as degraded (503).
"""

from __future__ import annotations

import builtins
import importlib
import logging
import sys

import pytest

from extractors import registry


@pytest.fixture
def broken_email(monkeypatch):
    """Make `extractors.email` unimportable, as a missing libmagic would."""
    monkeypatch.delitem(sys.modules, "extractors.email", raising=False)
    import extractors

    monkeypatch.delattr(extractors, "email", raising=False)
    real_import = builtins.__import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "magic":
            raise ImportError("failed to find libmagic")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    monkeypatch.setattr(registry, "_import_failures", {})
    yield
    # Drop the half-imported module so later tests re-import the real one.
    sys.modules.pop("extractors.email", None)


def test_a_failed_extractor_import_is_logged_and_recorded(broken_email, caplog):
    with caplog.at_level(logging.ERROR, logger="extractors.registry"):
        assert registry._route("message/rfc822") is None
    assert "email" in registry.extractor_import_failures()
    assert "libmagic" in registry.extractor_import_failures()["email"]
    assert any("email" in r.getMessage() and "libmagic" in r.getMessage() for r in caplog.records)


def test_healthy_registry_reports_no_failures(monkeypatch):
    monkeypatch.setattr(registry, "_import_failures", {})
    assert registry.extractor_import_failures() == {}


def test_health_is_degraded_when_an_extractor_cannot_import(broken_email):
    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    main = importlib.import_module("main")
    resp = fastapi_testclient.TestClient(main.build_http_app()).get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "degraded"
    assert "email" in body["extractorImportErrors"]
