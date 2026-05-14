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
from abc import ABC, abstractmethod
from typing import Any, Optional

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
    ):
        self._base_url = base_url.rstrip("/")
        self._chat_path = chat_path
        self._health_path = health_path
        self._model = model
        self._bearer_token = bearer_token
        self._system_prompt = system_prompt
        self._timeout_s = timeout_s

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
        body: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": self._system_prompt},
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
    """
    import os

    raw = (os.environ.get("LLM_URL") or "").strip()
    model = (os.environ.get("LLM_MODEL") or DEFAULT_LLM_MODEL).strip() or DEFAULT_LLM_MODEL
    token = (os.environ.get("ORCHESTRATOR_TOKEN") or "").strip() or None
    if raw == "__mock__":
        logger.info("LLM_URL=__mock__ → MockLLM (echoes the user transcript)")
        return MockLLM(echo=True)
    if not raw:
        raw = DEFAULT_LLM_URL
    return OrchestratorLLM(base_url=raw, model=model, bearer_token=token)
