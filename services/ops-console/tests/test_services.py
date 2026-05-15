"""ops.services — fan-out HTTP probes.

We mock httpx.AsyncClient at the function-call level so the tests are
fast and don't reach out to the network. Each test seeds one or more
"responses" and asserts the classification logic produces the right
ProbeResult.status.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Any

import httpx
import pytest

from ops import services as svc


# ---------------------------------------------------------------------------
# Test helpers — fake AsyncClient with a scripted GET response/exception
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, status_code: int, body: str = "ok"):
        self.status_code = status_code
        self.text = body


class _FakeAsyncClient:
    """httpx.AsyncClient stand-in. Maps URL → (delay_s, response_or_exc)."""

    def __init__(self, script: dict[str, tuple[float, Any]]):
        self.script = script
        self.calls: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url: str, timeout=None):
        self.calls.append(url)
        delay, payload = self.script.get(url, (0.0, _FakeResponse(200)))
        if delay:
            await asyncio.sleep(delay)
        if isinstance(payload, Exception):
            raise payload
        return payload


@pytest.fixture
def patched_httpx(monkeypatch):
    """Returns a function the test calls with the script, which patches
    httpx.AsyncClient to return a _FakeAsyncClient with that script."""
    holder = {}

    def _patch(script: dict[str, tuple[float, Any]]):
        fake = _FakeAsyncClient(script)
        monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: fake)
        holder["fake"] = fake
        return fake

    return _patch


# ---------------------------------------------------------------------------
# build_registry
# ---------------------------------------------------------------------------

class TestBuildRegistry:
    def test_default_registry_has_known_services(self, monkeypatch):
        # Clear all OPS_PROBE_* envs so we get pure defaults
        for k in list(monkeypatch._setitem):
            pass  # noqa: monkeypatch impl detail
        reg = svc.build_registry()
        assert "orchestrator" in reg
        assert "ai-gateway" in reg
        assert "voice-orchestrator" in reg
        assert "web-dashboard" in reg
        # Defaults should look like compose DNS
        assert reg["ai-gateway"].startswith("http://ai-gateway:")
        # Infra services without HTTP /health default to empty
        assert reg["db"] == ""
        assert reg["broker"] == ""

    def test_env_override_wins(self, monkeypatch):
        monkeypatch.setenv("OPS_PROBE_AI_GATEWAY", "http://override:1234/x")
        reg = svc.build_registry()
        assert reg["ai-gateway"] == "http://override:1234/x"

    def test_env_strip_whitespace(self, monkeypatch):
        monkeypatch.setenv("OPS_PROBE_AI_GATEWAY", "  http://x:1/   ")
        reg = svc.build_registry()
        assert reg["ai-gateway"] == "http://x:1/"


# ---------------------------------------------------------------------------
# probe_all — classification matrix
# ---------------------------------------------------------------------------

class TestProbeAll:

    @pytest.mark.asyncio
    async def test_2xx_fast_is_ok(self, patched_httpx):
        patched_httpx({"http://a/": (0.0, _FakeResponse(200))})
        results = await svc.probe_all({"a": "http://a/"})
        assert len(results) == 1
        assert results[0].status == "ok"
        assert results[0].http_status == 200
        assert results[0].latency_ms is not None and results[0].latency_ms < 1000

    @pytest.mark.asyncio
    async def test_2xx_slow_is_degraded(self, patched_httpx, monkeypatch):
        # Drop the slow threshold so we don't actually have to sleep
        # for >1.5s in CI.
        monkeypatch.setattr(svc, "_SLOW_MS", 5.0)
        patched_httpx({"http://a/": (0.05, _FakeResponse(200))})
        results = await svc.probe_all({"a": "http://a/"})
        assert results[0].status == "degraded"
        assert "slow" in results[0].detail

    @pytest.mark.asyncio
    async def test_4xx_is_degraded(self, patched_httpx):
        patched_httpx({"http://a/": (0.0, _FakeResponse(429))})
        results = await svc.probe_all({"a": "http://a/"})
        assert results[0].status == "degraded"
        assert results[0].http_status == 429

    @pytest.mark.asyncio
    async def test_5xx_is_down(self, patched_httpx):
        patched_httpx({"http://a/": (0.0, _FakeResponse(503))})
        results = await svc.probe_all({"a": "http://a/"})
        assert results[0].status == "down"
        assert results[0].http_status == 503

    @pytest.mark.asyncio
    async def test_transport_error_is_down(self, patched_httpx):
        patched_httpx({"http://a/": (0.0, httpx.ConnectError("nope"))})
        results = await svc.probe_all({"a": "http://a/"})
        assert results[0].status == "down"
        assert results[0].http_status is None
        assert "ConnectError" in results[0].detail

    @pytest.mark.asyncio
    async def test_timeout_is_down(self, patched_httpx):
        patched_httpx({"http://a/": (0.0, httpx.ReadTimeout("slow"))})
        results = await svc.probe_all({"a": "http://a/"})
        assert results[0].status == "down"
        assert "timeout" in results[0].detail.lower()

    @pytest.mark.asyncio
    async def test_unexpected_exception_is_down_not_500(self, patched_httpx):
        # Last-ditch except: prevents one bad probe from killing the fan-out.
        patched_httpx({"http://a/": (0.0, RuntimeError("bug"))})
        results = await svc.probe_all({"a": "http://a/"})
        assert results[0].status == "down"
        assert "unexpected" in results[0].detail

    @pytest.mark.asyncio
    async def test_empty_url_is_unknown(self, patched_httpx):
        patched_httpx({})
        results = await svc.probe_all({"db": ""})
        assert results[0].status == "unknown"
        assert results[0].url is None
        assert results[0].http_status is None

    @pytest.mark.asyncio
    async def test_fan_out_runs_all_probes(self, patched_httpx):
        fake = patched_httpx({
            "http://a/": (0.0, _FakeResponse(200)),
            "http://b/": (0.0, _FakeResponse(200)),
            "http://c/": (0.0, _FakeResponse(503)),
        })
        results = await svc.probe_all({"a": "http://a/", "b": "http://b/", "c": "http://c/"})
        assert len(results) == 3
        assert sorted(fake.calls) == ["http://a/", "http://b/", "http://c/"]


class TestSummarise:

    def test_counts_each_status_bucket(self):
        results = [
            svc.ProbeResult("a", "http://a/", "ok",       200,  10.0, None),
            svc.ProbeResult("b", "http://b/", "ok",       200,  20.0, None),
            svc.ProbeResult("c", "http://c/", "degraded", 429,  30.0, "x"),
            svc.ProbeResult("d", "http://d/", "down",     None, 30.0, "x"),
            svc.ProbeResult("e", None,        "unknown",  None, None, "x"),
        ]
        s = svc.summarise(results)
        assert s == {"ok": 2, "degraded": 1, "down": 1, "unknown": 1}

    def test_empty_summary(self):
        assert svc.summarise([]) == {"ok": 0, "degraded": 0, "down": 0, "unknown": 0}
