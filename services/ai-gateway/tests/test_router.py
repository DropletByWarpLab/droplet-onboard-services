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
    async def test_resolve_gpt_oss_routes_to_local_ollama(self, mock_key):
        """gpt-oss is OpenAI's OPEN-WEIGHTS family, served locally by Ollama.
        Its name collides with the openai 'gpt' cloud prefix, so it must
        resolve to ollama — never the cloud provider, which the off-LAN gate
        (correctly) blocks with HTTP 451. Regression for the live single-box
        chat failure where LLM_MODEL=gpt-oss:20b was routed to OpenAI."""
        router = ProviderRouter()
        for model in ["gpt-oss:20b", "gpt-oss:120b", "gpt-oss", "GPT-OSS:20B"]:
            provider = router.resolve_provider(model)
            assert provider is router.ollama, f"Expected ollama for {model}, got cloud"

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_real_openai_models_still_route_to_cloud(self, mock_key):
        """Regression guard: the gpt-oss fix must NOT divert genuine cloud
        OpenAI models (gpt-4o, o1, …) to Ollama."""
        router = ProviderRouter()
        for model in ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1-preview", "o3-mini"]:
            provider = router.resolve_provider(model)
            assert provider is router.openai, f"Expected openai for {model}"

    @patch.dict("os.environ", {"LLM_MODEL": "claude-distill-local:7b"})
    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_configured_local_model_always_routes_local(self, mock_key):
        """The one configured local model (LLM_MODEL) always routes to
        Ollama, even when its name collides with a cloud prefix. Encodes
        the one-model rule explicitly instead of guessing from the name.
        Here the name would otherwise match the anthropic 'claude' prefix."""
        router = ProviderRouter()
        provider = router.resolve_provider("claude-distill-local:7b")
        assert provider is router.ollama, "configured LLM_MODEL must route local"
        # A genuine cloud model is unaffected by the local-model guard.
        assert router.resolve_provider("claude-sonnet-4-20250514") is router.anthropic

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_gpt_oss_clears_the_off_lan_gate(self, mock_key):
        """End-to-end regression for the production chat failure (WARP-604):
        the local model must resolve to a provider the off-LAN gate treats as
        local, so it is never blocked with HTTP 451. Pins the full
        resolve -> reverse-lookup -> is_local_provider chain that actually
        broke, not just the resolve half."""
        from middleware.off_lan_gating import is_local_provider

        router = ProviderRouter()
        provider = router.resolve_provider("gpt-oss:20b")
        # Reverse-lookup the canonical provider key the gate sees — mirrors
        # ProviderRouter.chat's lookup before check_off_lan_gate().
        provider_name = next(
            (n for n, p in router._providers.items() if p is provider),
            "unknown",
        )
        assert provider_name == "ollama"
        assert is_local_provider(provider_name) is True

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
