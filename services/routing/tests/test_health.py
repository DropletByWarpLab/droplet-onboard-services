"""Smoke tests for the `/health` endpoint."""

from __future__ import annotations


def test_health_reports_disconnected_without_router(disconnected_client):
    resp = disconnected_client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "disconnected"
    assert body["connected"] is False
    assert "router_host" in body
    assert body["error"] == "Router not connected at startup"


def test_health_reports_ok_when_router_connected(connected_client):
    resp = connected_client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["connected"] is True


def test_health_does_not_leak_board_inventory(connected_client):
    """WARP-2111: /health is auth-exempt on a 0.0.0.0:8080 host-network bind, so
    it must NOT echo board_info() (model/CPU/kernel/hostname) to unauthenticated
    LAN clients. The successful board_info() probe still drives connected=True;
    its result just isn't returned. Board detail lives behind GET /system/info."""
    resp = connected_client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["connected"] is True
    assert "board" not in body
