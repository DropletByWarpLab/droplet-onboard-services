"""In-memory operation store for safe-apply writes (WARP-40).

Every write to the routing service (POST/PUT/DELETE) is assigned an operation
id. The id is surfaced to callers via the `X-Operation-Id` response header and
exposed for polling at `GET /operations/{id}`. The orchestrator hands the id to
the dashboard so the UI can distinguish:

  - pending      — the apply is still in flight
  - applied      — the router accepted the change (HTTP 2xx)
  - rolled_back  — the router reverted (HTTP 5xx, or a ConnectionLost from
                    safe_apply's rollback path)

Entries live for 5 minutes, long enough for the dashboard to poll through a
slow apply + a rollback window, short enough not to leak memory.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from typing import Literal, Optional

OperationState = Literal["pending", "applied", "rolled_back"]

# Matches safe_apply's 60s timeout × 5 — enough headroom for dashboard polling
# through a slow apply followed by a rollback without evicting the record mid-flight.
OPERATION_TTL_SEC = 300


@dataclass
class Operation:
    id: str
    state: OperationState
    started_at: float
    finished_at: Optional[float] = None
    reason: Optional[str] = None


_store: dict[str, Operation] = {}
_lock = threading.Lock()


def register() -> str:
    """Create a fresh pending operation and return its id."""
    op = Operation(id=uuid.uuid4().hex, state="pending", started_at=time.time())
    with _lock:
        _purge_locked()
        _store[op.id] = op
    return op.id


def mark_applied(op_id: str) -> None:
    _update_terminal(op_id, "applied", None)


def mark_rolled_back(op_id: str, reason: str) -> None:
    _update_terminal(op_id, "rolled_back", reason)


def get(op_id: str) -> Optional[Operation]:
    with _lock:
        _purge_locked()
        return _store.get(op_id)


def clear() -> None:
    """For tests: drop all records."""
    with _lock:
        _store.clear()


def _update_terminal(op_id: str, state: OperationState, reason: Optional[str]) -> None:
    with _lock:
        op = _store.get(op_id)
        if op is None or op.state != "pending":
            return
        op.state = state
        op.finished_at = time.time()
        op.reason = reason


def _purge_locked() -> None:
    """Evict entries older than OPERATION_TTL_SEC. Caller must hold _lock."""
    cutoff = time.time() - OPERATION_TTL_SEC
    expired = [
        op_id
        for op_id, op in _store.items()
        if (op.finished_at or op.started_at) < cutoff
    ]
    for op_id in expired:
        del _store[op_id]
