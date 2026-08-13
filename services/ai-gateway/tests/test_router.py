"""Tests for the provider router resolution logic."""

import pytest
from unittest.mock import AsyncMock, patch

from router import ProviderRouter
from schemas import ChatMessage, ChatRequest, ModelInfo


class TestProviderResolution:
    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_resolve_ollama_by_prefix(self, mock_key):
        router = ProviderRouter()
        for model in ["llama3:8b", "mistral:7b", "phi3:mini", "gemma:2b", "deepseek-coder:6.7b"]:
            provider = router.resolve_provider(model)
            assert provider is router.local, f"Expected ollama for {model}"

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
            assert provider is router.local, f"Expected ollama for {model}, got cloud"

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
        assert provider is router.local, "configured LLM_MODEL must route local"
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
        assert provider_name == "local"
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
        assert provider is router.local

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
        assert provider is router.local


class TestLegacyLocalProviderAliases:
    """WARP-1933 — `provider` is a PERSISTED column (`ChatSession.provider`,
    `ChatMessage.provider`), so turns recorded before the WARP-1926 rename
    carry `ollama` on disk. `_providers` only has the `local` key, so those
    turns missed the explicit-provider lookup entirely and fell through to
    prefix matching — which resolves a cloud provider whenever the persisted
    model name happens to match a cloud prefix.

    The off-LAN gate already treats these spellings as local
    (`LOCAL_PROVIDERS` in middleware/off_lan_gating.py). The router did not,
    so the two disagreed about the same request: a 451 under the default
    posture, or an actual off-box call when cloud_model_escape=true.
    """

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_legacy_alias_resolves_local(self, mock_key):
        router = ProviderRouter()
        for alias in ["ollama", "ollama_local", "local"]:
            provider = router.resolve_provider("some-model", explicit_provider=alias)
            assert provider is router.local, f"{alias} must resolve to the on-box provider"

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_legacy_alias_beats_a_cloud_looking_model_name(self, mock_key):
        """The case the router's own comments document: a local model whose
        name starts with a cloud prefix and is NOT the current LLM_MODEL.
        Without the alias guard this resolved to anthropic."""
        router = ProviderRouter()
        # LLM_MODEL is unset here, so the one-model rule cannot rescue it —
        # exactly the state of a box whose configured model has since changed.
        assert router._local_model is None
        for alias in ["ollama", "ollama_local"]:
            for model in ["claude-distill-local:7b", "gpt-4o", "o1-preview"]:
                provider = router.resolve_provider(model, explicit_provider=alias)
                assert provider is router.local, (
                    f"{alias}/{model} escaped to a cloud provider"
                )

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_alias_matching_is_case_insensitive(self, mock_key):
        router = ProviderRouter()
        for alias in ["Ollama", "OLLAMA_LOCAL"]:
            provider = router.resolve_provider("claude-3-5-sonnet", explicit_provider=alias)
            assert provider is router.local

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_explicit_cloud_provider_is_untouched(self, mock_key):
        """The guard must only catch local aliases — an explicit cloud
        provider still wins over prefix matching."""
        router = ProviderRouter()
        assert (
            router.resolve_provider("llama3:8b", explicit_provider="anthropic")
            is router.anthropic
        )
        assert (
            router.resolve_provider("llama3:8b", explicit_provider="openai")
            is router.openai
        )

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_aliases_are_not_added_to_the_provider_registry(self, mock_key):
        """Aliasing `ollama` back into `_providers` would double-query the
        on-box provider in `list_all_models`'s fan-out and skew the reverse
        lookup that names the provider for the off-LAN gate. The guard has to
        live in `resolve_provider`, not in the registry."""
        router = ProviderRouter()
        assert set(router._providers) == {"local", "anthropic", "openai"}

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_alias_set_matches_the_off_lan_gate(self, mock_key):
        """Parity: every spelling the gate exempts must also resolve local in
        the router. If the two sets drift, a request is local to one and cloud
        to the other — which is the defect this ticket describes."""
        from middleware.off_lan_gating import LOCAL_PROVIDERS

        router = ProviderRouter()
        for alias in LOCAL_PROVIDERS:
            assert (
                router.resolve_provider("claude-sonnet-4-20250514", explicit_provider=alias)
                is router.local
            ), f"{alias} is exempt from the off-LAN gate but resolves cloud"


class TestListAllModelsDegradedSignal:
    """WARP-1284 — list_all_models must NAME the providers whose
    list_models() raised instead of silently swallowing the failure into a
    shorter (possibly empty) list. The empty-list-with-no-signal behavior
    made a dead Ollama indistinguishable from a first-boot model pull in
    the setup wizard's AI step."""

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_names_provider_whose_listing_raised(self, mock_key):
        router = ProviderRouter()
        router.local.list_models = AsyncMock(
            side_effect=RuntimeError("connection refused")
        )
        result = await router.list_all_models()
        assert result.models == []
        assert result.degraded_providers == ["local"]

    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_empty_degraded_list_when_all_providers_succeed(self, mock_key):
        router = ProviderRouter()
        router.local.list_models = AsyncMock(
            return_value=[
                ModelInfo(id="gpt-oss:20b", provider="local", name="gpt-oss:20b")
            ]
        )
        result = await router.list_all_models()
        assert [m.id for m in result.models] == ["gpt-oss:20b"]
        # Unkeyed cloud providers return [] rather than raising — a healthy
        # single-box (no BYOK keys) must NOT report cloud providers degraded.
        assert result.degraded_providers == []

    @patch("router.get_api_key", new_callable=AsyncMock, return_value="test-key")
    async def test_partial_failure_keeps_surviving_providers_models(self, mock_key):
        """A dead Ollama must not hide the keyed cloud catalogues — the
        surviving providers' models still return, alongside the signal."""
        router = ProviderRouter()
        router.local.list_models = AsyncMock(side_effect=RuntimeError("boom"))
        result = await router.list_all_models()
        assert result.degraded_providers == ["local"]
        assert len(result.models) > 0
        assert all(m.provider in ("anthropic", "openai") for m in result.models)


class TestReasoningEffortForwarding:
    """WARP-1442 — the router threads `reasoning_effort` into the provider's
    chat kwargs when the caller set one, and passes NOTHING when it's unset so
    the outbound provider call is byte-for-byte unchanged for every existing
    caller (voice + dashboard share this path)."""

    @staticmethod
    def _capture_chat(router: ProviderRouter) -> dict:
        """Replace the ollama provider's chat with a kwargs-capturing stub."""
        captured: dict = {}

        async def fake_chat(**kwargs):
            captured.update(kwargs)
            return {"ok": True}

        router.local.chat = fake_chat  # type: ignore[method-assign]
        return captured

    @patch("router.check_off_lan_gate", new_callable=AsyncMock)
    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_forwards_reasoning_effort_when_set(self, mock_key, mock_gate):
        router = ProviderRouter()
        captured = self._capture_chat(router)
        await router.chat(
            ChatRequest(
                model="gpt-oss:20b",
                messages=[ChatMessage(role="user", content="hi")],
                reasoning_effort="low",
            )
        )
        assert captured.get("reasoning_effort") == "low"

    @patch("router.check_off_lan_gate", new_callable=AsyncMock)
    @patch("router.get_api_key", new_callable=AsyncMock, return_value=None)
    async def test_no_reasoning_effort_key_when_unset(self, mock_key, mock_gate):
        router = ProviderRouter()
        captured = self._capture_chat(router)
        await router.chat(
            ChatRequest(
                model="gpt-oss:20b",
                messages=[ChatMessage(role="user", content="hi")],
            )
        )
        assert "reasoning_effort" not in captured
