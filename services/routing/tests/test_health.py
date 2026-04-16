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
    assert body["board"] is not None
