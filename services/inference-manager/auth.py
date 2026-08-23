"""Shared-secret authentication middleware for inference-manager.

In production, inference-manager is an internal service on the inference host.
Today's direct-inference path goes to Ollama on port 11434 and bypasses this
service. Lifecycle traffic (model pull/sync/list/delete) hits this service and
is consumed by fleet-management tooling and operator scripts
(``./scripts/pull-models.sh``, etc.).

Auth contract — read this before adding new routes:

* :class:`AuthMiddleware` gates **every** path on the manager except those in
  :data:`_EXEMPT_PATHS` (currently just ``/health`` for Docker health checks).
  Any future route — including a reverse-proxy/passthrough to Ollama, a
  metrics endpoint, etc. — is gated automatically. Do not assume auth is
  scoped to ``/models/*``.
* When ``INFERENCE_AUTH_TOKEN`` is empty: permissive mode, every caller
  accepted. On a provisioned box that never happens — ``scripts/lib/secrets.sh``
  mints the key on a fresh install and backfills it on an existing one — but it
  is a SILENT failure mode if it ever does, so ``setup_auth`` logs it loudly.
* When ``AUTH_TOKEN`` is set: every caller — including the orchestrator's
  ai-gateway in ``droplet-onboard-services`` if it ever talks to this service —
  MUST send ``Authorization: Bearer <token>``. There is no allowlist of
  "internal" callers; the middleware does not know who you are.

See ``docs/AUTHENTICATION.md`` for the operator-facing deployment contract
and the cross-repo coupling with ``droplet-onboard-services``.
"""

from __future__ import annotations

import hmac
import logging
import os

from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

# Paths that are always accessible (e.g. Docker health checks).
_EXEMPT_PATHS = {"/health"}

# WARP-2131 (vendored divergence): read the key by the name it has in `.env`.
#
# Upstream reads `AUTH_TOKEN` and the compose file maps
# `AUTH_TOKEN=${INFERENCE_AUTH_TOKEN}`. That mapping cannot be used here. This
# repo delivers secrets through `env_file: ../.env`, and re-declaring an
# env_file key as a `${VAR}` substitution resolves it against `docker/.env` —
# a DIFFERENT file, untracked and absent outside a provisioned box — yielding
# "". Because `environment:` outranks `env_file:`, that empty string SHADOWS
# the real value. The orchestrator block in docker-compose.yml carries the
# post-mortem: the same mistake blanked SERVICE_TOKEN_RAG_EVAL and 401'd 15
# consecutive nightly eval runs.
#
# Reading the `.env` name directly means env_file delivers it with no
# substitution anywhere, so there is nothing to shadow. The module global keeps
# its name because the test suite patches `auth.AUTH_TOKEN` directly.
AUTH_TOKEN = os.getenv("INFERENCE_AUTH_TOKEN", "")


class AuthMiddleware(BaseHTTPMiddleware):
    """Validate ``Authorization: Bearer <token>`` on every request.

    * If *AUTH_TOKEN* is empty the middleware is a no-op (dev mode).
    * ``/health`` is always exempt so Docker health checks work.
    """

    async def dispatch(self, request: Request, call_next):
        if AUTH_TOKEN and request.url.path.rstrip("/") not in _EXEMPT_PATHS:
            header = request.headers.get("authorization", "")
            # Constant-time compare: this middleware is the only access control
            # for EVERY non-exempt path on the manager — only ``/health`` is
            # exempt, so the lifecycle API (model pull/delete/sync), ``/proxy``,
            # ``/metrics`` and any route added later are all gated here (do not
            # assume auth is scoped to ``/models/*``). Ollama itself (:11434) has
            # no auth, so this one gate must not leak the token via response
            # timing: a plain ``!=`` short-circuits on the first differing byte,
            # enabling byte-by-byte recovery.
            if not hmac.compare_digest(header, f"Bearer {AUTH_TOKEN}"):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Unauthorized"},
                )
        return await call_next(request)


def setup_auth(app: FastAPI) -> None:
    """Add :class:`AuthMiddleware` to *app* and log the auth mode."""
    if AUTH_TOKEN:
        logger.info("Auth middleware enabled — requests require a valid token")
    else:
        # WARP-2131: louder than upstream's wording. On this shape the service
        # is only reachable from inside the compose network, but its
        # `POST /models/pull` hands its identifier straight to the runtime —
        # an arbitrary-registry-pull primitive. "Permissive" here means every
        # caller that can reach the container, not just a friendly dev.
        logger.warning(
            "INFERENCE_AUTH_TOKEN is EMPTY — every caller is accepted on every "
            "route except /health. scripts/lib/secrets.sh should have minted "
            "this; check .env before treating this box as provisioned."
        )
    app.add_middleware(AuthMiddleware)
