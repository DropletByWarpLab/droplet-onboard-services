"""LLM bridge — POST a transcript to an OpenAI-style chat endpoint,
get back the assistant's reply.

This is the glue layer that closes the voice loop. Commits 1-6 built
mic → wake → STT → text. This module hands that text to an LLM and
returns the response; the pipeline then feeds it through TTS to the
speaker.

We point at the ai-gateway service (port 8000, `/ai/chat`) rather
than the orchestrator's `/api/llm/chat` because:

  - ai-gateway is the OpenAI-compatible provider router. No auth on
    the internal docker network. Voice loops are stateless calls;
    we don't need (yet) the orchestrator's session/agent state.
  - The orchestrator's `/api/llm/chat` requires a session JWT, which
    is designed for logged-in dashboard users. Service-to-service
    auth there is a separate fix (commit 7b — wires the agent loop
    in so voice gets tool dispatch alongside the dashboard).
  - For commit 7, "user asks → LLM answers" is enough to demo + ship.
    Tool calls (set_volume, mute_mic, ...) land in commit 7b once
    the auth path is sorted.

`LLMClient` is the abstract interface (mockable for tests).
`OrchestratorLLM` is the production HTTP client — the name is
historical; it currently points at ai-gateway. Renaming will happen
when commit 7b adds an OrchestratorAgentLLM variant. `MockLLM` for
tests.
"""
from __future__ import annotations

import json
import logging
import os
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

logger = logging.getLogger("voice.llm")

# Reasonable defaults; overridable via env in main.py.
DEFAULT_LLM_URL = "http://ai-gateway:8000"
DEFAULT_LLM_CHAT_PATH = "/ai/chat"
DEFAULT_LLM_HEALTH_PATH = "/ai/health"
# ai-gateway model name is raw (no `ollama:` prefix — that confuses the
# OpenAI-compatible /v1 wrapper). Local Ollama on the POC currently has
# llama3.1:8b-instruct-q8_0 and nomic-embed-text; pick the first.
DEFAULT_LLM_MODEL = "llama3.1:8b-instruct-q8_0"
DEFAULT_LLM_TIMEOUT_S = 60.0  # generous: 8 B-param model on CPU can take
                              # 15-30 s for a short reply; first request
                              # also waits for model warm-up.
DEFAULT_LLM_SYSTEM_PROMPT = (
    "You are the voice assistant inside a Droplet, a private on-device "
    "appliance running in the user's home. Reply in ONE short sentence "
    "suitable for spoken playback. No markdown, no formatting, no lists. "
    "If you don't know something, say so plainly."
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
    def reply(self, user_text: str) -> str:
        """Return the assistant's reply text for the given user turn.

        Stateless from the voice-orchestrator's perspective — the
        orchestrator owns conversation history. Each call uses an
        anonymous conversation (commit 7b switches to a sticky voice
        conversation id once the dashboard surfaces it).
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
        """Hit the health path quickly. Returns False (not raise) on
        any transport or HTTP-error — /voice/status's llm_loaded flag
        is meant to be a stable green/red signal."""
        try:
            resp = httpx.get(
                f"{self._base_url}{self._health_path}",
                timeout=2.0,
                headers=self._headers(),
            )
            return resp.is_success
        except (httpx.HTTPError, OSError) as exc:
            logger.info("LLM endpoint %s unreachable: %s", self._base_url, exc)
            return False

    def reply(self, user_text: str) -> str:
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
        body: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_text.strip()},
            ],
            "stream": False,
        }
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
    """Pull the assistant's text out of the response, accepting both
    of the shapes we may see:

      ai-gateway / OpenAI-compatible:
        {"choices": [{"message": {"role":"assistant","content":"..."}}]}

      orchestrator's /api/llm/chat (agent-loop result):
        {"message": {"role":"assistant","content":"..."}, ...}

    Fall through to "" on unrecognised shapes — silent reply beats
    crashing the pipeline mid-call.
    """
    # OpenAI / ai-gateway shape first.
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            msg = first.get("message") or {}
            content = msg.get("content")
            if isinstance(content, str):
                return content.strip()

    # Orchestrator agent-loop shape.
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

    def reply(self, user_text: str) -> str:
        self.requests.append(user_text)
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

    Tool calling:
      - When `voice.tools.build_tool_client_from_env()` returns a
        client (i.e. `VOICE_TOOLS_ENABLED=1`), we wrap the
        OrchestratorLLM in a tool-iterating shell — see
        `OrchestratorLLMWithTools` below. Otherwise we return the
        plain text-only client and the voice loop stays single-shot.

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

    # Resolve location + timezone via voice.geo (env override → web
    # lookup → fallback). Done at startup; the result is held for the
    # process lifetime. To force a re-lookup after a move, restart
    # voice-orchestrator. Lazy import keeps tests that mock `os.environ`
    # but don't care about geo from triggering an HTTP call.
    from voice.geo import get_geo
    geo = get_geo()

    base_llm = OrchestratorLLM(
        base_url=raw,
        model=model,
        bearer_token=token,
        location=geo.description,
        timezone=geo.timezone,
    )

    # Optional tool-calling wrapper (WARP-102 phase 2). Disabled by
    # default — set VOICE_TOOLS_ENABLED=1 in env to opt in.
    from voice.tools import build_tool_client_from_env
    tools = build_tool_client_from_env()
    if tools is None:
        return base_llm
    logger.info("voice tools enabled — LLM responses can invoke smart-home tools")
    return OrchestratorLLMWithTools(base_llm, tools)


# ────────────────────────────────────────────────────────────────────
# Tool-iterating LLM wrapper
# ────────────────────────────────────────────────────────────────────


# Hard cap on the LLM ↔ tool feedback loop. Most useful smart-home
# requests resolve in one tool call (control_device) or two (list →
# control). The cap is a safety net against pathological loops where
# the LLM repeatedly re-tries a failing tool — at 5 we bail with a
# spoken "I tried but couldn't complete that" rather than burning the
# Pi's CPU.
MAX_TOOL_ITERATIONS = 5


class OrchestratorLLMWithTools(LLMClient):
    """LLMClient that does tool-calling against an MCP server.

    Wraps a base OrchestratorLLM (which still owns the HTTP plumbing,
    system-prompt construction, and response parsing) and adds the
    tool-iteration loop on top. Single responsibility: orchestrate
    multi-turn between the LLM and the MCP server until the LLM
    returns plain text.

    Pipeline integration: ``pipeline.py`` already calls ``reply()``
    once per voice turn; this class makes that one call expand into
    up to MAX_TOOL_ITERATIONS HTTP round-trips internally.
    """

    def __init__(self, base: "OrchestratorLLM", tools: "Any"):
        """`tools` is a voice.tools.ToolClient — typed as Any here to
        avoid a forward-import cycle (tools.py doesn't import llm.py;
        this file imports tools.py lazily in build_llm_from_env)."""
        self._base = base
        self._tools = tools
        # Cache the tool list. We re-fetch on first call rather than
        # at construction so a brief MCP outage at startup doesn't kill
        # voice — the first reply() that gets to tool-iteration warms it.
        self._tool_defs: list[Any] | None = None

    @property
    def available(self) -> bool:
        # We're "available" as soon as the base LLM is — tool-calling
        # is a soft enhancement, not a hard dependency. If the MCP
        # server is down, we fall through to text-only replies.
        return self._base.available

    def _get_tool_defs(self) -> list[Any]:
        if self._tool_defs is None:
            try:
                self._tool_defs = self._tools.list_tools()
            except Exception as exc:  # noqa: BLE001 — tool fetch must not crash voice
                logger.warning(
                    "voice tools list_tools() failed; running text-only this turn: %s",
                    exc,
                )
                # Cache an empty list for THIS process lifetime is
                # wrong — a transient MCP blip would lose tools forever.
                # Return [] for this call only; next reply() retries.
                return []
        return self._tool_defs

    def reply(self, user_text: str) -> str:
        """Run the LLM ↔ MCP tool loop. Returns the final assistant
        text once the LLM emits a response with no tool_calls."""
        if not user_text or not user_text.strip():
            return ""

        tool_defs = self._get_tool_defs()
        if not tool_defs:
            # No tools available — degrade gracefully to text-only.
            # This is how a Tier 2 lock request also ends up: the LLM
            # has no control_device tool, so it just talks about it.
            return self._base.reply(user_text)

        # Conversation history starts with the user's turn. We build
        # the system prompt the same way OrchestratorLLM does so the
        # "right now" timestamp and location are present.
        now = self._base._now_provider() if self._base._now_provider else None
        system_msg = build_system_prompt(
            self._base._system_prompt,
            location=self._base._location,
            timezone=self._base._timezone,
            now=now,
        )
        history: list[dict[str, Any]] = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_text.strip()},
        ]

        for iteration in range(MAX_TOOL_ITERATIONS):
            try:
                resp = self._call_with_tools(history, tool_defs)
            except LLMUnavailable as exc:
                logger.warning("LLM call failed mid-tool-loop: %s", exc)
                # Surface the error as a spoken reply so the user knows
                # something happened. Pipeline still gets a non-empty
                # string to feed to TTS.
                return "Sorry, I had trouble reaching the assistant. Please try again."

            assistant_msg = resp.get("message") or _first_choice_message(resp)
            tool_calls = assistant_msg.get("tool_calls") if assistant_msg else None

            if not tool_calls:
                # Plain text reply — done.
                content = (assistant_msg or {}).get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
                # Some providers stream content as a list of parts.
                return _extract_assistant_text(resp)

            # Tool path — append the assistant's tool-call message
            # verbatim so the next LLM call has the full thread, then
            # dispatch each tool and append its result.
            history.append(assistant_msg)
            for tc in tool_calls:
                inv = _normalize_tool_call(tc)
                if inv is None:
                    continue
                try:
                    result = self._tools.invoke(inv)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "tool dispatch threw (%s); feeding error back to LLM",
                        exc,
                    )
                    result_content = json.dumps({
                        "ok": False,
                        "error": {"code": "TOOL_EXCEPTION", "message": str(exc)},
                    })
                    call_id = inv.call_id
                    tool_name = inv.name
                else:
                    result_content = result.content
                    call_id = result.call_id
                    tool_name = result.name
                history.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": tool_name,
                    "content": result_content,
                })
            logger.debug("tool iteration %d completed, looping back to LLM", iteration + 1)

        # Cap exceeded — bail with a spoken apology so the user
        # doesn't hear silence.
        logger.warning(
            "voice tool loop exceeded MAX_TOOL_ITERATIONS=%d", MAX_TOOL_ITERATIONS,
        )
        return "I tried to do that but couldn't finish. Please try the dashboard."

    def _call_with_tools(
        self,
        history: list[dict[str, Any]],
        tool_defs: list[Any],
    ) -> dict[str, Any]:
        """One HTTP round-trip to ai-gateway with `tools=[...]` set.
        Reaches into the base OrchestratorLLM's transport so we keep
        timeout / auth / URL discipline in one place."""
        body: dict[str, Any] = {
            "model": self._base._model,
            "messages": history,
            "stream": False,
            "tools": [t.to_chat_format() for t in tool_defs],
        }
        try:
            resp = httpx.post(
                f"{self._base._base_url}{self._base._chat_path}",
                json=body,
                timeout=self._base._timeout_s,
                headers=self._base._headers(),
            )
        except httpx.HTTPError as exc:
            raise LLMUnavailable(
                f"POST {self._base._chat_path} (with tools) failed: {exc}",
            ) from exc
        if not resp.is_success:
            raise LLMUnavailable(
                f"{self._base._chat_path} returned {resp.status_code}: "
                f"{_extract_error_detail(resp)}",
            )
        try:
            return resp.json()
        except json.JSONDecodeError as exc:
            raise LLMUnavailable(f"non-JSON response: {exc}") from exc


def _first_choice_message(payload: dict[str, Any]) -> dict[str, Any]:
    """OpenAI-shape: choices[0].message. Ollama-shape returns top-level
    `message`. Either path yields a dict here for the tool-call parser."""
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            msg = first.get("message")
            if isinstance(msg, dict):
                return msg
    return {}


def _normalize_tool_call(raw: dict[str, Any]) -> "Any":
    """Coerce one of the LLM provider's tool_call shapes into our
    ToolInvocation. OpenAI / ai-gateway:
      {id, type:"function", function:{name, arguments:"<json-str>"}}
    Ollama native:
      {function:{name, arguments:{...}}}  (id may be absent)
    """
    from voice.tools import ToolInvocation
    if not isinstance(raw, dict):
        return None
    fn = raw.get("function") or {}
    name = fn.get("name") or raw.get("name")
    if not isinstance(name, str):
        return None
    args_raw = fn.get("arguments") if "arguments" in fn else raw.get("arguments")
    if isinstance(args_raw, str):
        try:
            args = json.loads(args_raw) if args_raw else {}
        except json.JSONDecodeError:
            # Some smaller models occasionally emit slightly malformed
            # JSON args. Surface empty rather than crash — the tool
            # will return an INVALID_ARGS error and the LLM can retry.
            logger.warning("malformed tool_call arguments: %r", args_raw)
            args = {}
    elif isinstance(args_raw, dict):
        args = args_raw
    else:
        args = {}
    call_id = raw.get("id") or fn.get("name", "anon") + "-call"
    return ToolInvocation(call_id=str(call_id), name=name, arguments=args)
