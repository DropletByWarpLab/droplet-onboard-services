"""voice.tools — MCP HTTP client + voice-side safety policy.

Categories:
  - ToolDefinition.to_chat_format          (1 test)
  - McpToolClient.list_tools               (3 tests)
  - McpToolClient.invoke                   (5 tests)
  - Lock-via-voice refusal                 (3 tests, both McpToolClient + MockToolClient)
  - Unknown tool refusal                   (1 test)
  - MockToolClient                         (2 tests)
  - build_tool_client_from_env             (4 tests)
"""
from __future__ import annotations

import json

import httpx
import pytest

from voice import tools as tools_mod
from voice.tools import (
    DEFAULT_MCP_URL,
    McpToolClient,
    MockToolClient,
    SMART_HOME_TOOL_NAMES,
    ToolClientError,
    ToolDefinition,
    ToolInvocation,
    build_tool_client_from_env,
)


# ────────────────────────────────────────────────────────────────────
# Test helpers
# ────────────────────────────────────────────────────────────────────


class _StubResponse:
    """httpx-compatible stub. We don't use httpx.Response because its
    constructor wants a real request — overkill for our purposes."""

    def __init__(self, status_code: int, body: object):
        self.status_code = status_code
        self.text = json.dumps(body) if isinstance(body, (dict, list)) else str(body)
        self._body = body

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> object:
        if isinstance(self._body, (dict, list)):
            return self._body
        raise json.JSONDecodeError("not json", "", 0)


def _patch_post(monkeypatch, *responses):
    """Install a sequence of fake responses. Each httpx.post() call
    consumes the next one. Records `calls = [(url, body), ...]`."""
    calls: list[tuple[str, dict]] = []
    queue = list(responses)

    def fake_post(url, *, json=None, **kwargs):
        calls.append((url, json))
        if isinstance(queue[0], Exception):
            raise queue.pop(0)
        return queue.pop(0)

    monkeypatch.setattr(tools_mod.httpx, "post", fake_post)
    return calls


# ────────────────────────────────────────────────────────────────────
# ToolDefinition shape
# ────────────────────────────────────────────────────────────────────


class TestToolDefinition:
    def test_to_chat_format_is_openai_compatible(self):
        td = ToolDefinition(
            name="control_device",
            description="Send a command to a smart-home device.",
            parameters={"type": "object", "properties": {}},
        )
        out = td.to_chat_format()
        assert out == {
            "type": "function",
            "function": {
                "name": "control_device",
                "description": "Send a command to a smart-home device.",
                "parameters": {"type": "object", "properties": {}},
            },
        }


# ────────────────────────────────────────────────────────────────────
# McpToolClient.list_tools — filtering + normalization
# ────────────────────────────────────────────────────────────────────


class TestListTools:
    def test_filters_to_smart_home_subset(self, monkeypatch):
        # Server returns 4 tools — 3 smart-home, 1 calendar. Calendar drops out.
        _patch_post(monkeypatch, _StubResponse(200, {
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [
                    {"name": "list_smart_home_devices", "description": "x",
                     "inputSchema": {"type": "object"}},
                    {"name": "control_device", "description": "y",
                     "inputSchema": {"type": "object"}},
                    {"name": "create_event", "description": "calendar",
                     "inputSchema": {"type": "object"}},
                    {"name": "get_smart_home_device", "description": "z",
                     "inputSchema": {"type": "object"}},
                ],
            },
        }))
        client = McpToolClient()
        defs = client.list_tools()
        names = {d.name for d in defs}
        assert names == {"list_smart_home_devices", "control_device", "get_smart_home_device"}

    def test_uses_inputSchema_for_parameters(self, monkeypatch):
        _patch_post(monkeypatch, _StubResponse(200, {
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [{
                    "name": "control_device",
                    "description": "x",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"node_id": {"type": "string"}},
                        "required": ["node_id"],
                    },
                }],
            },
        }))
        defs = McpToolClient().list_tools()
        assert defs[0].parameters["required"] == ["node_id"]
        assert defs[0].parameters["properties"]["node_id"]["type"] == "string"

    def test_raises_on_transport_error(self, monkeypatch):
        _patch_post(monkeypatch, httpx.ConnectError("unreachable"))
        with pytest.raises(ToolClientError) as exc:
            McpToolClient().list_tools()
        assert "transport error" in str(exc.value).lower()


# ────────────────────────────────────────────────────────────────────
# McpToolClient.invoke — happy path + error mapping
# ────────────────────────────────────────────────────────────────────


class TestInvoke:
    def test_happy_path_dispatches_to_tools_call(self, monkeypatch):
        calls = _patch_post(monkeypatch, _StubResponse(200, {
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "content": [{"type": "text", "text": '{"ok": true, "data": "off"}'}],
            },
        }))
        client = McpToolClient()
        result = client.invoke(ToolInvocation(
            call_id="call-1",
            name="control_device",
            arguments={"node_id": "12345", "command": "turn_off"},
        ))
        assert result.call_id == "call-1"
        assert result.name == "control_device"
        assert json.loads(result.content) == {"ok": True, "data": "off"}
        assert not result.is_refusal
        # JSON-RPC envelope sent to /mcp
        url, body = calls[0]
        assert url == f"{DEFAULT_MCP_URL}/mcp"
        assert body["method"] == "tools/call"
        assert body["params"]["name"] == "control_device"
        assert body["params"]["arguments"]["command"] == "turn_off"

    def test_mcp_returns_5xx_surfaces_as_tool_result(self, monkeypatch):
        # 5xx -> ToolClientError -> wrapped as tool result with
        # MCP_UNREACHABLE error. Loop keeps moving rather than crash.
        _patch_post(monkeypatch, _StubResponse(503, {"error": "down"}))
        client = McpToolClient()
        result = client.invoke(ToolInvocation(
            call_id="call-1", name="control_device", arguments={"command": "turn_on"},
        ))
        parsed = json.loads(result.content)
        assert parsed["ok"] is False
        assert parsed["error"]["code"] == "MCP_UNREACHABLE"

    def test_mcp_error_payload_surfaces(self, monkeypatch):
        # JSON-RPC error envelope, not HTTP 4xx
        _patch_post(monkeypatch, _StubResponse(200, {
            "jsonrpc": "2.0",
            "id": 2,
            "error": {"code": -32602, "message": "Invalid params"},
        }))
        client = McpToolClient()
        result = client.invoke(ToolInvocation(
            call_id="call-1", name="control_device", arguments={},
        ))
        parsed = json.loads(result.content)
        assert parsed["error"]["code"] == "MCP_UNREACHABLE"
        assert "Invalid params" in parsed["error"]["message"]

    def test_flattens_mcp_text_content_segments(self, monkeypatch):
        # MCP wraps text content; we flatten to a single string the LLM consumes.
        _patch_post(monkeypatch, _StubResponse(200, {
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "content": [
                    {"type": "text", "text": "Line 1"},
                    {"type": "text", "text": "Line 2"},
                ],
            },
        }))
        result = McpToolClient().invoke(ToolInvocation(
            call_id="x", name="list_smart_home_devices", arguments={},
        ))
        assert result.content == "Line 1\nLine 2"

    def test_bearer_token_attached_when_set(self, monkeypatch):
        # Spy on headers via a custom fake that captures the kwargs.
        captured = {}

        def fake_post(url, *, json=None, headers=None, **kw):
            captured["headers"] = headers
            return _StubResponse(200, {
                "jsonrpc": "2.0", "id": 2,
                "result": {"content": [{"type": "text", "text": "{}"}]},
            })

        monkeypatch.setattr(tools_mod.httpx, "post", fake_post)
        McpToolClient(bearer_token="abc123").invoke(ToolInvocation(
            call_id="x", name="control_device", arguments={"command": "turn_on"},
        ))
        assert captured["headers"]["Authorization"] == "Bearer abc123"


# ────────────────────────────────────────────────────────────────────
# Lock-via-voice refusal
# ────────────────────────────────────────────────────────────────────


class TestLockRefusal:
    def test_lock_command_refused_before_network(self, monkeypatch):
        # No httpx.post stub -> if invoke reaches the network the test fails
        # with NameError. The refusal must short-circuit BEFORE.
        def boom(*a, **k):
            raise AssertionError("lock command should NOT reach the MCP server")
        monkeypatch.setattr(tools_mod.httpx, "post", boom)
        result = McpToolClient().invoke(ToolInvocation(
            call_id="x",
            name="control_device",
            arguments={"node_id": "999", "command": "lock"},
        ))
        assert result.is_refusal is True
        parsed = json.loads(result.content)
        assert parsed["error"]["code"] == "VOICE_LOCK_REFUSED"

    def test_unlock_command_refused(self, monkeypatch):
        def boom(*a, **k):
            raise AssertionError("unlock should not reach MCP")
        monkeypatch.setattr(tools_mod.httpx, "post", boom)
        result = McpToolClient().invoke(ToolInvocation(
            call_id="x",
            name="control_device",
            arguments={"node_id": "999", "command": "unlock"},
        ))
        assert result.is_refusal is True

    def test_case_insensitive_match(self, monkeypatch):
        def boom(*a, **k):
            raise AssertionError("should not reach MCP")
        monkeypatch.setattr(tools_mod.httpx, "post", boom)
        for variant in ("Lock", "UNLOCK", "Unlock"):
            result = McpToolClient().invoke(ToolInvocation(
                call_id="x", name="control_device",
                arguments={"command": variant},
            ))
            assert result.is_refusal, f"failed to refuse '{variant}'"

    def test_mock_client_also_refuses_lock(self):
        client = MockToolClient()
        result = client.invoke(ToolInvocation(
            call_id="x", name="control_device",
            arguments={"command": "unlock"},
        ))
        assert result.is_refusal is True
        assert json.loads(result.content)["error"]["code"] == "VOICE_LOCK_REFUSED"


# ────────────────────────────────────────────────────────────────────
# Unknown / disallowed tool refusal
# ────────────────────────────────────────────────────────────────────


class TestUnknownToolRefusal:
    def test_hallucinated_tool_name_refused(self, monkeypatch):
        # LLM emits a tool not in the allow-list — we refuse BEFORE
        # calling the MCP server.
        def boom(*a, **k):
            raise AssertionError("should not reach MCP")
        monkeypatch.setattr(tools_mod.httpx, "post", boom)
        result = McpToolClient().invoke(ToolInvocation(
            call_id="x", name="rm_rf_everything", arguments={},
        ))
        assert result.is_refusal
        assert json.loads(result.content)["error"]["code"] == "TOOL_NOT_AVAILABLE"


# ────────────────────────────────────────────────────────────────────
# MockToolClient — tests rely on this; sanity-check its shape
# ────────────────────────────────────────────────────────────────────


class TestMockClient:
    def test_records_invocations(self):
        client = MockToolClient(responses={"control_device": {"ok": True, "data": "on"}})
        client.invoke(ToolInvocation(call_id="a", name="control_device",
                                       arguments={"command": "turn_on"}))
        client.invoke(ToolInvocation(call_id="b", name="list_smart_home_devices",
                                       arguments={}))
        assert len(client.invocations) == 2
        assert client.invocations[0].name == "control_device"
        assert client.invocations[1].name == "list_smart_home_devices"

    def test_returns_scripted_response(self):
        client = MockToolClient(responses={
            "control_device": {"ok": True, "data": {"state": "on", "brightness": 75}},
        })
        result = client.invoke(ToolInvocation(call_id="x", name="control_device",
                                                 arguments={"command": "turn_on"}))
        parsed = json.loads(result.content)
        assert parsed["data"]["brightness"] == 75


# ────────────────────────────────────────────────────────────────────
# build_tool_client_from_env — env switching
# ────────────────────────────────────────────────────────────────────


class TestBuildFromEnv:
    def test_disabled_by_default(self, monkeypatch):
        monkeypatch.delenv("VOICE_TOOLS_ENABLED", raising=False)
        assert build_tool_client_from_env() is None

    def test_explicit_zero_returns_none(self, monkeypatch):
        monkeypatch.setenv("VOICE_TOOLS_ENABLED", "0")
        assert build_tool_client_from_env() is None

    def test_truthy_returns_mcp_client(self, monkeypatch):
        monkeypatch.setenv("VOICE_TOOLS_ENABLED", "1")
        monkeypatch.setenv("MCP_URL", "http://mcp.example:9090")
        client = build_tool_client_from_env()
        assert isinstance(client, McpToolClient)
        assert client._base_url == "http://mcp.example:9090"

    def test_invalid_timeout_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("VOICE_TOOLS_ENABLED", "true")
        monkeypatch.setenv("MCP_TIMEOUT_S", "not-a-number")
        client = build_tool_client_from_env()
        assert isinstance(client, McpToolClient)
        # Default is 10.0s (DEFAULT_MCP_TIMEOUT_S)
        assert client._timeout_s == 10.0


# ────────────────────────────────────────────────────────────────────
# Module-level coverage — SMART_HOME_TOOL_NAMES is the contract
# ────────────────────────────────────────────────────────────────────


def test_smart_home_tool_names_locked():
    # If these change, the doc + the LLM-side tool-selection space
    # both need updating. Keep the set explicit so reviewers notice.
    assert SMART_HOME_TOOL_NAMES == frozenset({
        "list_smart_home_devices",
        "get_smart_home_device",
        "control_device",
        "discover_matter_devices",
        "commission_device",
        "get_command_history",
    })
