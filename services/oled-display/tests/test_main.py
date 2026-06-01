"""FastAPI route tests for the boot/shutdown endpoints (WARP-624).

Uses the lifespan-aware TestClient so `main.display` is the real (sim-backed)
TFTDisplay. We assert auth posture (401 without bearer, 200 with) and that the
routes drive the display into the right mode.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from conftest import TEST_SERVICE_SECRET

AUTH = {"Authorization": f"Bearer {TEST_SERVICE_SECRET}"}


@pytest.fixture
def client():
    # `with TestClient(...)` runs the lifespan, constructing main.display +
    # main.touch and starting the cycle thread, then tears them down.
    with TestClient(main.app) as c:
        yield c


# --- /display/boot ----------------------------------------------------------

def test_boot_requires_auth(client: TestClient):
    r = client.post("/display/boot", json={"stage": "Starting services"})
    assert r.status_code == 401


def test_boot_ok_with_bearer(client: TestClient):
    r = client.post(
        "/display/boot",
        json={"stage": "Starting services", "detail": "ollama", "pct": 30},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "boot"
    assert main.display._current_mode == main.display.BOOT
    assert main.display._boot_stage == "Starting services"
    assert main.display._boot_pct == 30


def test_boot_detail_and_pct_optional(client: TestClient):
    r = client.post("/display/boot", json={"stage": "Booting"}, headers=AUTH)
    assert r.status_code == 200
    assert main.display._boot_pct is None


def test_boot_rejects_out_of_range_pct(client: TestClient):
    r = client.post(
        "/display/boot",
        json={"stage": "Booting", "pct": 250},
        headers=AUTH,
    )
    assert r.status_code == 422


# --- /display/shutdown ------------------------------------------------------

def test_shutdown_requires_auth(client: TestClient):
    r = client.post("/display/shutdown", json={"reason": "system shutdown"})
    assert r.status_code == 401


def test_shutdown_ok_with_bearer(client: TestClient):
    r = client.post(
        "/display/shutdown",
        json={"reason": "system shutdown", "phase": "stopping"},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "shutdown"
    assert main.display._current_mode == main.display.SHUTDOWN
    assert main.display._shutdown_reason == "system shutdown"


def test_shutdown_empty_body_defaults(client: TestClient):
    # Both fields optional; an empty body is a valid "stopping" shutdown.
    r = client.post("/display/shutdown", json={}, headers=AUTH)
    assert r.status_code == 200
    assert main.display._shutdown_phase == "stopping"


def test_shutdown_halted_phase(client: TestClient):
    r = client.post(
        "/display/shutdown",
        json={"phase": "halted"},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert main.display._shutdown_phase == "halted"
