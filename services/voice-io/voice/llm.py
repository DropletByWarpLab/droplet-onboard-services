"""LLM bridge — POST a transcript to the **orchestrator's agent loop**,
get back the assistant's reply.

This is the glue layer that closes the voice loop. The voice path
mic → wake → STT → text now hands that text to the orchestrator's
`/api/llm/chat` route; the orchestrator runs the full ReAct agent loop
(MCP tool dispatch, ai-gateway → Ollama :11434 direct) and
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
    ai-gateway → Ollama `:11434` (direct), with `mcpClient.callTool()`
    fan-out for tool_calls. Single, canonical path. (Lifecycle/health
    live on ollama-manager `:8002`; its `/proxy` is an opt-in that is
    NOT in the chat path — see repo `CLAUDE.md` "Ollama call path".)

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
from typing import Any, Callable, Iterator, Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

# WARP-236 — internal mTLS: rewrite the orchestrator base URL to https:// and
# present voice-io's client cert when DROPLET_INTERNAL_TLS=1.
from _shared.internal_tls import base_url as _internal_base_url, httpx_client_kwargs

# WARP-1119 — workspace persona for greeting turns (arch brief §14).
from voice.persona import PersonaFetcher, build_persona_fetcher_from_env

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
# routes `llama*`/`qwen*`/`mistral*`/`phi*` to the local Ollama instance
# (or its ollama-manager sidecar when deployed); the model must already
# be installed on the inference host (see
# `shared_brain/projects/droplet-local-LLM/docs/model-management.md` for
# `/models/sync`). `qwen2.5:3b-instruct` is the agent docs' default —
# tool-calling-capable, fits a 7 GB RAM budget. Override via LLM_MODEL
# env if the deployment has a larger / different model loaded.
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
# WARP-1432 — voice turn shaping (client-side request-shape only).
#
# gpt-oss:20b (the box's voice model) spends reasoning-channel tokens
# BEFORE any visible content (apps/orchestrator/src/services/llm-agent
# .service.ts). A cap that's too low starves the answer and yields an
# empty completion (WARP-854), so the DEFAULT is deliberately generous:
# enough for a few hundred reasoning tokens + a short spoken sentence,
# while still bounding runaway generation. 1024 is ~1/4 of the gateway's
# hard ceiling (max_tokens le=4096 in routes/llm.ts + ai-gateway
# schemas.py). Override per-box via VOICE_MAX_TOKENS.
DEFAULT_VOICE_MAX_TOKENS = 1024
# The gateway/orchestrator bound (routes/llm.ts:156 — int, 1..4096). A
# VOICE_MAX_TOKENS outside this range would 400 every reply, so we clamp
# the ACCEPTED window here and fall back to the default outside it.
MIN_VOICE_MAX_TOKENS = 1
MAX_VOICE_MAX_TOKENS = 4096

# The curated tool scope voice advertises on tool-enabled turns. Voice
# used to inherit the full ~43-tool `_service:voice` set (~5k tokens of
# schema prefill serialized on EVERY non-greeting turn); this cuts that
# to the tools a household/office actually asks by voice.
#
# Correctness-first (WARP-1432 brief): the set covers every domain the
# voice persona ADVERTISES — cameras, network, files, smart devices,
# calendar, reminders (all read) — plus box health and the ONE write
# tool voice may drive (`control_device`; the sole member of
# VOICE_WRITE_TOOLS in routes/llm.ts, e.g. "turn off the kitchen
# lights"). Every other write tool (run_scene, create_reminder,
# block_network_device, …) is stripped SERVER-SIDE for the voice
# principal (narrowAllowedToolsForRole), so shipping it here would be
# misleading dead weight — those are intentionally omitted. The long
# tail (PM, ERP, data-utility, switch-admin) is dropped outright.
#
# Names are the canonical registry names (packages/tools-core/src/
# registry.ts). Override the whole set per-box via VOICE_ALLOWED_TOOLS.
DEFAULT_VOICE_ALLOWED_TOOLS: tuple[str, ...] = (
    # box health — "is everything working?"
    "get_system_health",
    # cameras (read) — "is the front camera online?", "any motion?"
    "list_cameras",
    "list_camera_events",
    "get_camera_snapshot",
    # smart devices — query + the one scoped control tool
    "list_smart_home_devices",
    "get_smart_home_device",
    "control_device",
    # network (read) — "is the internet up?", "what's connected?"
    "get_network_status",
    "list_network_devices",
    "network_summary",
    "get_wifi_settings",
    # files (read) — "find my …", "read me my note"
    "search_files",
    "search_content",
    "list_recent_files",
    "read_file",
    # calendar + reminders (read) — the persona promises both
    "list_events",
    "list_reminders",
)

# The voice persona must carry the identity essentials itself: on the
# intent-gated tool_choice="none" path (greetings, "who are you?") the
# orchestrator deliberately skips its base system prompt — see the
# splice guard in apps/orchestrator/src/routes/llm.ts — so these turns
# answer from THIS text alone. The full "what the box does" block
# (apps/orchestrator/data/droplet-identity.md) still rides on every
# tool-enabled turn server-side; keep this compact so voice turns don't
# pay for it twice.
DEFAULT_LLM_SYSTEM_PROMPT = (
    "You're Droplet — the private AI that lives on the little box in "
    "this home, and you're its voice. You're not a cloud service: "
    "everything you hear, say, and know stays right here in the house. "
    "Talk warmly and casually, like a helpful housemate you'd hand a "
    "coffee to — never a corporate bot: use contractions, keep it "
    "natural, one short spoken sentence per reply. No markdown, no "
    "lists, no emojis — every reply gets read aloud. If you don't know, "
    "just say so plainly without apologizing twice. You can check the "
    "home's cameras, network, files, smart devices, calendar, and "
    "reminders (read-only); changes still happen on the dashboard."
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


def parse_max_tokens(raw: Optional[str]) -> int:
    """Resolve VOICE_MAX_TOKENS → an int the gateway will accept.

    Unset / empty / non-numeric / out-of-range [1, 4096] all fall back to
    DEFAULT_VOICE_MAX_TOKENS with a warning. Voice must never break on a
    fat-fingered env: a garbage cap silently degrades to the known-safe
    default instead of 400-ing every reply (same defensive posture as
    `_safe_zone` falling back to UTC)."""
    s = (raw or "").strip()
    if not s:
        return DEFAULT_VOICE_MAX_TOKENS
    try:
        n = int(s)
    except ValueError:
        logger.warning(
            "VOICE_MAX_TOKENS=%r is not an integer — using default %d.",
            raw,
            DEFAULT_VOICE_MAX_TOKENS,
        )
        return DEFAULT_VOICE_MAX_TOKENS
    if not (MIN_VOICE_MAX_TOKENS <= n <= MAX_VOICE_MAX_TOKENS):
        logger.warning(
            "VOICE_MAX_TOKENS=%d is outside the accepted range %d..%d — "
            "using default %d.",
            n,
            MIN_VOICE_MAX_TOKENS,
            MAX_VOICE_MAX_TOKENS,
            DEFAULT_VOICE_MAX_TOKENS,
        )
        return DEFAULT_VOICE_MAX_TOKENS
    return n


def parse_allowed_tools(raw: Optional[str]) -> list[str]:
    """Resolve VOICE_ALLOWED_TOOLS → the scoped tool list voice sends.

    Comma-separated names; each segment trimmed, empty segments dropped.
    Unset / empty / all-whitespace / all-empty-segments falls back to the
    curated DEFAULT_VOICE_ALLOWED_TOOLS. This NEVER returns an empty list:
    an empty `allowed_tools` would be read by the orchestrator as ZERO
    tools (routes/llm.ts distinguishes `[]` from omitted), zeroing out
    every non-greeting turn — not what "operator left it blank" means."""
    names = [seg.strip() for seg in (raw or "").split(",")]
    names = [n for n in names if n]
    if not names:
        return list(DEFAULT_VOICE_ALLOWED_TOOLS)
    return names


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

    def reply_stream(
        self, user_text: str, *, tool_choice: Optional[ToolChoice] = None,
    ) -> Iterator[str]:
        """Yield the reply as a stream of text pieces (WARP-626).

        Default: delegate to the blocking `reply()` and yield the whole
        reply as ONE piece. `OrchestratorLLM` overrides this to consume the
        orchestrator's SSE incrementally, so the pipeline can start speaking
        sentence 1 before the whole reply is decoded. Every other client
        (MockLLM, dashboard-driven callbacks) inherits this single-chunk
        fallback for free — the pipeline's sentence chunker then splits that
        one piece the same way it would split multiple deltas, so the
        overlapped-speak path is exercised identically."""
        text = self.reply(user_text, tool_choice=tool_choice)
        if text:
            yield text

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
        max_tokens: int = DEFAULT_VOICE_MAX_TOKENS,
        allowed_tools: Optional[list[str]] = None,
        location: Optional[str] = None,
        timezone: str = DEFAULT_TIMEZONE,
        now_provider: Optional[Callable[[], datetime]] = None,
        persona_fetcher: Optional[PersonaFetcher] = None,
    ):
        self._base_url = _internal_base_url(base_url.rstrip("/"))
        self._chat_path = chat_path
        self._health_path = health_path
        self._model = model
        self._bearer_token = bearer_token
        self._system_prompt = system_prompt
        self._timeout_s = timeout_s
        self._max_iter = max_iter
        # WARP-1432 — per-turn request shaping. `max_tokens` caps runaway
        # generation (covers gpt-oss reasoning + a short spoken answer).
        # `allowed_tools` is the curated scope voice advertises on tool-
        # enabled turns; None → the correctness-first DEFAULT set. An
        # explicit [] (a caller opting out) is kept as-is and suppresses
        # the field so the orchestrator's role default applies instead of
        # being told "zero tools".
        self._max_tokens = max_tokens
        self._allowed_tools = (
            list(DEFAULT_VOICE_ALLOWED_TOOLS)
            if allowed_tools is None
            else list(allowed_tools)
        )
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
        # WARP-1119 (§14): the workspace persona block for GREETING turns
        # only. tool_choice="none" turns skip the orchestrator base prompt
        # (which carries the persona for tool-enabled turns), so they must
        # bring the persona themselves — and ONLY they may, or the block
        # would ride twice on tool-enabled turns. None → pre-persona
        # behavior (tests, __mock__ deployments).
        self._persona_fetcher = persona_fetcher

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
                **httpx_client_kwargs(),
            )
            return resp.is_success
        except (httpx.HTTPError, OSError) as exc:
            logger.info(
                "orchestrator health endpoint %s unreachable: %s",
                self._base_url,
                exc,
            )
            return False

    def _build_chat_body(
        self,
        user_text: str,
        *,
        tool_choice: Optional[ToolChoice],
        stream: bool,
    ) -> dict[str, Any]:
        """Assemble the /api/llm/chat request body shared by reply() and
        reply_stream() so the streaming path carries the IDENTICAL request
        shape — the only difference is `stream`.

        Wire shape matches `apps/orchestrator/src/routes/llm.ts`
        `chatRequestSchema` (Zod). Carries all Wave-C turn shaping
        (WARP-1432): ephemeral + max_tokens + the curated allowed_tools
        scope + the per-turn tool_choice, plus a fresh "right now"
        timestamp (rebuilt every call) and the WARP-1119 workspace persona
        on the greeting fast path.
        """
        # Build a fresh system prompt on every call so the embedded
        # "right now" timestamp is current. Cheap (string concat +
        # one datetime.now()) — no need to cache.
        now = self._now_provider() if self._now_provider else None
        # WARP-1119 (§14): greeting turns (tool_choice="none") skip the
        # orchestrator base prompt, so the workspace persona block is
        # prepended HERE — and only here. Tool-enabled turns get the
        # persona from the orchestrator base prompt; consulting the
        # fetcher there would double-inject (§16: exactly one block per
        # path). On any fetch failure get_block() returns None and the
        # built-in prompt stands alone — voice never breaks because the
        # orchestrator is restarting.
        base_prompt = self._system_prompt
        if tool_choice == "none" and self._persona_fetcher is not None:
            persona_block = self._persona_fetcher.get_block()
            if persona_block:
                base_prompt = f"{persona_block}\n\n{self._system_prompt}"
        system_msg = build_system_prompt(
            base_prompt,
            location=self._location,
            timezone=self._timezone,
            now=now,
        )
        # WARP-1432 — voice turn shaping, sent on EVERY turn:
        #   * ephemeral:true — voice has no human session, so a persisted
        #     ChatSession per utterance just litters the chat sidebar
        #     (routes/llm.ts:872, chat-persistence.service.ts:429). Voice
        #     is always ephemeral.
        #   * max_tokens — cap runaway generation (see DEFAULT_VOICE_MAX_
        #     TOKENS: covers gpt-oss reasoning + a short spoken answer).
        body: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_text.strip()},
            ],
            "stream": stream,
            "max_iter": self._max_iter,
            "ephemeral": True,
            "max_tokens": self._max_tokens,
        }
        # Forward the per-turn override when the caller passed one.
        # The intent gate sets "none" for utterances that don't need a
        # tool (greetings, time-of-day) so the model can't wander; for
        # everything else we leave the field unset and the orchestrator's
        # default ("auto") applies. The new chatRequestSchema field
        # (apps/orchestrator/src/routes/llm.ts) accepts this verbatim.
        if tool_choice is not None:
            body["tool_choice"] = tool_choice
        # WARP-1432 — scoped tool advertisement. On the greeting fast path
        # (tool_choice="none") the orchestrator sends ZERO tools, so
        # allowed_tools is moot — omit it to keep that path exactly as-is.
        # On every tool-enabled turn, send the curated scope so the model
        # sees ~1-1.5k tokens of tool schema instead of the full ~43-tool
        # ~5k prefill. An empty list (a caller that opted out) is left off
        # entirely so the orchestrator applies its role default rather
        # than reading `[]` as "zero tools".
        if tool_choice != "none" and self._allowed_tools:
            body["allowed_tools"] = self._allowed_tools
        return body

    def reply(self, user_text: str, *, tool_choice: Optional[ToolChoice] = None) -> str:
        if not user_text or not user_text.strip():
            return ""
        body = self._build_chat_body(
            user_text, tool_choice=tool_choice, stream=False,
        )
        try:
            resp = httpx.post(
                f"{self._base_url}{self._chat_path}",
                json=body,
                timeout=self._timeout_s,
                headers=self._headers(),
                **httpx_client_kwargs(),
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

    def _headers(self, accept: str = "application/json") -> dict[str, str]:
        h = {"Content-Type": "application/json", "Accept": accept}
        if self._bearer_token:
            h["Authorization"] = f"Bearer {self._bearer_token}"
        return h

    # ────────────────────────────────────────────────────────────────
    # WARP-626 — incremental SSE consume
    # ────────────────────────────────────────────────────────────────

    def reply_stream(
        self, user_text: str, *, tool_choice: Optional[ToolChoice] = None,
    ) -> Iterator[str]:
        """Consume the orchestrator's SSE and yield content deltas as they
        arrive, so the pipeline can synthesize + play sentence 1 before the
        whole reply is decoded (WARP-626).

        POSTs the SAME Wave-C-shaped body as reply() (via `_build_chat_body`)
        with stream:true and an event-stream Accept. Parses the frames from
        `apps/orchestrator/src/types/sse-events.ts` (event on the `event:`
        line, JSON payload on `data:`):
          * content_delta → yield `.text`
          * tool_call / tool_result / reasoning_step / model_loading →
            ignored for audio (tool activity logged at debug)
          * done → stop; a done with stop_reason:"error" (the WARP-854
            empty-completion rewrite) raises LLMUnavailable

        ROBUSTNESS: falls back to the blocking reply() (yielded as one
        chunk) when the stream can't be opened, returns a non-2xx, or comes
        back as a non-streaming JSON body — so a server that doesn't stream
        (today's single-`content_delta` reality) still works. Once content
        has been yielded, a later transport break is surfaced as
        LLMUnavailable rather than re-running reply() (which would double
        the audio).
        """
        if not user_text or not user_text.strip():
            return
        body = self._build_chat_body(
            user_text, tool_choice=tool_choice, stream=True,
        )
        url = f"{self._base_url}{self._chat_path}"
        yielded = False
        try:
            with httpx.stream(
                "POST",
                url,
                json=body,
                headers=self._headers(accept="text/event-stream"),
                timeout=self._timeout_s,
                **httpx_client_kwargs(),
            ) as resp:
                if not resp.is_success:
                    resp.read()  # drain so the connection releases
                    logger.info(
                        "voice stream got %d — falling back to blocking reply()",
                        resp.status_code,
                    )
                    yield from self._blocking_fallback(user_text, tool_choice)
                    return
                ctype = (resp.headers.get("content-type") or "").lower()
                if "text/event-stream" not in ctype:
                    # Server ignored stream:true (or a proxy buffered it) —
                    # read the full body + parse it once, same as reply().
                    raw = resp.read()
                    try:
                        data = json.loads(raw)
                    except (ValueError, json.JSONDecodeError):
                        logger.info(
                            "voice stream returned a non-SSE, non-JSON body — "
                            "falling back to blocking reply()",
                        )
                        yield from self._blocking_fallback(user_text, tool_choice)
                        return
                    text = _extract_assistant_text(data)
                    if text:
                        yield text
                    return
                for piece in self._parse_sse(resp):
                    yielded = True
                    yield piece
                return
        except httpx.HTTPError as exc:
            if yielded:
                # Already spoke part of the reply — re-running reply() would
                # double the audio, so surface the break instead.
                raise LLMUnavailable(
                    f"stream interrupted after partial content: {exc}",
                ) from exc
            logger.info(
                "voice stream POST failed (%s) — falling back to blocking reply()",
                exc,
            )
            yield from self._blocking_fallback(user_text, tool_choice)
            return

    def _blocking_fallback(
        self, user_text: str, tool_choice: Optional[ToolChoice],
    ) -> Iterator[str]:
        """Yield the blocking reply() as a single chunk. reply() may raise
        LLMUnavailable — that propagates (the pipeline handles it the same
        way it always has)."""
        text = self.reply(user_text, tool_choice=tool_choice)
        if text:
            yield text

    def _parse_sse(self, resp: "httpx.Response") -> Iterator[str]:
        """Yield content_delta text pieces from an SSE response. Raises
        LLMUnavailable on a done error frame; stops after the done frame."""
        event_type: Optional[str] = None
        data_lines: list[str] = []
        for line in resp.iter_lines():
            if line == "":
                # Blank line = frame boundary — dispatch what we accumulated.
                if event_type is not None or data_lines:
                    stop = yield from self._dispatch_frame(event_type, data_lines)
                    if stop:
                        return
                event_type, data_lines = None, []
                continue
            if line.startswith(":"):
                continue  # SSE comment / keep-alive heartbeat
            if line.startswith("event:"):
                event_type = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:"):].lstrip())
        # A trailing frame with no terminating blank line.
        if event_type is not None or data_lines:
            yield from self._dispatch_frame(event_type, data_lines)

    def _dispatch_frame(
        self, event_type: Optional[str], data_lines: list[str],
    ) -> Iterator[str]:
        """Handle one SSE frame: yield content text (if any) and RETURN True
        when the stream should stop (the `done` frame). Raises LLMUnavailable
        on a done error frame. The generator's return value is read by the
        caller via `yield from`."""
        raw = "\n".join(data_lines)
        try:
            payload = json.loads(raw) if raw else {}
        except (ValueError, json.JSONDecodeError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        # The type lives on the `event:` line (encodeSSE strips it from the
        # data payload); tolerate a `type` in data too for robustness.
        etype = event_type or payload.get("type")
        if etype == "content_delta":
            text = payload.get("text")
            if isinstance(text, str) and text:
                yield text
            return False
        if etype == "done":
            if payload.get("stop_reason") == "error":
                raise LLMUnavailable(
                    payload.get("error")
                    or "stream ended with stop_reason=error",
                )
            return True
        # tool_call / tool_result / reasoning_step / model_loading are not
        # spoken. Log tool activity at debug for diagnosis; drop the rest.
        if etype in ("tool_call", "tool_result"):
            logger.debug("voice stream: ignoring %s frame for audio", etype)
        return False


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

def build_llm_from_env(
    persona_fetcher: Optional[PersonaFetcher] = None,
) -> LLMClient:
    """Resolve env config → LLM client.

    `persona_fetcher` (WARP-1119): main.py builds it once at startup (via
    `voice.persona.build_persona_fetcher_from_env`) and passes it in so the
    /health endpoint can read the same instance's `fetch_ok` /
    `last_fetch_at`. Ignored on the __mock__ path.

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

    # WARP-1432 — voice turn shaping. Both parse defensively (garbage or
    # out-of-range env → known-safe default) so a fat-fingered value never
    # breaks the voice loop. VOICE_ALLOWED_TOOLS unset → the curated
    # DEFAULT scope; VOICE_MAX_TOKENS unset → DEFAULT_VOICE_MAX_TOKENS.
    max_tokens = parse_max_tokens(os.environ.get("VOICE_MAX_TOKENS"))
    allowed_tools = parse_allowed_tools(os.environ.get("VOICE_ALLOWED_TOOLS"))
    logger.info(
        "voice turn shaping: ephemeral=on, max_tokens=%d, allowed_tools=%d scoped",
        max_tokens,
        len(allowed_tools),
    )

    return OrchestratorLLM(
        base_url=raw,
        model=model,
        bearer_token=token,
        max_tokens=max_tokens,
        allowed_tools=allowed_tools,
        location=geo.description,
        timezone=geo.timezone,
        persona_fetcher=persona_fetcher,
    )
