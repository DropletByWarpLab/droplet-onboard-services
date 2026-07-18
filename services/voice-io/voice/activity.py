"""Voice activity event reporter (WARP-1058).

Pushes pipeline events — wake outcomes, missed wakes, DSP wedge and
recovery — to the orchestrator's ``POST /api/voice/events``, which maps
them onto signed ``ActivityRow`` entries (kind ``voice``) for the
/voice page's "Recent voice activity" feed and the audit log.

Channel: the SAME voice-io → orchestrator HTTP path llm.py and
persona.py already use — base URL from ``LLM_URL`` (compose-default
``http://orchestrator:3000``), bearer auth from ``ORCHESTRATOR_TOKEN``
(the orchestrator's ``SERVICE_TOKEN_VOICE``), and the WARP-236
internal-mTLS helpers. No new transport, no new secret.

Threading contract: ``report()`` is called from the pipeline's worker
thread mid-frame-handling, so it must never block on the network. It
enqueues onto a bounded queue and returns; a daemon worker drains the
queue one POST at a time (sequential, so event order is preserved in
the activity chain). When the queue is full — orchestrator down for a
while — new events are DROPPED with a warning: the activity feed is
observability, and losing a row must never back-pressure the wake loop.
"""
from __future__ import annotations

import logging
import os
import queue
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

import httpx

# WARP-236 — internal mTLS: rewrite the orchestrator base URL to https:// and
# present voice-io's client cert when DROPLET_INTERNAL_TLS=1.
from _shared.internal_tls import base_url as _internal_base_url, httpx_client_kwargs

logger = logging.getLogger("voice.activity")

DEFAULT_EVENTS_PATH = "/api/voice/events"
# One event is a tiny JSON POST answered from memory; 5 s covers a busy
# orchestrator without letting a dead one pin the worker for long.
DEFAULT_POST_TIMEOUT_S = 5.0
# Bounded backlog while the orchestrator is unreachable. Wake events
# arrive at human speech pace (plus a debounced miss stream), so 64
# rides out a normal orchestrator restart; beyond that, drop.
DEFAULT_QUEUE_MAX = 64

# Wire event types — must stay in sync with the orchestrator's
# `voiceEventSchema` (apps/orchestrator/src/routes/voice.ts).
EVENT_TYPES = frozenset(
    {
        "wake_answered",
        "wake_heard",
        "wake_ignored",
        "wake_missed",
        "dsp_wedge",
        "dsp_recovered",
    }
)


@dataclass
class VoiceEvent:
    type: str
    at: float
    score: Optional[float] = None
    threshold: Optional[float] = None
    model: Optional[str] = None

    def to_payload(self) -> dict:
        payload: dict = {"type": self.type, "at": self.at}
        if self.score is not None:
            payload["score"] = self.score
        if self.threshold is not None:
            payload["threshold"] = self.threshold
        if self.model is not None:
            payload["model"] = self.model
        return payload


class ActivityReporter(ABC):
    """Non-blocking event sink the pipeline emits into."""

    @abstractmethod
    def report(
        self,
        type_: str,
        *,
        at: float,
        score: Optional[float] = None,
        threshold: Optional[float] = None,
        model: Optional[str] = None,
    ) -> None:
        """Queue one event. MUST return promptly — never network-bound."""

    def stop(self) -> None:  # pragma: no cover — overridden where needed
        """Release worker resources. Idempotent."""


class OrchestratorActivityReporter(ActivityReporter):
    """Production reporter: bounded queue + one daemon POST worker."""

    def __init__(
        self,
        base_url: str,
        bearer_token: Optional[str],
        events_path: str = DEFAULT_EVENTS_PATH,
        timeout_s: float = DEFAULT_POST_TIMEOUT_S,
        queue_max: int = DEFAULT_QUEUE_MAX,
    ):
        self._base_url = _internal_base_url(base_url.rstrip("/"))
        self._events_path = events_path
        self._bearer_token = bearer_token
        self._timeout_s = timeout_s
        self._queue: "queue.Queue[Optional[VoiceEvent]]" = queue.Queue(
            maxsize=max(1, queue_max),
        )
        self._dropped = 0
        # Daemon so process exit never waits on a wedged POST; stop()
        # is the polite path (sentinel + join).
        self._worker = threading.Thread(
            target=self._drain, name="voice-activity-reporter", daemon=True,
        )
        self._worker.start()

    def report(
        self,
        type_: str,
        *,
        at: float,
        score: Optional[float] = None,
        threshold: Optional[float] = None,
        model: Optional[str] = None,
    ) -> None:
        if type_ not in EVENT_TYPES:
            # A typo'd emitter is a bug, but the wake loop must not die
            # for it — the orchestrator would 400 the event anyway.
            logger.warning("unknown voice event type %r — dropped", type_)
            return
        event = VoiceEvent(
            type=type_, at=at, score=score, threshold=threshold, model=model,
        )
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            # Orchestrator has been unreachable long enough to fill the
            # backlog. Rate-limit the log to every 25th drop so a long
            # outage doesn't spam one line per wake.
            self._dropped += 1
            if self._dropped == 1 or self._dropped % 25 == 0:
                logger.warning(
                    "voice event queue full — dropped %r (%d dropped so far)",
                    type_, self._dropped,
                )

    def stop(self, timeout: float = 5.0) -> None:
        """Signal the worker and join it. Idempotent."""
        w = self._worker
        if w is None or not w.is_alive():
            return
        try:
            self._queue.put_nowait(None)  # sentinel
        except queue.Full:
            # Worker is alive and draining; it will see the sentinel we
            # place after the backlog clears — or the daemon flag ends it.
            try:
                self._queue.put(None, timeout=timeout)
            except queue.Full:
                return
        w.join(timeout=timeout)

    # ── worker ──

    def _drain(self) -> None:
        # Event-driven dispatch loop (blocks on queue.get) — not a
        # scheduling loop, per the repo's while-True rule carve-out.
        while True:
            event = self._queue.get()
            if event is None:  # sentinel from stop()
                return
            self._post_event(event)

    def _post_event(self, event: VoiceEvent) -> None:
        """POST one event. Failures are logged and the event is dropped —
        the feed is best-effort observability, never worth a retry storm
        against an orchestrator that's mid-restart."""
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self._bearer_token:
            headers["Authorization"] = f"Bearer {self._bearer_token}"
        try:
            resp = httpx.post(
                f"{self._base_url}{self._events_path}",
                json=event.to_payload(),
                timeout=self._timeout_s,
                headers=headers,
                **httpx_client_kwargs(),
            )
        except (httpx.HTTPError, OSError) as exc:
            logger.info(
                "voice event %r not delivered (%s) — dropped", event.type, exc,
            )
            return
        if not resp.is_success:
            logger.warning(
                "voice event %r rejected by orchestrator (%d) — dropped",
                event.type, resp.status_code,
            )


class MockActivityReporter(ActivityReporter):
    """Records events in-memory. Tests inject this directly."""

    def __init__(self) -> None:
        self.events: list[VoiceEvent] = []

    def report(
        self,
        type_: str,
        *,
        at: float,
        score: Optional[float] = None,
        threshold: Optional[float] = None,
        model: Optional[str] = None,
    ) -> None:
        self.events.append(
            VoiceEvent(
                type=type_, at=at, score=score, threshold=threshold, model=model,
            ),
        )

    def types(self) -> list[str]:
        return [e.type for e in self.events]


def build_reporter_from_env() -> Optional[ActivityReporter]:
    """Resolve env config → reporter, mirroring build_llm_from_env's
    conventions: ``LLM_URL`` is the orchestrator base (``__mock__`` →
    no orchestrator → no reporter), ``ORCHESTRATOR_TOKEN`` is the
    bearer. A missing token still builds the reporter — llm.py already
    warns loudly at startup, and the orchestrator's 401s are logged per
    event — so a token added without a redeploy of this code works.
    """
    raw = (os.environ.get("LLM_URL") or "").strip()
    if raw == "__mock__":
        logger.info("LLM_URL=__mock__ → no orchestrator, voice events disabled")
        return None
    if not raw:
        # Same compose-default DNS llm.py uses.
        raw = "http://orchestrator:3000"
    token = (os.environ.get("ORCHESTRATOR_TOKEN") or "").strip() or None
    return OrchestratorActivityReporter(base_url=raw, bearer_token=token)
