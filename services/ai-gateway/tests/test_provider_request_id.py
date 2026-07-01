import sys
import types
import pytest

from request_context import set_request_id
from schemas import ChatMessage


@pytest.mark.anyio
async def test_anthropic_passes_request_id_extra_header(monkeypatch):
    captured = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)
        class R:
            def model_dump(self):
                return {"ok": True}
        return R()

    fake_litellm = types.ModuleType("litellm")
    fake_litellm.acompletion = fake_acompletion
    monkeypatch.setitem(sys.modules, "litellm", fake_litellm)

    from providers.anthropic_cloud import AnthropicCloudProvider

    set_request_id("prov-rid-9")
    provider = AnthropicCloudProvider(api_key="sk-test")
    await provider.chat([ChatMessage(role="user", content="hi")], "claude-3-5-haiku-20241022")

    assert captured.get("extra_headers", {}).get("x-request-id") == "prov-rid-9"
