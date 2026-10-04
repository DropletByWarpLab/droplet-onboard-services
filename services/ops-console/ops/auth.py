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

import hashlib
import logging
import os
import secrets
from datetime import datetime, timezone

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
# at every request. WARP-3193 SEC-DATA-11: the value itself is NEVER
# logged — this token guards a docker.sock API and container logs leave
# the box in support bundles. Only a sha256 fingerprint is, so an
# operator can tell which token a process holds; a developer who needs
# a usable bearer sets OPS_TOKEN. The line carries an explicit "NOT
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
        "OPS_TOKEN in .env, or set OPS_TOKEN yourself for local dev. "
        "Ephemeral token sha256 fingerprint: %s",
        hashlib.sha256(_OPS_TOKEN.encode()).hexdigest()[:8],
    )


# WARP-3641: explicit expiry on the support window. OPS_ACCESS_EXPIRES_AT is an
# ISO-8601 timestamp (a trailing Z or an offset; no zone means UTC) set by
# whoever enables the `ops` profile for an engagement. Once it passes, every
# /ops/* request is refused even with the right token, until the value is
# changed and the container recreated. Unset = no expiry (the behaviour before
# this setting existed; a deployed box is not locked out by an upgrade).
# FAIL CLOSED on a value that does not parse: a typo must end the window, not
# silently leave it open forever. The deadline is checked per request, not
# only at boot, so a long-running container cannot outlive it.
_EXPIRY_ENV = "OPS_ACCESS_EXPIRES_AT"


def _parse_expiry(raw: str | None) -> datetime | None:
    value = (raw or "").strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        logger.error(
            "%s=%r is not an ISO-8601 timestamp; the support window is "
            "CLOSED until it is fixed", _EXPIRY_ENV, value,
        )
        return datetime.fromtimestamp(0, tz=timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


_ACCESS_EXPIRES_AT = _parse_expiry(os.environ.get(_EXPIRY_ENV))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def window_description() -> str:
    """One line for the boot audit record: when the window ends, if ever."""
    if _ACCESS_EXPIRES_AT is None:
        return "support window: no expiry configured"
    return f"support window ends {_ACCESS_EXPIRES_AT.isoformat()}"


def require_token(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency that 401s on missing / mismatched bearer.

    Usage:
        @router.get("/ops/health", dependencies=[Depends(require_token)])
        def health(): ...

    Constant-time compare via secrets.compare_digest so timing-side-
    channel attacks don't leak the token a byte at a time.
    """
    if _ACCESS_EXPIRES_AT is not None and _now() >= _ACCESS_EXPIRES_AT:
        logger.warning("refusing /ops request: the support window ended %s",
                       _ACCESS_EXPIRES_AT.isoformat())
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Support access window has ended",
        )
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
    # Compare bytes: compare_digest on str raises TypeError (a 500) for any
    # non-ASCII character in the header, which an unauthenticated caller can send.
    if not secrets.compare_digest(presented.encode("utf-8"), _OPS_TOKEN.encode("utf-8")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid token",
        )
