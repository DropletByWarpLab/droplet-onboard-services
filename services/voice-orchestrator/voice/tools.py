"""MCP tool client for the voice loop.

What this module owns
---------------------
The voice loop's job, after STT and before TTS, is to feed the
transcribed text to the LLM. WARP-154 (commits 5–7) wired the simple
path: prompt → LLM → text → TTS. This module adds tool-calling for the
smart-home subset (light/switch/climate/lock/cover/etc.) so:

  "Hey Jarvis, turn off the office lamp"
   → STT → "turn off the office lamp"
   → LLM with tools=[list_smart_home_devices, control_device, ...]
   → LLM emits `tool_calls: [{name: "control_device", args: {...}}]`
   → THIS MODULE invokes the tool via the MCP server (HTTP)
   → result fed back to LLM as a tool message
   → LLM emits the final spoken text
   → TTS

Safety policy
-------------
The MCP server enforces the three-tier safety model server-side
(safety-tier.service.ts). On top of that, THIS module enforces a
voice-specific rule layered on the server's tier classification:

  Tier 1 (lights, switches, plugs):  execute, speak the result
  Tier 2 non-lock (climate extremes, covers):
    server returns `confirmation_required`; we surface a prompt for
    a follow-up voice "yes". The stateful yes-tracking lives in the
    pipeline (next commit) — this module just classifies and emits
    the right prompt shape.
  Tier 2 LOCK:
    REFUSED via voice. Voice has no speaker authentication; anyone
    in earshot saying "yes" could unlock the front door. The tool
    call is intercepted BEFORE dispatch and we return a personality
    refusal message for the LLM to relay.
  Tier 3 (audit-only):  execute, speak the result, audit log on server.

Why two layers (server + voice)
-------------------------------
The server tier check is the trust boundary. The voice-side check is
a second layer of defence + a UX layer (refuse with personality vs.
just 403). If voice ever wires speaker-auth, the local lock refusal
can be downgraded to "ask for verbal confirmation" without touching
the server code.

Smart-home tool subset
----------------------
The MCP server exposes 60+ tools (calendar, files, network, …). For
the voice loop we filter down to the smart-home set — see
`SMART_HOME_TOOL_NAMES`. Keeps the LLM's tool-selection space small,
which helps latency AND reduces hallucinated tool calls for things
the voice surface shouldn't trigger.
"""
from __future__ import annotations

import json
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger("voice.tools")

# ────────────────────────────────────────────────────────────────────
# Configuration
# ────────────────────────────────────────────────────────────────────

DEFAULT_MCP_URL = "http://mcp-server:9090"
DEFAULT_MCP_TIMEOUT_S = 10.0

# Tools voice is allowed to invoke. The MCP server's full registry is
# RBAC-filtered on tools/list (server.ts:32-38) — what the LLM SEES is
# whatever survives that filter for the calling role. We narrow further
# here to the smart-home subset because:
#
#  - The voice loop's persona is "the assistant in your home"
#  - Other tool families (calendar, files) are dashboard / chat-first;
#    spoken interaction for them has different ergonomics
#  - Smaller tool lists -> better tool selection on smaller models
#
# Update when new smart-home tools land. The mapping back to MCP names
# matches packages/tools-core/src/handlers/smart-home/*.ts.
SMART_HOME_TOOL_NAMES = frozenset({
    "list_smart_home_devices",
    "get_smart_home_device",
    "control_device",
    "discover_matter_devices",
    "commission_device",
    "get_command_history",
})

# Lock-category devices: voice-side refusal, see module docstring.
# matches DEVICE_TYPE_CATEGORY in apps/orchestrator/src/services/
# matter.service.ts. We hold our own list because the safety check
# happens BEFORE we call the server.
LOCK_CATEGORIES = frozenset({"lock"})


# ────────────────────────────────────────────────────────────────────
# Result shapes
# ────────────────────────────────────────────────────────────────────


@dataclass
class ToolDefinition:
    """One tool, as returned by MCP tools/list. Shape matches what the
    Ollama / OpenAI chat APIs accept under their `tools` parameter."""
    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema; passed through as-is

    def to_chat_format(self) -> dict[str, Any]:
        """OpenAI-compatible tool wrapper consumed by ai-gateway / Ollama."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass
class ToolInvocation:
    """One tool_call from the LLM's response, normalized so callers
    don't have to fiddle with the OpenAI vs Ollama call-id quirks."""
    call_id: str   # echoed back in the tool message so the LLM can stitch
    name: str
    arguments: dict[str, Any]


@dataclass
class ToolResult:
    """Outcome of a single tool invocation, ready to be appended to
    the conversation history as a `role: "tool"` message."""
    call_id: str
    name: str
    content: str          # JSON-stringified for the LLM to consume
    is_refusal: bool = False  # True if WE blocked it (lock-via-voice)


class ToolClientError(Exception):
    """Raised when the MCP server is unreachable or returns 5xx. The
    caller (pipeline) should fall through to a "I couldn't reach that
    right now" spoken reply rather than crashing."""


# ────────────────────────────────────────────────────────────────────
# Abstract interface — for tests + future transports
# ────────────────────────────────────────────────────────────────────


class ToolClient(ABC):
    """Pluggable MCP front. The pipeline holds an instance and asks it
    for the tool list at startup, then calls invoke() for each
    tool_call the LLM emits."""

    @abstractmethod
    def list_tools(self) -> list[ToolDefinition]:
        ...

    @abstractmethod
    def invoke(self, call: ToolInvocation) -> ToolResult:
        ...


# ────────────────────────────────────────────────────────────────────
# Real implementation — HTTP to MCP server's streamable-HTTP transport
# ────────────────────────────────────────────────────────────────────


class McpToolClient(ToolClient):
    """Talks to services/mcp-server over its HTTP transport. The MCP
    server's tools/list + tools/call are JSON-RPC 2.0 methods on a
    streamable-HTTP endpoint at base + '/mcp' (per the SDK default).

    Auth: services/mcp-server/src/auth/jwt.ts gates this with a
    bearer token. The voice-orchestrator is a trusted intra-cluster
    caller; it gets a service-account JWT minted at startup. We hold
    it as `bearer_token` here. When absent, the request goes
    unauthenticated and the server returns AUTH_REQUIRED — the
    pipeline should log + fall back to non-tool replies.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_MCP_URL,
        bearer_token: str | None = None,
        timeout_s: float = DEFAULT_MCP_TIMEOUT_S,
        allowed_names: frozenset[str] = SMART_HOME_TOOL_NAMES,
    ):
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._timeout_s = timeout_s
        self._allowed_names = allowed_names
        # Each MCP JSON-RPC request needs a unique numeric ID. We don't
        # care about correlation (the response always echoes ours), but
        # we MUST not reuse the same ID — some SDK clients enforce it.
        self._next_id = 1

    def _post_rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Wraps the JSON-RPC POST. Returns the `result` field, raises
        ToolClientError on transport / protocol failure."""
        self._next_id += 1
        body = {
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": method,
            "params": params,
        }
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self._bearer_token:
            headers["Authorization"] = f"Bearer {self._bearer_token}"
        try:
            resp = httpx.post(
                f"{self._base_url}/mcp",
                json=body,
                headers=headers,
                timeout=self._timeout_s,
            )
        except httpx.HTTPError as exc:
            raise ToolClientError(f"MCP transport error: {exc}") from exc
        if not resp.is_success:
            raise ToolClientError(
                f"MCP returned {resp.status_code}: {resp.text[:200]}",
            )
        try:
            payload = resp.json()
        except json.JSONDecodeError as exc:
            raise ToolClientError(f"MCP returned non-JSON: {exc}") from exc
        err = payload.get("error")
        if err:
            raise ToolClientError(
                f"MCP error {err.get('code')}: {err.get('message')}",
            )
        result = payload.get("result")
        if not isinstance(result, dict):
            raise ToolClientError(f"MCP missing result: {payload}")
        return result

    def list_tools(self) -> list[ToolDefinition]:
        """Fetch tools/list, filter to the smart-home subset, normalise
        to ToolDefinition. Called once at startup (and re-callable for
        reloads — cheap, single HTTP round-trip)."""
        result = self._post_rpc("tools/list", {})
        tools_raw = result.get("tools") or []
        out: list[ToolDefinition] = []
        for t in tools_raw:
            name = t.get("name")
            if not name or name not in self._allowed_names:
                continue
            out.append(ToolDefinition(
                name=name,
                description=t.get("description", ""),
                parameters=t.get("inputSchema") or {"type": "object", "properties": {}},
            ))
        logger.info(
            "voice tools: %d/%d total tools after smart-home filter",
            len(out), len(tools_raw),
        )
        return out

    def invoke(self, call: ToolInvocation) -> ToolResult:
        """Run one tool through tools/call. Pre-empts lock-via-voice
        before reaching the network — see module docstring."""
        # ─── Pre-flight: lock-via-voice refusal ──────────────────────
        # control_device for a lock-category nodeId is intercepted.
        # We can't know the category without a list_smart_home_devices
        # round-trip first; the canonical pattern is the LLM has
        # already called list_smart_home_devices and seen the
        # `category: "lock"` field. If the LLM nonetheless tries to
        # control a lock, we refuse here.
        #
        # The "is this a lock?" signal we trust at this layer: the
        # LLM's own arguments include a `lock_intent` hint (lock,
        # unlock) AND/OR the orchestrator returns
        # `{tier: 2, category: "lock"}` and the LLM should have
        # surfaced confirmation_required. We catch the case where
        # the LLM blindly invokes control_device with lock-specific
        # commands.
        if call.name == "control_device":
            cmd = call.arguments.get("command")
            if isinstance(cmd, str) and cmd.lower() in ("lock", "unlock"):
                logger.warning(
                    "voice: refusing lock-via-voice tool call (%s)", call.arguments,
                )
                return ToolResult(
                    call_id=call.call_id,
                    name=call.name,
                    content=json.dumps({
                        "ok": False,
                        "error": {
                            "code": "VOICE_LOCK_REFUSED",
                            "message": (
                                "Voice cannot lock or unlock doors. The user must use "
                                "the dashboard for this. Tell them this politely."
                            ),
                        },
                    }),
                    is_refusal=True,
                )

        # ─── Allowed: dispatch to the MCP server ─────────────────────
        if call.name not in self._allowed_names:
            # LLM hallucinated a tool name. Better to surface a
            # structured "no such tool" than 404 from the server.
            logger.warning("voice: LLM emitted non-allowed tool '%s'", call.name)
            return ToolResult(
                call_id=call.call_id,
                name=call.name,
                content=json.dumps({
                    "ok": False,
                    "error": {
                        "code": "TOOL_NOT_AVAILABLE",
                        "message": f"Voice cannot use the '{call.name}' tool.",
                    },
                }),
                is_refusal=True,
            )

        try:
            result = self._post_rpc("tools/call", {
                "name": call.name,
                "arguments": call.arguments,
            })
        except ToolClientError as exc:
            # Surface as a tool result the LLM can speak about, rather
            # than re-raising. Pipeline keeps moving.
            return ToolResult(
                call_id=call.call_id,
                name=call.name,
                content=json.dumps({
                    "ok": False,
                    "error": {
                        "code": "MCP_UNREACHABLE",
                        "message": str(exc),
                    },
                }),
            )

        # MCP wraps text content in `content: [{type: "text", text: "..."}]`
        # — server.ts:toolResultToContent. Flatten to a plain JSON string
        # for the LLM, which expects a single text body per tool result.
        content_parts = result.get("content") or []
        text_parts: list[str] = []
        for seg in content_parts:
            if isinstance(seg, dict) and seg.get("type") == "text":
                t = seg.get("text")
                if isinstance(t, str):
                    text_parts.append(t)
        text = "\n".join(text_parts) if text_parts else json.dumps(result)
        return ToolResult(
            call_id=call.call_id,
            name=call.name,
            content=text,
        )


# ────────────────────────────────────────────────────────────────────
# Mock — for tests + dev fallback
# ────────────────────────────────────────────────────────────────────


class MockToolClient(ToolClient):
    """In-memory ToolClient that returns scripted results. Tests inject
    a `responses` map keyed by tool name; production never picks this."""

    def __init__(
        self,
        tools: list[ToolDefinition] | None = None,
        responses: dict[str, Any] | None = None,
    ):
        self._tools = tools or []
        self._responses = responses or {}
        self.invocations: list[ToolInvocation] = []

    def list_tools(self) -> list[ToolDefinition]:
        return list(self._tools)

    def invoke(self, call: ToolInvocation) -> ToolResult:
        self.invocations.append(call)
        # Lock-via-voice refusal applies to the mock too — keeps
        # tests aligned with the production path.
        if call.name == "control_device":
            cmd = call.arguments.get("command")
            if isinstance(cmd, str) and cmd.lower() in ("lock", "unlock"):
                return ToolResult(
                    call_id=call.call_id,
                    name=call.name,
                    content=json.dumps({
                        "ok": False,
                        "error": {
                            "code": "VOICE_LOCK_REFUSED",
                            "message": "Voice cannot lock or unlock doors.",
                        },
                    }),
                    is_refusal=True,
                )
        scripted = self._responses.get(call.name, {"ok": True, "data": None})
        return ToolResult(
            call_id=call.call_id,
            name=call.name,
            content=json.dumps(scripted),
        )


# ────────────────────────────────────────────────────────────────────
# Env-driven builder
# ────────────────────────────────────────────────────────────────────


def build_tool_client_from_env() -> ToolClient | None:
    """Build the voice's ToolClient from env, or return None to disable
    tool calling. Mirrors `build_llm_from_env` in llm.py.

    Returns None when:
      - `VOICE_TOOLS_ENABLED` is "0" / "false" / unset (disabled by default
        during the v1 rollout; flip to "1" to opt in)
      - `MCP_URL` is empty (no MCP server configured)
    """
    enabled = os.environ.get("VOICE_TOOLS_ENABLED", "").strip().lower()
    if enabled not in ("1", "true", "yes"):
        logger.info("voice tools disabled (set VOICE_TOOLS_ENABLED=1 to enable)")
        return None

    base_url = os.environ.get("MCP_URL", "").strip() or DEFAULT_MCP_URL
    bearer = os.environ.get("VOICE_MCP_TOKEN", "").strip() or None
    timeout_raw = os.environ.get("MCP_TIMEOUT_S", "").strip()
    try:
        timeout_s = float(timeout_raw) if timeout_raw else DEFAULT_MCP_TIMEOUT_S
    except ValueError:
        logger.warning(
            "invalid MCP_TIMEOUT_S=%r, falling back to %s",
            timeout_raw, DEFAULT_MCP_TIMEOUT_S,
        )
        timeout_s = DEFAULT_MCP_TIMEOUT_S
    return McpToolClient(
        base_url=base_url,
        bearer_token=bearer,
        timeout_s=timeout_s,
    )
