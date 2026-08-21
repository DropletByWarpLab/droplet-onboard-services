"""Tests for the /health endpoint."""

from __future__ import annotations

import httpx
import pytest
from httpx import Response


@pytest.mark.asyncio
async def test_health_ok(client, respx_mock):
    """Health returns ok when Ollama is reachable and circuit is closed."""
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )
    resp = await client.get("/health")

    assert resp.status_code == 200
    body = resp.json()
    # WARP-284: schema_version is the canonical drift detector for the
    # cross-repo contract. The orchestrator's _LimitsCache logs a warning
    # when this is newer than what it knows. v2 = WARP-1825 placement block.
    assert body["schema_version"] == 2
    assert body["status"] == "ok"
    assert body["ollama_reachable"] is True
    assert body["models_loading"] == []
    assert body["circuit_breaker"] == "closed"
    assert "placement" in body
    assert body["limits"]["num_parallel"] >= 1
    assert "max_queue" in body["limits"]
    assert "max_loaded_models" in body["limits"]


@pytest.mark.asyncio
async def test_health_schema_version_matches_constant(client, respx_mock):
    """schema_version in the response equals the module constant.

    Guard against accidental drift between the constant and the literal
    in the dict — bumping the constant should be the only place to change
    the version.
    """
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )
    from main import _HEALTH_SCHEMA_VERSION
    resp = await client.get("/health")
    assert resp.json()["schema_version"] == _HEALTH_SCHEMA_VERSION


@pytest.mark.asyncio
async def test_health_degraded_when_ollama_down(client, respx_mock):
    """Health returns degraded when Ollama is unreachable."""
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        side_effect=httpx.ConnectError("nope")
    )
    resp = await client.get("/health")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["ollama_reachable"] is False


@pytest.mark.asyncio
async def test_health_includes_loading_models(client, respx_mock, loading_tracker):
    """Models in the tracker show up in models_loading."""
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )
    await loading_tracker.add("llama3.2:3b")
    resp = await client.get("/health")
    assert resp.json()["models_loading"] == ["llama3.2:3b"]


@pytest.mark.asyncio
async def test_health_degraded_when_circuit_open(client, respx_mock):
    """Even with Ollama reachable, an open circuit means status=degraded."""
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )
    # Trip the breaker through its public failure path (5 transport failures)
    # rather than poking the private `_state` attribute. See LLM-07.
    from circuit import OLLAMA_BREAKER, get_circuit_state, reset_circuit

    @OLLAMA_BREAKER
    async def _fail():
        raise httpx.ConnectError("nope")

    for _ in range(5):
        with pytest.raises(httpx.ConnectError):
            await _fail()
    assert get_circuit_state() == "open"

    try:
        resp = await client.get("/health")
        body = resp.json()
        assert body["ollama_reachable"] is True
        assert body["circuit_breaker"] == "open"
        assert body["status"] == "degraded"
    finally:
        # The autouse _reset_circuit fixture resets between tests, but reset
        # here too in case this assertion fails before the fixture runs.
        reset_circuit()
