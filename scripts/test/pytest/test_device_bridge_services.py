"""WARP-1645 — device-bridge's /services normaliser for the rack panel.

The panel's SERVICES cell is the only thing on the rack that says a container
is down, so the two properties that matter most here are both about being
honest when things are bad:

  1. a 503 from the orchestrator (which is what it returns when the aggregate
     is `down`) must still yield data — urlopen RAISES on 503, and naively
     catching that would blank the cell at exactly the moment it matters; and
  2. an unreachable orchestrator must yield None/em-dash, never zeros. The
     panel has already shipped two fake zeros (WARP-1643); "0/0 services"
     reads as "nothing is running", which is both alarming and wrong.

Lives in scripts/test/pytest/ because services/oled-display's own suite is not
where the bridge is covered — see test_device_bridge_panel_console.py.
"""
from __future__ import annotations

import importlib.util
import io
import json
import urllib.error
from pathlib import Path

import pytest

_BRIDGE_PATH = (Path(__file__).resolve().parents[3]
                / "services" / "oled-display" / "device-bridge.py")


def _load_bridge(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    spec = importlib.util.spec_from_file_location("device_bridge_services_test",
                                                  _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Resp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._b


def _snapshot(status="ok", components=None):
    return {
        "status": status,
        "uptime": 1234,
        "version": "0.1.0",
        "components": components if components is not None else [
            {"name": "postgres", "status": "ok", "latencyMs": 2},
            {"name": "redis", "status": "ok", "latencyMs": 1},
            {"name": "routing", "status": "ok", "latencyMs": 5},
            {"name": "ai-gateway", "status": "ok", "latencyMs": 9},
            {"name": "nextcloud", "status": "ok", "latencyMs": 12},
            {"name": "display", "status": "ok", "latencyMs": 1},
            {"name": "file-indexer", "status": "ok", "latencyMs": 3},
            {"name": "storage", "status": "ok", "latencyMs": 1},
        ],
    }


def _serve(monkeypatch, bridge, payload=None, exc=None):
    def fake(url, timeout=None, context=None):
        if exc is not None:
            raise exc
        return _Resp(payload)

    monkeypatch.setattr(bridge.urlrequest, "urlopen", fake)


# --- happy path -------------------------------------------------------------

def test_all_healthy(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    _serve(monkeypatch, bridge, _snapshot())
    out = bridge.services_snapshot()
    assert out["up"] == 8 and out["total"] == 8
    assert out["status"] == "ok"
    assert out["degraded"] == []


def test_one_down_is_named(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    comps = _snapshot()["components"]
    comps[4] = {"name": "nextcloud", "status": "down",
                "error": "connection refused", "latencyMs": 0}
    _serve(monkeypatch, bridge, _snapshot(status="degraded", components=comps))
    out = bridge.services_snapshot()
    assert out["up"] == 7 and out["total"] == 8
    assert out["status"] == "degraded"
    assert out["degraded"] == [{"name": "nextcloud",
                                "state": "connection refused", "core": False}]


def test_error_text_is_preferred_over_the_word_down(monkeypatch):
    """At a rack, "connection refused" is worth more than "down"."""
    bridge = _load_bridge(monkeypatch)
    comps = [{"name": "redis", "status": "down", "error": "ECONNREFUSED :6379"}]
    _serve(monkeypatch, bridge, _snapshot(status="degraded", components=comps))
    assert bridge.services_snapshot()["degraded"][0]["state"] == "ECONNREFUSED :6379"


def test_missing_error_falls_back_to_status(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    comps = [{"name": "redis", "status": "down"}]
    _serve(monkeypatch, bridge, _snapshot(status="degraded", components=comps))
    assert bridge.services_snapshot()["degraded"][0]["state"] == "down"


def test_core_is_flagged_and_sorted_first(monkeypatch):
    """The row that matters must never be the one pushed off by the 3-row cap."""
    bridge = _load_bridge(monkeypatch)
    comps = [
        {"name": "storage", "status": "down"},
        {"name": "postgres", "status": "down"},
        {"name": "ai-gateway", "status": "down"},
    ]
    _serve(monkeypatch, bridge, _snapshot(status="down", components=comps))
    deg = bridge.services_snapshot()["degraded"]
    assert deg[0]["name"] == "postgres" and deg[0]["core"] is True
    assert [s["name"] for s in deg[1:]] == ["ai-gateway", "storage"]
    assert all(s["core"] is False for s in deg[1:])


# --- the 503 case -----------------------------------------------------------

def test_503_still_yields_data(monkeypatch):
    """/api/orchestrator/health returns 503 when the aggregate is `down`, and
    urlopen raises on it. Blanking the cell there would lose the data at
    exactly the moment the panel has to show it."""
    bridge = _load_bridge(monkeypatch)
    payload = _snapshot(status="down", components=[
        {"name": "postgres", "status": "down", "error": "P1001"},
        {"name": "redis", "status": "ok"},
    ])
    err = urllib.error.HTTPError(
        "http://x/api/orchestrator/health", 503, "Service Unavailable", {},
        io.BytesIO(json.dumps(payload).encode()))
    _serve(monkeypatch, bridge, exc=err)

    out = bridge.services_snapshot()
    assert out["status"] == "down"
    assert out["up"] == 1 and out["total"] == 2
    assert out["degraded"][0]["name"] == "postgres"


# --- failing soft, never zeros ---------------------------------------------

def test_unreachable_orchestrator_is_none_not_zero(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    _serve(monkeypatch, bridge, exc=OSError("connection refused"))
    out = bridge.services_snapshot()
    assert out["up"] is None and out["total"] is None
    assert out["status"] is None
    assert out["degraded"] == []


def test_garbage_body_is_none_not_zero(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    _serve(monkeypatch, bridge, {"nonsense": True})
    assert bridge.services_snapshot()["total"] is None


def test_empty_component_list_is_none_not_zero(monkeypatch):
    """An empty list would otherwise render a confident green 0/0."""
    bridge = _load_bridge(monkeypatch)
    _serve(monkeypatch, bridge, _snapshot(components=[]))
    assert bridge.services_snapshot()["up"] is None


def test_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    _serve(monkeypatch, bridge, exc=ValueError("boom"))
    assert bridge.services_snapshot()["total"] is None


# --- posture ----------------------------------------------------------------

def test_does_not_reach_for_the_docker_socket():
    """/ops/containers is backed by /var/run/docker.sock, which is
    root-equivalent on the host. Nothing on the panel's data path may need it."""
    src = _BRIDGE_PATH.read_text(encoding="utf-8")
    code = "\n".join(ln for ln in src.splitlines()
                     if not ln.lstrip().startswith("#"))
    assert "docker.sock" not in code
    assert "/ops/containers" not in code


def test_route_is_registered():
    src = _BRIDGE_PATH.read_text(encoding="utf-8")
    assert 'if path == "/services":' in src


# --- WARP-1646: the route to the orchestrator -------------------------------
# The bridge runs on the HOST. `expose: 3000` is not reachable from there, and
# the gateway on :80 now 301s to HTTPS with a cert for the device FQDN — so
# every orchestrator read failed silently. These pin the fix so the URL cannot
# quietly lose its port again.

_UNIT = (_BRIDGE_PATH.parent / "droplet-device-bridge.service")
_COMPOSE = (_BRIDGE_PATH.parents[2] / "docker" / "docker-compose.yml")


def test_unit_orchestrator_url_carries_a_port():
    lines = [ln for ln in _UNIT.read_text(encoding="utf-8").splitlines()
             if ln.startswith("Environment=ORCHESTRATOR_URL=")]
    assert len(lines) == 1, lines
    url = lines[0].split("=", 2)[2]
    assert url == "http://127.0.0.1:3000", url


def test_orchestrator_is_published_on_loopback_only():
    """The 127.0.0.1 prefix is the whole safety story — without it this
    publishes the orchestrator API on every interface."""
    src = _COMPOSE.read_text(encoding="utf-8")
    i = src.index("\n  orchestrator:")
    block = src[i:i + 3000]
    published = [ln.strip() for ln in block.splitlines()
                 if ln.strip().startswith('- "') and ":3000" in ln]
    assert published, "orchestrator must publish 3000 for the host-side bridge"
    for entry in published:
        assert entry.startswith('- "127.0.0.1:'), \
            f"orchestrator port must bind loopback only, got {entry}"


def test_bridge_default_matches_the_unit():
    """device-bridge.py's fallback and the unit must not drift apart."""
    src = _BRIDGE_PATH.read_text(encoding="utf-8")
    assert 'os.environ.get("ORCHESTRATOR_URL", "http://127.0.0.1:3000")' in src
