"""Shared pytest fixtures for services/camera-discovery.

Seed test infrastructure for the CI coverage guard. Sets env-var defaults that
make the service's top-level module importable in a test context.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("ROUTING_SERVICE_URL", "http://localhost:8080")
os.environ.setdefault("ROUTING_SERVICE_TOKEN", "pytest-fake-token")
os.environ.setdefault("FRIGATE_URL", "http://localhost:5000")
os.environ.setdefault("MQTT_BROKER", "mqtt://localhost:1883")
os.environ.setdefault("DEVICE_SECRET", "pytest-fake-secret")
os.environ.setdefault("CAMERA_SUBNET", "192.168.100.0/24")

import pytest

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))


@pytest.fixture(autouse=True)
def _isolated_state_dir(tmp_path, monkeypatch):
    """Give every test its own camera-discovery state dir.

    A rejected camera is written to disk (WARP-3508), so a test that rejects one
    must never touch the real default dir, and one test's dismissals must never
    leak into the next test's startup. The service resolves the path from the
    environment at call time, so this applies to modules already imported.
    """
    monkeypatch.setenv("CAMERA_DISCOVERY_STATE_DIR", str(tmp_path / "camera-discovery-state"))


@pytest.fixture(autouse=True)
def _fresh_credential_budget():
    """Start every test with cameras that have never rejected a login.

    The credential ladder keeps a per-IP failed-login budget (WARP-3508), and most
    prober tests aim a fake camera at 127.0.0.1. One test that exhausts the budget
    would otherwise leave the ladder standing down for the next test's camera.
    """
    import rtsp_prober

    rtsp_prober._ladder.clear()
    yield
    rtsp_prober._ladder.clear()

# WARP-235/236 — main.py's mqtts:// path imports `_shared.internal_tls`.
# In-container the helper is COPY'd to /app/_shared; in the repo it lives at
# services/_shared, so add services/ to the path (voice-io precedent).
_SERVICES_DIR = _SERVICE_DIR.parent
if str(_SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICES_DIR))
