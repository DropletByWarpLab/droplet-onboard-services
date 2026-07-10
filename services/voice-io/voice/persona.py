"""WARP-1119 — persona threading for the voice greeting path (§14).

The orchestrator owns the workspace personality (`AssistantPersona`,
WARP-1118): its base system prompt carries the composed persona block on
every tool-enabled turn. But greeting-class voice turns run with
`tool_choice="none"`, where the orchestrator deliberately SKIPS its base
prompt and the turn answers from voice-io's local greeting prompt alone
(see `voice/llm.py::DEFAULT_LLM_SYSTEM_PROMPT`). Without this module those
turns would ignore the owner's personality settings; with an unconditional
prepend they would double-inject ~1200 chars on the tightest-margin
surface. So:

  - greeting path — `PersonaFetcher.get_block()` fetches the composed block
    from `GET /api/persona/prompt` (service bearer token) and `llm.py`
    prepends it to the local greeting prompt;
  - tool-enabled path — untouched; the orchestrator base prompt is the
    single persona owner there (exactly one block per path, §16).

Fetch semantics: per session start, never a long-lived cross-session
cache — a short TTL (default 60 s) keeps greeting bursts from hammering
the orchestrator and keeps a DOWN orchestrator from adding a connect
timeout to every single greeting. Failures never raise: the caller falls
back to the built-in prompt (voice must never break because the
orchestrator is restarting) and the failure is LOUD — a warn log plus
`fetch_ok` / `last_fetch_at`, surfaced on `/health` (`:8086`, the
WARP-1092 precedent) so a rotated service token shows up in health, not as
months of undiagnosed drift.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Callable, Optional

import httpx

# WARP-236 — same internal-mTLS treatment as the chat calls in llm.py.
from _shared.internal_tls import base_url as _internal_base_url, httpx_client_kwargs

logger = logging.getLogger("voice.persona")

DEFAULT_PERSONA_PROMPT_PATH = "/api/persona/prompt"
# Short in-session TTL (§14): a greeting burst inside one interaction is
# served from cache; the next session (anything later than this) re-fetches
# so a Settings change is live on the next voice session without a restart.
DEFAULT_PERSONA_TTL_S = 60.0
# Keep the greeting path snappy: this rides synchronously in front of the
# LLM call, so it gets the health-probe budget, not the chat budget.
DEFAULT_PERSONA_TIMEOUT_S = 2.0


class PersonaFetcher:
    """Fetch (and briefly cache) the orchestrator's composed persona block.

    Thread-safety note: called only from the single pipeline worker thread
    (plus one optional startup prime before the worker exists), so plain
    attributes are fine — same model as the rest of the pipeline state.
    """

    def __init__(
        self,
        base_url: str,
        *,
        path: str = DEFAULT_PERSONA_PROMPT_PATH,
        bearer_token: Optional[str] = None,
        ttl_s: float = DEFAULT_PERSONA_TTL_S,
        timeout_s: float = DEFAULT_PERSONA_TIMEOUT_S,
        time_source: Callable[[], float] = time.monotonic,
    ):
        self._base_url = _internal_base_url(base_url.rstrip("/"))
        self._path = path
        self._bearer_token = bearer_token
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        # Injectable monotonic clock for deterministic TTL tests.
        self._time_source = time_source

        # Observability (read by /health): None = never attempted.
        self.fetch_ok: Optional[bool] = None
        self.last_fetch_at: Optional[float] = None  # wall time (time.time())

        self._cached: Optional[str] = None
        self._cached_at: Optional[float] = None  # via time_source

    def get_block(self) -> Optional[str]:
        """The composed persona block, or None (caller falls back to the
        built-in greeting prompt). Never raises."""
        now = self._time_source()
        if self._cached_at is not None and (now - self._cached_at) < self._ttl_s:
            return self._cached
        return self._fetch(now)

    def _fetch(self, now: float) -> Optional[str]:
        self.last_fetch_at = time.time()
        self._cached_at = now  # both outcomes hold for the TTL
        try:
            resp = httpx.get(
                f"{self._base_url}{self._path}",
                timeout=self._timeout_s,
                headers=self._headers(),
                **httpx_client_kwargs(),
            )
        except (httpx.HTTPError, OSError) as exc:
            logger.warning(
                "persona fetch failed (%s%s): %s — greeting turns use the "
                "built-in prompt until the next attempt",
                self._base_url,
                self._path,
                exc,
            )
            self.fetch_ok = False
            self._cached = None
            return None

        if not resp.is_success:
            logger.warning(
                "persona fetch returned %s from %s%s — greeting turns use "
                "the built-in prompt until the next attempt (a 401/403 here "
                "usually means a rotated ORCHESTRATOR_TOKEN)",
                resp.status_code,
                self._base_url,
                self._path,
            )
            self.fetch_ok = False
            self._cached = None
            return None

        self.fetch_ok = True
        block = (resp.text or "").strip()
        self._cached = block or None  # an empty block is "no persona set"
        return self._cached

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "text/plain"}
        if self._bearer_token:
            h["Authorization"] = f"Bearer {self._bearer_token}"
        return h


def build_persona_fetcher_from_env() -> Optional[PersonaFetcher]:
    """Resolve env config → PersonaFetcher, mirroring
    `voice.llm.build_llm_from_env` (`LLM_URL` + `ORCHESTRATOR_TOKEN`).
    Returns None under `LLM_URL=__mock__` — the MockLLM path has no
    orchestrator to fetch from."""
    raw = (os.environ.get("LLM_URL") or "").strip()
    if raw == "__mock__":
        return None
    from voice.llm import DEFAULT_LLM_URL  # local import — avoids a cycle

    base_url = raw or DEFAULT_LLM_URL
    token = (os.environ.get("ORCHESTRATOR_TOKEN") or "").strip() or None
    ttl_raw = (os.environ.get("PERSONA_PROMPT_TTL_S") or "").strip()
    try:
        ttl_s = float(ttl_raw) if ttl_raw else DEFAULT_PERSONA_TTL_S
    except ValueError:
        logger.warning(
            "PERSONA_PROMPT_TTL_S=%r is not a number — using the default %ss",
            ttl_raw,
            DEFAULT_PERSONA_TTL_S,
        )
        ttl_s = DEFAULT_PERSONA_TTL_S
    return PersonaFetcher(base_url, bearer_token=token, ttl_s=ttl_s)
