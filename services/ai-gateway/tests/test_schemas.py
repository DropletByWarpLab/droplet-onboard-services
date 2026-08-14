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

    def test_empty_messages_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest(model="test", messages=[])

    def test_too_many_messages_rejected(self):
        msgs = [ChatMessage(content=f"msg {i}") for i in range(101)]
        with pytest.raises(ValidationError):
            ChatRequest(model="test", messages=msgs)

    def test_max_tokens_upper_bound(self):
        with pytest.raises(ValidationError):
            ChatRequest(
                model="test",
                messages=[ChatMessage(content="hi")],
                max_tokens=5000,
            )
        # Valid at boundary
        req = ChatRequest(
            model="test",
            messages=[ChatMessage(content="hi")],
            max_tokens=4096,
        )
        assert req.max_tokens == 4096

    def test_total_content_size_cap(self):
        # 100 messages × 32k chars would be 3.2MB — reject before Pydantic even
        # hits the per-message cap, via the model validator.
        huge = "x" * 32_000
        msgs = [ChatMessage(content=huge) for _ in range(5)]  # 160k total > 128k cap
        with pytest.raises(ValidationError):
            ChatRequest(model="test", messages=msgs)

    def test_total_content_size_under_cap(self):
        # 3 × 32k = 96k < 128k — allowed
        huge = "x" * 32_000
        msgs = [ChatMessage(content=huge) for _ in range(3)]
        req = ChatRequest(model="test", messages=msgs)
        assert len(req.messages) == 3


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
        m = ModelInfo(id="llama3:8b", provider="local", name="llama3:8b")
        assert m.context_window is None


class TestModelsResponse:
    def test_empty_models(self):
        resp = ModelsResponse(models=[])
        assert resp.models == []

    def test_multiple_models(self):
        resp = ModelsResponse(
            models=[
                ModelInfo(id="a", provider="local", name="A"),
                ModelInfo(id="b", provider="anthropic", name="B"),
            ]
        )
        assert len(resp.models) == 2


class TestApiKeyRequest:
    def test_valid_key(self):
        req = ApiKeyRequest(api_key="sk-ant-abc123")
        assert req.api_key == "sk-ant-abc123"

    def test_oversized_key_rejected(self):
        # GW-10: an unbounded body would be PBKDF2'd (480k iters) and written to
        # disk on the unauthenticated key endpoint. Cap it at the schema edge.
        with pytest.raises(ValidationError):
            ApiKeyRequest(api_key="x" * 513)

    def test_key_at_max_length_allowed(self):
        req = ApiKeyRequest(api_key="x" * 512)
        assert len(req.api_key) == 512


class TestKeyStatusResponse:
    def test_empty_providers(self):
        resp = KeyStatusResponse(providers=[])
        assert resp.providers == []

    def test_with_providers(self):
        resp = KeyStatusResponse(providers=["anthropic", "openai"])
        assert "anthropic" in resp.providers


class TestChatRequestReasoningEffort:
    """WARP-1442 — optional gpt-oss reasoning-effort knob on the chat request.

    Additive + backward-compatible: unset defaults to None so the provider
    layer sends a byte-for-byte-unchanged Ollama request. Only the three
    gpt-oss harmony levels are accepted; anything else is a 422 at the edge
    rather than a silently-ignored field that reaches Ollama malformed.
    """

    @staticmethod
    def _msgs():
        return [ChatMessage(role="user", content="hi")]

    def test_defaults_to_none_when_unset(self):
        req = ChatRequest(model="gpt-oss:20b", messages=self._msgs())
        assert req.reasoning_effort is None

    @pytest.mark.parametrize("level", ["low", "medium", "high"])
    def test_accepts_valid_levels(self, level):
        req = ChatRequest(
            model="gpt-oss:20b", messages=self._msgs(), reasoning_effort=level
        )
        assert req.reasoning_effort == level

    @pytest.mark.parametrize("bad", ["ultra", "LOW", "minimal", "", "none"])
    def test_rejects_invalid_levels(self, bad):
        with pytest.raises(ValidationError):
            ChatRequest(
                model="gpt-oss:20b", messages=self._msgs(), reasoning_effort=bad
            )
