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
        d: dict = {"role": m.role, "content": content}
        # Preserve the agent-loop replay fields. The orchestrator re-POSTs the
        # whole message array each ReAct iteration: the assistant turn carries
        # `tool_calls`, and the following role="tool" results carry
        # `tool_call_id`. OpenAI/Anthropic REQUIRE tool_call_id on tool messages
        # and tool_calls on the assistant turn that issued them, so dropping
        # these (as this function previously did) desyncs / 400s the cloud agent
        # loop. The local Ollama path already keeps them via model_dump.
        tool_calls = getattr(m, "tool_calls", None)
        if tool_calls:
            d["tool_calls"] = [
                tc.model_dump(exclude_none=True) if hasattr(tc, "model_dump") else tc
                for tc in tool_calls
            ]
        tool_call_id = getattr(m, "tool_call_id", None)
        if tool_call_id:
            d["tool_call_id"] = tool_call_id
        out.append(d)
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
