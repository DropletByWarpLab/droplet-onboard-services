"""Append-only audit log for the ops-console support-client surface.

WARP-337. Every /ops/* request is recorded with timestamp, identity,
method, path, status code, and a short detail field — JSONL on disk,
mirrored to the structured logger so docker logs / a Loki sidecar /
support's aggregator can ingest it.

Why this lives next to the FastAPI app, not in a database
---------------------------------------------------------
The point of the audit log is to tell support and the customer
(after the fact) exactly what was looked at and what was changed
on the box during a support engagement. That makes it the *trust
boundary* with the customer — it needs to:

  - work even if Postgres is wedged (the most common reason
    support is connected in the first place is "something is
    broken"),
  - survive an ops-console restart (operator restarted the
    service mid-debug is exactly when we want forensic clarity),
  - be append-only (so the operator-with-token can't quietly
    rewrite history if they're investigating their own mistake),
  - be cheap to read line-by-line (jq / grep tooling).

JSONL on a volume-mounted file satisfies all four. A future
follow-up can ship lines off-box to a central support aggregator
via an inotify tail — that's tooling on top of this file format,
not a replacement for it.

File path
---------
Default: `/var/log/ops-console/audit.jsonl`. Override via
`OPS_AUDIT_LOG`. The directory is created on first write so the
caller doesn't have to pre-mkdir the volume mount. If the write
fails (read-only fs, no perms), the structured logger still records
the entry — losing the file is logged but doesn't 5xx the request.

Identity field
--------------
Bearer-token auth has no user concept today, so identity is the
constant string `"support"`. When OIDC / per-engagement credentials
land, swap to a richer claim — only this module's `_resolve_identity`
needs to change.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

logger = logging.getLogger("ops.audit")

# Default path is under /var/log/ so the volume mount survives an
# ops-console container restart. The directory is auto-created on
# first write — operators don't need to pre-`mkdir -p`.
DEFAULT_AUDIT_LOG = "/var/log/ops-console/audit.jsonl"
AUDIT_LOG = Path(os.environ.get("OPS_AUDIT_LOG", DEFAULT_AUDIT_LOG))

# Paths we deliberately do NOT audit — they're noise (uvicorn-level
# health probes, the static serving of the redirect, etc.) and would
# drown the support-relevant lines under per-second healthcheck spam.
_AUDIT_SKIP_PREFIXES = (
    "/healthz",        # FastAPI/uvicorn health check, fires every few sec
    "/favicon.ico",
)


def _resolve_identity(request: Request) -> str:
    """Map an authenticated request to a stable identity string.

    Today: single bearer token → constant "support". Future: pull from
    a JWT sub claim when OIDC lands. Kept narrow so the only place to
    change is this function.
    """
    return "support"


def _write_jsonl_line(entry: dict[str, Any]) -> None:
    """Append one JSON line to the audit log file. Best-effort: a
    write failure is logged but never raises into the request path."""
    line = json.dumps(entry, separators=(",", ":"), default=str)
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with AUDIT_LOG.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError as exc:
        # Don't 5xx the operator's request just because the audit
        # file is read-only — surface the failure loudly via the
        # logger so the structured-log pipeline still records it.
        logger.warning(
            "audit write to %s failed: %s — falling back to logger only",
            AUDIT_LOG, exc,
        )
    # Always mirror to the structured logger so a Loki / CloudWatch
    # collector picks it up from docker logs even if the on-disk file
    # is gone.
    logger.info("AUDIT %s", line)


def record(
    *,
    method: str,
    path: str,
    status: int,
    identity: str,
    latency_ms: float,
    detail: str | None = None,
) -> None:
    """Write one audit entry. Used by the middleware and by anything
    that needs to record a non-request action (e.g. boot, shutdown)."""
    _write_jsonl_line({
        "ts": time.time(),
        "method": method,
        "path": path,
        "status": status,
        "identity": identity,
        "latency_ms": round(latency_ms, 2),
        "detail": detail,
    })


class AuditMiddleware(BaseHTTPMiddleware):
    """Records every /ops/* request after it completes.

    Captures status code so support can see what worked vs what 401'd
    or 5xx'd during the engagement. Records latency so the on-disk
    audit doubles as a thin performance signal.
    """

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        # Skip noisy paths that aren't operator actions.
        path = request.url.path
        if any(path.startswith(p) for p in _AUDIT_SKIP_PREFIXES):
            return await call_next(request)
        # Only audit the operator surface, not the static / root.
        if not path.startswith("/ops"):
            return await call_next(request)

        identity = _resolve_identity(request)
        started = time.perf_counter()
        status = 500
        detail: str | None = None
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        except Exception as exc:
            detail = f"{exc.__class__.__name__}: {exc}"
            raise
        finally:
            latency_ms = (time.perf_counter() - started) * 1000
            record(
                method=request.method,
                path=path,
                status=status,
                identity=identity,
                latency_ms=latency_ms,
                detail=detail,
            )


def install(app: ASGIApp) -> None:
    """Attach the audit middleware to a FastAPI/Starlette app.

    Idempotent at the call site: callers can invoke once during app
    setup. The middleware itself is stateless, so installing twice
    would just record each request twice — keep it to one call.
    """
    # Starlette / FastAPI accept `add_middleware(cls)` — but ASGIApp
    # type alone doesn't expose that, so cast at the boundary. Callers
    # always pass a FastAPI / Starlette instance.
    app.add_middleware(AuditMiddleware)  # type: ignore[attr-defined]
