"""Tests for the model registry TTL cache."""

import asyncio
import logging
import time
from unittest.mock import AsyncMock

import pytest

from models.registry import ModelRegistry, CACHE_TTL_SECONDS
from router import ModelListResult
from schemas import ModelInfo


def _healthy(models: list[ModelInfo]) -> ModelListResult:
    """WARP-1284: list_all_models returns a ModelListResult, not a bare list."""
    return ModelListResult(models=models, degraded_providers=[])


class TestModelRegistry:
    async def test_initial_fetch(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = _healthy([
            ModelInfo(id="llama3:8b", provider="local", name="llama3:8b"),
        ])

        result = await registry.get_models(mock_router)
        assert len(result.models) == 1
        assert result.models[0].id == "llama3:8b"
        mock_router.list_all_models.assert_called_once()

    async def test_cache_hit(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = _healthy([
            ModelInfo(id="llama3:8b", provider="local", name="llama3:8b"),
        ])

        await registry.get_models(mock_router)
        await registry.get_models(mock_router)  # second call should hit cache

        mock_router.list_all_models.assert_called_once()

    async def test_cache_stale_refetches(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = _healthy([
            ModelInfo(id="llama3:8b", provider="local", name="llama3:8b"),
        ])

        await registry.get_models(mock_router)

        # Force stale
        registry._last_fetched = time.time() - CACHE_TTL_SECONDS - 1

        mock_router.list_all_models.return_value = _healthy([
            ModelInfo(id="llama3:8b", provider="local", name="llama3:8b"),
            ModelInfo(id="gpt-4o", provider="openai", name="GPT-4o"),
        ])

        result = await registry.get_models(mock_router)
        assert len(result.models) == 2
        assert mock_router.list_all_models.call_count == 2

    async def test_invalidate(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = _healthy([])

        await registry.get_models(mock_router)
        registry.invalidate()
        assert registry.is_stale is True

    async def test_fetch_error_returns_stale_cache(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = _healthy([
            ModelInfo(id="llama3:8b", provider="local", name="llama3:8b"),
        ])

        await registry.get_models(mock_router)
        registry._last_fetched = 0  # force stale

        mock_router.list_all_models.side_effect = Exception("network error")
        result = await registry.get_models(mock_router)

        # Should return stale cache
        assert len(result.models) == 1
        assert result.models[0].id == "llama3:8b"


class TestModelRegistryDegradedSignal:
    """WARP-1284 — a degraded listing (a provider's list_models() raised) is
    SERVED but never cached as fresh: the next access re-queries the
    providers, so the /ai/models signal self-heals the moment Ollama is
    reachable again instead of pinning "degraded" for a full TTL."""

    async def test_degraded_fetch_served_but_not_cached_as_fresh(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = ModelListResult(
            models=[], degraded_providers=["local"]
        )

        first = await registry.get_models(mock_router)
        assert first.degraded_providers == ["local"]
        assert first.models == []

        # Degraded → the TTL cache is NOT armed; the next call re-queries.
        await registry.get_models(mock_router)
        assert mock_router.list_all_models.call_count == 2

        # Recovery: a healthy fetch caches again.
        mock_router.list_all_models.return_value = ModelListResult(
            models=[ModelInfo(id="gpt-oss:20b", provider="local", name="gpt-oss:20b")],
            degraded_providers=[],
        )
        third = await registry.get_models(mock_router)
        assert third.degraded_providers == []
        assert [m.id for m in third.models] == ["gpt-oss:20b"]

        fourth = await registry.get_models(mock_router)
        assert mock_router.list_all_models.call_count == 3  # healthy → cache hit
        assert fourth.models == third.models


class TestModelRegistrySingleFlight:
    """WARP-1284 F2 — once degraded listings stop arming the TTL, every
    /ai/models request would otherwise run its own provider fan-out. With a
    slow-not-down Ollama, the wizard's 8s poll + the dashboard's 30s SWR
    would pile hung /api/tags calls onto the shared httpx pool that chat
    also uses. Concurrent callers must share ONE in-flight fan-out."""

    async def test_concurrent_get_models_share_one_fanout(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()

        async def slow_fanout():
            await asyncio.sleep(0.05)
            return ModelListResult(models=[], degraded_providers=["local"])

        mock_router.list_all_models.side_effect = slow_fanout

        results = await asyncio.gather(
            *(registry.get_models(mock_router) for _ in range(5))
        )
        # One fan-out, shared by all five concurrent callers.
        assert mock_router.list_all_models.call_count == 1
        assert all(r.degraded_providers == ["local"] for r in results)

        # A LATER (sequential) call still refetches — degraded never arms
        # the TTL, and self-healing depends on the re-query.
        await registry.get_models(mock_router)
        assert mock_router.list_all_models.call_count == 2

    async def test_concurrent_healthy_fetch_also_single_flight(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()

        async def slow_fanout():
            await asyncio.sleep(0.05)
            return ModelListResult(
                models=[ModelInfo(id="gpt-oss:20b", provider="local", name="gpt-oss:20b")],
                degraded_providers=[],
            )

        mock_router.list_all_models.side_effect = slow_fanout

        results = await asyncio.gather(
            *(registry.get_models(mock_router) for _ in range(4))
        )
        assert mock_router.list_all_models.call_count == 1
        assert all([m.id for m in r.models] == ["gpt-oss:20b"] for r in results)

        # Healthy fetch armed the TTL — the next call is a cache hit.
        await registry.get_models(mock_router)
        assert mock_router.list_all_models.call_count == 1

    async def test_degraded_warning_logged_on_state_change_not_per_request(
        self, caplog
    ):
        """The registry re-queries on every poll while degraded; the WARNING
        must not fire per request — only when the degraded set changes."""
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = ModelListResult(
            models=[], degraded_providers=["local"]
        )

        with caplog.at_level(logging.WARNING, logger="models.registry"):
            await registry.get_models(mock_router)
            await registry.get_models(mock_router)
            await registry.get_models(mock_router)

        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
