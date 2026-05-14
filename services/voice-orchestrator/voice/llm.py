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

    `DROPLET_LOCATION` (free-form, e.g. "Greenwich, CT, USA") +
    `TZ` (IANA, e.g. "America/New_York") feed into the system prompt
    so the model can answer time/location questions directly.
    """
    raw = (os.environ.get("LLM_URL") or "").strip()
    model = (os.environ.get("LLM_MODEL") or DEFAULT_LLM_MODEL).strip() or DEFAULT_LLM_MODEL
    token = (os.environ.get("ORCHESTRATOR_TOKEN") or "").strip() or None
    location = (os.environ.get("DROPLET_LOCATION") or "").strip() or None
    timezone = (os.environ.get("TZ") or "").strip() or DEFAULT_TIMEZONE
    if raw == "__mock__":
        logger.info("LLM_URL=__mock__ → MockLLM (echoes the user transcript)")
        return MockLLM(echo=True)
    if not raw:
        raw = DEFAULT_LLM_URL
    return OrchestratorLLM(
        base_url=raw,
        model=model,
        bearer_token=token,
        location=location,
        timezone=timezone,
    )
