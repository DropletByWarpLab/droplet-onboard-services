"""Tests for Pydantic request/response schemas."""

import pytest
from pydantic import ValidationError

from schemas import (
    ChatMessage,
    ChatRequest,
    ChatResponse,
    ChatChoice,
    ChatUsage,
    ModelInfo,
    ModelsResponse,
    ApiKeyRequest,
    KeyStatusResponse,
)


class TestChatMessage:
    def test_default_role(self):
        msg = ChatMessage(content="hello")
        assert msg.role == "user"

    def test_explicit_role(self):
        msg = ChatMessage(role="assistant", content="hi")
        assert msg.role == "assistant"

    def test_invalid_role_rejected(self):
        with pytest.raises(ValidationError):
            ChatMessage(role="invalid", content="hello")

    def test_empty_content_allowed(self):
        msg = ChatMessage(content="")
        assert msg.content == ""


class TestChatRequest:
    def test_minimal_request(self):
        req = ChatRequest(
            model="llama3:8b",
            messages=[ChatMessage(content="hello")],
        )
        assert req.model == "llama3:8b"
        assert req.stream is False
        assert req.temperature == 0.7
        assert req.max_tokens is None
        assert req.provider is None

    def test_full_request(self):
        req = ChatRequest(
            model="claude-3-5-sonnet-20241022",
            messages=[
                ChatMessage(role="system", content="You are helpful."),
                ChatMessage(role="user", content="Hi"),
            ],
            stream=True,
            temperature=0.5,
            max_tokens=1000,
            provider="anthropic",
        )
        assert req.stream is True
        assert req.provider == "anthropic"
        assert len(req.messages) == 2

    def test_temperature_bounds(self):
        with pytest.raises(ValidationError):
            ChatRequest(
                model="test",
                messages=[ChatMessage(content="hi")],
                temperature=3.0,
            )
        with pytest.raises(ValidationError):
            ChatRequest(
                model="test",
                messages=[ChatMessage(content="hi")],
                temperature=-0.1,
            )

    def test_empty_messages_allowed(self):
        # Pydantic allows empty list; the endpoint should validate further
        req = ChatRequest(model="test", messages=[])
        assert req.messages == []


class TestChatResponse:
    def test_auto_generated_id(self):
        resp = ChatResponse(
            model="llama3:8b",
            choices=[ChatChoice(message=ChatMessage(role="assistant", content="hi"))],
        )
        assert resp.id.startswith("chatcmpl-")
        assert resp.object == "chat.completion"

    def test_default_usage(self):
        resp = ChatResponse(
            model="test",
            choices=[ChatChoice(message=ChatMessage(role="assistant", content="ok"))],
        )
        assert resp.usage.total_tokens == 0


class TestModelInfo:
    def test_with_context_window(self):
        m = ModelInfo(id="gpt-4o", provider="openai", name="GPT-4o", context_window=128000)
        assert m.context_window == 128000

    def test_without_context_window(self):
        m = ModelInfo(id="llama3:8b", provider="ollama", name="llama3:8b")
        assert m.context_window is None


class TestModelsResponse:
    def test_empty_models(self):
        resp = ModelsResponse(models=[])
        assert resp.models == []

    def test_multiple_models(self):
        resp = ModelsResponse(
            models=[
                ModelInfo(id="a", provider="ollama", name="A"),
                ModelInfo(id="b", provider="anthropic", name="B"),
            ]
        )
        assert len(resp.models) == 2


class TestApiKeyRequest:
    def test_valid_key(self):
        req = ApiKeyRequest(api_key="sk-ant-abc123")
        assert req.api_key == "sk-ant-abc123"


class TestKeyStatusResponse:
    def test_empty_providers(self):
        resp = KeyStatusResponse(providers=[])
        assert resp.providers == []

    def test_with_providers(self):
        resp = KeyStatusResponse(providers=["anthropic", "openai"])
        assert "anthropic" in resp.providers
