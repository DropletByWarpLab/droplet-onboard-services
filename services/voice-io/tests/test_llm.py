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

import voice.llm
from voice.llm import (
    DEFAULT_LLM_SYSTEM_PROMPT,
    DEFAULT_LLM_URL,
    DEFAULT_VOICE_ALLOWED_TOOLS,
    DEFAULT_VOICE_MAX_TOKENS,
    LLMUnavailable,
    MockLLM,
    OrchestratorLLM,
    _extract_assistant_text,
    _extract_error_detail,
    build_llm_from_env,
    build_system_prompt,
    parse_allowed_tools,
    parse_max_tokens,
)


# ────────────────────────────────────────────────────────────────────
# httpx.MockTransport plumbing
# ────────────────────────────────────────────────────────────────────

def _install_mock_transport(monkeypatch, handler) -> list:
    """Route the OrchestratorLLM's POOLED client through a MockTransport.

    WARP-1433: OrchestratorLLM builds ONE `httpx.Client` via
    `voice.llm._new_httpx_client()` and reuses it across
    available()/reply()/reply_stream(). Patching the factory so it returns a
    MockTransport-backed client makes every hop route through our handler —
    no real network. Captures every request for assertions.
    """
    captured: list[httpx.Request] = []

    def _record_and_handle(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_record_and_handle)
    monkeypatch.setattr(
        voice.llm, "_new_httpx_client",
        lambda: httpx.Client(transport=transport),
    )
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


# ────────────────────────────────────────────────────────────────────
# WARP-1432 — voice turn shaping (ephemeral + max_tokens + allowed_tools)
# ────────────────────────────────────────────────────────────────────
#
# Every non-greeting voice turn used to inherit the full ~43-tool
# `_service:voice` set (~5k tokens of schema prefill) and mint a
# throwaway ChatSession. These pin the three client-side request-shape
# changes: `ephemeral:true` on every turn, a `max_tokens` cap, and a
# curated `allowed_tools` scope that cuts the prefill long tail. The
# orchestrator's chatRequestSchema already accepts all three
# (apps/orchestrator/src/routes/llm.ts) — this is purely about voice-io
# SENDING them.

def _capture_chat_body(monkeypatch) -> dict:
    """Route reply() through a mock transport and hand back the parsed
    POST body of the chat call (the last non-health request)."""
    bodies: list[dict] = []

    def handler(req):
        if req.url.path == "/api/orchestrator/health":
            return httpx.Response(200, json={"status": "ok"})
        bodies.append(json.loads(req.content))
        return httpx.Response(200, json={
            "message": {"role": "assistant", "content": "ok"},
            "trace": [], "iterations": 1, "stop_reason": "model_done",
        })

    _install_mock_transport(monkeypatch, handler)
    return bodies


class TestEphemeralAlwaysSent:
    """`ephemeral:true` is dead-safe and high-value: without it every
    utterance mints a throwaway ChatSession + litters the chat sidebar
    (routes/llm.ts:872). Voice must ALWAYS send it — on tool turns AND
    on the greeting fast path."""

    def test_reply_sends_ephemeral_true_on_tool_turn(self, monkeypatch):
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test").reply("is the front camera online?")
        assert bodies[0]["ephemeral"] is True

    def test_reply_sends_ephemeral_true_on_greeting(self, monkeypatch):
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test").reply(
            "good morning", tool_choice="none",
        )
        assert bodies[0]["ephemeral"] is True


class TestMaxTokensCap:
    """A `max_tokens` cap prevents runaway generation. gpt-oss:20b spends
    reasoning-channel tokens BEFORE visible content, so the default must
    be generous enough to cover reasoning + a short spoken answer (too
    low → empty completion, WARP-854)."""

    def test_reply_sends_default_max_tokens(self, monkeypatch):
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test").reply("what time is it")
        assert bodies[0]["max_tokens"] == DEFAULT_VOICE_MAX_TOKENS

    def test_max_tokens_is_generous_but_within_gateway_bound(self):
        # ai-gateway/orchestrator hard-cap max_tokens at 4096 (routes/
        # llm.ts:156). The default must sit under that AND leave real
        # room for reasoning + answer (WARP-854 anti-starvation).
        assert 512 <= DEFAULT_VOICE_MAX_TOKENS <= 4096

    def test_configured_max_tokens_is_honored(self, monkeypatch):
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test", max_tokens=2048).reply("hi")
        assert bodies[0]["max_tokens"] == 2048

    def test_max_tokens_also_sent_on_greeting(self, monkeypatch):
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test").reply(
            "good morning", tool_choice="none",
        )
        assert bodies[0]["max_tokens"] == DEFAULT_VOICE_MAX_TOKENS


class TestAllowedToolsScope:
    """A curated `allowed_tools` scope replaces the inherited ~43-tool set
    on tool-enabled turns. On the greeting fast path (tool_choice="none")
    the orchestrator sends ZERO tools, so allowed_tools is moot and MUST
    be omitted to keep that path exactly as-is."""

    def test_reply_sends_default_scope_on_tool_turn(self, monkeypatch):
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test").reply("is the front camera online?")
        assert bodies[0]["allowed_tools"] == list(DEFAULT_VOICE_ALLOWED_TOOLS)

    def test_reply_sends_default_scope_when_tool_choice_auto(self, monkeypatch):
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test").reply("hi", tool_choice="auto")
        assert bodies[0]["allowed_tools"] == list(DEFAULT_VOICE_ALLOWED_TOOLS)

    def test_allowed_tools_omitted_on_greeting_fast_path(self, monkeypatch):
        # The intent-gate fast path stays exactly as-is: zero tools sent,
        # so allowed_tools is moot and must not appear.
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test").reply(
            "good morning", tool_choice="none",
        )
        assert "allowed_tools" not in bodies[0]
        assert bodies[0]["tool_choice"] == "none"

    def test_configured_scope_is_honored(self, monkeypatch):
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(
            base_url="http://test",
            allowed_tools=["list_cameras", "get_system_health"],
        ).reply("is the camera up?")
        assert bodies[0]["allowed_tools"] == ["list_cameras", "get_system_health"]

    def test_empty_explicit_scope_omits_field(self, monkeypatch):
        # An explicit [] at the class level means "send no allowed_tools
        # field" (the caller opted out), NOT allowed_tools:[] which the
        # orchestrator would read as ZERO tools.
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test", allowed_tools=[]).reply("hi")
        assert "allowed_tools" not in bodies[0]

    def test_camera_question_routes_with_list_cameras_in_scope(self, monkeypatch):
        # Representative household tool question — the tool that answers
        # it must be in the default scope or voice silently loses cameras.
        bodies = _capture_chat_body(monkeypatch)
        OrchestratorLLM(base_url="http://test").reply("is the front camera online?")
        assert "list_cameras" in bodies[0]["allowed_tools"]


class TestDefaultScopeContract:
    """The curated default is correctness-first: it must cover every
    domain the voice persona ADVERTISES (cameras, network, files, smart
    devices, calendar, reminders + box health), and it must not carry
    write tools that the `_service:voice` principal can't drive anyway
    (they'd be stripped server-side — dead weight in the prefill)."""

    def test_covers_every_persona_promised_domain(self):
        # DEFAULT_LLM_SYSTEM_PROMPT promises cameras, network, files,
        # smart devices, calendar, and reminders (read-only). Each must
        # have at least its primary read tool in scope.
        scope = set(DEFAULT_VOICE_ALLOWED_TOOLS)
        assert "list_cameras" in scope          # cameras
        assert "get_network_status" in scope    # network
        assert "search_files" in scope          # files
        assert "list_smart_home_devices" in scope  # smart devices
        assert "list_events" in scope           # calendar
        assert "list_reminders" in scope        # reminders
        assert "get_system_health" in scope     # box health

    def test_includes_the_one_scoped_voice_control_tool(self):
        # `control_device` is the sole write tool voice may drive
        # (VOICE_WRITE_TOOLS in routes/llm.ts) — "hey Droplet, turn off
        # the kitchen lights". It survives the server-side write strip,
        # so it belongs in scope.
        assert "control_device" in DEFAULT_VOICE_ALLOWED_TOOLS

    def test_excludes_write_tools_stripped_for_voice(self):
        # These are requiresWrite tools NOT in VOICE_WRITE_TOOLS — the
        # orchestrator strips them for the voice principal, so shipping
        # them in the default would be misleading dead weight.
        scope = set(DEFAULT_VOICE_ALLOWED_TOOLS)
        for stripped in (
            "run_scene",
            "block_network_device",
            "write_file",
            "delete_file",
            "email_send",
            "restart_router",
            "create_reminder",
        ):
            assert stripped not in scope

    def test_excludes_the_long_tail(self):
        # The whole point (WARP-1432) is cutting the rarely-voice-used
        # long tail — PM, ERP, data-utility, switch-admin tools.
        scope = set(DEFAULT_VOICE_ALLOWED_TOOLS)
        for tail in (
            "pm_list_work_items",
            "erp_find_patient",
            "uuid_generate",
            "regex_test",
            "set_port_vlan",
            "convert_data_format",
        ):
            assert tail not in scope

    def test_no_duplicate_tool_names(self):
        assert len(DEFAULT_VOICE_ALLOWED_TOOLS) == len(set(DEFAULT_VOICE_ALLOWED_TOOLS))


class TestParseMaxTokens:
    """VOICE_MAX_TOKENS parsing: unset/garbage/out-of-range all fall back
    to the known-safe default with a warning (voice never breaks on a
    fat-fingered env), a valid int is honored."""

    def test_none_returns_default(self):
        assert parse_max_tokens(None) == DEFAULT_VOICE_MAX_TOKENS

    def test_empty_returns_default(self):
        assert parse_max_tokens("") == DEFAULT_VOICE_MAX_TOKENS

    def test_whitespace_returns_default(self):
        assert parse_max_tokens("   \n\t ") == DEFAULT_VOICE_MAX_TOKENS

    def test_valid_int_is_used(self):
        assert parse_max_tokens("2048") == 2048

    def test_surrounding_whitespace_stripped(self):
        assert parse_max_tokens("  2048  ") == 2048

    def test_non_numeric_falls_back_to_default(self):
        assert parse_max_tokens("abc") == DEFAULT_VOICE_MAX_TOKENS

    def test_zero_out_of_range_falls_back(self):
        # Below the gateway's ge=1 bound — a 0 cap would empty every reply.
        assert parse_max_tokens("0") == DEFAULT_VOICE_MAX_TOKENS

    def test_negative_falls_back(self):
        assert parse_max_tokens("-100") == DEFAULT_VOICE_MAX_TOKENS

    def test_above_gateway_ceiling_falls_back(self):
        # Above the orchestrator/gateway le=4096 bound — sending it would
        # 400 every voice reply, so fall back rather than guarantee failure.
        assert parse_max_tokens("99999") == DEFAULT_VOICE_MAX_TOKENS

    def test_float_string_falls_back(self):
        assert parse_max_tokens("1024.5") == DEFAULT_VOICE_MAX_TOKENS


class TestParseAllowedTools:
    """VOICE_ALLOWED_TOOLS parsing: comma-separated names, whitespace
    trimmed, empty segments dropped; unset/all-empty falls back to the
    curated default (never an empty list — that would zero out tools)."""

    def test_none_returns_default(self):
        assert parse_allowed_tools(None) == list(DEFAULT_VOICE_ALLOWED_TOOLS)

    def test_empty_returns_default(self):
        assert parse_allowed_tools("") == list(DEFAULT_VOICE_ALLOWED_TOOLS)

    def test_whitespace_returns_default(self):
        assert parse_allowed_tools("   ") == list(DEFAULT_VOICE_ALLOWED_TOOLS)

    def test_all_empty_segments_returns_default(self):
        # ",,, ," carries no real names — treat as "operator said nothing".
        assert parse_allowed_tools(",,, ,") == list(DEFAULT_VOICE_ALLOWED_TOOLS)

    def test_comma_separated_names_parsed(self):
        assert parse_allowed_tools("a,b,c") == ["a", "b", "c"]

    def test_segments_are_trimmed(self):
        assert parse_allowed_tools("list_cameras, get_system_health") == [
            "list_cameras",
            "get_system_health",
        ]

    def test_empty_segments_dropped(self):
        assert parse_allowed_tools("a,,b, ,c") == ["a", "b", "c"]

    def test_single_name(self):
        assert parse_allowed_tools("list_cameras") == ["list_cameras"]


class TestBuildLLMFromEnvTurnShaping:
    """build_llm_from_env wires VOICE_MAX_TOKENS + VOICE_ALLOWED_TOOLS
    through to the OrchestratorLLM, same as it does LLM_MODEL / token."""

    def test_default_build_uses_default_cap_and_scope(self, monkeypatch, stub_geo):
        for k in ("LLM_URL", "VOICE_MAX_TOKENS", "VOICE_ALLOWED_TOOLS"):
            monkeypatch.delenv(k, raising=False)
        llm = build_llm_from_env()
        assert isinstance(llm, OrchestratorLLM)
        assert llm._max_tokens == DEFAULT_VOICE_MAX_TOKENS
        assert llm._allowed_tools == list(DEFAULT_VOICE_ALLOWED_TOOLS)

    def test_voice_max_tokens_env_propagates(self, monkeypatch, stub_geo):
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("VOICE_MAX_TOKENS", "2048")
        llm = build_llm_from_env()
        assert llm._max_tokens == 2048

    def test_voice_max_tokens_env_invalid_falls_back(self, monkeypatch, stub_geo):
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("VOICE_MAX_TOKENS", "not-a-number")
        llm = build_llm_from_env()
        assert llm._max_tokens == DEFAULT_VOICE_MAX_TOKENS

    def test_voice_allowed_tools_env_propagates(self, monkeypatch, stub_geo):
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv(
            "VOICE_ALLOWED_TOOLS", "list_cameras, get_system_health",
        )
        llm = build_llm_from_env()
        assert llm._allowed_tools == ["list_cameras", "get_system_health"]

    def test_voice_allowed_tools_env_empty_uses_default(self, monkeypatch, stub_geo):
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("VOICE_ALLOWED_TOOLS", "   ")
        llm = build_llm_from_env()
        assert llm._allowed_tools == list(DEFAULT_VOICE_ALLOWED_TOOLS)


# ────────────────────────────────────────────────────────────────────
# WARP-626 — incremental SSE consume (reply_stream)
# ────────────────────────────────────────────────────────────────────
#
# `reply_stream()` POSTs with stream:true and parses the orchestrator's
# SSE (apps/orchestrator/src/types/sse-events.ts): one frame per event,
# `event: <type>\ndata: <json-without-type>\n\n`. content_delta.text is
# yielded; tool_call / tool_result / reasoning_step / model_loading are
# ignored for audio; done stops; a done with stop_reason:"error" (the
# WARP-854 empty-completion rewrite) raises LLMUnavailable. On any
# transport failure or a non-streaming response it FALLS BACK to the
# blocking reply(). Wave-C request shaping rides on the stream request too.


def _sse(*frames: tuple[str, dict]) -> bytes:
    """Encode SSE frames exactly like the orchestrator's encodeSSE():
    `event: <type>\\ndata: <json payload without the type key>\\n\\n`."""
    out = []
    for event_type, payload in frames:
        out.append(f"event: {event_type}\ndata: {json.dumps(payload)}\n\n")
    return "".join(out).encode("utf-8")


def _install_mock_stream(monkeypatch, handler) -> list:
    """Route the pooled client (stream + get + post) through one MockTransport.

    WARP-1433: reply_stream() uses `self._client.stream`, the blocking
    fallback uses `self._client.post`, and the health probe uses
    `self._client.get` — all on the ONE pooled client. Patching the factory
    covers the stream path and its fallback in a single test."""
    captured: list[httpx.Request] = []

    def _record(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_record)
    monkeypatch.setattr(
        voice.llm, "_new_httpx_client",
        lambda: httpx.Client(transport=transport),
    )
    return captured


def _sse_response(*frames: tuple[str, dict]) -> httpx.Response:
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=_sse(*frames),
    )


class _BreakingByteStream(httpx.SyncByteStream):
    """Yields one chunk of real SSE bytes, then raises a transport error
    mid-body — models the orchestrator connection dropping AFTER sentence 1
    has already been streamed (and, on the pipeline side, already spoken)."""

    def __init__(self, prefix: bytes):
        self._prefix = prefix

    def __iter__(self):
        yield self._prefix
        raise httpx.ReadError("stream dropped mid-body (test)")

    def close(self) -> None:
        pass


class TestReplyStreamSSE:
    def test_yields_content_deltas_in_order(self, monkeypatch):
        def handler(req):
            return _sse_response(
                ("content_delta", {"text": "The camera "}),
                ("content_delta", {"text": "is online."}),
                ("done", {"iterations": 1, "stop_reason": "model_done"}),
            )
        _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        assert list(llm.reply_stream("is the camera up")) == [
            "The camera ", "is online.",
        ]

    def test_tool_frames_ignored_for_audio(self, monkeypatch):
        def handler(req):
            return _sse_response(
                ("content_delta", {"text": "Checking. "}),
                ("tool_call", {"id": "t1", "name": "list_cameras", "args": {}}),
                ("tool_result", {"id": "t1", "ok": True, "data": []}),
                ("content_delta", {"text": "All cameras are online."}),
                ("done", {"iterations": 2, "stop_reason": "model_done"}),
            )
        _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        # Only the two content deltas are spoken; tool frames are dropped.
        assert list(llm.reply_stream("check cameras")) == [
            "Checking. ", "All cameras are online.",
        ]

    def test_reasoning_step_ignored_for_audio(self, monkeypatch):
        def handler(req):
            return _sse_response(
                ("reasoning_step", {"text": "the user wants the time"}),
                ("content_delta", {"text": "It is 3 p.m."}),
                ("done", {"iterations": 1, "stop_reason": "model_done"}),
            )
        _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        assert list(llm.reply_stream("what time is it")) == ["It is 3 p.m."]

    def test_done_stops_iteration(self, monkeypatch):
        # Any frames after `done` are not consumed.
        def handler(req):
            return _sse_response(
                ("content_delta", {"text": "Done now."}),
                ("done", {"iterations": 1, "stop_reason": "model_done"}),
                ("content_delta", {"text": "SHOULD NOT APPEAR"}),
            )
        _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        assert list(llm.reply_stream("hi")) == ["Done now."]

    def test_warp854_done_error_raises(self, monkeypatch):
        # An empty completion is rewritten server-side to a done with
        # stop_reason:error (WARP-854) — reply_stream surfaces it.
        def handler(req):
            return _sse_response(
                ("done", {
                    "iterations": 1,
                    "stop_reason": "error",
                    "error": "empty_completion: the model returned no output.",
                }),
            )
        _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        with pytest.raises(LLMUnavailable, match="empty_completion"):
            list(llm.reply_stream("hi"))

    def test_empty_user_text_yields_nothing_no_network(self, monkeypatch):
        captured = _install_mock_stream(
            monkeypatch, lambda r: httpx.Response(500),
        )
        assert list(OrchestratorLLM(base_url="http://test").reply_stream("")) == []
        assert captured == []

    def test_blank_data_and_comment_lines_tolerated(self, monkeypatch):
        # SSE keep-alive comments (": ping") and stray blank frames must
        # not crash the parser.
        def handler(req):
            body = (
                b": keep-alive ping\n\n"
                b"event: content_delta\ndata: {\"text\": \"Hi there now.\"}\n\n"
                b"event: done\ndata: {\"iterations\": 1, \"stop_reason\": \"model_done\"}\n\n"
            )
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=body,
            )
        _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        assert list(llm.reply_stream("hi")) == ["Hi there now."]


class TestReplyStreamFallback:
    def test_transport_error_falls_back_to_blocking_reply(self, monkeypatch):
        # The STREAM attempt (Accept: text/event-stream) raises a transport
        # error → reply_stream falls back to the pooled client's blocking
        # POST, which succeeds and yields as a single chunk.
        def handler(req):
            if "text/event-stream" in req.headers.get("accept", ""):
                raise httpx.ConnectError("stream connect refused")
            return httpx.Response(200, json={
                "message": {"role": "assistant", "content": "blocking reply won"},
            })
        _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        assert list(llm.reply_stream("hi")) == ["blocking reply won"]

    def test_non_event_stream_response_parsed_as_single_reply(self, monkeypatch):
        # Server ignored stream:true and returned a normal JSON body — parse
        # it via the same extractor and yield the whole reply once.
        def handler(req):
            return httpx.Response(200, json={
                "message": {"role": "assistant", "content": "whole reply here"},
                "trace": [], "iterations": 1, "stop_reason": "model_done",
            })
        _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        assert list(llm.reply_stream("hi")) == ["whole reply here"]

    def test_non_2xx_falls_back_to_blocking(self, monkeypatch):
        # 503 on the stream request → fall back to blocking reply(). Same
        # handler answers both; the blocking reply() then gets the 503 too
        # and raises — so the fallback surfaces LLMUnavailable, not silence.
        def handler(req):
            return httpx.Response(503, json={"detail": "model loading"})
        _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        with pytest.raises(LLMUnavailable, match="model loading"):
            list(llm.reply_stream("hi"))

    def test_partial_yield_then_break_surfaces_error_no_double_audio(
        self, monkeypatch,
    ):
        # The stream yields sentence 1, then the transport drops mid-body.
        # Because content was ALREADY yielded (and, upstream, already spoken),
        # reply_stream must SURFACE the break as LLMUnavailable rather than
        # re-running the blocking reply() — re-running would replay the whole
        # answer over the top of the partial audio (double audio). Guards the
        # `if yielded: raise` branch the other fallbacks (break BEFORE any
        # yield) never reach.
        def handler(req):
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                stream=_BreakingByteStream(
                    _sse(("content_delta", {"text": "The camera is online. "})),
                ),
            )
        captured = _install_mock_stream(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://test")
        gen = llm.reply_stream("status please")
        assert next(gen) == "The camera is online. "  # sentence 1 streamed
        with pytest.raises(LLMUnavailable, match="partial content"):
            next(gen)
        # Exactly ONE request was made — the stream POST. The blocking reply()
        # fallback did NOT re-POST, so the partial audio is never doubled.
        assert len(captured) == 1


class TestReplyStreamRequestShape:
    """Every Wave-C request shape (ephemeral / max_tokens / allowed_tools /
    tool_choice) must ride on the STREAMING request too, plus stream:true
    and an event-stream Accept header."""

    def _capture(self, monkeypatch):
        bodies: list[dict] = []
        headers: list[dict] = []

        def handler(req):
            bodies.append(json.loads(req.content))
            headers.append(dict(req.headers))
            return _sse_response(
                ("content_delta", {"text": "ok now."}),
                ("done", {"iterations": 1, "stop_reason": "model_done"}),
            )
        _install_mock_stream(monkeypatch, handler)
        return bodies, headers

    def test_stream_true_and_wave_c_fields_on_tool_turn(self, monkeypatch):
        bodies, headers = self._capture(monkeypatch)
        list(OrchestratorLLM(base_url="http://test").reply_stream(
            "is the front camera online?",
        ))
        b = bodies[0]
        assert b["stream"] is True
        assert b["ephemeral"] is True
        assert b["max_tokens"] == DEFAULT_VOICE_MAX_TOKENS
        assert b["allowed_tools"] == list(DEFAULT_VOICE_ALLOWED_TOOLS)

    def test_accept_header_is_event_stream(self, monkeypatch):
        bodies, headers = self._capture(monkeypatch)
        list(OrchestratorLLM(base_url="http://test").reply_stream("hi"))
        assert "text/event-stream" in headers[0].get("accept", "")

    def test_tool_choice_none_omits_allowed_tools_on_stream(self, monkeypatch):
        bodies, headers = self._capture(monkeypatch)
        list(OrchestratorLLM(base_url="http://test").reply_stream(
            "good morning", tool_choice="none",
        ))
        assert bodies[0]["tool_choice"] == "none"
        assert "allowed_tools" not in bodies[0]

    def test_bearer_token_attached_on_stream(self, monkeypatch):
        bodies, headers = self._capture(monkeypatch)
        list(OrchestratorLLM(
            base_url="http://test", bearer_token="secret",
        ).reply_stream("hi"))
        assert headers[0].get("authorization") == "Bearer secret"


class TestMockReplyStreamFallbackDefault:
    """The abstract LLMClient provides a default reply_stream that yields
    the blocking reply() as a single chunk — so MockLLM (and any client
    that only implements reply()) streams for free."""

    def test_mock_reply_stream_yields_single_blocking_reply(self):
        m = MockLLM(scripted_replies=["the whole reply"])
        assert list(m.reply_stream("hi")) == ["the whole reply"]
        assert m.requests == ["hi"]

    def test_mock_reply_stream_empty_yields_nothing(self):
        m = MockLLM(scripted_replies=[""])
        assert list(m.reply_stream("hi")) == []

    def test_mock_reply_stream_threads_tool_choice(self):
        m = MockLLM(scripted_replies=["ok"])
        list(m.reply_stream("good morning", tool_choice="none"))
        assert m.last_tool_choice == "none"
