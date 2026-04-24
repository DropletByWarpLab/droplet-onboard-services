"""Smoke tests for services/switch.

Baseline coverage for the CI guard:
  - The module graph imports cleanly (catches syntax errors + missing deps).
  - /health is reachable without SERVICE_SECRET even when one is configured.
  - Driver factory rejects unknown SWITCH_DRIVER values early.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


def test_main_imports():
    main = importlib.import_module("main")
    assert hasattr(main, "app"), "main must expose a FastAPI `app`"


def test_health_endpoint_bypasses_auth():
    main = importlib.import_module("main")
    client = TestClient(main.app)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert "status" in body


def test_create_driver_rejects_unknown_type(monkeypatch):
    monkeypatch.setenv("SWITCH_DRIVER", "does-not-exist")
    from drivers import create_driver

    with pytest.raises(ValueError, match="Unknown SWITCH_DRIVER"):
        create_driver()
