"""WARP-154 — LLM bridge contract.

The contract these tests pin:

  - `OrchestratorLLM.available` GETs /api/health; returns False (not
    raise) on any transport or HTTP-error. Status endpoints depend on
    this never throwing.
  - `reply()` POSTs /api/llm/chat with the right model + messages +
    stream:false, parses the assistant text from the response.
  - `reply("")` short-circuits with no network call.
  - HTTP errors raise LLMUnavailable with a readable detail.
  - The response-parser pulls the assistant text from both flat and
    segmented content shapes.
  - `MockLLM` records requests and replays scripted replies in order.
  - `build_llm_from_env` honours LLM_URL=__mock__ + http://.

We swap in `httpx.MockTransport` so we exercise httpx end-to-end
without a real network. No external orchestrator needed.
"""
from __future__ import annotations

import json
from typing import Optional

import httpx
import pytest

from voice.llm import (
    DEFAULT_LLM_URL,
    LLMUnavailable,
    MockLLM,
    OrchestratorLLM,
    _extract_assistant_text,
    _extract_error_detail,
    build_llm_from_env,
)


# ────────────────────────────────────────────────────────────────────
# httpx.MockTransport plumbing
# ────────────────────────────────────────────────────────────────────

def _install_mock_transport(monkeypatch, handler) -> list:
    """Patch httpx.get/httpx.post to route through a MockTransport.

    OrchestratorLLM uses module-level `httpx.get` and `httpx.post`
    (not a long-lived client), so we replace those two functions with
    versions that use a MockTransport-backed Client. Captures every
    request for assertions.
    """
    captured: list[httpx.Request] = []

    def _record_and_handle(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_record_and_handle)
    client = httpx.Client(transport=transport)

    def _patched_get(url, **kwargs):
        return client.get(url, **kwargs)

    def _patched_post(url, **kwargs):
        return client.post(url, **kwargs)

    monkeypatch.setattr(httpx, "get", _patched_get)
    monkeypatch.setattr(httpx, "post", _patched_post)
    return captured


# ────────────────────────────────────────────────────────────────────
# OrchestratorLLM — reachability
# ────────────────────────────────────────────────────────────────────

class TestOrchestratorAvailable:
    def test_available_true_on_healthy_response(self, monkeypatch):
        def handler(req):
            assert req.url.path == "/ai/health"
            return httpx.Response(200, json={"status": "ok"})
        _install_mock_transport(monkeypatch, handler)
        client = OrchestratorLLM(base_url="http://test")
        assert client.available is True

    def test_available_false_on_5xx(self, monkeypatch):
        def handler(req):
            return httpx.Response(503, json={"status": "down"})
        _install_mock_transport(monkeypatch, handler)
        assert OrchestratorLLM(base_url="http://test").available is False

    def test_available_false_on_transport_error(self, monkeypatch):
        def handler(req):
            raise httpx.ConnectError("connection refused")
        _install_mock_transport(monkeypatch, handler)
        assert OrchestratorLLM(base_url="http://test").available is False


# ────────────────────────────────────────────────────────────────────
# OrchestratorLLM — reply()
# ────────────────────────────────────────────────────────────────────

class TestOrchestratorReply:
    def test_reply_posts_to_chat_path_with_model_messages(self, monkeypatch):
        def handler(req):
            assert req.url.path == "/ai/chat"
            body = json.loads(req.content)
            assert body["model"] == "test-model"
            assert body["stream"] is False
            assert body["messages"][0]["role"] == "system"
            assert body["messages"][1]["role"] == "user"
            assert body["messages"][1]["content"] == "what time is it"
            # OpenAI/ai-gateway response shape.
            return httpx.Response(
                200,
                json={
                    "id": "chatcmpl-1",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": "it is 3 pm"},
                        "finish_reason": "stop",
                    }],
                },
            )
        _install_mock_transport(monkeypatch, handler)
        client = OrchestratorLLM(base_url="http://test", model="test-model")
        assert client.reply("what time is it") == "it is 3 pm"

    def test_reply_handles_orchestrator_agent_shape_too(self, monkeypatch):
        # Commit 7b will move to /api/llm/chat which returns the agent
        # shape (message at top level). Parser must handle both.
        def handler(req):
            return httpx.Response(200, json={
                "message": {"role": "assistant", "content": "agent reply"},
                "conversationId": "c1",
            })
        _install_mock_transport(monkeypatch, handler)
        client = OrchestratorLLM(
            base_url="http://test", chat_path="/api/llm/chat",
        )
        assert client.reply("hi") == "agent reply"

    def test_bearer_token_attached_when_set(self, monkeypatch):
        seen_auth: list[str] = []
        def handler(req):
            seen_auth.append(req.headers.get("authorization", ""))
            return httpx.Response(200, json={
                "choices": [{"message": {"content": "ok"}}],
            })
        _install_mock_transport(monkeypatch, handler)
        OrchestratorLLM(
            base_url="http://test", bearer_token="secret",
        ).reply("hi")
        assert seen_auth == ["Bearer secret"]

    def test_empty_user_text_short_circuits_no_network(self, monkeypatch):
        # Empty input shouldn't burn an orchestrator call. The wake loop
        # may misfire on noise and produce empty transcripts.
        captured = _install_mock_transport(
            monkeypatch, lambda r: httpx.Response(500),
        )
        result = OrchestratorLLM(base_url="http://test").reply("")
        assert result == ""
        assert captured == []

    def test_whitespace_only_text_also_short_circuits(self, monkeypatch):
        captured = _install_mock_transport(
            monkeypatch, lambda r: httpx.Response(500),
        )
        result = OrchestratorLLM(base_url="http://test").reply("   \n\t  ")
        assert result == ""
        assert captured == []

    def test_user_text_is_stripped(self, monkeypatch):
        seen: list[str] = []
        def handler(req):
            body = json.loads(req.content)
            seen.append(body["messages"][1]["content"])
            return httpx.Response(200, json={
                "choices": [{"message": {"content": "ok"}}],
            })
        _install_mock_transport(monkeypatch, handler)
        OrchestratorLLM(base_url="http://test").reply("  hello there  \n")
        assert seen == ["hello there"]

    def test_system_prompt_propagates(self, monkeypatch):
        seen_system: list[str] = []
        def handler(req):
            body = json.loads(req.content)
            seen_system.append(body["messages"][0]["content"])
            return httpx.Response(200, json={
                "choices": [{"message": {"content": "ok"}}],
            })
        _install_mock_transport(monkeypatch, handler)
        OrchestratorLLM(
            base_url="http://test", system_prompt="you are a tiny robot",
        ).reply("hi")
        assert seen_system == ["you are a tiny robot"]


class TestOrchestratorReplyErrors:
    def test_transport_failure_raises_llmunavailable(self, monkeypatch):
        def handler(req):
            raise httpx.ConnectError("connection refused")
        _install_mock_transport(monkeypatch, handler)
        with pytest.raises(LLMUnavailable, match="failed"):
            OrchestratorLLM(base_url="http://test").reply("hi")

    def test_5xx_with_detail_surfaces_message(self, monkeypatch):
        def handler(req):
            return httpx.Response(500, json={"detail": "model not loaded"})
        _install_mock_transport(monkeypatch, handler)
        with pytest.raises(LLMUnavailable, match="model not loaded"):
            OrchestratorLLM(base_url="http://test").reply("hi")

    def test_non_json_body_handled(self, monkeypatch):
        def handler(req):
            return httpx.Response(200, content=b"not json at all")
        _install_mock_transport(monkeypatch, handler)
        with pytest.raises(LLMUnavailable):
            OrchestratorLLM(base_url="http://test").reply("hi")


# ────────────────────────────────────────────────────────────────────
# Response shape parsers
# ────────────────────────────────────────────────────────────────────

class TestExtractAssistantText:
    def test_openai_choices_shape(self):
        # ai-gateway returns this.
        payload = {"choices": [{"message": {"content": "hello"}}]}
        assert _extract_assistant_text(payload) == "hello"

    def test_orchestrator_message_shape(self):
        # Commit 7b's path returns this.
        payload = {"message": {"role": "assistant", "content": "hello"}}
        assert _extract_assistant_text(payload) == "hello"

    def test_segmented_text_content(self):
        # Some agent paths return content as a list of segments. We
        # only want the text segments concatenated.
        payload = {"message": {"content": [
            {"type": "text", "text": "first"},
            {"type": "tool_use", "name": "x"},
            {"type": "text", "text": "second"},
        ]}}
        assert _extract_assistant_text(payload) == "first second"

    def test_missing_message_returns_empty(self):
        # Don't crash on unexpected shapes; just speak nothing.
        assert _extract_assistant_text({}) == ""

    def test_strips_leading_trailing_whitespace(self):
        payload = {"choices": [{"message": {"content": "  hello there  \n"}}]}
        assert _extract_assistant_text(payload) == "hello there"

    def test_empty_choices_array_returns_empty(self):
        # Edge case: ai-gateway sometimes returns choices:[] on errors.
        assert _extract_assistant_text({"choices": []}) == ""

    def test_choices_with_no_message_returns_empty(self):
        # Malformed payload should not crash.
        assert _extract_assistant_text({"choices": [{}]}) == ""


class TestExtractErrorDetail:
    def test_pulls_detail_field(self):
        resp = httpx.Response(500, json={"detail": "model busy"})
        assert _extract_error_detail(resp) == "model busy"

    def test_pulls_error_field(self):
        resp = httpx.Response(500, json={"error": "rate-limited"})
        assert _extract_error_detail(resp) == "rate-limited"

    def test_falls_back_to_body_text(self):
        resp = httpx.Response(500, content=b"plain text error")
        assert "plain text error" in _extract_error_detail(resp)


# ────────────────────────────────────────────────────────────────────
# MockLLM
# ────────────────────────────────────────────────────────────────────

class TestMockLLM:
    def test_replays_scripted_replies_in_order(self):
        m = MockLLM(scripted_replies=["one", "two", "three"])
        assert m.reply("first") == "one"
        assert m.reply("second") == "two"
        assert m.reply("third") == "three"
        assert m.requests == ["first", "second", "third"]

    def test_returns_empty_after_script_exhausted(self):
        m = MockLLM(scripted_replies=["only"])
        m.reply("a")
        assert m.reply("b") == ""

    def test_echo_mode_returns_user_text(self):
        m = MockLLM(echo=True)
        assert m.reply("how are you") == "You said: how are you"

    def test_available_true_by_default(self):
        assert MockLLM().available is True

    def test_available_false_when_explicitly_set(self):
        assert MockLLM(available=False).available is False


# ────────────────────────────────────────────────────────────────────
# build_llm_from_env
# ────────────────────────────────────────────────────────────────────

class TestBuildLLMFromEnv:
    def test_default_uses_orchestrator_compose_dns(self, monkeypatch):
        for k in ("LLM_URL", "LLM_MODEL", "ORCHESTRATOR_TOKEN"):
            monkeypatch.delenv(k, raising=False)
        llm = build_llm_from_env()
        assert isinstance(llm, OrchestratorLLM)
        assert llm._base_url == DEFAULT_LLM_URL

    def test_mock_when_url_is_double_underscore_mock(self, monkeypatch):
        monkeypatch.setenv("LLM_URL", "__mock__")
        llm = build_llm_from_env()
        assert isinstance(llm, MockLLM)
        # echo mode so manual dev triggering shows something
        assert llm.reply("hi") == "You said: hi"

    def test_custom_url_propagates(self, monkeypatch):
        monkeypatch.setenv("LLM_URL", "http://other-host:1234")
        llm = build_llm_from_env()
        assert isinstance(llm, OrchestratorLLM)
        assert llm._base_url == "http://other-host:1234"

    def test_model_env_propagates(self, monkeypatch):
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("LLM_MODEL", "tinyllama:latest")
        llm = build_llm_from_env()
        assert llm._model == "tinyllama:latest"

    def test_orchestrator_token_propagates_to_authorization(self, monkeypatch):
        # Reuse the existing service-to-service auth secret.
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("ORCHESTRATOR_TOKEN", "shared-secret")
        llm = build_llm_from_env()
        assert isinstance(llm, OrchestratorLLM)
        assert llm._bearer_token == "shared-secret"
