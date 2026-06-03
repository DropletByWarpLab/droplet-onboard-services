"""FastAPI route tests for the boot/shutdown endpoints (WARP-624).

Uses the lifespan-aware TestClient so `main.display` is the real (sim-backed)
TFTDisplay. We assert auth posture (401 without bearer, 200 with) and that the
routes drive the display into the right mode.
"""

from __future__ import annotations

import asyncio

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


# --- /display/system --------------------------------------------------------

def test_system_requires_auth(client: TestClient):
    r = client.post("/display/system")
    assert r.status_code == 401


def test_system_ok_with_bearer(client: TestClient):
    # The bare-nav endpoint the screen-qr poller calls once the box is claimed,
    # to move the panel off the modal claim screen onto the live System screen.
    r = client.post("/display/system", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "system"
    assert main.display._current_mode == main.display.SYSTEM


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


# --- /display/claim (WARP-632 / ADR-017) ------------------------------------

def test_claim_requires_auth(client: TestClient):
    r = client.post(
        "/display/claim",
        json={"code": "DRPL-7K2Q-9F4M", "setup_url": "https://192.168.1.87/setup"},
    )
    assert r.status_code == 401


def test_claim_ok_with_bearer(client: TestClient):
    r = client.post(
        "/display/claim",
        json={"code": "DRPL-7K2Q-9F4M", "setup_url": "https://192.168.1.87/setup"},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "claim"
    assert main.display._current_mode == main.display.CLAIM
    assert main.display._claim_code == "DRPL-7K2Q-9F4M"
    assert main.display._claim_setup_url == "https://192.168.1.87/setup"


def test_claim_rejects_missing_code(client: TestClient):
    # `code` is required (min_length=1) — an empty/absent code is a 422, never
    # a blank claim screen.
    r = client.post(
        "/display/claim",
        json={"setup_url": "https://192.168.1.87/setup"},
        headers=AUTH,
    )
    assert r.status_code == 422


def test_claim_rejects_empty_code(client: TestClient):
    r = client.post(
        "/display/claim",
        json={"code": "", "setup_url": "https://192.168.1.87/setup"},
        headers=AUTH,
    )
    assert r.status_code == 422


# --- Lifespan shutdown fallback (M1) ----------------------------------------

def test_lifespan_shutdown_renders_shutdown_frame():
    # M1 (WARP-624): non-systemd teardown (docker compose down, crash/OOM, a
    # host without the ExecStop unit) leaves the last live frame frozen unless
    # the container renders the shutdown screen itself. The FastAPI lifespan
    # shutdown runs inside the container before teardown, so it must drive the
    # panel to SHUTDOWN as a best-effort fallback regardless of teardown path.
    async def _drive():
        cm = main.lifespan(main.app)
        await cm.__aenter__()
        assert main.display._current_mode == main.display.BOOT
        await cm.__aexit__(None, None, None)

    asyncio.run(_drive())
    assert main.display._current_mode == main.display.SHUTDOWN
    # And cycling must be stopped so nothing repaints over the shutdown frame.
    assert main.display._cycle_running is False


def test_lifespan_shutdown_fallback_never_raises(monkeypatch: pytest.MonkeyPatch):
    # The fallback is best-effort: a failure rendering/sending the shutdown
    # frame must never escape lifespan and wedge container teardown.
    async def _drive():
        cm = main.lifespan(main.app)
        await cm.__aenter__()

        def _boom(*a, **k):
            raise RuntimeError("serial gone")

        monkeypatch.setattr(main.display, "show_shutdown", _boom)
        # Must not raise even though show_shutdown blows up.
        await cm.__aexit__(None, None, None)

    asyncio.run(_drive())
