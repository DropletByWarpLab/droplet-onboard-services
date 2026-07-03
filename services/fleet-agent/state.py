"""WARP-963 — runtime state for the fleet-agent.

Everything here lives in the service's state dir (a named Docker volume
on the box, ``fleet-agent-state``) and is NEVER tracked in git:

  identity.json          — machine_id + ingest_token + server-issued
                           cadence config from the one-time
                           /agents/register call. chmod 0600 best-effort
                           (the ingest token is a credential).
  heartbeat-spool.jsonl  — bounded offline spool (see spool.py).

Corrupt state fails OPEN: an unreadable identity.json is treated as
"not registered" (logged), never as a crash.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger("fleet_agent.state")

_IDENTITY_FILE = "identity.json"
_SPOOL_FILE = "heartbeat-spool.jsonl"


@dataclass(frozen=True)
class Identity:
    machine_id: str
    ingest_token: str
    ingest_endpoint: str
    intervals: dict


class StateStore:
    def __init__(self, state_dir: Path) -> None:
        self._dir = state_dir
        self._dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self._dir, 0o700)
        except OSError:  # pragma: no cover — best-effort on non-POSIX hosts
            pass

    @property
    def spool_path(self) -> Path:
        return self._dir / _SPOOL_FILE

    @property
    def identity_path(self) -> Path:
        return self._dir / _IDENTITY_FILE

    def identity(self) -> Optional[Identity]:
        path = self.identity_path
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return Identity(
                machine_id=str(raw["machine_id"]),
                ingest_token=str(raw["ingest_token"]),
                ingest_endpoint=str(raw.get("ingest_endpoint", "")),
                intervals=dict(raw.get("intervals", {})),
            )
        except (OSError, ValueError, KeyError, TypeError) as exc:
            # Fail open: a corrupt identity means "re-register when a
            # provisioning code is available", never a crash.
            logger.warning("identity.json unreadable (%s) — treating as unregistered", exc)
            return None

    def save_identity(
        self,
        machine_id: str,
        ingest_token: str,
        ingest_endpoint: str,
        intervals: dict,
    ) -> None:
        payload = {
            "machine_id": machine_id,
            "ingest_token": ingest_token,
            "ingest_endpoint": ingest_endpoint,
            "intervals": intervals,
        }
        path = self.identity_path
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        try:
            os.chmod(path, 0o600)  # the ingest token is a credential
        except OSError:  # pragma: no cover — best-effort on non-POSIX hosts
            pass
