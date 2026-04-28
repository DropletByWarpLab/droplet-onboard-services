"""Pydantic models for AI Gateway request/response contracts.

The Tool* classes below are retained for OpenAI-passthrough validation:
the orchestrator's agent loop forwards `tools[]` and `tool_calls[]` /
`tool_call_id` on replayed messages through the gateway, and the gateway
must validate the request shape before forwarding it to a provider.
The gateway itself does not execute tools — see router.py.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field, model_validator


# --- Chat ---


class ToolFunction(BaseModel):
    name: str
    description: str
    parameters: dict = Field(default_factory=dict)


class ToolDefinition(BaseModel):
    type: Literal["function"] = "function"
    function: ToolFunction


class FunctionCall(BaseModel):
    name: str
    arguments: str  # JSON string


class ToolCall(BaseModel):
    id: str
    type: Literal["function"] = "function"
    function: FunctionCall


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"] = "user"
    content: str | None = Field(default=None, max_length=32_000)
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None  # for role="tool" messages


# Total content size across all messages in a request. Prevents a client from
# sending 100 messages × 32k chars (= 3.2MB). The per-message cap is 32k; the
# sum across messages is capped here at 128k which is enough for long chats.
_MAX_TOTAL_CONTENT_CHARS = 128_000


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage] = Field(..., min_length=1, max_length=100)
    stream: bool = False
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=4096)
    provider: str | None = None  # explicit provider override
    tools: list[ToolDefinition] | None = None

    @model_validator(mode="after")
    def _validate_total_content(self) -> "ChatRequest":
        total = sum(len(m.content or "") for m in self.messages)
        if total > _MAX_TOTAL_CONTENT_CHARS:
            raise ValueError(
                f"Total message content exceeds {_MAX_TOTAL_CONTENT_CHARS} characters"
            )
        return self


class ChatChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: str | None = "stop"


class ChatUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex[:12]}")
    object: str = "chat.completion"
    model: str
    choices: list[ChatChoice]
    usage: ChatUsage = ChatUsage()


class ChatChunkDelta(BaseModel):
    role: str | None = None
    content: str | None = None


class ChatChunkChoice(BaseModel):
    index: int = 0
    delta: ChatChunkDelta
    finish_reason: str | None = None


class ChatChunk(BaseModel):
    id: str
    object: str = "chat.completion.chunk"
    model: str
    choices: list[ChatChunkChoice]


# --- Models ---


class ModelInfo(BaseModel):
    id: str
    provider: str
    name: str
    context_window: int | None = None


class ModelsResponse(BaseModel):
    models: list[ModelInfo]


# --- Keys ---


class ApiKeyRequest(BaseModel):
    api_key: str


class KeyStatusResponse(BaseModel):
    providers: list[str]


# --- Sessions ---


class SessionCreateRequest(BaseModel):
    model: str
    title: str = ""
    system_prompt: str | None = None


class SessionUpdateRequest(BaseModel):
    title: str


class SessionMessageOut(BaseModel):
    role: str
    content: str
    timestamp: float


class SessionOut(BaseModel):
    id: str
    title: str
    model: str
    created_at: float
    updated_at: float
    message_count: int
    system_prompt: str | None = None


class SessionDetailOut(SessionOut):
    messages: list[SessionMessageOut]


class SessionListResponse(BaseModel):
    sessions: list[SessionOut]


class SessionChatRequest(BaseModel):
    """Chat within an existing session — messages are auto-appended."""
    message: str = Field(..., min_length=1, max_length=32_000)
    stream: bool = False
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=4096)
    provider: str | None = None
