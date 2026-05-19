"""ops.docker_client — list / logs / restart wrappers.

We don't have a real docker daemon in CI. Every test stubs the
underlying docker SDK by patching `_get_client` to return a small
fake. That keeps assertions on OUR translation layer (summarising
attrs, clamping tail, surfacing the right exceptions), not on the
docker SDK itself.
"""
from __future__ import annotations

import pytest
from docker.errors import APIError, NotFound

from ops import docker_client as dc


# ---------------------------------------------------------------------------
# Fakes — minimal stand-ins for docker SDK objects
# ---------------------------------------------------------------------------

class _FakeImage:
    def __init__(self, tag: str | None):
        self.tags = [tag] if tag else []
        self.short_id = "sha256:deadbeef"


class _FakeContainer:
    def __init__(
        self,
        *,
        name: str = "ct1",
        short_id: str = "abc123",
        status: str = "running",
        image_tag: str | None = "myimage:latest",
        attrs: dict | None = None,
        logs_bytes: bytes = b"line1\nline2\n",
        restart_raises: Exception | None = None,
    ):
        self.name = name
        self.short_id = short_id
        self.status = status
        self.image = _FakeImage(image_tag)
        self.attrs = attrs or {
            "State": {
                "Status": status,
                "StartedAt": "2026-05-14T10:00:00Z",
                "RestartCount": 0,
                "Health": {"Status": "healthy"},
            },
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "droplet",
                    "com.docker.compose.service": name,
                },
            },
        }
        self._logs_bytes = logs_bytes
        self._restart_raises = restart_raises
        self.logs_calls: list[dict] = []
        self.restart_calls: list[dict] = []

    def logs(self, **kwargs):
        self.logs_calls.append(kwargs)
        return self._logs_bytes

    def restart(self, **kwargs):
        self.restart_calls.append(kwargs)
        if self._restart_raises:
            raise self._restart_raises

    def reload(self):
        # Bump RestartCount to prove the wrapper re-reads attrs
        self.attrs["State"]["RestartCount"] += 1


class _FakeContainersAPI:
    def __init__(self, containers: list[_FakeContainer]):
        self._all = containers
        self.list_calls: list[dict] = []
        self.get_calls: list[str] = []

    def list(self, all=False):  # noqa: A002 — match docker SDK signature
        self.list_calls.append({"all": all})
        if all:
            return list(self._all)
        return [c for c in self._all if c.status == "running"]

    def get(self, name_or_id):
        self.get_calls.append(name_or_id)
        for c in self._all:
            if c.name == name_or_id or c.short_id == name_or_id:
                return c
        raise NotFound(f"no such container: {name_or_id}")


class _FakeDockerClient:
    def __init__(self, containers: list[_FakeContainer], info: dict | None = None):
        self.containers = _FakeContainersAPI(containers)
        self._info = info or {
            "ServerVersion": "27.0.0",
            "Containers": len(containers),
            "ContainersRunning": sum(1 for c in containers if c.status == "running"),
            "ContainersPaused": 0,
            "ContainersStopped": 0,
            "Images": 12,
            "Driver": "overlay2",
            "KernelVersion": "6.1.0",
            "OperatingSystem": "Test OS",
            "Architecture": "x86_64",
            "NCPU": 4,
            "MemTotal": 8 * 1024 ** 3,
        }

    def info(self):
        return self._info


@pytest.fixture
def patch_client(monkeypatch):
    """Returns a setter — call with a list of _FakeContainer to install
    a fake `_get_client` that returns a _FakeDockerClient over them."""
    holder: dict = {}

    def _install(containers, info=None):
        client = _FakeDockerClient(containers, info=info)
        monkeypatch.setattr(dc, "_get_client", lambda: client)
        # Reset module-level cache so subsequent _get_client() calls see ours
        monkeypatch.setattr(dc, "_client", None, raising=False)
        holder["client"] = client
        return client

    return _install


# ---------------------------------------------------------------------------
# list_containers
# ---------------------------------------------------------------------------

class TestListContainers:

    def test_summarise_extracts_compose_labels(self, patch_client):
        patch_client([_FakeContainer(name="orchestrator")])
        out = dc.list_containers()
        assert len(out) == 1
        s = out[0]
        assert s.name == "orchestrator"
        assert s.image == "myimage:latest"
        assert s.status == "running"
        assert s.health == "healthy"
        assert s.project == "droplet"
        assert s.service == "orchestrator"
        assert s.restart_count == 0

    def test_no_health_check_returns_none_health(self, patch_client):
        patch_client([_FakeContainer(name="x", attrs={
            "State": {"Status": "running", "StartedAt": None, "RestartCount": 0},
            "Config": {"Labels": {}},
        })])
        out = dc.list_containers()
        assert out[0].health is None

    def test_image_with_no_tag_uses_short_id(self, patch_client):
        patch_client([_FakeContainer(image_tag=None)])
        out = dc.list_containers()
        assert out[0].image == "sha256:deadbeef"

    def test_all_states_false_filters_to_running(self, patch_client):
        patch_client([
            _FakeContainer(name="a", status="running"),
            _FakeContainer(name="b", status="exited"),
        ])
        out = dc.list_containers(all_states=False)
        assert [c.name for c in out] == ["a"]

    def test_dict_form_round_trips(self, patch_client):
        patch_client([_FakeContainer()])
        out = dc.list_containers_dict()
        assert isinstance(out, list)
        assert isinstance(out[0], dict)
        assert out[0]["name"] == "ct1"


# ---------------------------------------------------------------------------
# get_logs
# ---------------------------------------------------------------------------

class TestGetLogs:

    def test_returns_decoded_string(self, patch_client):
        patch_client([_FakeContainer(name="x", logs_bytes=b"hello\nworld\n")])
        out = dc.get_logs("x")
        assert out == "hello\nworld\n"

    def test_invalid_utf8_replaced_not_raised(self, patch_client):
        patch_client([_FakeContainer(name="x", logs_bytes=b"\xff\xfe\x00bad")])
        out = dc.get_logs("x")  # must not raise
        assert "�" in out  # replacement char

    def test_tail_zero_falls_back_to_default(self, patch_client):
        client = patch_client([_FakeContainer(name="x")])
        dc.get_logs("x", tail=0)
        assert client.containers._all[0].logs_calls[0]["tail"] == dc.DEFAULT_LOG_TAIL

    def test_tail_clamped_to_max(self, patch_client, monkeypatch):
        monkeypatch.setattr(dc, "MAX_LOG_TAIL", 100)
        client = patch_client([_FakeContainer(name="x")])
        dc.get_logs("x", tail=99999)
        assert client.containers._all[0].logs_calls[0]["tail"] == 100

    def test_since_seconds_passed_through(self, patch_client):
        client = patch_client([_FakeContainer(name="x")])
        dc.get_logs("x", since_seconds=60)
        kwargs = client.containers._all[0].logs_calls[0]
        # since is epoch seconds — int, recent
        import time as _t
        assert isinstance(kwargs["since"], int)
        assert abs(kwargs["since"] - (int(_t.time()) - 60)) < 5

    def test_not_found_propagates(self, patch_client):
        patch_client([_FakeContainer(name="real")])
        with pytest.raises(NotFound):
            dc.get_logs("missing")


# ---------------------------------------------------------------------------
# restart_container
# ---------------------------------------------------------------------------

class TestRestart:

    def test_happy_path_returns_post_restart_summary(self, patch_client):
        patch_client([_FakeContainer(name="x")])
        s = dc.restart_container("x")
        # reload() bumps RestartCount, so the post-restart summary
        # should reflect the new count.
        assert s.name == "x"
        assert s.restart_count == 1

    def test_uses_default_timeout(self, patch_client):
        client = patch_client([_FakeContainer(name="x")])
        dc.restart_container("x")
        assert client.containers._all[0].restart_calls[0] == {"timeout": 10}

    def test_custom_timeout_passed_through(self, patch_client):
        client = patch_client([_FakeContainer(name="x")])
        dc.restart_container("x", timeout=30)
        assert client.containers._all[0].restart_calls[0] == {"timeout": 30}

    def test_not_found_propagates(self, patch_client):
        patch_client([])
        with pytest.raises(NotFound):
            dc.restart_container("ghost")

    def test_api_error_propagates(self, patch_client):
        patch_client([_FakeContainer(name="x", restart_raises=APIError("daemon broke"))])
        with pytest.raises(APIError):
            dc.restart_container("x")


# ---------------------------------------------------------------------------
# daemon_info
# ---------------------------------------------------------------------------

class TestDaemonInfo:

    def test_trims_to_operator_relevant_fields(self, patch_client):
        patch_client([_FakeContainer()], info={
            "ServerVersion": "27.0.0",
            "Containers": 1,
            "ContainersRunning": 1,
            "ContainersPaused": 0,
            "ContainersStopped": 0,
            "Images": 5,
            "Driver": "overlay2",
            "KernelVersion": "6.1.0",
            "OperatingSystem": "Linux",
            "Architecture": "aarch64",
            "NCPU": 4,
            "MemTotal": 4 * 1024**3,
            "SecretField": "must-not-leak",   # extra field — must be dropped
        })
        out = dc.daemon_info()
        assert out["server_version"] == "27.0.0"
        assert out["containers_running"] == 1
        assert "SecretField" not in out
        # All expected keys present (sanity for the UI consumer)
        for k in ("server_version", "containers_total", "images", "ncpu", "mem_total"):
            assert k in out
