"""WARP-2882 — `trained_context_window` on local models comes from the
`/api/show` probe `list_models` already makes for capabilities.

`context_window` stays None for every local model: the served window is the
operator's OLLAMA_CONTEXT_LENGTH, and the orchestrator budgets each turn
against any positive `context_window` (WARP-854). The trained length is a
separate, display-only field.

Ollama reports the architecture's context length as
`model_info["<arch>.context_length"]`. Docker Model Runner's Ollama-compatible
`/api/show` returns `details` only, so the field stays None there — honest,
never guessed.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from capabilities import ollama_context_window_from_show
from providers.ollama_local import OllamaLocalProvider

BASE = "http://ctx-ollama:11434"
SHOW_URL = f"{BASE}/api/show"
TAGS_URL = f"{BASE}/api/tags"


@pytest.fixture
async def provider():
    p = OllamaLocalProvider(base_url=BASE)
    yield p
    await p.close()


class TestParser:
    def test_reads_arch_context_length(self):
        show = {"model_info": {"gptoss.context_length": 131072, "gptoss.block_count": 24}}
        assert ollama_context_window_from_show(show) == 131072

    @pytest.mark.parametrize(
        "show",
        [
            {},
            {"details": {"family": "gptoss"}},  # DMR shape: no model_info at all
            {"model_info": {}},
            {"model_info": {"gptoss.context_length": 0}},
            {"model_info": {"gptoss.context_length": "131072"}},
        ],
    )
    def test_unknown_stays_none(self, show):
        assert ollama_context_window_from_show(show) is None


class TestListModels:
    @respx.mock
    async def test_ollama_reports_trained_length_but_never_a_served_window(self, provider):
        respx.get(TAGS_URL).mock(
            return_value=httpx.Response(200, json={"models": [{"name": "gpt-oss:20b"}]})
        )
        respx.post(SHOW_URL).mock(
            return_value=httpx.Response(
                200,
                json={"capabilities": ["tools"], "model_info": {"gptoss.context_length": 131072}},
            )
        )
        models = await provider.list_models()
        assert models[0].trained_context_window == 131072
        # The budget-bearing field must not carry the trained length.
        assert models[0].context_window is None

    @respx.mock
    async def test_dmr_shaped_show_leaves_it_none(self, provider):
        respx.get(TAGS_URL).mock(
            return_value=httpx.Response(200, json={"models": [{"name": "docker.io/ai/gpt-oss:20B-F16"}]})
        )
        respx.post(SHOW_URL).mock(
            return_value=httpx.Response(200, json={"details": {"family": "gptoss"}})
        )
        models = await provider.list_models()
        assert models[0].trained_context_window is None
        assert models[0].context_window is None
