"""Tool-call / tool-result message-contract validation on ChatRequest (WARP-176).

Threat model: a misbehaving tool or a malicious client must not be able to
inject fabricated or malformed tool results into the conversation the gateway
hands back to the model. These tests pin the boundary-level structural checks
enforced by ``ChatRequest._validate_tool_message_integrity``. They are
deliberately generic (message-contract only) — per-tool argument schemas live
in the orchestrator/tools-core, not here.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from schemas import ChatMessage, ChatRequest, FunctionCall, ToolCall


def _assistant_tool_call(call_id: str, args: str = "{}") -> ChatMessage:
    return ChatMessage(
        role="assistant",
        content=None,
        tool_calls=[
            ToolCall(id=call_id, function=FunctionCall(name="get_x", arguments=args))
        ],
    )


# --- VALID cases -----------------------------------------------------------


def test_paired_tool_call_and_result_ok():
    req = ChatRequest(
        model="gpt-4o",
        messages=[
            ChatMessage(role="user", content="what is x?"),
            _assistant_tool_call("call_1"),
            ChatMessage(role="tool", content="42", tool_call_id="call_1"),
        ],
    )
    assert len(req.messages) == 3
    assert req.messages[2].tool_call_id == "call_1"


def test_zero_arg_tool_call_with_empty_arguments_ok():
    # Zero-arg tool calls: some models (notably local Ollama) emit
    # arguments="" instead of "{}". The orchestrator replays the model's raw
    # arguments, so "" must be accepted or the guard would 422 a legitimate
    # zero-arg agent turn. Only NON-empty arguments must be valid JSON.
    req = ChatRequest(
        model="llama3:8b",
        messages=[
            ChatMessage(role="user", content="ping"),
            _assistant_tool_call("call_1", args=""),
            ChatMessage(role="tool", content="pong", tool_call_id="call_1"),
        ],
    )
    assert len(req.messages) == 3


def test_plain_chat_without_tools_ok():
    # Regression: ordinary conversations must be untouched.
    req = ChatRequest(
        model="llama3:8b",
        messages=[
            ChatMessage(role="system", content="You are helpful."),
            ChatMessage(role="user", content="hi"),
            ChatMessage(role="assistant", content="hello"),
        ],
    )
    assert len(req.messages) == 3


def test_multi_turn_two_paired_tool_calls_ok():
    req = ChatRequest(
        model="gpt-4o",
        messages=[
            ChatMessage(role="user", content="do two things"),
            _assistant_tool_call("call_1", args='{"a": 1}'),
            ChatMessage(role="tool", content="first", tool_call_id="call_1"),
            _assistant_tool_call("call_2", args='{"b": 2}'),
            ChatMessage(role="tool", content="second", tool_call_id="call_2"),
            ChatMessage(role="assistant", content="done"),
        ],
    )
    assert len(req.messages) == 6


def test_two_tool_calls_in_one_assistant_message_ok():
    req = ChatRequest(
        model="gpt-4o",
        messages=[
            ChatMessage(role="user", content="go"),
            ChatMessage(
                role="assistant",
                content=None,
                tool_calls=[
                    ToolCall(id="call_a", function=FunctionCall(name="f", arguments="{}")),
                    ToolCall(id="call_b", function=FunctionCall(name="g", arguments="{}")),
                ],
            ),
            ChatMessage(role="tool", content="ra", tool_call_id="call_a"),
            ChatMessage(role="tool", content="rb", tool_call_id="call_b"),
        ],
    )
    assert len(req.messages) == 4


def test_empty_string_tool_result_content_ok():
    # An empty tool result is a legitimate (if unusual) result — allowed.
    req = ChatRequest(
        model="gpt-4o",
        messages=[
            _assistant_tool_call("call_1"),
            ChatMessage(role="tool", content="", tool_call_id="call_1"),
        ],
    )
    assert req.messages[1].content == ""


# --- INVALID cases (fail-closed → ValidationError) -------------------------


def test_tool_result_referencing_unknown_id_rejected():
    with pytest.raises(ValidationError):
        ChatRequest(
            model="gpt-4o",
            messages=[
                ChatMessage(role="user", content="hi"),
                ChatMessage(role="tool", content="fabricated", tool_call_id="call_ghost"),
            ],
        )


def test_tool_result_with_none_tool_call_id_rejected():
    with pytest.raises(ValidationError):
        ChatRequest(
            model="gpt-4o",
            messages=[
                _assistant_tool_call("call_1"),
                ChatMessage(role="tool", content="42", tool_call_id=None),
            ],
        )


def test_tool_result_with_multimodal_content_rejected():
    # tool_call_id is correctly paired so ONLY the content-type check can fail.
    with pytest.raises(ValidationError):
        ChatRequest(
            model="gpt-4o",
            messages=[
                _assistant_tool_call("call_1"),
                ChatMessage(
                    role="tool",
                    tool_call_id="call_1",
                    content=[{"type": "text", "text": "smuggled block"}],
                ),
            ],
        )


def test_tool_result_with_none_content_rejected():
    with pytest.raises(ValidationError):
        ChatRequest(
            model="gpt-4o",
            messages=[
                _assistant_tool_call("call_1"),
                ChatMessage(role="tool", content=None, tool_call_id="call_1"),
            ],
        )


def test_assistant_tool_call_with_non_json_arguments_rejected():
    with pytest.raises(ValidationError):
        ChatRequest(
            model="gpt-4o",
            messages=[
                ChatMessage(role="user", content="hi"),
                _assistant_tool_call("call_1", args="not json{{"),
            ],
        )


def test_tool_calls_on_user_message_rejected():
    with pytest.raises(ValidationError):
        ChatRequest(
            model="gpt-4o",
            messages=[
                ChatMessage(
                    role="user",
                    content="hi",
                    tool_calls=[
                        ToolCall(id="call_1", function=FunctionCall(name="f", arguments="{}"))
                    ],
                ),
            ],
        )


def test_tool_call_id_on_user_message_rejected():
    with pytest.raises(ValidationError):
        ChatRequest(
            model="gpt-4o",
            messages=[
                ChatMessage(role="user", content="hi", tool_call_id="call_1"),
            ],
        )


def test_duplicate_tool_call_ids_rejected():
    with pytest.raises(ValidationError):
        ChatRequest(
            model="gpt-4o",
            messages=[
                _assistant_tool_call("call_1"),
                ChatMessage(role="tool", content="42", tool_call_id="call_1"),
                _assistant_tool_call("call_1"),  # id reused — globally not unique
            ],
        )
