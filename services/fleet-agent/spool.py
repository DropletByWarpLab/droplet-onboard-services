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
from pathlib import Path
from typing import Awaitable, Callable

logger = logging.getLogger("fleet_agent.spool")


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

    async def drain(self, sender: Callable[[dict], Awaitable[bool]]) -> bool:
        """Replay oldest-first through ``sender``. Stops at the first
        failure, persisting whatever is still unsent. Returns True when
        the spool is fully drained."""
        entries = self.entries()
        if not entries:
            return True
        remaining = list(entries)
        for entry in entries:
            if not await sender(entry):
                self._write(remaining)
                return False
            remaining.pop(0)
        self._write([])
        return True

    def _write(self, entries: list[dict]) -> None:
        body = "".join(json.dumps(e, separators=(",", ":")) + "\n" for e in entries)
        self._path.write_text(body, encoding="utf-8")
