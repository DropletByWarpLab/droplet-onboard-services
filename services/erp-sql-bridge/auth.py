"""WARP-2590 — fail-closed service bearer for the ERP SQL bridge.

WHY THIS SERVICE FAILS CLOSED AND inference-manager DOES NOT
------------------------------------------------------------
`services/inference-manager/auth.py` treats an empty token as permissive mode:
its worst case is an unauthenticated model pull. This bridge's worst case is a
connection to a dental practice's system of record holding `droplet_ro` /
`droplet_rw`, so the two services cannot share that default. Here an unset
token is a MISCONFIGURATION, never a mode: every non-exempt route answers 503
`BRIDGE_NOT_PROVISIONED` and no pool acquire happens.

That direction matters. A fail-OPEN default is invisible when it regresses —
the box keeps working and the gate is simply gone. Fail-closed announces
itself the moment `.env` is wrong, which is the only time it can bite.

WHAT THE GATE IS AND IS NOT
---------------------------
It authenticates the CALLER (the orchestrator), nothing else. It is not a
substitute for the two guards that were already here:

  * `allowlist.py` (WARP-2540) decides WHICH statement may run;
  * the database GRANT decides what `droplet_ro` may touch.

This decides WHO may ask at all — the layer neither of the others covers. Note
that the allowlist gates the statement but not the TARGET: `_target_from` still
takes the caller's `target.host`, so before this gate existed any container on
the compose network could point the bridge at a server it controlled and
collect the practice's ODBC credentials from the connection attempt. That is
the hole this closes.

/health is exempt so the compose healthcheck (which cannot hold a secret)
keeps working. It reports reachability only — never a credential, never a row.
It is the ONLY exemption: `EXEMPT_PATHS` is the whole list, and nothing —
including `/` — is waved through beside it.
"""
from __future__ import annotations

import hmac
import logging
import os

from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger("erp-sql-bridge.auth")

#: Only the container healthcheck. Everything else — /read, /write,
#: /introspect, and any route added later — is gated by default. New routes
#: are covered without touching this module; that is the point of gating in
#: middleware rather than per-route dependencies.
EXEMPT_PATHS = {"/health"}

#: Read the `.env` name directly. Re-declaring an env_file key as a `${VAR}`
#: substitution in compose resolves it against `docker/.env` — a different,
#: untracked file — and because `environment:` outranks `env_file:` the empty
#: result SHADOWS the real value. That mistake blanked SERVICE_TOKEN_RAG_EVAL
#: and 401'd 15 consecutive nightly eval runs; the inference-manager module
#: carries the same warning. The name is read at import so the test suite can
#: patch `auth.SERVICE_TOKEN` directly.
#: The env var's NAME, lifted out of the log format strings below on purpose.
#: semgrep's python-logger-credential-disclosure rule matches on the literal
#: text of a logger call, so a message merely NAMING the variable tripped it —
#: no secret was ever logged. Passing the name as an argument keeps the
#: operator-facing message identical and leaves one source for the spelling.
TOKEN_ENV = "SERVICE_TOKEN_ERP_BRIDGE"

SERVICE_TOKEN = os.environ.get(TOKEN_ENV, "").strip()


def _unauthorized(code: str, message: str, status: int = 401) -> JSONResponse:
    """Bridge-shaped error body: `{code, message}`, same as `_fail` in main.

    The client (`services/erp-connector/src/sql-bridge-client.ts`) reads
    `code` to decide whether a failure is upstream or its own bug, so an auth
    rejection has to speak that vocabulary rather than FastAPI's `detail`.
    """
    return JSONResponse(status_code=status, content={"code": code, "message": message})


class ServiceBearerMiddleware(BaseHTTPMiddleware):
    """Require `Authorization: Bearer <SERVICE_TOKEN_ERP_BRIDGE>`."""

    async def dispatch(self, request: Request, call_next):
        if request.url.path.rstrip("/") in EXEMPT_PATHS:
            return await call_next(request)

        if not SERVICE_TOKEN:
            # Not "allow anyway". A bridge with no token was never provisioned,
            # and answering 503 keeps it from touching the practice's database
            # while saying plainly which knob is missing.
            logger.error(
                "%s is empty — refusing %s %s. scripts/lib/secrets.sh mints "
                "this key; run ./scripts/setup.sh on the host, then recreate "
                "this container.",
                TOKEN_ENV,
                request.method,
                request.url.path,
            )
            return _unauthorized(
                "BRIDGE_NOT_PROVISIONED",
                f"erp-sql-bridge has no {TOKEN_ENV} configured",
                status=503,
            )

        header = request.headers.get("authorization", "")
        expected = f"Bearer {SERVICE_TOKEN}"

        # `hmac.compare_digest` accepts two `str` only when BOTH are ASCII;
        # anything else raises TypeError rather than returning False. Starlette
        # decodes raw header bytes as latin-1 — a decode that cannot fail — so a
        # single 0x80 byte in `Authorization` arrives here as an ordinary
        # non-ASCII `str` and used to blow the middleware up into an unhandled
        # 500. That is a denial-of-service shape (unauthenticated, one byte, no
        # session) and it also breaks the error contract: a 500 off the ASGI
        # server carries no `{code, message}`, so sql-bridge-client.ts reads
        # BRIDGE_ERROR and cannot tell a refused caller from a broken bridge.
        #
        # A non-ASCII header can never equal the token anyway — secrets.sh mints
        # it from hex — so refusing is the correct answer. It just has to be the
        # SAME refusal as every other bad bearer, which is what the guard buys.
        if not expected.isascii():
            # The mirror case: a hand-pasted non-ASCII token. Still a 401 (it
            # cannot match a latin-1-decoded header), but say so in the log —
            # otherwise this looks like a caller problem for the rest of time.
            logger.error(
                "%s contains non-ASCII characters and can never match a bearer "
                "header; every gated route will answer 401 until it is reminted.",
                TOKEN_ENV,
            )

        # Constant-time over the WHOLE header. A plain `!=` short-circuits on
        # the first differing byte, which leaks the token a byte at a time to a
        # caller that can time responses — and every caller here can, since the
        # bridge answers on the compose network with no proxy in between. The
        # two `isascii()` guards short-circuit BEFORE the compare, so the
        # constant-time path is unchanged for every header that could match.
        if (
            not header.isascii()
            or not expected.isascii()
            or not hmac.compare_digest(header, expected)
        ):
            logger.warning(
                "rejected unauthenticated %s %s", request.method, request.url.path
            )
            return _unauthorized("UNAUTHORIZED", "missing or invalid service bearer")

        return await call_next(request)


def setup_auth(app: FastAPI) -> None:
    """Install the gate and say which posture the process booted in."""
    if SERVICE_TOKEN:
        logger.info("service bearer enabled — /read, /write and /introspect require it")
    else:
        logger.error(
            "%s is EMPTY — every route except /health will answer 503 until it "
            "is set. This box is not provisioned.",
            TOKEN_ENV,
        )
    app.add_middleware(ServiceBearerMiddleware)
