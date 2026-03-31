"""Pydantic models for AI Gateway request/response contracts."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field


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
    content: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None  # for role="tool" messages


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    stream: bool = False
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = None
    provider: str | None = None  # explicit provider override
    tools: list[ToolDefinition] | None = None


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
    message: str
    stream: bool = False
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = None
    provider: str | None = None
