"""WARP-2111 — the interactive API docs + OpenAPI schema must be OFF by default.

routing binds 0.0.0.0:8080 (network_mode: host) and gates route auth via a
`Depends(require_bearer)` app dependency. FastAPI mounts /docs, /redoc and
/openapi.json OUTSIDE the router, so that dependency does NOT guard them — an
unauthenticated LAN client could otherwise read a labelled map of every
mutation endpoint (VPN, firewall, SSID/PSK, factory-reset). They are disabled
unless ROUTING_ENABLE_DOCS is set (local-dev opt-in only).
"""

from __future__ import annotations

import main


def test_openapi_and_docs_routes_are_disabled_by_default():
    # conftest imports main without ROUTING_ENABLE_DOCS, so the app is built
    # with the schema + docs URLs set to None.
    assert main.ROUTING_ENABLE_DOCS is False
    assert main.app.openapi_url is None
    assert main.app.docs_url is None
    assert main.app.redoc_url is None


def test_openapi_json_is_not_served(disconnected_client):
    """The schema endpoint must 404 — not merely 401 — so the control-surface
    map is never emitted, with or without a token."""
    resp = disconnected_client.get("/openapi.json")
    assert resp.status_code == 404


def test_docs_ui_is_not_served(disconnected_client):
    resp = disconnected_client.get("/docs")
    assert resp.status_code == 404
