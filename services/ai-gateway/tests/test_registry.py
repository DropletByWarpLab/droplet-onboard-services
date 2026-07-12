"""Tests for the model registry TTL cache."""

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
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
        ])

        result = await registry.get_models(mock_router)
        assert len(result.models) == 1
        assert result.models[0].id == "llama3:8b"
        mock_router.list_all_models.assert_called_once()

    async def test_cache_hit(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = _healthy([
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
        ])

        await registry.get_models(mock_router)
        await registry.get_models(mock_router)  # second call should hit cache

        mock_router.list_all_models.assert_called_once()

    async def test_cache_stale_refetches(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = _healthy([
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
        ])

        await registry.get_models(mock_router)

        # Force stale
        registry._last_fetched = time.time() - CACHE_TTL_SECONDS - 1

        mock_router.list_all_models.return_value = _healthy([
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
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
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
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
            models=[], degraded_providers=["ollama"]
        )

        first = await registry.get_models(mock_router)
        assert first.degraded_providers == ["ollama"]
        assert first.models == []

        # Degraded → the TTL cache is NOT armed; the next call re-queries.
        await registry.get_models(mock_router)
        assert mock_router.list_all_models.call_count == 2

        # Recovery: a healthy fetch caches again.
        mock_router.list_all_models.return_value = ModelListResult(
            models=[ModelInfo(id="gpt-oss:20b", provider="ollama", name="gpt-oss:20b")],
            degraded_providers=[],
        )
        third = await registry.get_models(mock_router)
        assert third.degraded_providers == []
        assert [m.id for m in third.models] == ["gpt-oss:20b"]

        fourth = await registry.get_models(mock_router)
        assert mock_router.list_all_models.call_count == 3  # healthy → cache hit
        assert fourth.models == third.models
