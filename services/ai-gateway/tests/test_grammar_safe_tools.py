"""Grammar-safe tool schemas for the DMR runtime (WARP-1839).

llama.cpp (DMR's backend) compiles the request's `tools` JSON schemas into a
GBNF grammar for constrained tool-call decoding. Bounded schema keywords
(`maxLength` & co.) expand into repeated rule copies, and one real schema —
`memory_extract_fact.fact`, `maxLength: 2000` — blew the parser's repetition
guard ("Failed to initialize samplers: failed to parse grammar"), 400ing
every tools-bearing chat on the box. Ollama never grammar-constrains tool
calls, which is why the identical catalog worked before the flip.

These tests pin the four things that matter:

* bounded keywords are stripped recursively, wherever they nest,
* keys that merely NAME things (`properties`, `$defs`) are never treated as
  keywords — `regex_test`'s property literally named `pattern` survives, and
  data-valued keys (`enum`, `default`) pass through unrecursed,
* the caller's dicts are never mutated,
* the wire: `chat()` sanitizes exactly when the DMR gate is on and posts the
  caller's schemas verbatim when it is off (ollama rollback shape stays
  byte-identical).
"""

from __future__ import annotations

import asyncio
import copy
import json
import time

import httpx
import pytest
import respx

import providers.ollama_local as ollama_local
from providers.ollama_local import (
    OllamaLocalProvider,
    _strip_grammar_unsafe,
    grammar_safe_tools,
)
from schemas import ChatMessage, ToolDefinition, ToolFunction

TEST_BASE_URL = "http://test-ollama:11434"
TEST_CHAT_URL = "http://test-ollama:11434/v1/chat/completions"

pytestmark = pytest.mark.anyio


@pytest.fixture
async def provider():
    p = OllamaLocalProvider(base_url=TEST_BASE_URL)
    yield p
    await p.close()


def _stub_limits(provider: OllamaLocalProvider) -> None:
    provider._limits.num_parallel = 1
    provider._limits._last_refresh = time.monotonic()
    provider._sema = asyncio.Semaphore(1)
    provider._sema_size = 1


_OK = httpx.Response(
    200, json={"choices": [{"message": {"role": "assistant", "content": "hi"}}]}
)

# The shape that broke the box: memory_extract_fact's real schema, bounded
# string plus enum, `additionalProperties: false`.
EXTRACT_FACT_PARAMS = {
    "type": "object",
    "properties": {
        "category": {
            "type": "string",
            "enum": ["Tone", "Workflow", "Scope", "Schedule", "Other", "Business"],
        },
        "fact": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000,
            "description": "The fact itself.",
        },
    },
    "required": ["category", "fact"],
    "additionalProperties": False,
}


# ---------------------------------------------------------------------------
# _strip_grammar_unsafe
# ---------------------------------------------------------------------------


class TestStripGrammarUnsafe:
    def test_string_bounds_stripped_description_kept(self):
        out = _strip_grammar_unsafe(EXTRACT_FACT_PARAMS)
        fact = out["properties"]["fact"]
        assert "minLength" not in fact
        assert "maxLength" not in fact
        assert fact["type"] == "string"
        assert fact["description"] == "The fact itself."
        # Structural keys survive untouched.
        assert out["required"] == ["category", "fact"]
        assert out["additionalProperties"] is False

    def test_nested_bounds_stripped_everywhere(self):
        # set_detection_zones-shaped: arrays of arrays with item bounds, plus
        # a bounded string inside an anyOf branch.
        schema = {
            "type": "object",
            "properties": {
                "zones": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "properties": {
                            "coordinates": {
                                "type": "array",
                                "minItems": 3,
                                "items": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 2,
                                    "items": {"type": "number"},
                                },
                            },
                            "label": {
                                "anyOf": [
                                    {"type": "string", "maxLength": 60},
                                    {"type": "null"},
                                ]
                            },
                        },
                    },
                },
                "when": {"type": "string", "format": "date-time"},
                "code": {"type": "string", "pattern": "^[A-Z]{3}$"},
            },
        }
        out = _strip_grammar_unsafe(schema)
        assert json.dumps(out).find("maxItems") == -1
        assert "minItems" not in json.dumps(out)
        assert "maxLength" not in json.dumps(out)
        assert "pattern" not in out["properties"]["code"]
        assert "format" not in out["properties"]["when"]
        # The structure itself is intact.
        coords = out["properties"]["zones"]["items"]["properties"]["coordinates"]
        assert coords["items"]["items"] == {"type": "number"}

    def test_property_named_pattern_survives(self):
        # regex_test really has a property NAMED `pattern` — a name under
        # `properties` is not a keyword and must not be stripped.
        schema = {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "the regex to test"},
                "format": {"type": "string"},
            },
            "required": ["pattern"],
        }
        out = _strip_grammar_unsafe(schema)
        assert "pattern" in out["properties"]
        assert "format" in out["properties"]
        assert out["properties"]["pattern"]["description"] == "the regex to test"

    def test_data_keys_pass_through_unrecursed(self):
        # An enum member / default value could legitimately contain a key
        # named like a keyword; data is never schema.
        schema = {
            "type": "object",
            "properties": {
                "preset": {
                    "type": "object",
                    "default": {"maxLength": 5, "pattern": "raw-data"},
                    "enum": [{"maxLength": 5}, {"pattern": "x"}],
                }
            },
        }
        out = _strip_grammar_unsafe(schema)
        assert out["properties"]["preset"]["default"] == {
            "maxLength": 5,
            "pattern": "raw-data",
        }
        assert out["properties"]["preset"]["enum"] == [
            {"maxLength": 5},
            {"pattern": "x"},
        ]

    def test_defs_names_are_not_keywords(self):
        schema = {
            "type": "object",
            "$defs": {
                "pattern": {"type": "string", "maxLength": 9},
            },
            "properties": {"p": {"$ref": "#/$defs/pattern"}},
        }
        out = _strip_grammar_unsafe(schema)
        assert "pattern" in out["$defs"]
        assert "maxLength" not in out["$defs"]["pattern"]
        assert out["properties"]["p"] == {"$ref": "#/$defs/pattern"}


# ---------------------------------------------------------------------------
# grammar_safe_tools
# ---------------------------------------------------------------------------


class TestGrammarSafeTools:
    def test_only_parameters_rewritten_and_input_not_mutated(self):
        tool = {
            "type": "function",
            "function": {
                "name": "memory_extract_fact",
                "description": "Persist a durable memory fact.",
                "parameters": EXTRACT_FACT_PARAMS,
            },
        }
        snapshot = copy.deepcopy(tool)
        out = grammar_safe_tools([tool])
        assert tool == snapshot, "caller's dict must not be mutated"
        assert out[0]["function"]["name"] == "memory_extract_fact"
        assert out[0]["function"]["description"] == "Persist a durable memory fact."
        assert "maxLength" not in json.dumps(out[0]["function"]["parameters"])

    def test_tools_without_parameters_pass_through(self):
        odd = {"type": "function", "function": {"name": "n", "description": "d"}}
        assert grammar_safe_tools([odd]) == [odd]


# ---------------------------------------------------------------------------
# The wire — chat() sanitizes exactly when the DMR gate is on
# ---------------------------------------------------------------------------


def _extract_fact_tool() -> ToolDefinition:
    return ToolDefinition(
        function=ToolFunction(
            name="memory_extract_fact",
            description="Persist a durable memory fact.",
            parameters=EXTRACT_FACT_PARAMS,
        )
    )


@respx.mock
async def test_chat_posts_sanitized_tools_when_dmr(provider, monkeypatch):
    monkeypatch.setattr(ollama_local, "_GRAMMAR_SAFE_TOOL_SCHEMAS", True)
    _stub_limits(provider)
    route = respx.post(TEST_CHAT_URL).mock(return_value=_OK)
    await provider.chat(
        messages=[ChatMessage(role="user", content="hi")],
        model="docker.io/ai/gpt-oss:20B-F16",
        tools=[_extract_fact_tool()],
    )
    sent = json.loads(route.calls.last.request.content)
    params = sent["tools"][0]["function"]["parameters"]
    assert "maxLength" not in json.dumps(params)
    assert "minLength" not in json.dumps(params)
    # Everything the model actually needs is still there.
    assert params["properties"]["category"]["enum"][0] == "Tone"
    assert params["required"] == ["category", "fact"]
    assert sent["tools"][0]["function"]["name"] == "memory_extract_fact"


@respx.mock
async def test_chat_posts_verbatim_tools_when_ollama(provider, monkeypatch):
    monkeypatch.setattr(ollama_local, "_GRAMMAR_SAFE_TOOL_SCHEMAS", False)
    _stub_limits(provider)
    route = respx.post(TEST_CHAT_URL).mock(return_value=_OK)
    await provider.chat(
        messages=[ChatMessage(role="user", content="hi")],
        model="gpt-oss:20b",
        tools=[_extract_fact_tool()],
    )
    sent = json.loads(route.calls.last.request.content)
    fact = sent["tools"][0]["function"]["parameters"]["properties"]["fact"]
    assert fact["maxLength"] == 2000, "ollama wire shape must stay byte-identical"
    assert fact["minLength"] == 1


@respx.mock
async def test_streaming_body_shares_the_same_sanitized_tools(provider, monkeypatch):
    # _stream_chat consumes the body chat() built, so the gate must hold for
    # the shipped dashboard (streaming) path too.
    monkeypatch.setattr(ollama_local, "_GRAMMAR_SAFE_TOOL_SCHEMAS", True)
    _stub_limits(provider)
    route = respx.post(TEST_CHAT_URL).mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
        )
    )
    stream = await provider.chat(
        messages=[ChatMessage(role="user", content="hi")],
        model="docker.io/ai/gpt-oss:20B-F16",
        stream=True,
        tools=[_extract_fact_tool()],
    )
    async for _ in stream:
        pass
    sent = json.loads(route.calls.last.request.content)
    assert "maxLength" not in json.dumps(sent["tools"][0]["function"]["parameters"])
    assert sent["stream"] is True
