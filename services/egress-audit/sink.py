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
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)


def internal_tls_context() -> Optional[ssl.SSLContext]:
    """WARP-1061 — internal-mTLS client context for the anomaly POST.

    The collector is a HOST-side systemd unit (stdlib only — no pip deps and
    no importable services/_shared), so it reads the standard env contract
    directly. The launcher (/usr/local/sbin/droplet-egress-audit) exports
    DROPLET_INTERNAL_TLS from the repo .env and points DROPLET_TLS_* at the
    host-issued `egress-audit` bundle. Flag on → present the client cert +
    pin trust to the internal CA; unset/0 → None (plain HTTP, unchanged).
    """
    if os.environ.get("DROPLET_INTERNAL_TLS", "0") != "1":
        return None
    ctx = ssl.create_default_context(
        cafile=os.environ.get("DROPLET_TLS_CA", "/data/service-tls/ca.pem")
    )
    ctx.load_cert_chain(
        certfile=os.environ.get("DROPLET_TLS_CERT", "/data/service-tls/cert.pem"),
        keyfile=os.environ.get("DROPLET_TLS_KEY", "/data/service-tls/key.pem"),
    )
    return ctx


def internal_base_url(url: str) -> str:
    """Rewrite an internal http:// base URL to https:// when mTLS is on
    (mirrors services/_shared/internal_tls.base_url)."""
    if url.startswith("http://") and os.environ.get("DROPLET_INTERNAL_TLS", "0") == "1":
        return "https://" + url[len("http://"):]
    return url


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
        self._url = internal_base_url(base_url.rstrip("/")) + "/api/security/egress-anomaly"
        self._token = token
        if opener is None:
            # WARP-1061: bind the mTLS context once at construction — the
            # flag/bundle can't change under a running unit (systemd restart
            # re-reads both).
            ctx = internal_tls_context()
            def opener(request, timeout):  # noqa: ANN001 — urllib shim
                return urllib.request.urlopen(request, timeout=timeout, context=ctx)
        self._opener = opener
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
