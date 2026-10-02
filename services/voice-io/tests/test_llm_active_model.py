"""WARP-3047 — voice follows the box's ACTIVE model.

voice-io used to send env ``LLM_MODEL`` as ``model`` on every turn, read once
at startup. After an owner switched the box to B on the Models page, every
voice turn still asked for A — and on Docker Model Runner (no memory-aware
eviction) that loads A next to B until the GPU runs out.

The contract pinned here:

  - The production client (``build_llm_from_env``) asks the orchestrator's
    ``GET /api/llm/models`` for ``defaultModel`` with the service bearer, and
    sends THAT as the turn's ``model`` — on the blocking and streaming paths.
  - The answer is cached for ``ACTIVE_MODEL_TTL_S`` (one GET per window, not
    per turn); a switch is picked up on the next window.
  - When the orchestrator can't name one (non-2xx, transport error, null
    ``defaultModel``) the last known answer stands, else env ``LLM_MODEL``.
  - An active model the same listing STATES can't call tools
    (``capabilities.tools is False``) is not followed — voice is a
    tool-driven loop; unknown capabilities still follow.
  - A directly-constructed ``OrchestratorLLM`` (tests, ``__mock__`` style
    wiring) keeps sending its configured model and never makes the GET.
"""
from __future__ import annotations

import json

import httpx
import pytest

import voice.llm
from voice.llm import ACTIVE_MODEL_TTL_S, OrchestratorLLM, build_llm_from_env

ENV_MODEL = "docker.io/ai/gpt-oss:20B-F16"
ACTIVE_B = "docker.io/ai/qwen3:8B-Q4_K_M"


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class _Orchestrator:
    """MockTransport stand-in for the orchestrator: answers the models
    listing with whatever ``default`` currently is, and records every chat
    body so a test can read the ``model`` each turn sent."""

    def __init__(self, default: object = ACTIVE_B, models_status: int = 200) -> None:
        self.default = default
        self.models_status = models_status
        # The `models` half of the listing — the gateway's ModelInfo rows,
        # whose `capabilities` voice reads for the active model.
        self.models: list[dict] = []
        self.models_gets: list[httpx.Request] = []
        self.chat_models: list[str] = []
        self.raise_on_models = False

    def transport(self) -> httpx.MockTransport:
        def _handle(req: httpx.Request) -> httpx.Response:
            if req.url.path == "/api/llm/models":
                self.models_gets.append(req)
                if self.raise_on_models:
                    raise httpx.ConnectError("orchestrator restarting", request=req)
                return httpx.Response(
                    self.models_status,
                    json={"models": self.models, "defaultModel": self.default},
                )
            body = json.loads(req.content)
            self.chat_models.append(body["model"])
            return httpx.Response(
                200, json={"message": {"role": "assistant", "content": "ok"}},
            )

        return httpx.MockTransport(_handle)


@pytest.fixture
def orch(monkeypatch) -> _Orchestrator:
    fake = _Orchestrator()
    monkeypatch.setattr(
        voice.llm, "_new_httpx_client", lambda: httpx.Client(transport=fake.transport()),
    )
    return fake


def _following(clock: _Clock | None = None) -> OrchestratorLLM:
    return OrchestratorLLM(
        base_url="http://orchestrator:3000",
        model=ENV_MODEL,
        bearer_token="voice-token",
        follow_active_model=True,
        time_source=clock or _Clock(),
    )


class TestFollowsActiveModel:
    def test_turn_sends_the_orchestrators_default_model_not_env(self, orch):
        llm = _following()
        llm.reply("what's on the cameras?")
        assert orch.chat_models == [ACTIVE_B]
        # Asked with the service bearer — /api/llm/models needs a principal.
        assert orch.models_gets[0].headers["authorization"] == "Bearer voice-token"

    def test_streaming_turn_sends_the_active_model_too(self, orch):
        llm = _following()
        list(llm.reply_stream("hello"))
        assert orch.chat_models == [ACTIVE_B]

    def test_cached_for_the_ttl_then_a_switch_is_picked_up(self, orch):
        clock = _Clock()
        llm = _following(clock)
        llm.reply("one")
        llm.reply("two")
        assert len(orch.models_gets) == 1  # one GET per window, not per turn

        orch.default = ENV_MODEL  # the owner switches back on /models
        clock.now += ACTIVE_MODEL_TTL_S + 1
        llm.reply("three")
        assert len(orch.models_gets) == 2
        assert orch.chat_models == [ACTIVE_B, ACTIVE_B, ENV_MODEL]

    @pytest.mark.parametrize("default", [None, "", "   ", 42])
    def test_no_usable_default_falls_back_to_env_model(self, orch, default):
        orch.default = default
        llm = _following()
        llm.reply("hi")
        assert orch.chat_models == [ENV_MODEL]

    def test_orchestrator_error_falls_back_to_env_model(self, orch):
        orch.models_status = 503
        llm = _following()
        llm.reply("hi")
        assert orch.chat_models == [ENV_MODEL]

    def test_an_active_model_that_cannot_call_tools_keeps_the_configured_model(self, orch):
        """Voice is a tool-driven agent loop (``allowed_tools``). An active
        model the box states cannot call tools (a vision-only model, e.g.
        llava) keeps voice on its configured model — the same rule agent
        runs get from ``resolveActiveModel({ requireTools })``."""
        orch.default = "llava:7b"
        orch.models = [
            {"id": "llava:7b", "provider": "ollama", "name": "Llava 7B",
             "capabilities": {"vision": True, "tools": False}},
        ]
        llm = _following()
        llm.reply("hi")
        assert orch.chat_models == [ENV_MODEL]

    @pytest.mark.parametrize(
        "entry",
        [
            None,  # the active model is not in the listing at all
            {"id": ACTIVE_B, "provider": "ollama", "name": "Qwen 3 8B"},
            {"id": ACTIVE_B, "provider": "ollama", "name": "Qwen 3 8B", "capabilities": None},
            {"id": ACTIVE_B, "provider": "ollama", "name": "Qwen 3 8B",
             "capabilities": {"vision": False, "tools": True}},
        ],
    )
    def test_only_a_stated_no_moves_voice_off_the_active_model(self, orch, entry):
        # Unknown capabilities are not a reason to load a second model.
        orch.models = [entry] if entry else []
        llm = _following()
        llm.reply("hi")
        assert orch.chat_models == [ACTIVE_B]

    def test_a_failed_refresh_keeps_the_last_known_active_model(self, orch):
        clock = _Clock()
        llm = _following(clock)
        llm.reply("one")
        orch.raise_on_models = True
        clock.now += ACTIVE_MODEL_TTL_S + 1
        llm.reply("two")
        # A transient orchestrator blip must not flip voice back to the env
        # model — that is the second model this ticket keeps off the GPU.
        assert orch.chat_models == [ACTIVE_B, ACTIVE_B]


class TestConstructionDefaults:
    def test_direct_construction_does_not_follow(self, orch):
        llm = OrchestratorLLM(base_url="http://orchestrator:3000", model=ENV_MODEL)
        llm.reply("hi")
        assert orch.models_gets == []
        assert orch.chat_models == [ENV_MODEL]

    def test_build_llm_from_env_follows_the_active_model(self, orch, monkeypatch):
        from voice import geo

        monkeypatch.setattr(
            geo, "get_geo",
            lambda: geo.GeoLocation(description=None, timezone="UTC", source="fallback"),
        )
        monkeypatch.delenv("LLM_URL", raising=False)
        monkeypatch.setenv("LLM_MODEL", ENV_MODEL)
        llm = build_llm_from_env()
        assert isinstance(llm, OrchestratorLLM)
        llm.reply("hi")
        assert orch.chat_models == [ACTIVE_B]
