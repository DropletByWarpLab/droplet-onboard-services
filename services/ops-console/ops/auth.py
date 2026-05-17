"""Single-bearer-token gate for /ops/*. Operator gets the token via a
secure channel (1Password / encrypted chat); never goes into a URL or
gets logged.

Why not JWT / OIDC: ops-console is internal Warp Lab tooling reached
through the reverse tunnel (future). The tunnel is the actual first
line of defence — bearer-token here just stops "I left the tab open
on my laptop" mistakes. When the operator team grows past ~5 people
or the fleet grows past 50 units, this gets replaced with proper
OIDC + per-operator audit. Until then, simple beats "right".

Compare: dashboard /api/* uses session cookies (user JWT). ops-console
is a SEPARATE trust boundary — Warp Lab operator vs end customer. The
tokens MUST not be shared with the customer.
"""
from __future__ import annotations

import logging
import os
import secrets

from fastapi import Header, HTTPException, status

logger = logging.getLogger("ops.auth")

# Token loaded once at module import. scripts/lib/secrets.sh (WARP-337)
# generates OPS_TOKEN in `generate_env` and backfills it via
# `_migrate_ensure_key` so existing installs get one on the next
# `./scripts/setup.sh` run — production paths should never hit the
# ephemeral fallback below.
#
# The ephemeral path stays as a developer escape hatch: running
# `uvicorn main:app` against a bare repo without `.env` shouldn't 500
# at every request. We log the value loudly so it's discoverable in
# `docker logs` if support needs it during a misconfigured-deployment
# fire drill, but the structured-log line carries an explicit "NOT
# suitable for production — run ./scripts/setup.sh" hint so operators
# never assume the ephemeral mode is the intended one.
_OPS_TOKEN = (os.environ.get("OPS_TOKEN") or "").strip()
if not _OPS_TOKEN:
    _OPS_TOKEN = secrets.token_hex(32)
    logger.warning(
        "OPS_TOKEN env not set — generated ephemeral token for this "
        "process (regenerates on every container restart, invalidating "
        "any saved bearer). NOT suitable for production. Run "
        "`./scripts/setup.sh` once on the host to provision a stable "
        "OPS_TOKEN in .env. Generated value (this run only): %s",
        _OPS_TOKEN,
    )


def require_token(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency that 401s on missing / mismatched bearer.

    Usage:
        @router.get("/ops/health", dependencies=[Depends(require_token)])
        def health(): ...

    Constant-time compare via secrets.compare_digest so timing-side-
    channel attacks don't leak the token a byte at a time.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    scheme, _, presented = authorization.partition(" ")
    if scheme.lower() != "bearer" or not presented:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be `Bearer <token>`",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not secrets.compare_digest(presented, _OPS_TOKEN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid token",
        )
