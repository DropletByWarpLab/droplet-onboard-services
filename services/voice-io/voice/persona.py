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

Fetch semantics — stale-while-revalidate (WARP-3124): a greeting turn never
waits on this GET. `get_block()` returns whatever is cached right now and,
once the short TTL (default 60 s) has passed, starts ONE background refresh;
the next greeting sees the result, so a Settings change is live within about
one TTL without a restart. The very first call (nothing cached yet) returns
None — the built-in greeting prompt — while the first fetch runs; main.py
primes at pipeline build so that fetch has normally landed before anyone
speaks. The TTL also paces failures, so a DOWN orchestrator is asked at most
once per TTL. Failures never raise, and a failed refresh keeps the last good
block (a restarting orchestrator must not strip the owner's persona). The
failure is still LOUD — a warn log plus `fetch_ok` / `last_fetch_at`,
surfaced on `/health` (`:8086`, the WARP-1092 precedent) so a rotated service
token shows up in health, not as months of undiagnosed drift.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable, Optional

import httpx

# WARP-236 — same internal-mTLS treatment as the chat calls in llm.py.
from _shared.internal_tls import base_url as _internal_base_url, httpx_client_kwargs

logger = logging.getLogger("voice.persona")


def _new_httpx_client() -> httpx.Client:
    """Build the reused httpx.Client for one PersonaFetcher (WARP-1433).

    The mTLS material rides on the pool, built once, instead of the old
    module-level ``httpx.get`` per greeting fetch (a fresh TCP + full mTLS
    handshake + CA re-read each time). Reused across every ``get_block()``
    for the fetcher's lifetime, closed on shutdown. Module-level so tests
    can inject a MockTransport + count constructions.
    """
    return httpx.Client(**httpx_client_kwargs())


DEFAULT_PERSONA_PROMPT_PATH = "/api/persona/prompt"
# Short in-session TTL (§14): a greeting burst inside one interaction is
# served from cache; the next session (anything later than this) re-fetches
# so a Settings change is live on the next voice session without a restart.
DEFAULT_PERSONA_TTL_S = 60.0
# The health-probe budget, not the chat budget. The GET runs on a background
# refresh thread (WARP-3124), so this bounds how long a refresh — and close()
# waiting on one — can take; it is never added to a greeting turn.
DEFAULT_PERSONA_TIMEOUT_S = 2.0


class PersonaFetcher:
    """Fetch (and briefly cache) the orchestrator's composed persona block.

    Thread-safety: `get_block()` runs on the pipeline worker thread (and once
    at startup for the prime); refreshes run on a short-lived background
    thread; /health reads `fetch_ok` / `last_fetch_at`. `_lock` guards the
    cache and the single-flight flag, so at most one refresh is in flight and
    a reader never sees a half-updated cache.
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
        # When the cache was last settled (a refresh finished, either way),
        # via time_source. None = never attempted → the first get_block()
        # starts a refresh.
        self._cached_at: Optional[float] = None
        # WARP-3124 — single-flight background refresh + shutdown latch.
        self._lock = threading.Lock()
        self._refreshing = False
        self._refresh_thread: Optional[threading.Thread] = None
        self._closed = False
        # WARP-1433 — ONE pooled httpx.Client reused across every fetch and
        # closed on shutdown; the mTLS material is applied once, on the pool.
        self._client = _new_httpx_client()

    def get_block(self) -> Optional[str]:
        """The cached persona block, or None (caller falls back to the
        built-in greeting prompt). Never raises and never waits on the
        network: once the TTL has passed it starts ONE background refresh
        and returns the stale value right away (stale-while-revalidate)."""
        now = self._time_source()
        with self._lock:
            block = self._cached
            stale = self._cached_at is None or (now - self._cached_at) >= self._ttl_s
            if stale and not self._refreshing and not self._closed:
                self._start_refresh_locked()
        return block

    def wait_for_refresh(self, timeout: float) -> bool:
        """Wait up to `timeout` seconds for an in-flight background refresh.
        Returns True once none is running. Used by close() and tests — the
        greeting path never calls it."""
        with self._lock:
            thread = self._refresh_thread
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    def _start_refresh_locked(self) -> None:
        """Spawn the one background refresh. Caller holds `_lock`."""
        thread = threading.Thread(
            target=self._refresh, name="persona-refresh", daemon=True,
        )
        self._refreshing = True
        try:
            thread.start()
        except RuntimeError as exc:  # thread exhaustion — retry next call
            self._refreshing = False
            logger.warning("persona refresh not started: %s", exc)
            return
        self._refresh_thread = thread

    def _refresh(self) -> None:
        try:
            self._fetch()
        finally:
            with self._lock:
                self._refreshing = False

    def _fetch(self) -> None:
        """One GET on the refresh thread. Settles the cache + health fields;
        never raises."""
        attempted_at = time.time()
        try:
            resp = self._client.get(
                f"{self._base_url}{self._path}",
                timeout=self._timeout_s,
                headers=self._headers(),
            )
        except Exception as exc:  # noqa: BLE001 — see below
            # httpx / OS errors, or a client closed during shutdown: the
            # refresh thread must record the failure, never die on it.
            logger.warning(
                "persona fetch failed (%s%s): %s — greeting turns keep the "
                "last good persona (or the built-in prompt) until the next "
                "attempt",
                self._base_url,
                self._path,
                exc,
            )
            self._settle(ok=False, attempted_at=attempted_at)
            return

        if not resp.is_success:
            logger.warning(
                "persona fetch returned %s from %s%s — greeting turns keep "
                "the last good persona (or the built-in prompt) until the "
                "next attempt (a 401/403 here usually means a rotated "
                "ORCHESTRATOR_TOKEN)",
                resp.status_code,
                self._base_url,
                self._path,
            )
            self._settle(ok=False, attempted_at=attempted_at)
            return

        block = (resp.text or "").strip()
        # An empty block is a real answer: "no persona set".
        self._settle(ok=True, attempted_at=attempted_at, block=block or None)

    def _settle(
        self, *, ok: bool, attempted_at: float, block: Optional[str] = None,
    ) -> None:
        with self._lock:
            self.fetch_ok = ok
            self.last_fetch_at = attempted_at
            # Both outcomes hold for the TTL, so a down orchestrator is asked
            # at most once per TTL.
            self._cached_at = self._time_source()
            if ok:
                self._cached = block
            # A failure keeps whatever was cached: the last good block, or
            # None when nothing good was ever fetched.

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "text/plain"}
        if self._bearer_token:
            h["Authorization"] = f"Bearer {self._bearer_token}"
        return h

    def close(self) -> None:
        """Close the pooled httpx.Client (WARP-1433). Idempotent. Starts no
        further refresh and waits, bounded by the fetch timeout, for one in
        flight so it isn't cut off mid-request."""
        with self._lock:
            self._closed = True
        self.wait_for_refresh(self._timeout_s + 1.0)
        self._client.close()


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
