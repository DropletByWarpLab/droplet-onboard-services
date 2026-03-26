"""Abstract provider interface for AI backends."""

from abc import ABC, abstractmethod


class BaseProvider(ABC):
    @abstractmethod
    async def chat(self, messages: list, model: str, stream: bool = False):
        """Send a chat completion request."""
        ...

    @abstractmethod
    async def list_models(self) -> list:
        """Return available models for this provider."""
        ...
