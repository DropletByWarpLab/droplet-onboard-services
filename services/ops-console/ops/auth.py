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

# Token loaded once at module import. setup.sh writes a 32-byte hex
# string to .env as OPS_TOKEN; if missing we generate one at startup
# so the dev box still works (logged loudly so operators don't ship
# a generated-token deployment).
_OPS_TOKEN = (os.environ.get("OPS_TOKEN") or "").strip()
if not _OPS_TOKEN:
    _OPS_TOKEN = secrets.token_hex(32)
    logger.warning(
        "OPS_TOKEN env not set — generated ephemeral token for this "
        "process. NOT suitable for production. Set OPS_TOKEN in .env "
        "to a stable secret. Generated value (this run only): %s",
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
