"""Providers must preserve multimodal content blocks + report capabilities."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from providers.base import to_litellm_messages
from schemas import ChatMessage


def test_string_content_passthrough():
    out = to_litellm_messages([ChatMessage(role="user", content="hi")])
    assert out == [{"role": "user", "content": "hi"}]


def test_image_blocks_serialized_to_dicts():
    msgs = [
        ChatMessage(
            role="user",
            content=[
                {"type": "text", "text": "hi"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/jpeg;base64,AAAA"},
                },
            ],
        )
    ]
    out = to_litellm_messages(msgs)
    content = out[0]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "hi"}
    assert content[1]["type"] == "image_url"
    assert isinstance(content[1]["image_url"], dict)
    assert content[1]["image_url"]["url"] == "data:image/jpeg;base64,AAAA"


def test_cloud_model_lists_report_vision_capability():
    # Importing the cloud providers pulls in litellm; skip where it's absent.
    pytest.importorskip("litellm")
    from providers.anthropic_cloud import ANTHROPIC_MODELS
    from providers.openai_cloud import OPENAI_MODELS

    gpt4o = next(m for m in OPENAI_MODELS if m.id == "gpt-4o")
    assert gpt4o.capabilities is not None and gpt4o.capabilities.vision is True
    haiku = next(m for m in ANTHROPIC_MODELS if m.id.startswith("claude-3-5-haiku"))
    assert haiku.capabilities is not None and haiku.capabilities.vision is True


@respx.mock
async def test_ollama_list_models_includes_capabilities():
    # ollama_local has no litellm dependency, so this runs anywhere.
    from providers.ollama_local import OllamaLocalProvider

    base = "http://fake-ollama:11434"
    respx.get(f"{base}/api/tags").mock(
        return_value=httpx.Response(
            200,
            json={"models": [{"name": "llava:7b"}, {"name": "mistral:7b-instruct"}]},
        )
    )

    def show_cb(request):
        body = json.loads(request.content)
        if "llava" in body["model"]:
            return httpx.Response(200, json={"capabilities": ["completion", "vision"]})
        return httpx.Response(200, json={"capabilities": ["completion"]})

    respx.post(f"{base}/api/show").mock(side_effect=show_cb)

    provider = OllamaLocalProvider(base_url=base)
    models = await provider.list_models()
    by_id = {m.id: m for m in models}
    assert by_id["llava:7b"].capabilities.vision is True
    assert by_id["mistral:7b-instruct"].capabilities.vision is False
