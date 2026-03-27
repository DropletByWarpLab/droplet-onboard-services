"""Pydantic models for AI Gateway request/response contracts."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field


# --- Chat ---


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"] = "user"
    content: str


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    stream: bool = False
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = None
    provider: str | None = None  # explicit provider override


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
