"""Bearer auth tests — covers WARP-36 acceptance criteria.

`require_bearer` gates every route except `/health`. Its behaviour:
- If ROUTING_SERVICE_TOKEN is unset, auth is disabled (dev mode).
- `/health` is exempt regardless of token.
- Missing / wrong / wrong-scheme tokens → 401.
- Right token with constant-time compare → pass.
"""

from __future__ import annotations

import pytest


def test_health_exempt_without_auth(disconnected_client):
    """/health returns 200 without any Authorization header, even without router."""
    resp = disconnected_client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "disconnected"
    assert body["connected"] is False


def test_health_exempt_with_wrong_token(disconnected_client):
    """/health still works with a bad bearer — it's the Docker healthcheck endpoint."""
    resp = disconnected_client.get(
        "/health",
        headers={"Authorization": "Bearer this-is-wrong"},
    )
    assert resp.status_code == 200


def test_protected_route_rejects_missing_header(disconnected_client):
    resp = disconnected_client.get("/network/summary")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Unauthorized"


def test_protected_route_rejects_wrong_token(disconnected_client):
    resp = disconnected_client.get(
        "/network/summary",
        headers={"Authorization": "Bearer wrong-token-value"},
    )
    assert resp.status_code == 401


def test_protected_route_rejects_wrong_scheme(disconnected_client):
    """Basic / Token schemes must not smuggle past the bearer check."""
    resp = disconnected_client.get(
        "/network/summary",
        headers={"Authorization": "Basic pytest-fake-token"},
    )
    assert resp.status_code == 401


def test_protected_route_passes_with_right_token(disconnected_client):
    """Valid token passes auth — the downstream 503 proves we got past require_bearer."""
    resp = disconnected_client.get(
        "/network/summary",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )
    # router_instance is None in the disconnected client → 503 from get_router()
    assert resp.status_code == 503
    assert "not connected" in resp.json()["detail"].lower()


def test_empty_token_disables_auth(disconnected_client, set_token):
    """Dev-mode fallback: unset token means any request is accepted."""
    set_token("")
    resp = disconnected_client.get("/network/summary")
    # Reaches the handler → 503 because no router, NOT 401.
    assert resp.status_code == 503


def test_case_insensitive_bearer_scheme(disconnected_client):
    """RFC 7235 says the scheme is case-insensitive — accept `bearer` and `BEARER`."""
    for scheme in ("Bearer", "bearer", "BEARER", "BeArEr"):
        resp = disconnected_client.get(
            "/network/summary",
            headers={"Authorization": f"{scheme} pytest-fake-token"},
        )
        assert resp.status_code == 503, f"scheme {scheme!r} was rejected"


def test_timing_safe_compare_used():
    """Guards against accidental regression to `==`.

    A real timing-attack test is flaky and out of scope, but we can at least
    assert that require_bearer wires hmac.compare_digest so a future refactor
    is forced to notice.
    """
    import main

    import inspect

    src = inspect.getsource(main.require_bearer)
    assert "hmac.compare_digest" in src, (
        "require_bearer must use hmac.compare_digest for constant-time comparison"
    )


@pytest.mark.parametrize(
    "bad_header",
    [
        "",  # empty string
        "Bearer",  # no token
        "Bearer ",  # trailing space, empty token
        "pytest-fake-token",  # token without scheme
    ],
)
def test_malformed_auth_headers_rejected(disconnected_client, bad_header):
    resp = disconnected_client.get(
        "/network/summary",
        headers={"Authorization": bad_header},
    )
    assert resp.status_code == 401
