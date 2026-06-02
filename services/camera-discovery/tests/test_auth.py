"""NET-05 — camera-discovery read/scan/driver endpoints must require DEVICE_SECRET.

Before this fix `_require_auth` (DEVICE_SECRET bearer) gated only 3 write
endpoints (`init-status`, `initialize`, `drivers/fix`). `/scan`,
`/cameras/known`, `/cameras/discovered`, accept/reject, `/subnet/status` and
`/drivers` were unauthenticated — any LAN peer (incl. a compromised camera on
the same VLAN, reachable via `lan→cameras` forwarding) could enumerate cameras,
harvest embedded `user:pass@` RTSP URLs, push a camera into Frigate, or launch
the on-demand RTSP/ONVIF/default-credential sweep at will. The sibling routing
(`require_bearer` global) and switch (`ServiceAuthMiddleware` global) services
already gate every non-health endpoint; this aligns camera-discovery to that
posture.

`/health` stays open (docker healthcheck). When DEVICE_SECRET is unset auth is
disabled by design (dev/CI) — these tests set it via the conftest env default.
"""

from __future__ import annotations

import importlib

import pytest

# conftest sets DEVICE_SECRET=pytest-fake-secret before main imports, so the
# gate is active for this run.
SECRET = "pytest-fake-secret"

# Every endpoint that must reject an unauthenticated/wrong-token caller.
# (method, path) — path params use throwaway values; auth runs before any
# 404/400 path-validation, so the assertion is purely on the 401/403.
PROTECTED = [
    ("get", "/cameras/discovered"),
    ("get", "/cameras/known"),
    ("post", "/cameras/discovered/aa:bb:cc:dd:ee:ff/accept"),
    ("post", "/cameras/discovered/aa:bb:cc:dd:ee:ff/reject"),
    ("post", "/scan"),
    ("get", "/cameras/192.168.100.10/init-status"),
    ("post", "/cameras/192.168.100.10/initialize"),
    ("get", "/subnet/status"),
    ("get", "/drivers"),
    ("post", "/drivers/fix"),
]


@pytest.fixture(scope="module")
def client():
    fastapi_testclient = pytest.importorskip(
        "fastapi.testclient",
        reason="fastapi/pydantic unavailable (e.g. Python 3.14 host can't build "
        "pydantic-core) — run under the project's supported Python / CI",
    )
    main = importlib.import_module("main")
    return fastapi_testclient.TestClient(main.app)


@pytest.mark.parametrize("method,path", PROTECTED)
def test_rejects_missing_auth(client, method, path):
    """No Authorization header → 403 (the gate fires before any handler work)."""
    resp = getattr(client, method)(path)
    assert resp.status_code == 403, f"{method.upper()} {path} should require auth"


@pytest.mark.parametrize("method,path", PROTECTED)
def test_rejects_wrong_token(client, method, path):
    resp = getattr(client, method)(
        path, headers={"Authorization": "Bearer not-the-secret"}
    )
    assert resp.status_code == 403, f"{method.upper()} {path} should reject a bad token"


def test_health_is_open(client):
    """`/health` must stay reachable without a token (docker healthcheck)."""
    resp = client.get("/health")
    assert resp.status_code == 200


def test_scan_accepts_valid_token(client, monkeypatch):
    """A correct DEVICE_SECRET passes the gate. Stub scan_and_discover so the
    test asserts auth, not real discovery I/O."""
    import main

    async def _noop():
        return None

    monkeypatch.setattr(main, "scan_and_discover", _noop)
    resp = client.post("/scan", headers={"Authorization": f"Bearer {SECRET}"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "scan_complete"
