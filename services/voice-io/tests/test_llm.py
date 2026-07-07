"""WARP-154 — LLM bridge contract.

The contract these tests pin (per shared_brain
`projects/droplet-onboard-services/docs/LLM_AGENT.md`):

  - `OrchestratorLLM.available` GETs /api/orchestrator/health; returns
    False (not raise) on any transport or HTTP-error. /voice/status
    depends on this never throwing.
  - `reply()` POSTs /api/llm/chat with the right model + messages +
    stream:false + max_iter, parses the assistant text from the
    AgentResult shape (`{message: {content: "..."}, trace, iterations,
    stop_reason}`). Legacy ai-gateway/OpenAI shape still parses for
    dev configurations that override LLM_URL.
  - `reply("")` short-circuits with no network call.
  - HTTP errors raise LLMUnavailable with a readable detail.
  - The response-parser pulls the assistant text from both flat and
    segmented content shapes.
  - `MockLLM` records requests and replays scripted replies in order.
  - `build_llm_from_env` honours LLM_URL=__mock__ + http://, and
    propagates ORCHESTRATOR_TOKEN as a Bearer auth header.

We swap in `httpx.MockTransport` so we exercise httpx end-to-end
without a real network. No external orchestrator needed.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

import httpx
import pytest

from voice.llm import (
    DEFAULT_LLM_SYSTEM_PROMPT,
    DEFAULT_LLM_URL,
    LLMUnavailable,
    MockLLM,
    OrchestratorLLM,
    _extract_assistant_text,
    _extract_error_detail,
    build_llm_from_env,
    build_system_prompt,
)


# ────────────────────────────────────────────────────────────────────
# httpx.MockTransport plumbing
# ────────────────────────────────────────────────────────────────────

def _install_mock_transport(monkeypatch, handler) -> list:
    """Patch httpx.get/httpx.post to route through a MockTransport.

    OrchestratorLLM uses module-level `httpx.get` and `httpx.post`
    (not a long-lived client), so we replace those two functions with
    versions that use a MockTransport-backed Client. Captures every
    request for assertions.
    """
    captured: list[httpx.Request] = []

    def _record_and_handle(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_record_and_handle)
    client = httpx.Client(transport=transport)

    def _patched_get(url, **kwargs):
        return client.get(url, **kwargs)

    def _patched_post(url, **kwargs):
        return client.post(url, **kwargs)

    monkeypatch.setattr(httpx, "get", _patched_get)
    monkeypatch.setattr(httpx, "post", _patched_post)
    return captured


# ────────────────────────────────────────────────────────────────────
# OrchestratorLLM — reachability
# ────────────────────────────────────────────────────────────────────

class TestOrchestratorAvailable:
    def test_available_true_on_healthy_response(self, monkeypatch):
        def handler(req):
            assert req.url.path == "/api/orchestrator/health"
            return httpx.Response(200, json={"status": "ok"})
        _install_mock_transport(monkeypatch, handler)
        client = OrchestratorLLM(base_url="http://test")
        assert client.available is True

    def test_available_false_on_5xx(self, monkeypatch):
        def handler(req):
            return httpx.Response(503, json={"status": "down"})
        _install_mock_transport(monkeypatch, handler)
        assert OrchestratorLLM(base_url="http://test").available is False

    def test_available_false_on_transport_error(self, monkeypatch):
        def handler(req):
            raise httpx.ConnectError("connection refused")
        _install_mock_transport(monkeypatch, handler)
        assert OrchestratorLLM(base_url="http://test").available is False


# ────────────────────────────────────────────────────────────────────
# OrchestratorLLM — reply()
# ────────────────────────────────────────────────────────────────────

class TestOrchestratorReply:
    def test_reply_posts_to_chat_path_with_model_messages(self, monkeypatch):
        def handler(req):
            # Canonical path per LLM_AGENT.md.
            assert req.url.path == "/api/llm/chat"
            body = json.loads(req.content)
            assert body["model"] == "test-model"
            assert body["stream"] is False
            assert body["max_iter"] >= 1  # cap the agent loop
            assert body["messages"][0]["role"] == "system"
            assert body["messages"][1]["role"] == "user"
            assert body["messages"][1]["content"] == "what time is it"
            # AgentResult shape per shared_brain LLM_AGENT.md.
            return httpx.Response(
                200,
                json={
                    "message": {"role": "assistant", "content": "it is 3 pm"},
                    "trace": [],
                    "iterations": 1,
                    "stop_reason": "model_done",
                },
            )
        _install_mock_transport(monkeypatch, handler)
        client = OrchestratorLLM(base_url="http://test", model="test-model")
        assert client.reply("what time is it") == "it is 3 pm"

    def test_reply_handles_legacy_ai_gateway_shape(self, monkeypatch):
        # Some dev configs still point LLM_URL at ai-gateway directly.
        # The parser is intentionally back-compat: OpenAI choices[] shape
        # also works.
        def handler(req):
            return httpx.Response(200, json={
                "choices": [{"message": {"content": "legacy reply"}}],
            })
        _install_mock_transport(monkeypatch, handler)
        client = OrchestratorLLM(
            base_url="http://test", chat_path="/ai/chat",
        )
        assert client.reply("hi") == "legacy reply"

    def test_bearer_token_attached_when_set(self, monkeypatch):
        # The Bearer token IS the service-principal handshake the
        # orchestrator's authMiddleware matches against
        # SERVICE_TOKEN_VOICE — without it the request 401s.
        seen_auth: list[str] = []
        def handler(req):
            seen_auth.append(req.headers.get("authorization", ""))
            return httpx.Response(200, json={
                "message": {"role": "assistant", "content": "ok"},
            })
        _install_mock_transport(monkeypatch, handler)
        OrchestratorLLM(
            base_url="http://test", bearer_token="secret",
        ).reply("hi")
        assert seen_auth == ["Bearer secret"]

    def test_empty_user_text_short_circuits_no_network(self, monkeypatch):
        # Empty input shouldn't burn an orchestrator call. The wake loop
        # may misfire on noise and produce empty transcripts.
        captured = _install_mock_transport(
            monkeypatch, lambda r: httpx.Response(500),
        )
        result = OrchestratorLLM(base_url="http://test").reply("")
        assert result == ""
        assert captured == []

    def test_whitespace_only_text_also_short_circuits(self, monkeypatch):
        captured = _install_mock_transport(
            monkeypatch, lambda r: httpx.Response(500),
        )
        result = OrchestratorLLM(base_url="http://test").reply("   \n\t  ")
        assert result == ""
        assert captured == []

    def test_user_text_is_stripped(self, monkeypatch):
        seen: list[str] = []
        def handler(req):
            body = json.loads(req.content)
            seen.append(body["messages"][1]["content"])
            return httpx.Response(200, json={
                "message": {"role": "assistant", "content": "ok"},
                "trace": [], "iterations": 1, "stop_reason": "model_done",
            })
        _install_mock_transport(monkeypatch, handler)
        OrchestratorLLM(base_url="http://test").reply("  hello there  \n")
        assert seen == ["hello there"]

    def test_system_prompt_propagates(self, monkeypatch):
        # The base system prompt is the persona text. The time + location
        # footer is appended at reply() time (see TestBuildSystemPrompt).
        # We just check the base is the prefix here.
        seen_system: list[str] = []
        def handler(req):
            body = json.loads(req.content)
            seen_system.append(body["messages"][0]["content"])
            return httpx.Response(200, json={
                "message": {"role": "assistant", "content": "ok"},
                "trace": [], "iterations": 1, "stop_reason": "model_done",
            })
        _install_mock_transport(monkeypatch, handler)
        OrchestratorLLM(
            base_url="http://test", system_prompt="you are a tiny robot",
        ).reply("hi")
        assert len(seen_system) == 1
        assert seen_system[0].startswith("you are a tiny robot")


class TestOrchestratorReplyErrors:
    def test_transport_failure_raises_llmunavailable(self, monkeypatch):
        def handler(req):
            raise httpx.ConnectError("connection refused")
        _install_mock_transport(monkeypatch, handler)
        with pytest.raises(LLMUnavailable, match="failed"):
            OrchestratorLLM(base_url="http://test").reply("hi")

    def test_5xx_with_detail_surfaces_message(self, monkeypatch):
        def handler(req):
            return httpx.Response(500, json={"detail": "model not loaded"})
        _install_mock_transport(monkeypatch, handler)
        with pytest.raises(LLMUnavailable, match="model not loaded"):
            OrchestratorLLM(base_url="http://test").reply("hi")

    def test_non_json_body_handled(self, monkeypatch):
        def handler(req):
            return httpx.Response(200, content=b"not json at all")
        _install_mock_transport(monkeypatch, handler)
        with pytest.raises(LLMUnavailable):
            OrchestratorLLM(base_url="http://test").reply("hi")


# ────────────────────────────────────────────────────────────────────
# Response shape parsers
# ────────────────────────────────────────────────────────────────────

class TestExtractAssistantText:
    def test_openai_choices_shape(self):
        # ai-gateway returns this.
        payload = {"choices": [{"message": {"content": "hello"}}]}
        assert _extract_assistant_text(payload) == "hello"

    def test_orchestrator_message_shape(self):
        # Commit 7b's path returns this.
        payload = {"message": {"role": "assistant", "content": "hello"}}
        assert _extract_assistant_text(payload) == "hello"

    def test_segmented_text_content(self):
        # Some agent paths return content as a list of segments. We
        # only want the text segments concatenated.
        payload = {"message": {"content": [
            {"type": "text", "text": "first"},
            {"type": "tool_use", "name": "x"},
            {"type": "text", "text": "second"},
        ]}}
        assert _extract_assistant_text(payload) == "first second"

    def test_missing_message_returns_empty(self):
        # Don't crash on unexpected shapes; just speak nothing.
        assert _extract_assistant_text({}) == ""

    def test_strips_leading_trailing_whitespace(self):
        payload = {"choices": [{"message": {"content": "  hello there  \n"}}]}
        assert _extract_assistant_text(payload) == "hello there"

    def test_empty_choices_array_returns_empty(self):
        # Edge case: ai-gateway sometimes returns choices:[] on errors.
        assert _extract_assistant_text({"choices": []}) == ""

    def test_choices_with_no_message_returns_empty(self):
        # Malformed payload should not crash.
        assert _extract_assistant_text({"choices": [{}]}) == ""


class TestExtractErrorDetail:
    def test_pulls_detail_field(self):
        resp = httpx.Response(500, json={"detail": "model busy"})
        assert _extract_error_detail(resp) == "model busy"

    def test_pulls_error_field(self):
        resp = httpx.Response(500, json={"error": "rate-limited"})
        assert _extract_error_detail(resp) == "rate-limited"

    def test_falls_back_to_body_text(self):
        resp = httpx.Response(500, content=b"plain text error")
        assert "plain text error" in _extract_error_detail(resp)


# ────────────────────────────────────────────────────────────────────
# MockLLM
# ────────────────────────────────────────────────────────────────────

class TestMockLLM:
    def test_replays_scripted_replies_in_order(self):
        m = MockLLM(scripted_replies=["one", "two", "three"])
        assert m.reply("first") == "one"
        assert m.reply("second") == "two"
        assert m.reply("third") == "three"
        assert m.requests == ["first", "second", "third"]

    def test_returns_empty_after_script_exhausted(self):
        m = MockLLM(scripted_replies=["only"])
        m.reply("a")
        assert m.reply("b") == ""

    def test_echo_mode_returns_user_text(self):
        m = MockLLM(echo=True)
        assert m.reply("how are you") == "You said: how are you"

    def test_available_true_by_default(self):
        assert MockLLM().available is True

    def test_available_false_when_explicitly_set(self):
        assert MockLLM(available=False).available is False


# ────────────────────────────────────────────────────────────────────
# build_llm_from_env
# ────────────────────────────────────────────────────────────────────

@pytest.fixture
def stub_geo(monkeypatch):
    """Pin voice.geo.get_geo to the no-lookup fallback (WARP-1053).

    build_llm_from_env() resolves location via a LIVE ipapi.co lookup
    whenever DROPLET_LOCATION + TZ aren't both set — on a networked
    runner that returns the runner's real city (e.g. "Des Moines,
    Iowa, United States" on GitHub CI) and flakes any assertion on
    `_location`. Geo resolution itself is pinned hermetically in
    test_geo.py; these tests only care about the passthrough.
    """
    from voice import geo

    monkeypatch.setattr(
        geo, "get_geo",
        lambda: geo.GeoLocation(description=None, timezone="UTC", source="fallback"),
    )


class TestBuildLLMFromEnv:
    def test_default_uses_orchestrator_compose_dns(self, monkeypatch, stub_geo):
        for k in ("LLM_URL", "LLM_MODEL", "ORCHESTRATOR_TOKEN"):
            monkeypatch.delenv(k, raising=False)
        llm = build_llm_from_env()
        assert isinstance(llm, OrchestratorLLM)
        assert llm._base_url == DEFAULT_LLM_URL

    def test_mock_when_url_is_double_underscore_mock(self, monkeypatch):
        monkeypatch.setenv("LLM_URL", "__mock__")
        llm = build_llm_from_env()
        assert isinstance(llm, MockLLM)
        # echo mode so manual dev triggering shows something
        assert llm.reply("hi") == "You said: hi"

    def test_custom_url_propagates(self, monkeypatch, stub_geo):
        monkeypatch.setenv("LLM_URL", "http://other-host:1234")
        llm = build_llm_from_env()
        assert isinstance(llm, OrchestratorLLM)
        assert llm._base_url == "http://other-host:1234"

    def test_model_env_propagates(self, monkeypatch, stub_geo):
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("LLM_MODEL", "tinyllama:latest")
        llm = build_llm_from_env()
        assert llm._model == "tinyllama:latest"

    def test_orchestrator_token_propagates_to_authorization(self, monkeypatch, stub_geo):
        # Reuse the existing service-to-service auth secret.
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("ORCHESTRATOR_TOKEN", "shared-secret")
        llm = build_llm_from_env()
        assert isinstance(llm, OrchestratorLLM)
        assert llm._bearer_token == "shared-secret"

    def test_droplet_location_and_tz_env_propagate(self, monkeypatch):
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("DROPLET_LOCATION", "Greenwich, CT, USA")
        monkeypatch.setenv("TZ", "America/New_York")
        llm = build_llm_from_env()
        assert isinstance(llm, OrchestratorLLM)
        assert llm._location == "Greenwich, CT, USA"
        assert llm._timezone == "America/New_York"

    def test_missing_location_env_is_none_not_empty_string(self, monkeypatch, stub_geo):
        # A None location skips the "located in" line in the prompt
        # entirely. An empty string ("") would render as
        # "The Droplet is located in ." which is worse than silent.
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        llm = build_llm_from_env()
        assert llm._location is None
        assert llm._timezone == "UTC"


# ────────────────────────────────────────────────────────────────────
# Time + location context — system prompt builder
# ────────────────────────────────────────────────────────────────────

class TestBuildSystemPrompt:
    """The system prompt has to embed live time + location so the model
    can answer "what time is it?" / "what's the date?" / "what's the
    weather in our area?" without making up the answer. These tests
    pin that the placeholder + the values land where expected."""

    def test_includes_current_time_for_injected_now(self):
        now = datetime(2026, 5, 14, 21, 17, tzinfo=ZoneInfo("UTC"))
        prompt = build_system_prompt(
            "BASE", location=None, timezone="UTC", now=now,
        )
        assert "Right now it is" in prompt
        assert "May 14, 2026" in prompt
        assert "9:17 PM" in prompt  # 21:17 → 9:17 PM
        assert "Thursday" in prompt  # 2026-05-14 was a Thursday

    def test_omits_location_line_when_none(self):
        now = datetime(2026, 5, 14, 12, 0, tzinfo=ZoneInfo("UTC"))
        prompt = build_system_prompt(
            "BASE", location=None, timezone="UTC", now=now,
        )
        assert "located in" not in prompt

    def test_omits_location_line_when_empty_string(self):
        # Defensive: "" should be treated like None, not rendered as
        # "located in ." which is uglier than silent.
        now = datetime(2026, 5, 14, 12, 0, tzinfo=ZoneInfo("UTC"))
        prompt = build_system_prompt(
            "BASE", location="  ", timezone="UTC", now=now,
        )
        assert "located in" not in prompt

    def test_includes_location_when_set(self):
        now = datetime(2026, 5, 14, 12, 0, tzinfo=ZoneInfo("UTC"))
        prompt = build_system_prompt(
            "BASE", location="Greenwich, CT", timezone="UTC", now=now,
        )
        assert "located in Greenwich, CT" in prompt

    def test_converts_naive_now_to_target_timezone(self):
        # Naive datetime — should be treated as local-in-target-tz.
        naive = datetime(2026, 5, 14, 12, 0)
        prompt = build_system_prompt(
            "BASE", location=None, timezone="America/New_York", now=naive,
        )
        # Friendly format uses %Z which renders the TZ abbrev.
        assert "EDT" in prompt or "EST" in prompt

    def test_converts_aware_now_to_target_timezone(self):
        # UTC noon → 7 or 8 AM in New York depending on DST.
        utc_noon = datetime(2026, 5, 14, 12, 0, tzinfo=ZoneInfo("UTC"))
        prompt = build_system_prompt(
            "BASE", location=None, timezone="America/New_York", now=utc_noon,
        )
        # May → EDT → UTC-4, so 12:00 UTC → 08:00 EDT.
        assert "8:00 AM" in prompt
        assert "Thursday" in prompt  # date doesn't shift either way

    def test_unknown_timezone_falls_back_to_utc(self):
        now = datetime(2026, 5, 14, 12, 0, tzinfo=ZoneInfo("UTC"))
        # "Mars/Olympus" isn't an IANA zone — should fall back to UTC
        # silently rather than crash the LLM call.
        prompt = build_system_prompt(
            "BASE", location=None, timezone="Mars/Olympus", now=now,
        )
        assert "UTC" in prompt
        assert "Right now it is" in prompt

    def test_explicit_instruction_to_use_the_time(self):
        # Without an explicit instruction, smaller models often respond
        # with "I don't have access to the current time" even when the
        # time IS in their system prompt. Make the steer overt.
        prompt = build_system_prompt(
            "BASE", location="X", timezone="UTC",
            now=datetime(2026, 5, 14, 12, 0, tzinfo=ZoneInfo("UTC")),
        )
        assert "do not say you don't have access" in prompt.lower()

    def test_base_prompt_is_preserved_intact_at_top(self):
        prompt = build_system_prompt(
            "You are X.",
            location="Y", timezone="UTC",
            now=datetime(2026, 5, 14, 12, 0, tzinfo=ZoneInfo("UTC")),
        )
        assert prompt.startswith("You are X.\n\n")


class TestDefaultPersona:
    """The default persona must self-carry the identity essentials:
    the intent-gated tool_choice="none" path (greetings, "who are
    you?") skips the orchestrator's base system prompt entirely, so
    those turns answer from DEFAULT_LLM_SYSTEM_PROMPT alone. These
    pins protect the identity + spoken-delivery contract from a
    well-meaning copy edit."""

    def test_identity_names_droplet(self):
        assert "You're Droplet" in DEFAULT_LLM_SYSTEM_PROMPT

    def test_identity_states_local_privacy(self):
        assert "not a cloud service" in DEFAULT_LLM_SYSTEM_PROMPT
        assert "stays right here in the house" in DEFAULT_LLM_SYSTEM_PROMPT

    def test_spoken_delivery_constraints_present(self):
        # Every reply is read aloud by Piper — markdown and lists
        # turn into gibberish on the speaker.
        assert "No markdown" in DEFAULT_LLM_SYSTEM_PROMPT
        assert "read aloud" in DEFAULT_LLM_SYSTEM_PROMPT
        assert "one short spoken sentence" in DEFAULT_LLM_SYSTEM_PROMPT

    def test_warm_housemate_tone_present(self):
        assert "housemate" in DEFAULT_LLM_SYSTEM_PROMPT
        assert "warmly" in DEFAULT_LLM_SYSTEM_PROMPT

    def test_read_only_honesty_present(self):
        # ADR-015 is not implemented yet — voice is read-only and the
        # persona must say where changes actually happen.
        assert "(read-only)" in DEFAULT_LLM_SYSTEM_PROMPT
        assert "dashboard" in DEFAULT_LLM_SYSTEM_PROMPT


class TestSystemPromptWiringIntoReply:
    """End-to-end: when reply() sends a request to the LLM endpoint,
    the system message has the time + location baked in."""

    def test_reply_sends_enriched_system_prompt(self, monkeypatch):
        captured_system: list[str] = []
        def handler(req):
            body = json.loads(req.content)
            captured_system.append(body["messages"][0]["content"])
            return httpx.Response(200, json={
                "message": {"role": "assistant", "content": "ok"},
                "trace": [], "iterations": 1, "stop_reason": "model_done",
            })
        _install_mock_transport(monkeypatch, handler)
        fixed_now = datetime(2026, 5, 14, 21, 17, tzinfo=ZoneInfo("UTC"))
        llm = OrchestratorLLM(
            base_url="http://test",
            location="Greenwich, CT",
            timezone="America/New_York",
            now_provider=lambda: fixed_now,
        )
        llm.reply("hi")
        assert len(captured_system) == 1
        prompt = captured_system[0]
        # Time present + location present + tz-converted (UTC 21:17 → EDT 17:17)
        assert "5:17 PM" in prompt
        assert "Greenwich, CT" in prompt
        assert "EDT" in prompt

    def test_each_reply_gets_fresh_time(self, monkeypatch):
        # No tickless caching of the system prompt — every call resamples
        # the clock so a long-lived service stays accurate.
        captured: list[str] = []
        def handler(req):
            body = json.loads(req.content)
            captured.append(body["messages"][0]["content"])
            return httpx.Response(200, json={
                "message": {"role": "assistant", "content": "ok"},
                "trace": [], "iterations": 1, "stop_reason": "model_done",
            })
        _install_mock_transport(monkeypatch, handler)
        times = iter([
            datetime(2026, 5, 14, 12, 0, tzinfo=ZoneInfo("UTC")),
            datetime(2026, 5, 14, 13, 0, tzinfo=ZoneInfo("UTC")),
        ])
        llm = OrchestratorLLM(
            base_url="http://test",
            timezone="UTC",
            now_provider=lambda: next(times),
        )
        llm.reply("a")
        llm.reply("b")
        assert "12:00 PM" in captured[0]
        assert "1:00 PM" in captured[1]
