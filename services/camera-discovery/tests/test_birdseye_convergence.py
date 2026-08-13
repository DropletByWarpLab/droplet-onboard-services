"""WARP-1918 — birdseye is part of the MANAGED Frigate config.

The dashboard's multi-camera live view (/cameras/birdseye) renders
Frigate's birdseye composite. Frigate 404s ``/api/birdseye`` when the
section is missing/disabled, and the platform never wrote one — so every
box showed the "Birdseye view isn't set up on this Droplet" empty state.

Managed enablement has two halves, both guarded here:

1. The shipped baseline ``docker/frigate/config.yml`` declares
   ``birdseye: enabled + continuous`` (fresh provisioning).
2. ``FrigateClient.ensure_birdseye()`` converges an already-running box
   at camera-discovery startup via PUT /api/config/set (deep-merge,
   persists to disk) — no manual box step, no hand-edited config.yml.

``mode: continuous`` is deliberate: Frigate's default ``objects`` mode
blanks cameras with no active detections, which reads as a broken grid
on the "show me everything" surface.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import yaml

from frigate_client import BIRDSEYE_CONFIG, FrigateClient

REPO_ROOT = Path(__file__).resolve().parents[3]
BASELINE_CONFIG = REPO_ROOT / "docker" / "frigate" / "config.yml"


# --- Baseline config.yml (fresh provisioning) ---


def test_baseline_frigate_config_enables_birdseye():
    cfg = yaml.safe_load(BASELINE_CONFIG.read_text(encoding="utf-8"))
    birdseye = cfg.get("birdseye")
    assert birdseye is not None, "docker/frigate/config.yml lost its birdseye section"
    assert birdseye.get("enabled") is True
    assert birdseye.get("mode") == "continuous"


def test_managed_birdseye_payload_is_enabled_continuous():
    """The runtime-convergence payload matches what the dashboard expects."""
    assert BIRDSEYE_CONFIG == {"enabled": True, "mode": "continuous"}


# --- Runtime convergence (ensure_birdseye) ---


def _client_with(handler) -> FrigateClient:
    client = FrigateClient("http://frigate:5000")
    client._client = httpx.AsyncClient(
        base_url="http://frigate:5000",
        transport=httpx.MockTransport(handler),
    )
    return client


def _resolved_config(birdseye: dict | None) -> dict:
    cfg: dict = {"cameras": {}}
    if birdseye is not None:
        cfg["birdseye"] = birdseye
    return cfg


@pytest.mark.asyncio
async def test_ensure_birdseye_patches_a_disabled_box():
    """Disabled birdseye → one PUT /api/config/set with the managed section."""
    puts: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/config" and request.method == "GET":
            return httpx.Response(
                200, json=_resolved_config({"enabled": False, "mode": "objects"})
            )
        if request.url.path == "/api/config/set" and request.method == "PUT":
            puts.append(json.loads(request.content))
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404)

    client = _client_with(handler)
    try:
        assert await client.ensure_birdseye() is True
    finally:
        await client.close()

    assert len(puts) == 1
    assert puts[0]["config_data"] == {"birdseye": {"enabled": True, "mode": "continuous"}}
    # Persist to disk + reload so the running box actually serves the stream.
    assert puts[0]["requires_restart"] == 1


@pytest.mark.asyncio
async def test_ensure_birdseye_converges_wrong_mode():
    """Enabled but mode=objects still converges — idle cameras must render."""
    puts: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/config" and request.method == "GET":
            return httpx.Response(
                200, json=_resolved_config({"enabled": True, "mode": "objects"})
            )
        if request.url.path == "/api/config/set" and request.method == "PUT":
            puts.append(json.loads(request.content))
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404)

    client = _client_with(handler)
    try:
        assert await client.ensure_birdseye() is True
    finally:
        await client.close()
    assert len(puts) == 1


@pytest.mark.asyncio
async def test_ensure_birdseye_noop_when_already_converged():
    """An already-converged box must NOT be rewritten: config/set with
    requires_restart=1 bounces Frigate and takes every camera dark for
    seconds — never pay that on a routine service start."""
    puts: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/config" and request.method == "GET":
            return httpx.Response(
                200,
                json=_resolved_config(
                    {"enabled": True, "mode": "continuous", "width": 1280}
                ),
            )
        if request.url.path == "/api/config/set" and request.method == "PUT":
            puts.append(json.loads(request.content))
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404)

    client = _client_with(handler)
    try:
        assert await client.ensure_birdseye() is False
    finally:
        await client.close()
    assert puts == []


@pytest.mark.asyncio
async def test_ensure_birdseye_survives_frigate_errors():
    """Config fetch blowing up must not crash the caller (startup path)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client = _client_with(handler)
    try:
        assert await client.ensure_birdseye() is False
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_ensure_birdseye_rejected_save_reports_false():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/config" and request.method == "GET":
            return httpx.Response(200, json=_resolved_config({"enabled": False}))
        if request.url.path == "/api/config/set" and request.method == "PUT":
            return httpx.Response(400, json={"success": False, "message": "nope"})
        return httpx.Response(404)

    client = _client_with(handler)
    try:
        assert await client.ensure_birdseye() is False
    finally:
        await client.close()


# --- Startup wiring ---


@pytest.mark.asyncio
async def test_startup_converges_birdseye_once_frigate_is_ready(monkeypatch):
    """ensure_birdseye existing but never being called would ship the bug
    anyway — pin the startup hook."""
    import main

    calls: list[str] = []

    async def fake_health() -> bool:
        return True

    async def fake_reconcile() -> None:
        calls.append("reconcile")

    async def fake_ensure() -> bool:
        calls.append("ensure_birdseye")
        return True

    class _SchedulerStub:
        def start(self) -> None:
            calls.append("scheduler")

    monkeypatch.setattr(main, "_connect_mqtt", lambda: None)
    monkeypatch.setattr(main.frigate, "health_check", fake_health)
    monkeypatch.setattr(main, "_reconcile_with_frigate", fake_reconcile)
    monkeypatch.setattr(main.frigate, "ensure_birdseye", fake_ensure)
    monkeypatch.setattr(main, "build_scan_scheduler", lambda: _SchedulerStub())

    await main.startup()

    assert "ensure_birdseye" in calls
