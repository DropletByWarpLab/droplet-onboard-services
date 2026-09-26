"""WARP-3193 PERF-2 — UCI write sequences are serialised.

The service holds ONE rpcd session to the router, and UCI staging is per
session and shared across every config: `uci.apply` publishes whatever is
staged, and `uci.commit(cfg)` publishes everything staged for that config. Sync
handlers run concurrently in FastAPI's threadpool, so before this two writes
could interleave — one handler's commit/apply publishing another handler's
half-staged change (the orchestrator's two firewall cron jobs do this by
design: they use different lock keys). Every mutating route now runs its
stage -> commit -> reload sequence under one process-wide lock.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import main

AUTH = {"authorization": "Bearer pytest-fake-token"}
MAC = "AA:BB:CC:DD:EE:FF"


def test_concurrent_firewall_writes_never_overlap(monkeypatch, mock_router) -> None:
    monkeypatch.setattr(main, "router_instance", mock_router)
    client = TestClient(main.app)

    active = 0
    peak = 0
    guard = threading.Lock()

    def slow_write(*_args, **_kwargs):
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        time.sleep(0.05)  # stage ... commit ... reload
        with guard:
            active -= 1

    mock_router.firewall.block_device.side_effect = slow_write
    mock_router.firewall.unblock_device.side_effect = slow_write
    mock_router.firewall.add_rule.side_effect = slow_write

    def fire(i: int) -> int:
        if i % 3 == 0:
            return client.post("/firewall/block-device", json={"mac": MAC, "name": "tv"}, headers=AUTH).status_code
        if i % 3 == 1:
            return client.post("/firewall/unblock-device", json={"mac": MAC}, headers=AUTH).status_code
        return client.post(
            "/firewall/rule",
            json={"name": "r", "src": "lan", "dest": "wan", "proto": "tcp", "dest_port": "443", "target": "ACCEPT"},
            headers=AUTH,
        ).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(fire, range(9)))

    assert codes == [200] * 9
    assert peak == 1


def test_every_mutating_route_is_serialised() -> None:
    """Guard: a new write route that forgets the lock is caught here, not in
    the field. Every POST/PUT/PATCH/DELETE endpoint must carry the marker the
    decorator sets."""
    missing = [
        f"{sorted(r.methods)} {r.path}"
        for r in main.app.routes
        if isinstance(r, APIRoute)
        and r.methods & {"POST", "PUT", "PATCH", "DELETE"}
        and not getattr(r.endpoint, "__uci_serialised__", False)
    ]
    assert missing == []
