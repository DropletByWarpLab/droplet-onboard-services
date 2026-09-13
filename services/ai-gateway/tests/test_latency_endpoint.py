"""WARP-2883 — GET /ai/latency: a round-trip per inference endpoint, in ms.

The Models page's "Avg latency" tile hardcoded 0 because nothing measured
anything. This endpoint is that measurement. Two properties matter:

  * null, never 0, for an endpoint that did not answer — 0 ms reads as
    "instant", the exact lie the honesty contract forbids.
  * the probe is reachability, not generation: the cloud path is an
    authenticated /v1/models, so a page load never spends tokens.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import respx

from providers.anthropic_cloud import AnthropicCloudProvider
from providers.openai_cloud import OpenAICloudProvider


def _router(local_ok=True, anthropic_ok=True, openai_ok=None):
    """A ProviderRouter double. `None` for a provider = raise (crash path)."""
    router = MagicMock()
    router.refresh_keys = AsyncMock()
    for name, ok in (("local", local_ok), ("anthropic", anthropic_ok), ("openai", openai_ok)):
        prov = MagicMock()
        if ok is None:
            prov.is_reachable = AsyncMock(side_effect=RuntimeError("boom"))
        else:
            prov.is_reachable = AsyncMock(return_value=ok)
        setattr(router, name, prov)
    return router


class TestLatencyEndpoint:
    async def test_reports_ms_per_endpoint_and_null_for_the_rest(self, client):
        router = _router(local_ok=True, anthropic_ok=False, openai_ok=None)
        with patch("main.provider_router", router):
            resp = await client.get("/ai/latency")
        assert resp.status_code == 200
        providers = resp.json()["providers"]
        assert set(providers) == {"local", "anthropic", "openai"}
        assert isinstance(providers["local"], int) and providers["local"] >= 0
        assert providers["anthropic"] is None, "unreachable is null, never 0"
        assert providers["openai"] is None, "a raising probe is null, not a 500"
        router.refresh_keys.assert_awaited_once_with(None)

    async def test_measures_wall_clock(self, client):
        router = _router()

        async def slow():
            await asyncio.sleep(0.05)
            return True

        router.local.is_reachable = slow
        with patch("main.provider_router", router):
            resp = await client.get("/ai/latency")
        assert resp.json()["providers"]["local"] >= 40

    async def test_503_before_startup(self, client):
        with patch("main.provider_router", None):
            resp = await client.get("/ai/latency")
        assert resp.status_code == 503


class TestCloudProviderReachability:
    async def test_no_key_is_unreachable_without_dialling(self):
        with respx.mock(assert_all_called=False) as mock:
            route = mock.get("https://api.anthropic.com/v1/models")
            assert await AnthropicCloudProvider(api_key=None).is_reachable() is False
            assert not route.called

    @respx.mock
    async def test_anthropic_models_200_is_reachable(self):
        route = respx.get("https://api.anthropic.com/v1/models").mock(
            return_value=httpx.Response(200, json={"data": []}))
        assert await AnthropicCloudProvider(api_key="sk-ant-test").is_reachable() is True
        sent = route.calls.last.request
        assert sent.headers["x-api-key"] == "sk-ant-test"
        assert sent.headers["anthropic-version"]

    @respx.mock
    async def test_openai_bad_key_is_unreachable(self):
        respx.get("https://api.openai.com/v1/models").mock(
            return_value=httpx.Response(401, json={"error": "bad key"}))
        assert await OpenAICloudProvider(api_key="sk-bad").is_reachable() is False

    @respx.mock
    async def test_network_error_is_unreachable_not_an_exception(self):
        respx.get("https://api.openai.com/v1/models").mock(side_effect=httpx.ConnectError("down"))
        assert await OpenAICloudProvider(api_key="sk-x").is_reachable() is False
