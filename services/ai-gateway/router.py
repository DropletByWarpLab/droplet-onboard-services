"""Routes inference requests to the correct provider (local Ollama, Anthropic, OpenAI).

Supports tool calling: when the model returns tool_calls, the router executes
them via the ToolExecutor and re-prompts the model with results, looping until
the model produces a final text response (max 10 iterations).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator

from auth.byok import get_api_key
from providers.anthropic_cloud import AnthropicCloudProvider
from providers.ollama_local import OllamaLocalProvider
from providers.openai_cloud import OpenAICloudProvider
from providers.base import BaseProvider
from schemas import ChatMessage, ChatRequest, ModelInfo
from tools.executor import execute_tool

logger = logging.getLogger(__name__)

# Model name prefix → provider mapping
PROVIDER_PREFIXES = {
    "ollama": ["llama", "mistral", "phi", "gemma", "qwen", "codellama", "deepseek"],
    "anthropic": ["claude"],
    "openai": ["gpt", "o1", "o3"],
}


class ProviderRouter:
    """Resolves model names to providers and delegates inference."""

    def __init__(self):
        self.ollama = OllamaLocalProvider()
        self.anthropic = AnthropicCloudProvider()
        self.openai = OpenAICloudProvider()
        self._providers: dict[str, BaseProvider] = {
            "ollama": self.ollama,
            "anthropic": self.anthropic,
            "openai": self.openai,
        }

    async def refresh_keys(self):
        """Reload API keys from the BYOK keystore."""
        anthropic_key = await get_api_key("anthropic")
        openai_key = await get_api_key("openai")
        self.anthropic = AnthropicCloudProvider(api_key=anthropic_key)
        self.openai = OpenAICloudProvider(api_key=openai_key)
        self._providers["anthropic"] = self.anthropic
        self._providers["openai"] = self.openai

    def resolve_provider(self, model: str, explicit_provider: str | None = None) -> BaseProvider:
        """Resolve which provider handles the given model."""
        if explicit_provider and explicit_provider in self._providers:
            return self._providers[explicit_provider]

        model_lower = model.lower()
        for provider_name, prefixes in PROVIDER_PREFIXES.items():
            if any(model_lower.startswith(p) for p in prefixes):
                return self._providers[provider_name]

        # Default to Ollama (local-first)
        return self.ollama

    async def list_all_models(self) -> list[ModelInfo]:
        """Query all providers for available models concurrently."""
        await self.refresh_keys()
        tasks = [provider.list_models() for provider in self._providers.values()]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        models: list[ModelInfo] = []
        for provider_name, result in zip(self._providers.keys(), results):
            if isinstance(result, Exception):
                logger.warning("Failed to list models from %s: %s", provider_name, result)
            else:
                models.extend(result)
        return models

    async def chat(self, request: ChatRequest) -> dict | AsyncGenerator[str, None]:
        """Route a chat request to the appropriate provider.

        If tools are provided and the model returns tool_calls, executes them
        and re-prompts until the model produces a final text response.
        Tool calling only works in non-streaming mode.
        """
        await self.refresh_keys()
        provider = self.resolve_provider(request.model, request.provider)

        kwargs = dict(
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )
        if request.tools:
            kwargs["tools"] = request.tools

        # If no tools or streaming, do a simple single call
        if not request.tools or request.stream:
            return await provider.chat(
                messages=request.messages,
                model=request.model,
                stream=request.stream,
                **kwargs,
            )

        # Tool calling loop (non-streaming only)
        messages = list(request.messages)
        max_iterations = 10

        for iteration in range(max_iterations):
            result = await provider.chat(
                messages=messages,
                model=request.model,
                stream=False,
                **kwargs,
            )

            # Check if the model wants to call tools
            choice = result.get("choices", [{}])[0]
            message = choice.get("message", {})
            tool_calls = message.get("tool_calls")

            if not tool_calls:
                # No tool calls — final response
                return result

            logger.info(
                "Tool call iteration %d: %d tool(s) requested",
                iteration + 1,
                len(tool_calls),
            )

            # Append assistant message with tool calls to conversation
            messages.append(ChatMessage(
                role="assistant",
                content=message.get("content"),
                tool_calls=[
                    {"id": tc["id"], "type": "function", "function": tc["function"]}
                    for tc in tool_calls
                ],
            ))

            # Execute each tool call and append results
            for tc in tool_calls:
                func = tc.get("function", {})
                tool_name = func.get("name", "")
                try:
                    tool_args = json.loads(func.get("arguments", "{}"))
                except json.JSONDecodeError:
                    tool_args = {}

                logger.info("Executing tool: %s(%s)", tool_name, tool_args)
                tool_result = await execute_tool(tool_name, tool_args)

                messages.append(ChatMessage(
                    role="tool",
                    content=tool_result,
                    tool_call_id=tc["id"],
                ))

        # Max iterations reached — return last result
        logger.warning("Tool calling reached max iterations (%d)", max_iterations)
        return result

    async def close(self):
        await self.ollama.close()
