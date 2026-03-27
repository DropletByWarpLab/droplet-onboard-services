"""Tests for the provider router resolution logic."""

import pytest
from unittest.mock import AsyncMock, patch

from router import ProviderRouter


class TestProviderResolution:
    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_resolve_ollama_by_prefix(self, mock_key):
        router = ProviderRouter()
        for model in ["llama3:8b", "mistral:7b", "phi3:mini", "gemma:2b", "deepseek-coder:6.7b"]:
            provider = router.resolve_provider(model)
            assert provider is router.ollama, f"Expected ollama for {model}"

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_resolve_anthropic_by_prefix(self, mock_key):
        router = ProviderRouter()
        for model in ["claude-3-5-sonnet-20241022", "claude-sonnet-4-20250514"]:
            provider = router.resolve_provider(model)
            assert provider is router.anthropic, f"Expected anthropic for {model}"

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_resolve_openai_by_prefix(self, mock_key):
        router = ProviderRouter()
        for model in ["gpt-4o", "gpt-4o-mini", "o1-preview", "o3-mini"]:
            provider = router.resolve_provider(model)
            assert provider is router.openai, f"Expected openai for {model}"

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_explicit_provider_override(self, mock_key):
        router = ProviderRouter()
        provider = router.resolve_provider("some-model", explicit_provider="anthropic")
        assert provider is router.anthropic

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_unknown_model_defaults_to_ollama(self, mock_key):
        router = ProviderRouter()
        provider = router.resolve_provider("some-unknown-model")
        assert provider is router.ollama

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_case_insensitive_resolution(self, mock_key):
        router = ProviderRouter()
        provider = router.resolve_provider("Claude-3-5-Sonnet")
        assert provider is router.anthropic

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_invalid_explicit_provider_falls_back(self, mock_key):
        router = ProviderRouter()
        provider = router.resolve_provider("llama3:8b", explicit_provider="nonexistent")
        # Falls through to prefix matching since nonexistent is not in _providers
        assert provider is router.ollama
