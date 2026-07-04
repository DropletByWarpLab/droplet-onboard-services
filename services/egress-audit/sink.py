"""WARP-268 — local NDJSON audit trail + orchestrator anomaly shipping.

NDJSON is the primary record of truth (every flow), one file per UTC day
under /var/lib/droplet/egress-audit/, pruned past retention. Anomalies
additionally POST to the orchestrator's /api/security/egress-anomaly with
the SERVICE_TOKEN_EGRESS_AUDIT bearer (urllib only — the host python has
no pip deps). Shipping is fail-soft with warn-once, mirroring
services/routing/egress_meter.py's token/transport handling.
"""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)


class NdjsonSink:
    def __init__(self, directory: Path, clock: Callable[[], float] = time.time,
                 retention_days: int = 30) -> None:
        self._dir = Path(directory)
        self._clock = clock
        self._retention = retention_days
        self._current_day: Optional[str] = None

    def _day(self) -> str:
        return datetime.fromtimestamp(self._clock(), tz=timezone.utc).strftime("%Y%m%d")

    def _prune(self, today: str) -> None:
        cutoff = (datetime.strptime(today, "%Y%m%d").replace(tzinfo=timezone.utc)
                  - timedelta(days=self._retention)).strftime("%Y%m%d")
        for path in self._dir.glob("egress-*.ndjson"):
            stamp = path.stem.removeprefix("egress-")
            if stamp.isdigit() and stamp < cutoff:
                try:
                    path.unlink()
                except OSError as exc:
                    logger.warning("could not prune %s: %s", path, exc)

    def write(self, line: str) -> None:
        day = self._day()
        if day != self._current_day:
            self._dir.mkdir(parents=True, exist_ok=True)
            self._prune(day)
            self._current_day = day
        with open(self._dir / f"egress-{day}.ndjson", "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


class OrchestratorClient:
    def __init__(self, base_url: str, token: str, opener=None,
                 timeout: float = 5.0) -> None:
        self._url = base_url.rstrip("/") + "/api/security/egress-anomaly"
        self._token = token
        self._opener = opener or urllib.request.urlopen
        self._timeout = timeout
        self._outage_logged = False
        self._token_warned = False

    def post_anomaly(self, payload: dict) -> bool:
        if not self._token:
            if not self._token_warned:
                logger.warning(
                    "SERVICE_TOKEN_EGRESS_AUDIT unset — anomalies stay local-only "
                    "until scripts/setup.sh provisions the bearer (NDJSON is "
                    "unaffected)."
                )
                self._token_warned = True
            return False
        request = urllib.request.Request(
            self._url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
            },
            method="POST",
        )
        try:
            with self._opener(request, timeout=self._timeout) as response:
                ok = 200 <= response.status < 300
        except (urllib.error.URLError, OSError) as exc:
            if not self._outage_logged:
                logger.warning(
                    "egress-anomaly POST failed (%s) — suppressing repeats until "
                    "recovery; records keep landing in the local NDJSON.", exc,
                )
                self._outage_logged = True
            return False
        if ok:
            self._outage_logged = False
        return ok
