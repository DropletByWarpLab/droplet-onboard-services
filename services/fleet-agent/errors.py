"""WARP-963 — agent-side error reporting to POST /agents/errors.

A bounded in-memory queue of fingerprinted error reports, drained by a
short apscheduler tick. Two hard rules keep this loop-safe:

  1. PORTAL failures are never enqueued — a portal outage producing
     error reports about the portal outage would self-amplify. Only the
     agent's OWN faults (collector reads, unexpected exceptions) queue.
  2. The queue is bounded (drop-oldest) so a repeating fault can't grow
     memory without bound.

Fingerprint = sha256 over (service, normalized title, normalized
message); the portal upserts on (machine_id, fingerprint), so repeats
dedupe server-side into a count.
"""

from __future__ import annotations

import hashlib
from collections import deque
from datetime import datetime, timezone
from typing import Optional

_DEFAULT_MAX_QUEUE = 100


def _normalize(text: str) -> str:
    return " ".join(text.split()).lower()


def fingerprint(service: str, title: str, message: str) -> str:
    basis = "\x1f".join((_normalize(service), _normalize(title), _normalize(message)))
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


class ErrorReporter:
    def __init__(self, max_queue: int = _DEFAULT_MAX_QUEUE) -> None:
        self._queue: deque[dict] = deque(maxlen=max(1, max_queue))

    def pending(self) -> int:
        return len(self._queue)

    def report(
        self,
        severity: str,
        service: str,
        title: str,
        message: str,
        stack: Optional[str] = None,
        context: Optional[dict] = None,
    ) -> None:
        if severity not in ("error", "critical"):
            severity = "error"
        payload = {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "severity": severity,
            "fingerprint": fingerprint(service, title, message),
            "service": service,
            "title": title[:500],
            "message": message,
        }
        if stack:
            payload["stack"] = stack
        if context:
            payload["context"] = context
        self._queue.append(payload)

    def peek(self) -> Optional[dict]:
        return self._queue[0] if self._queue else None

    def pop(self) -> None:
        if self._queue:
            self._queue.popleft()
