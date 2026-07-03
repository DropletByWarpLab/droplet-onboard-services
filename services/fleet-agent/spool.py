"""WARP-963 — bounded on-disk heartbeat spool.

Portal unreachable ⇒ heartbeats append here (JSON-lines) instead of
being lost; portal back ⇒ they replay oldest-first. The portal keys
Heartbeat rows on ``(machine_id, ts)`` and treats replays as no-ops, so
re-sending after a reconnect is safe by contract.

Bounded by ``max_entries`` (oldest drop first) so a long outage can
never fill the box's disk — the agent must not degrade the appliance.
Corrupt lines are skipped, not fatal.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Awaitable, Callable, Protocol

logger = logging.getLogger("fleet_agent.spool")


class SendOutcome(Protocol):
    """Duck-typed result the drain ``sender`` must return — satisfied by
    ``portal.PortalResult`` as-is, so the drain path classifies exactly
    like the live-send path (no coupling to the portal module here)."""

    @property
    def ok(self) -> bool: ...

    @property
    def should_spool(self) -> bool: ...


class DiskSpool:
    def __init__(self, path: Path, max_entries: int) -> None:
        self._path = path
        self._max = max(1, max_entries)
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def entries(self) -> list[dict]:
        if not self._path.exists():
            return []
        out: list[dict] = []
        for line in self._path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except ValueError:
                logger.warning("spool: skipping corrupt line")
                continue
            if isinstance(parsed, dict):
                out.append(parsed)
        return out

    def entry_count(self) -> int:
        return len(self.entries())

    def append(self, entry: dict) -> None:
        entries = self.entries()
        entries.append(entry)
        if len(entries) > self._max:
            dropped = len(entries) - self._max
            entries = entries[-self._max :]
            logger.warning(
                "spool bound (%d) reached — dropped %d oldest heartbeat(s)",
                self._max,
                dropped,
            )
        self._write(entries)

    async def drain(
        self, sender: Callable[[dict], Awaitable[SendOutcome]]
    ) -> bool:
        """Replay oldest-first through ``sender``. A non-retryable 4xx
        reject (``should_spool`` False) is a poison pill: it is DROPPED so
        it can never wedge the queue head, and the drain continues. A
        transient failure (transport/5xx/429/skipped) stops the drain and
        persists whatever is still unsent — same fail-open classification
        the live-send path uses. Returns True when the spool is fully
        drained (every entry either delivered or dropped as a poison pill)."""
        entries = self.entries()
        if not entries:
            return True
        remaining = list(entries)
        for entry in entries:
            result = await sender(entry)
            if result.ok:
                remaining.pop(0)
                continue
            if result.should_spool:
                # Retryable — stop here, keep the head and everything behind
                # it for the next tick.
                self._write(remaining)
                return False
            # Poison pill (non-retryable 4xx): replaying it forever would
            # wedge the queue head until the disk bound evicts it. Drop it
            # and keep draining the rest.
            logger.warning(
                "spool: dropping poison-pill entry (HTTP %s) — not retryable",
                getattr(result, "status", "?"),
            )
            remaining.pop(0)
        # Every entry was delivered or dropped as a poison pill.
        self._write(remaining)
        return True

    def _write(self, entries: list[dict]) -> None:
        # Atomic write: a crash mid-write must never corrupt/truncate the
        # spool. Write to a temp file in the SAME directory (so os.replace
        # is a same-filesystem atomic rename), flush + fsync the bytes to
        # disk, then atomically swap it onto the target path.
        body = "".join(json.dumps(e, separators=(",", ":")) + "\n" for e in entries)
        tmp_path = self._path.with_name(self._path.name + ".tmp")
        with open(tmp_path, "w", encoding="utf-8") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, self._path)
