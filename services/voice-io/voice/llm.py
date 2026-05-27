"""LLM bridge — POST a transcript to the **orchestrator's agent loop**,
get back the assistant's reply.

This is the glue layer that closes the voice loop. The voice path
mic → wake → STT → text now hands that text to the orchestrator's
`/api/llm/chat` route; the orchestrator runs the full ReAct agent loop
(MCP tool dispatch, ai-gateway → ollama-manager :8002 → Ollama) and
returns the final assistant text. The pipeline then feeds that through
TTS to the speaker.

Why we call the orchestrator (not ai-gateway directly) — per shared_brain
`projects/droplet-onboard-services/docs/agentic-workflows.md` and
`projects/droplet-onboard-services/docs/LLM_AGENT.md`:

  * The **orchestrator owns the agent loop**. ai-gateway forwards
    `tools[]` to the model and returns the raw response untouched; it
    does NOT dispatch tools. Calling ai-gateway directly means the
    voice assistant can chat but cannot actually DO anything (no
    `list_cameras`, `set_light`, none of the ~50 tools in
    `packages/tools-core/`).
  * The **MCP server** owns tool dispatch — stdio-child of the
    orchestrator. There is no path to MCP that bypasses the
    orchestrator's agent loop.
  * So: voice → orchestrator `/api/llm/chat` → agent loop →
    ai-gateway → ollama-manager → Ollama, with `mcpClient.callTool()`
    fan-out for tool_calls. Single, canonical path.

Auth — the orchestrator's `/api/llm/chat` requires a verified
principal. Voice doesn't have a human session, so it uses a
**service-principal bearer token** (`ORCHESTRATOR_TOKEN` env var below).
The orchestrator-side `SERVICE_TOKEN_VOICE` constant must match;
`authMiddleware` recognises it and sets `req.user.role = "service"`.
RBAC then restricts voice to read-only tools (no destructive writes
via voice in v1).

`LLMClient` is the abstract interface (mockable for tests).
`OrchestratorLLM` is the production HTTP client. `MockLLM` for tests.
"""
from __future__ import annotations

import json
import logging
import os
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Callable, Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

logger = logging.getLogger("voice.llm")


# Per-turn override for the orchestrator's agent loop. "none" forces
# the model to answer from the system prompt context without calling
# any tool — the intent gate in `voice.pipeline.classify_tool_choice`
# uses this to short-circuit speculative tool calls on greetings,
# time-of-day, and who-are-you utterances. Matches the
# `tool_choice?: "auto" | "none"` field on `AgentDeps.aiGateway.chat`
# in `apps/orchestrator/src/services/llm-agent.service.ts` AND the
# new `tool_choice` field on `chatRequestSchema`
# (`apps/orchestrator/src/routes/llm.ts`).
ToolChoice = Literal["auto", "none"]

# Reasonable defaults; overridable via env in main.py.
#
# Default target is the orchestrator container on the compose network.
# Service-to-service: voice-io reaches the orchestrator by service name;
# no host gateway hop needed.
DEFAULT_LLM_URL = "http://orchestrator:3000"
DEFAULT_LLM_CHAT_PATH = "/api/llm/chat"
DEFAULT_LLM_HEALTH_PATH = "/api/orchestrator/health"
# Model the orchestrator's agent loop will ask ai-gateway for. ai-gateway
# routes `llama*`/`qwen*`/`mistral*`/`phi*` to the Jetson ollama-manager;
# the model must already be installed on the appliance (see
# `shared_brain/projects/droplet-local-LLM/docs/model-management.md` for
# `/models/sync`). `qwen2.5:3b-instruct` is the agent docs' default —
# tool-calling-capable, fits Orin Nano 7 GB RAM budget. Override via
# LLM_MODEL env if the appliance has a larger / different model loaded.
DEFAULT_LLM_MODEL = "qwen2.5:3b-instruct"
# Agent loop can take noticeably longer than a single LLM call because
# every tool_call adds an MCP round-trip + a re-prompt iteration.
# 120 s covers a 3-iteration loop on the POC; raise for production with
# slower models.
DEFAULT_LLM_TIMEOUT_S = 120.0
# Cap the agent loop. The orchestrator hard-caps at 10; we ask for a
# much lower number so voice replies stay snappy. A voice turn should
# resolve in at most one tool-call iteration ("list_cameras" → result
# → final answer). Letting the model take 3-5 iterations on noisy or
# ambiguous transcripts is the main reason voice replies feel slow —
# each iteration is a full ai-gateway round-trip (~2-4 s on the POC's
# 8 B model). 2 is the smallest value that still preserves the "one
# tool call, then answer" pattern. Override via the request body's
# max_iter for callers that explicitly need a multi-step plan.
DEFAULT_LLM_MAX_ITER = 2
DEFAULT_LLM_SYSTEM_PROMPT = (
    "You're the friendly voice assistant living inside this family's "
    "Droplet at home — think helpful housemate, not corporate bot. Talk "
    "warmly and casually, like a real person you'd hand a coffee to: use "
    "contractions, keep it natural, one short spoken sentence per reply. "
    "No markdown, no lists, no emojis — every reply gets read aloud. If "
    "you don't know, just say so plainly without apologizing twice. You "
    "can check the home's cameras, network, files, smart devices, "
    "calendar, and reminders (read-only); you can't change anything."
)

# Fallback timezone when neither `TZ` nor a system zoneinfo is usable.
# UTC is honest — if we don't know where we are, we don't lie about
# what time we say it is.
DEFAULT_TIMEZONE = "UTC"


def build_system_prompt(
    base: str,
    *,
    location: Optional[str],
    timezone: str,
    now: Optional[datetime] = None,
) -> str:
    """Compose the system prompt for ONE LLM call.

    The base prompt (a constant) defines the voice persona. We append a
    fresh "Right now" footer with current local time + the device's
    configured location so the model can answer "what time is it?" or
    "what's the weather in our area?" without freelancing.

    Pure function — `now` is injectable for tests + the timezone is an
    explicit arg so we can construct prompts deterministically.
    """
    tz = _safe_zone(timezone)
    if now is None:
        now = datetime.now(tz)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=tz)
    else:
        now = now.astimezone(tz)
    # Friendly format the model can read aloud directly.
    # "Wednesday, May 14, 2026 at 9:34 PM EDT" — explicit weekday lets
    # the model handle "is it the weekend?" without extra reasoning.
    when = now.strftime("%A, %B %d, %Y at %I:%M %p %Z").replace(" 0", " ")
    parts = [base, f"\n\nRight now it is {when}."]
    if location and location.strip():
        parts.append(f"\nThe Droplet is located in {location.strip()}.")
    parts.append(
        "\nIf the user asks for the time, the date, or anything tied "
        "to location, use the information above directly — do not say "
        "you don't have access to the time or location."
    )
    return "".join(parts)


def _safe_zone(name: str) -> ZoneInfo:
    """Get a ZoneInfo for `name`, falling back to UTC if the tz database
    doesn't know it. Containers without tzdata installed and dev boxes
    with typo'd `TZ` env both hit this."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        logger.warning(
            "unknown timezone %r — falling back to UTC. Set TZ to an "
            "IANA name (e.g. America/New_York) in .env.",
            name,
        )
        return ZoneInfo(DEFAULT_TIMEZONE)


class LLMUnavailable(Exception):
    """Raised when the orchestrator's /api/llm/chat can't be reached or
    returns an error. The pipeline catches this and surfaces the
    error_message via /voice/status; the user hears nothing (no TTS
    playback)."""


# ────────────────────────────────────────────────────────────────────
# Abstract interface
# ────────────────────────────────────────────────────────────────────

class LLMClient(ABC):
    """One-shot: transcript in → reply text out."""

    @abstractmethod
    def reply(self, user_text: str, *, tool_choice: Optional[ToolChoice] = None) -> str:
        """Return the assistant's reply text for the given user turn.

        Stateless from the voice-io perspective — the orchestrator owns
        conversation history. Each call uses an anonymous conversation
        (future: switch to a sticky voice conversation id once the
        dashboard surfaces it).

        `tool_choice="none"` is set by the pipeline's intent gate for
        utterances that should answer from system-prompt context only
        (greetings, time-of-day). The orchestrator forwards it to
        ai-gateway so the model can't speculatively call a tool. Pass
        `None` (the default) to let the orchestrator's auto-pick apply.
        """

    @property
    @abstractmethod
    def available(self) -> bool:
        """Cheap reachability probe used at startup + /health."""


# ────────────────────────────────────────────────────────────────────
# Orchestrator — production HTTP client
# ────────────────────────────────────────────────────────────────────

class OrchestratorLLM(LLMClient):
    def __init__(
        self,
        base_url: str = DEFAULT_LLM_URL,
        chat_path: str = DEFAULT_LLM_CHAT_PATH,
        health_path: str = DEFAULT_LLM_HEALTH_PATH,
        model: str = DEFAULT_LLM_MODEL,
        bearer_token: Optional[str] = None,
        system_prompt: str = DEFAULT_LLM_SYSTEM_PROMPT,
        timeout_s: float = DEFAULT_LLM_TIMEOUT_S,
        max_iter: int = DEFAULT_LLM_MAX_ITER,
        location: Optional[str] = None,
        timezone: str = DEFAULT_TIMEZONE,
        now_provider: Optional[Callable[[], datetime]] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._chat_path = chat_path
        self._health_path = health_path
        self._model = model
        self._bearer_token = bearer_token
        self._system_prompt = system_prompt
        self._timeout_s = timeout_s
        self._max_iter = max_iter
        # Context-enrichment fields. `location` is a free-form string
        # ("Greenwich, CT, USA") — what the operator set in env, no
        # geocoding. `timezone` is an IANA name; we resolve it to a
        # ZoneInfo at call time (in build_system_prompt) so a typo
        # falls back to UTC instead of crashing reply().
        self._location = location
        self._timezone = timezone
        # `now_provider` lets tests inject a deterministic clock without
        # patching datetime globally. Production passes None → real time.
        self._now_provider = now_provider

    @property
    def available(self) -> bool:
        """Hit the orchestrator's public health endpoint. Returns False
        (not raise) on any transport or HTTP-error — /voice/status's
        llm_loaded flag is meant to be a stable green/red signal.

        `/api/orchestrator/health` is in `authMiddleware`'s public-path
        list, so the probe succeeds without a service token — but having
        the token set is still required for `/api/llm/chat` to work, so
        a green probe with a missing/wrong token will still 401 at first
        reply(). That's intentional: the probe answers "is the
        orchestrator process up?", not "are my credentials valid?".
        """
        try:
            resp = httpx.get(
                f"{self._base_url}{self._health_path}",
                timeout=2.0,
                headers=self._headers(),
            )
            return resp.is_success
        except (httpx.HTTPError, OSError) as exc:
            logger.info(
                "orchestrator health endpoint %s unreachable: %s",
                self._base_url,
                exc,
            )
            return False

    def reply(self, user_text: str, *, tool_choice: Optional[ToolChoice] = None) -> str:
        if not user_text or not user_text.strip():
            return ""
        # Build a fresh system prompt on every call so the embedded
        # "right now" timestamp is current. Cheap (string concat +
        # one datetime.now()) — no need to cache.
        now = self._now_provider() if self._now_provider else None
        system_msg = build_system_prompt(
            self._system_prompt,
            location=self._location,
            timezone=self._timezone,
            now=now,
        )
        # Wire shape matches `apps/orchestrator/src/routes/llm.ts`
        # `chatRequestSchema` (Zod). Unknown fields are stripped server-
        # side; required: model + messages. `allowed_tools` deliberately
        # omitted so the orchestrator's role-gated default applies —
        # service-principal (this caller) gets all read tools, no writes.
        body: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_text.strip()},
            ],
            "stream": False,
            "max_iter": self._max_iter,
        }
        # Forward the per-turn override when the caller passed one.
        # The intent gate sets "none" for utterances that don't need a
        # tool (greetings, time-of-day) so the model can't wander; for
        # everything else we leave the field unset and the orchestrator's
        # default ("auto") applies. The new chatRequestSchema field
        # (apps/orchestrator/src/routes/llm.ts) accepts this verbatim.
        if tool_choice is not None:
            body["tool_choice"] = tool_choice
        try:
            resp = httpx.post(
                f"{self._base_url}{self._chat_path}",
                json=body,
                timeout=self._timeout_s,
                headers=self._headers(),
            )
        except httpx.HTTPError as exc:
            raise LLMUnavailable(f"POST {self._chat_path} failed: {exc}") from exc

        if not resp.is_success:
            # Try to surface server's error detail when present (FastAPI-shape
            # JSON, Express-shape JSON, or plain text).
            detail = _extract_error_detail(resp)
            raise LLMUnavailable(
                f"{self._chat_path} returned {resp.status_code}: {detail}",
            )

        try:
            data = resp.json()
        except json.JSONDecodeError as exc:
            raise LLMUnavailable(f"non-JSON response: {exc}") from exc

        return _extract_assistant_text(data)

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self._bearer_token:
            h["Authorization"] = f"Bearer {self._bearer_token}"
        return h


def _extract_error_detail(resp: "httpx.Response") -> str:
    """Best-effort error extraction from a non-2xx response. Both the
    orchestrator (Express + zod) and FastAPI surface errors via JSON
    `detail` or `error` keys. Fall back to text body."""
    try:
        j = resp.json()
        if isinstance(j, dict):
            for key in ("detail", "error", "message"):
                v = j.get(key)
                if v:
                    return str(v)
    except (ValueError, json.JSONDecodeError):
        pass
    body = resp.text or ""
    return body[:200] if body else f"(empty body, status={resp.status_code})"


def _extract_assistant_text(payload: dict) -> str:
    """Pull the assistant's text out of the response.

    Primary shape (orchestrator `/api/llm/chat`, non-streaming AgentResult
    per `shared_brain/.../LLM_AGENT.md`):
      {
        "message":     { "role": "assistant", "content": "..." },
        "trace":       [...],
        "iterations":  N,
        "stop_reason": "model_done" | "iteration_limit" | "error"
      }

    Legacy fallback (ai-gateway / OpenAI-compatible) — kept so the same
    helper covers the few dev configurations that still point at
    ai-gateway directly via LLM_URL override:
      { "choices": [ { "message": { "role": "assistant", "content": "..." } } ] }

    Fall through to "" on unrecognised shapes — silent reply beats
    crashing the pipeline mid-call.
    """
    # Orchestrator agent-loop shape first (the canonical path).
    msg = payload.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for seg in content:
            if isinstance(seg, dict) and seg.get("type") == "text":
                t = seg.get("text")
                if isinstance(t, str):
                    parts.append(t)
        if parts:
            return " ".join(parts).strip()

    # Legacy OpenAI / ai-gateway shape.
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            cmsg = first.get("message") or {}
            ccontent = cmsg.get("content")
            if isinstance(ccontent, str):
                return ccontent.strip()
    return ""


# ────────────────────────────────────────────────────────────────────
# Mock — tests + dev fallback
# ────────────────────────────────────────────────────────────────────

class MockLLM(LLMClient):
    """Returns scripted replies. Tests inject this directly; the runtime
    never picks it unless `LLM_URL=__mock__` is set."""

    def __init__(
        self,
        scripted_replies: Optional[list[str]] = None,
        available: bool = True,
        echo: bool = False,
    ):
        # Shared mutable list — each reply() call pops the next scripted
        # reply (same pattern as MockSTT). When the script is exhausted,
        # we return the canned echo or an empty string.
        self._scripts = list(scripted_replies or [])
        self._available = available
        self._echo = echo
        self.requests: list[str] = []

    @property
    def available(self) -> bool:
        return self._available

    def reply(self, user_text: str, *, tool_choice: Optional[ToolChoice] = None) -> str:
        # Accept tool_choice for signature parity with OrchestratorLLM —
        # the mock doesn't dispatch tools so the value is recorded for
        # tests to assert on, not acted on.
        self.requests.append(user_text)
        self.last_tool_choice = tool_choice
        if self._scripts:
            return self._scripts.pop(0)
        if self._echo:
            return f"You said: {user_text}"
        return ""


# ────────────────────────────────────────────────────────────────────
# Factory — pick the right client for the current env.
# ────────────────────────────────────────────────────────────────────

def build_llm_from_env() -> LLMClient:
    """Resolve env config → LLM client.

    `LLM_URL`:
      - `http://...` / `https://...` → OrchestratorLLM
      - `__mock__`                   → MockLLM (echo-mode for manual
                                         dev triggering)
      - empty/unset                  → OrchestratorLLM against the
                                         compose-default DNS

    `ORCHESTRATOR_TOKEN`:
      - REQUIRED in production — must match the orchestrator's
        `SERVICE_TOKEN_VOICE` env var. Empty default lets tests +
        `__mock__` runs work without it; in production the orchestrator
        rejects unauthenticated /api/llm/chat calls with 401.

    Location + timezone resolution order (via voice.geo.get_geo()):
      1. `DROPLET_LOCATION` env (free-form, e.g. "Greenwich, CT, USA")
         + `TZ` env (IANA, e.g. "America/New_York"). Operator-pin wins.
      2. IP-geolocation lookup (ipapi.co default). Auto-detects city/
         region/country/timezone based on egress IP.
      3. UTC + no description if both fail. System prompt just omits
         the location line and uses UTC for time formatting.
    """
    raw = (os.environ.get("LLM_URL") or "").strip()
    model = (os.environ.get("LLM_MODEL") or DEFAULT_LLM_MODEL).strip() or DEFAULT_LLM_MODEL
    token = (os.environ.get("ORCHESTRATOR_TOKEN") or "").strip() or None
    if raw == "__mock__":
        logger.info("LLM_URL=__mock__ → MockLLM (echoes the user transcript)")
        return MockLLM(echo=True)
    if not raw:
        raw = DEFAULT_LLM_URL

    if not token:
        # Loud at startup so a misconfigured deployment surfaces during
        # boot rather than silently 401-ing every voice reply.
        logger.warning(
            "ORCHESTRATOR_TOKEN is empty — voice → orchestrator /api/llm/chat "
            "will 401. Set ORCHESTRATOR_TOKEN to the orchestrator's "
            "SERVICE_TOKEN_VOICE value before going live."
        )

    # Resolve location + timezone via voice.geo (env override → web
    # lookup → fallback). Done at startup; the result is held for the
    # process lifetime. To force a re-lookup after a move, restart
    # voice-io. Lazy import keeps tests that mock `os.environ`
    # but don't care about geo from triggering an HTTP call.
    from voice.geo import get_geo
    geo = get_geo()

    return OrchestratorLLM(
        base_url=raw,
        model=model,
        bearer_token=token,
        location=geo.description,
        timezone=geo.timezone,
    )
