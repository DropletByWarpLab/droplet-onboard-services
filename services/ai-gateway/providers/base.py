"""Abstract provider interface for AI backends."""

from abc import ABC, abstractmethod


class BaseProvider(ABC):
    @abstractmethod
    async def chat(self, messages: list, model: str, stream: bool = False, **kwargs):
        """Send a chat completion request.

        kwargs may include:
            tools: list of tool definitions (OpenAI function calling format)
            temperature: float
            max_tokens: int
        """
        ...

    @abstractmethod
    async def list_models(self) -> list:
        """Return available models for this provider."""
        ...
