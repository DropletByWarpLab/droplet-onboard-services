"""voice.llm.OrchestratorLLMWithTools — tool-iteration loop.

Covers:
  - text-only reply when no tools are configured (lazy fetch path)
  - single-tool happy path (call → result → final text)
  - two-tool chain (list → control → final text)
  - tool refusal (VOICE_LOCK_REFUSED) surfaced through to final text
  - MAX_TOOL_ITERATIONS bail-out
  - LLM transport failure mid-loop returns a spoken apology
  - empty user_text fast-path returns ""
  - both OpenAI and Ollama tool-call wire shapes parse correctly
  - malformed tool_call arguments JSON → empty dict (don't crash)
"""
from __future__ import annotations

import json

import httpx
import pytest

from voice import llm as llm_mod
from voice.llm import (
    MAX_TOOL_ITERATIONS,
    OrchestratorLLM,
    OrchestratorLLMWithTools,
)
from voice.tools import (
    MockToolClient,
    ToolDefinition,
    ToolInvocation,
)


# ────────────────────────────────────────────────────────────────────
# Helpers — fake httpx for the LLM call
# ────────────────────────────────────────────────────────────────────


class _FakeResp:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body
        self.text = json.dumps(body)
        self.is_success = 200 <= status_code < 300

    def json(self) -> dict:
        return self._body


def _patch_llm_post(monkeypatch, *responses):
    """Install a queue of LLM responses. Each httpx.post() call from
    the LLM transport consumes the next one. Records the body sent.
    """
    calls: list[dict] = []
    queue = list(responses)

    def fake_post(url, *, json=None, timeout=None, headers=None):
        calls.append(json)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(llm_mod.httpx, "post", fake_post)
    return calls


def _llm_response_text(content: str) -> _FakeResp:
    """Plain text reply, OpenAI-shape."""
    return _FakeResp(200, {
        "choices": [{"message": {"role": "assistant", "content": content}}],
    })


def _llm_response_tool_call(
    name: str,
    args: dict,
    *,
    call_id: str = "call-1",
    text: str = "",
) -> _FakeResp:
    """Tool-call shape, OpenAI-style."""
    return _FakeResp(200, {
        "choices": [{
            "message": {
                "role": "assistant",
                "content": text,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)},
                }],
            },
        }],
    })


def _llm_response_ollama_tool_call(name: str, args: dict) -> _FakeResp:
    """Tool-call shape, Ollama-native: top-level `message` + arguments
    as a dict (not a JSON string)."""
    return _FakeResp(200, {
        "message": {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "function": {"name": name, "arguments": args},
            }],
        },
    })


def _build_wrapped_llm(tools):
    base = OrchestratorLLM(
        base_url="http://ai-gateway:8000",
        model="llama3.1:8b",
        system_prompt="test prompt",
        location=None,
        timezone="UTC",
    )
    return OrchestratorLLMWithTools(base, tools)


# ────────────────────────────────────────────────────────────────────
# Empty-input + no-tools paths
# ────────────────────────────────────────────────────────────────────


class TestNoToolPaths:
    def test_empty_user_text_returns_empty(self, monkeypatch):
        # No httpx.post stub — confirms we short-circuit before transport.
        def boom(*a, **k):
            raise AssertionError("should not call LLM with empty input")
        monkeypatch.setattr(llm_mod.httpx, "post", boom)
        wrapped = _build_wrapped_llm(MockToolClient())
        assert wrapped.reply("") == ""
        assert wrapped.reply("   ") == ""

    def test_falls_back_to_text_only_when_no_tools_available(self, monkeypatch):
        # Empty tool list (MockToolClient returned [] from list_tools)
        # → wrapper delegates to base.reply(), which is one POST.
        _patch_llm_post(monkeypatch, _llm_response_text("Hello back."))
        wrapped = _build_wrapped_llm(MockToolClient(tools=[]))
        result = wrapped.reply("Hi")
        assert result == "Hello back."


# ────────────────────────────────────────────────────────────────────
# Single tool call
# ────────────────────────────────────────────────────────────────────


class TestSingleToolCall:
    def test_happy_path_call_then_final_text(self, monkeypatch):
        tools = MockToolClient(
            tools=[ToolDefinition(name="control_device", description="ctrl",
                                   parameters={"type": "object"})],
            responses={"control_device": {"ok": True, "data": "off"}},
        )
        # First LLM call returns a tool_call; second returns plain text.
        _patch_llm_post(
            monkeypatch,
            _llm_response_tool_call("control_device",
                                     {"node_id": "12345", "command": "turn_off"}),
            _llm_response_text("Done, the office lamp is off."),
        )
        wrapped = _build_wrapped_llm(tools)
        result = wrapped.reply("Turn off the office lamp")
        assert result == "Done, the office lamp is off."
        # The tool was invoked exactly once with the LLM's args.
        assert len(tools.invocations) == 1
        assert tools.invocations[0].name == "control_device"
        assert tools.invocations[0].arguments == {
            "node_id": "12345", "command": "turn_off",
        }

    def test_tool_call_passes_tools_array_on_each_LLM_round(self, monkeypatch):
        tools = MockToolClient(
            tools=[ToolDefinition(name="control_device", description="x",
                                   parameters={"type": "object"})],
            responses={"control_device": {"ok": True}},
        )
        bodies = _patch_llm_post(
            monkeypatch,
            _llm_response_tool_call("control_device", {"command": "turn_on"}),
            _llm_response_text("OK"),
        )
        _build_wrapped_llm(tools).reply("turn on")
        # Both round-trips carry the `tools` array — the LLM can chain.
        assert "tools" in bodies[0]
        assert "tools" in bodies[1]
        assert bodies[0]["tools"][0]["function"]["name"] == "control_device"


# ────────────────────────────────────────────────────────────────────
# Multi-tool chain (list → control → final)
# ────────────────────────────────────────────────────────────────────


class TestToolChain:
    def test_two_tool_chain_resolves(self, monkeypatch):
        tools = MockToolClient(
            tools=[
                ToolDefinition(name="list_smart_home_devices", description="l",
                                parameters={"type": "object"}),
                ToolDefinition(name="control_device", description="c",
                                parameters={"type": "object"}),
            ],
            responses={
                "list_smart_home_devices": {
                    "ok": True,
                    "data": {"lights": [{"nodeId": "1", "name": "Lamp"}]},
                },
                "control_device": {"ok": True, "data": "off"},
            },
        )
        _patch_llm_post(
            monkeypatch,
            _llm_response_tool_call("list_smart_home_devices", {}, call_id="c1"),
            _llm_response_tool_call("control_device",
                                     {"node_id": "1", "command": "turn_off"},
                                     call_id="c2"),
            _llm_response_text("Lamp's off now."),
        )
        result = _build_wrapped_llm(tools).reply("turn off the lamp")
        assert result == "Lamp's off now."
        assert [i.name for i in tools.invocations] == [
            "list_smart_home_devices", "control_device",
        ]


# ────────────────────────────────────────────────────────────────────
# Lock-via-voice refusal end-to-end
# ────────────────────────────────────────────────────────────────────


class TestLockRefusalE2E:
    def test_lock_refusal_surfaced_to_final_speech(self, monkeypatch):
        # LLM tries to invoke control_device with command=unlock.
        # MockToolClient refuses (returns VOICE_LOCK_REFUSED with
        # is_refusal=True). The refusal text gets fed back to the LLM,
        # which then produces a polite spoken refusal.
        tools = MockToolClient(
            tools=[ToolDefinition(name="control_device", description="x",
                                   parameters={"type": "object"})],
        )
        _patch_llm_post(
            monkeypatch,
            _llm_response_tool_call("control_device",
                                     {"node_id": "9", "command": "unlock"}),
            _llm_response_text(
                "I can't unlock doors with voice. Use the dashboard.",
            ),
        )
        result = _build_wrapped_llm(tools).reply("unlock the front door")
        assert "dashboard" in result.lower()
        # Tool was invoked; refusal happened inside the client (defence
        # in depth), not via the LLM declining to call.
        assert tools.invocations[0].arguments["command"] == "unlock"


# ────────────────────────────────────────────────────────────────────
# MAX_TOOL_ITERATIONS bail-out
# ────────────────────────────────────────────────────────────────────


class TestIterationCap:
    def test_bails_after_max_iterations(self, monkeypatch):
        # LLM endlessly emits tool_calls — verify we cap.
        tools = MockToolClient(
            tools=[ToolDefinition(name="control_device", description="x",
                                   parameters={"type": "object"})],
            responses={"control_device": {"ok": False, "error": {"code": "X"}}},
        )
        # Queue MAX_TOOL_ITERATIONS tool-call responses (the cap loops
        # this many times before bailing).
        responses = [
            _llm_response_tool_call("control_device", {"command": "turn_on"})
            for _ in range(MAX_TOOL_ITERATIONS)
        ]
        _patch_llm_post(monkeypatch, *responses)
        result = _build_wrapped_llm(tools).reply("loop forever please")
        assert "couldn't finish" in result.lower() or "dashboard" in result.lower()
        # Tool was invoked exactly MAX_TOOL_ITERATIONS times (one per
        # LLM round-trip).
        assert len(tools.invocations) == MAX_TOOL_ITERATIONS


# ────────────────────────────────────────────────────────────────────
# LLM transport failure mid-loop
# ────────────────────────────────────────────────────────────────────


class TestTransportFailure:
    def test_transport_error_returns_spoken_apology(self, monkeypatch):
        tools = MockToolClient(
            tools=[ToolDefinition(name="control_device", description="x",
                                   parameters={"type": "object"})],
        )
        # First call: tool. Second call: transport error.
        _patch_llm_post(
            monkeypatch,
            _llm_response_tool_call("control_device", {"command": "turn_on"}),
            httpx.ConnectError("ai-gateway down"),
        )
        result = _build_wrapped_llm(tools).reply("turn on")
        assert "trouble" in result.lower() or "try again" in result.lower()

    def test_non_2xx_response_returns_spoken_apology(self, monkeypatch):
        tools = MockToolClient(
            tools=[ToolDefinition(name="control_device", description="x",
                                   parameters={"type": "object"})],
        )
        _patch_llm_post(monkeypatch, _FakeResp(503, {"error": "down"}))
        result = _build_wrapped_llm(tools).reply("hello")
        assert "trouble" in result.lower()


# ────────────────────────────────────────────────────────────────────
# Wire-shape compatibility: OpenAI vs Ollama
# ────────────────────────────────────────────────────────────────────


class TestWireShapes:
    def test_handles_ollama_native_tool_call_shape(self, monkeypatch):
        tools = MockToolClient(
            tools=[ToolDefinition(name="control_device", description="x",
                                   parameters={"type": "object"})],
            responses={"control_device": {"ok": True}},
        )
        # First response is Ollama-shape (top-level message, dict args).
        _patch_llm_post(
            monkeypatch,
            _llm_response_ollama_tool_call("control_device", {"command": "turn_on"}),
            _llm_response_text("Done."),
        )
        result = _build_wrapped_llm(tools).reply("turn on")
        assert result == "Done."
        # Args came through as dict, not string
        assert tools.invocations[0].arguments == {"command": "turn_on"}

    def test_malformed_json_args_become_empty_dict(self, monkeypatch):
        # Some small models emit slightly-wrong JSON in `arguments`.
        # We should NOT crash; pass empty args and let the tool reject.
        tools = MockToolClient(
            tools=[ToolDefinition(name="control_device", description="x",
                                   parameters={"type": "object"})],
            responses={"control_device": {"ok": False,
                                            "error": {"code": "INVALID_ARGS"}}},
        )
        bad = _FakeResp(200, {
            "choices": [{
                "message": {
                    "role": "assistant", "content": "",
                    "tool_calls": [{
                        "id": "c1", "type": "function",
                        "function": {
                            "name": "control_device",
                            "arguments": "{this is not valid json",
                        },
                    }],
                },
            }],
        })
        _patch_llm_post(
            monkeypatch, bad,
            _llm_response_text("That didn't quite work."),
        )
        result = _build_wrapped_llm(tools).reply("do something")
        assert result == "That didn't quite work."
        # Tool got {} (empty), not the malformed string
        assert tools.invocations[0].arguments == {}
