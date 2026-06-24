"""Abstract provider interface for AI backends."""

from abc import ABC, abstractmethod


def to_litellm_messages(messages: list) -> list[dict]:
    """Serialize ChatMessage objects to LiteLLM/OpenAI dicts.

    Preserves multimodal `content` block lists (e.g. image_url) by dumping each
    block to a plain dict; plain-string content passes through unchanged. Used
    by the cloud providers so image blocks reach LiteLLM intact instead of being
    flattened away.
    """
    out: list[dict] = []
    for m in messages:
        content = m.content
        if isinstance(content, list):
            content = [
                b.model_dump(exclude_none=True) if hasattr(b, "model_dump") else b
                for b in content
            ]
        out.append({"role": m.role, "content": content})
    return out


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
