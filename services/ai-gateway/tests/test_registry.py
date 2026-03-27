"""Tests for the model registry TTL cache."""

import time
from unittest.mock import AsyncMock

import pytest

from models.registry import ModelRegistry, CACHE_TTL_SECONDS
from schemas import ModelInfo


class TestModelRegistry:
    async def test_initial_fetch(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = [
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
        ]

        models = await registry.get_models(mock_router)
        assert len(models) == 1
        assert models[0].id == "llama3:8b"
        mock_router.list_all_models.assert_called_once()

    async def test_cache_hit(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = [
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
        ]

        await registry.get_models(mock_router)
        await registry.get_models(mock_router)  # second call should hit cache

        mock_router.list_all_models.assert_called_once()

    async def test_cache_stale_refetches(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = [
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
        ]

        await registry.get_models(mock_router)

        # Force stale
        registry._last_fetched = time.time() - CACHE_TTL_SECONDS - 1

        mock_router.list_all_models.return_value = [
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
            ModelInfo(id="gpt-4o", provider="openai", name="GPT-4o"),
        ]

        models = await registry.get_models(mock_router)
        assert len(models) == 2
        assert mock_router.list_all_models.call_count == 2

    async def test_invalidate(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = []

        await registry.get_models(mock_router)
        registry.invalidate()
        assert registry.is_stale is True

    async def test_fetch_error_returns_stale_cache(self):
        registry = ModelRegistry()
        mock_router = AsyncMock()
        mock_router.list_all_models.return_value = [
            ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b"),
        ]

        await registry.get_models(mock_router)
        registry._last_fetched = 0  # force stale

        mock_router.list_all_models.side_effect = Exception("network error")
        models = await registry.get_models(mock_router)

        # Should return stale cache
        assert len(models) == 1
        assert models[0].id == "llama3:8b"
