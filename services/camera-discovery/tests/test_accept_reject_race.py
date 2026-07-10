"""Concurrency invariant — a MAC cannot be both accepted-into-Frigate AND rejected.

PYNET-017. accept_camera peeks (does not pop) the pending record so a transient
verify_stream/add_camera failure can't silently drop the camera before the next
scan. But a bare peek leaves the record present during the long
``await verify_stream`` / ``await frigate.add_camera`` window, so a concurrent
reject_camera for the same MAC could pop it and mark it rejected while the accept
still commits it to Frigate — a "rejected" camera ending up live.

The fix claims the MAC in an in-progress set at accept entry (synchronously,
before any await), so a concurrent reject is refused (409) while an accept is in
flight, and a concurrent second accept is likewise refused. These tests pin that
a given MAC can never be both accepted and rejected.
"""

from __future__ import annotations

import asyncio
import importlib

import pytest
from fastapi import HTTPException

SECRET = "pytest-fake-secret"


class _FakeRequest:
    """Minimal stand-in — _require_auth only reads headers.get('Authorization')."""

    def __init__(self, token: str = SECRET):
        self.headers = {"Authorization": f"Bearer {token}"}


def _fresh_main():
    import main

    return importlib.reload(main)


def _seed_pending(main, mac: str) -> None:
    main.known_cameras.clear()
    main.pending_cameras.clear()
    main.rejected_macs.clear()
    main.pending_cameras[mac] = {
        "mac": mac,
        "ip": "192.168.100.50",
        "rtsp_url": "rtsp://192.168.100.50:554/stream1",
        "name": "cam",
        "status": "needs_setup",
    }


@pytest.mark.asyncio
async def test_reject_during_in_flight_accept_is_refused(monkeypatch):
    """While an accept is blocked in verify_stream/add_camera, a concurrent
    reject for the same MAC must be refused (409) — the camera cannot be both
    committed to Frigate and added to rejected_macs."""
    main = _fresh_main()
    mac = "aa:bb:cc:dd:ee:ff"
    _seed_pending(main, mac)

    entered_verify = asyncio.Event()
    release_verify = asyncio.Event()

    async def blocking_verify(url, timeout=4.0):
        entered_verify.set()          # signal: accept is now in-flight (claimed)
        await release_verify.wait()   # hold the accept open
        return True

    async def fake_add(name, url):
        return True

    monkeypatch.setattr(main, "verify_stream", blocking_verify)
    monkeypatch.setattr(main.frigate, "add_camera", fake_add)
    monkeypatch.setattr(main, "publish_discovery", lambda *_a, **_k: None)

    accept_task = asyncio.create_task(main.accept_camera(mac, _FakeRequest()))
    await asyncio.wait_for(entered_verify.wait(), timeout=2.0)

    # The accept holds the MAC; a concurrent reject must not succeed.
    with pytest.raises(HTTPException) as excinfo:
        await main.reject_camera(mac, _FakeRequest())
    assert excinfo.value.status_code == 409

    # The failed reject must not have mutated state.
    assert mac not in main.rejected_macs
    assert mac in main.pending_cameras

    # Let the accept finish and commit.
    release_verify.set()
    result = await asyncio.wait_for(accept_task, timeout=2.0)
    assert result["status"] == "accepted"

    # Invariant: accepted XOR rejected — never both.
    assert mac in main.known_cameras
    assert mac not in main.rejected_macs
    # Committed → removed from pending; the in-progress claim is released.
    assert mac not in main.pending_cameras
    assert mac not in main.accepting_macs


@pytest.mark.asyncio
async def test_concurrent_second_accept_is_refused(monkeypatch):
    """A second accept for a MAC already being accepted is refused (409), so a
    camera can't be double-added to Frigate."""
    main = _fresh_main()
    mac = "aa:bb:cc:dd:ee:aa"
    _seed_pending(main, mac)

    entered_verify = asyncio.Event()
    release_verify = asyncio.Event()
    add_calls = {"n": 0}

    async def blocking_verify(url, timeout=4.0):
        entered_verify.set()
        await release_verify.wait()
        return True

    async def fake_add(name, url):
        add_calls["n"] += 1
        return True

    monkeypatch.setattr(main, "verify_stream", blocking_verify)
    monkeypatch.setattr(main.frigate, "add_camera", fake_add)
    monkeypatch.setattr(main, "publish_discovery", lambda *_a, **_k: None)

    first = asyncio.create_task(main.accept_camera(mac, _FakeRequest()))
    await asyncio.wait_for(entered_verify.wait(), timeout=2.0)

    with pytest.raises(HTTPException) as excinfo:
        await main.accept_camera(mac, _FakeRequest())
    assert excinfo.value.status_code == 409

    release_verify.set()
    result = await asyncio.wait_for(first, timeout=2.0)
    assert result["status"] == "accepted"
    assert add_calls["n"] == 1  # added exactly once
    assert mac not in main.accepting_macs


@pytest.mark.asyncio
async def test_reject_after_accept_completes_is_404(monkeypatch):
    """Once an accept has committed and cleared the claim, a later reject for
    the (now known, no longer pending) MAC 404s — it can't be rejected."""
    main = _fresh_main()
    mac = "aa:bb:cc:dd:ee:bb"
    _seed_pending(main, mac)

    async def fake_verify(url, timeout=4.0):
        return True

    async def fake_add(name, url):
        return True

    monkeypatch.setattr(main, "verify_stream", fake_verify)
    monkeypatch.setattr(main.frigate, "add_camera", fake_add)
    monkeypatch.setattr(main, "publish_discovery", lambda *_a, **_k: None)

    result = await main.accept_camera(mac, _FakeRequest())
    assert result["status"] == "accepted"

    with pytest.raises(HTTPException) as excinfo:
        await main.reject_camera(mac, _FakeRequest())
    assert excinfo.value.status_code == 404
    assert mac not in main.rejected_macs
    assert mac in main.known_cameras
