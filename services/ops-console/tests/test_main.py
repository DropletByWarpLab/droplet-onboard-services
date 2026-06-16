"""End-to-end test of main.py's FastAPI wiring.

We don't spin up uvicorn — TestClient is enough. Each test exercises
one route and confirms (a) auth gating, (b) status codes for the
edge cases, (c) the response shape the UI depends on.

The system / docker / services modules are NOT mocked here — the
unit tests for those (test_system.py / test_docker_client.py /
test_services.py) own the deep coverage. Here we want to know the
wiring is right.
"""
from __future__ import annotations

import importlib
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    """Build a fresh app with a known token + docker stubbed out so
    /ops/containers* don't fail on missing daemon socket."""
    monkeypatch.setenv("OPS_TOKEN", "test-token-for-pytest")

    # Reload auth so the token env is captured
    from ops import auth as auth_mod
    importlib.reload(auth_mod)

    # Stub docker_client._get_client BEFORE main is imported / reloaded
    from ops import docker_client as dc

    class _StubImage:
        tags = ["img:latest"]
        short_id = "sha256:abc"

    class _StubContainer:
        name = "stub"
        short_id = "stub01"
        status = "running"
        image = _StubImage()
        attrs = {
            "State": {"Status": "running", "StartedAt": "2026-05-14T10:00:00Z",
                      "RestartCount": 0, "Health": {"Status": "healthy"}},
            "Config": {"Labels": {"com.docker.compose.project": "droplet",
                                  "com.docker.compose.service": "stub"}},
        }
        def logs(self, **kw): return b"stub-logs\n"
        def restart(self, **kw): pass
        def reload(self): pass

    class _Containers:
        # `filters=` matches the real docker SDK signature; list_containers()
        # passes filters={"label": "com.docker.compose.project=..."} to scope
        # to our compose project (see ops/docker_client.py).
        def list(self, all=False, filters=None): return [_StubContainer()]
        def get(self, name):
            from docker.errors import NotFound
            if name in ("stub", "stub01"):
                return _StubContainer()
            raise NotFound("no")

    class _StubClient:
        containers = _Containers()
        def info(self):
            return {
                "ServerVersion": "27.0.0", "Containers": 1, "ContainersRunning": 1,
                "ContainersPaused": 0, "ContainersStopped": 0, "Images": 1,
                "Driver": "overlay2", "KernelVersion": "test", "OperatingSystem": "test",
                "Architecture": "test", "NCPU": 1, "MemTotal": 1024,
            }

    monkeypatch.setattr(dc, "_get_client", lambda: _StubClient())
    monkeypatch.setattr(dc, "_client", None, raising=False)

    # Reload main so it picks up reloaded auth
    import main as main_mod
    importlib.reload(main_mod)

    return TestClient(main_mod.app)


# ---------------------------------------------------------------------------
# /healthz — unauth
# ---------------------------------------------------------------------------

class TestHealthz:
    def test_no_auth_required(self, client):
        r = client.get("/healthz")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        assert r.json()["service"] == "ops-console"


# ---------------------------------------------------------------------------
# Auth gating across /ops/*
# ---------------------------------------------------------------------------

class TestAuthGating:

    @pytest.mark.parametrize("path", [
        "/ops/health",
        "/ops/system",
        "/ops/containers",
        "/ops/containers/stub/logs",
        "/ops/services",
    ])
    def test_unauth_returns_401(self, client, path):
        r = client.get(path)
        assert r.status_code == 401

    @pytest.mark.parametrize("path", [
        "/ops/health",
        "/ops/system",
        "/ops/containers",
        "/ops/services",
    ])
    def test_wrong_token_returns_403(self, client, path):
        r = client.get(path, headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# /ops/health — token validation echo
# ---------------------------------------------------------------------------

class TestOpsHealth:
    def test_authenticated(self, client):
        r = client.get("/ops/health", headers={"Authorization": "Bearer test-token-for-pytest"})
        assert r.status_code == 200
        assert r.json() == {
            "status": "ok",
            "service": "ops-console",
            "token_check": "passed",
        }


# ---------------------------------------------------------------------------
# /ops/system — psutil snapshot
# ---------------------------------------------------------------------------

class TestOpsSystem:
    def test_returns_full_snapshot_shape(self, client):
        r = client.get("/ops/system", headers={"Authorization": "Bearer test-token-for-pytest"})
        assert r.status_code == 200
        body = r.json()
        for key in ("timestamp", "host", "cpu", "memory", "disks", "network"):
            assert key in body
        assert "hostname" in body["host"]
        assert "percent" in body["cpu"]


# ---------------------------------------------------------------------------
# /ops/containers — list
# ---------------------------------------------------------------------------

class TestOpsContainers:

    def test_returns_daemon_and_containers(self, client):
        r = client.get("/ops/containers", headers={"Authorization": "Bearer test-token-for-pytest"})
        assert r.status_code == 200
        body = r.json()
        assert "daemon" in body and "containers" in body
        assert body["daemon"]["server_version"] == "27.0.0"
        assert body["containers"][0]["name"] == "stub"

    def test_503_when_docker_unreachable(self, client, monkeypatch):
        from docker.errors import DockerException
        from ops import docker_client as dc
        def boom():
            raise DockerException("can't reach socket")
        monkeypatch.setattr(dc, "_get_client", boom)
        r = client.get("/ops/containers", headers={"Authorization": "Bearer test-token-for-pytest"})
        assert r.status_code == 503
        assert "docker" in r.json()["detail"].lower()


# ---------------------------------------------------------------------------
# /ops/containers/{name}/logs
# ---------------------------------------------------------------------------

class TestOpsContainerLogs:

    def test_returns_plaintext(self, client):
        r = client.get(
            "/ops/containers/stub/logs",
            headers={"Authorization": "Bearer test-token-for-pytest"},
        )
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/plain")
        assert "stub-logs" in r.text

    def test_404_for_unknown_container(self, client):
        r = client.get(
            "/ops/containers/ghost/logs",
            headers={"Authorization": "Bearer test-token-for-pytest"},
        )
        assert r.status_code == 404

    def test_tail_validation_min_1(self, client):
        r = client.get(
            "/ops/containers/stub/logs?tail=0",
            headers={"Authorization": "Bearer test-token-for-pytest"},
        )
        # FastAPI's Query(ge=1) → 422
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# /ops/containers/{name}/restart
# ---------------------------------------------------------------------------

class TestOpsContainerRestart:

    def test_get_does_not_restart(self, client):
        # GET on a POST-only route MUST NOT restart the container.
        # Starlette would normally return 405; with our static-mount
        # catch-all at "/" the unmatched GET turns into 404. Both are
        # fine — the contract here is "GET doesn't trigger the action".
        r = client.get(
            "/ops/containers/stub/restart",
            headers={"Authorization": "Bearer test-token-for-pytest"},
        )
        assert r.status_code in (404, 405)
        assert r.status_code != 200

    def test_happy_path(self, client):
        r = client.post(
            "/ops/containers/stub/restart",
            headers={"Authorization": "Bearer test-token-for-pytest"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["restarted"] is True
        assert body["container"]["name"] == "stub"

    def test_404_for_unknown_container(self, client):
        r = client.post(
            "/ops/containers/ghost/restart",
            headers={"Authorization": "Bearer test-token-for-pytest"},
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# /ops/services — fan-out probe
# ---------------------------------------------------------------------------

class TestOpsServices:

    def test_returns_summary_and_results(self, client, monkeypatch):
        # Stub probe_all so we don't try to reach real upstreams
        from ops import services as svc
        async def fake_probe_all(reg=None):
            return [
                svc.ProbeResult("a", "http://a/", "ok", 200, 5.0, None),
                svc.ProbeResult("b", "http://b/", "down", 500, 9.0, "5xx"),
            ]
        monkeypatch.setattr(svc, "probe_all", fake_probe_all)

        r = client.get("/ops/services", headers={"Authorization": "Bearer test-token-for-pytest"})
        assert r.status_code == 200
        body = r.json()
        assert body["summary"] == {"ok": 1, "degraded": 0, "down": 1, "unknown": 0}
        assert len(body["results"]) == 2
        assert body["results"][0]["name"] == "a"
