"""WARP-465 D1 follow-up — FastAPI entrypoint.

Lifespan responsibilities:
  1. FIPS boot self-test (same shape as routing service).
  2. Load the Fernet key (`creds.init_or_exit`).
  3. Start MQTT bridge.
  4. Connect asyncpg pool.
  5. Start AsyncIOScheduler.
  6. Iterate EmailAccount rows → start one IDLE loop per account.
  7. Schedule the outbound poller (every 10s).
  8. Refresh-accounts cron (every 5 min) — picks up newly-added
     accounts without a service restart.

Shutdown reverses the above. Failures in any non-load-bearing step
(MQTT, individual account IDLE) are logged but don't fail-fast — the
service stays up so other accounts keep working.

HTTP surface: a single /health endpoint for the docker healthcheck.
The orchestrator owns the email surface; this service is purely a
backend pump.
"""
from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager

# FIPS gate fires BEFORE any other import so a non-FIPS image
# never opens crypto-using sockets. Same pattern as ai-gateway.
def _run_fips_boot_self_test() -> None:
    raw = os.environ.get("DROPLET_FIPS_REQUIRED")
    if raw is None or raw.lower() in ("false", "0", "no"):
        return
    sys.path.insert(0, "/app")
    try:
        from _shared.fips_selftest import assert_fips_at_boot_or_exit
    except ImportError as err:
        sys.stderr.write(
            '{"event":"fips_self_test","service":"email-indexer","fips":false,'
            '"reason":"helper not importable: %s"}\n' % err,
        )
        sys.exit(1)
    assert_fips_at_boot_or_exit("email-indexer")


_run_fips_boot_self_test()


import hmac

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler

import creds
import db
import mqtt_bridge
import orchestrator_client
import provision as provisioning
from idle import IdleDeps, start_account_idle_loop
from outbound import StatusCallback, send_one_draft
from outbound_gate import OutboundGate

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("email-indexer")


_scheduler: AsyncIOScheduler | None = None


class OrchestratorStatusCallback(StatusCallback):
    async def claim(self, draft_id: str) -> bool:
        return await orchestrator_client.claim_draft(draft_id)

    async def mark_sent(self, draft_id: str) -> bool:
        return await orchestrator_client.mark_draft_sent(draft_id)

    async def mark_failed(self, draft_id: str, error: str) -> bool:
        return await orchestrator_client.mark_draft_failed(draft_id, error)


_status_callback = OrchestratorStatusCallback()
_outbound_gate = OutboundGate()
_idle_deps = IdleDeps(
    ingest=orchestrator_client.ingest_message,
    publish_new_mail=mqtt_bridge.publish_new_mail,
)


async def _refresh_accounts() -> None:
    """Re-scan EmailAccount and start IDLE for new ones. Existing
    IDLE jobs are left alone (replace_existing=True in
    start_account_idle_loop is a no-op for the same id)."""
    if _scheduler is None:
        return
    accounts = await db.list_accounts()
    for account in accounts:
        start_account_idle_loop(_scheduler, account, _idle_deps)
    logger.info("account refresh complete: %d accounts active", len(accounts))


async def _drain_outbound() -> None:
    """One outbound-poller tick: reconcile stuck `sending` drafts, then claim +
    SMTP-send every queued draft (the claim makes a lost-callback re-send
    impossible — WARP-890). WARP-1470: when the orchestrator reports the email
    module disabled, pause the pump and re-probe periodically instead of 404-ing
    every tick."""
    if not _outbound_gate.should_probe():
        return
    reconciled = await orchestrator_client.reconcile_stale_sending()
    transition = _outbound_gate.record(module_disabled=reconciled is None)
    if transition:
        logger.info(transition)
    if reconciled is None:
        return  # email module disabled — nothing to drain
    drafts = await db.list_queued_drafts()
    for draft in drafts:
        await send_one_draft(draft, _status_callback)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _scheduler
    creds.init_or_exit()
    mqtt_bridge.start()
    try:
        await db.init_pool()
    except Exception as exc:  # noqa: BLE001
        logger.error("asyncpg pool init failed: %s", exc)
        sys.exit(1)

    _scheduler = AsyncIOScheduler()
    _scheduler.start()

    await _refresh_accounts()
    # Outbound poller: every 10s. apscheduler owns the loop.
    _scheduler.add_job(
        _drain_outbound,
        "interval",
        seconds=int(os.environ.get("OUTBOUND_POLL_SECONDS", "10")),
        id="email-outbound-poller",
        max_instances=1,
        coalesce=True,
    )
    # Re-discover new accounts every 5 min so the operator doesn't
    # have to bounce the service after a dashboard add.
    _scheduler.add_job(
        _refresh_accounts,
        "interval",
        seconds=int(os.environ.get("ACCOUNT_REFRESH_SECONDS", "300")),
        id="email-account-refresh",
        max_instances=1,
        coalesce=True,
    )

    yield

    try:
        _scheduler.shutdown(wait=False)
    except Exception as exc:  # noqa: BLE001
        logger.warning("scheduler shutdown failed: %s", exc)
    mqtt_bridge.stop()
    await db.close_pool()


SERVICE_TOKEN_EMAIL = os.environ.get("SERVICE_TOKEN_EMAIL", "").strip()
EMAIL_ALLOW_NO_AUTH = os.environ.get("EMAIL_ALLOW_NO_AUTH", "").strip() == "1"

#: `/health` is the only unauthenticated path, matching every other service on
#: the box. It reports liveness and nothing about any account.
_AUTH_EXEMPT_PATHS = {"/health"}


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Reject every non-health request without a valid SERVICE_TOKEN_EMAIL.

    🔴 FAILS CLOSED, and that is the whole reason it is written as
    `if TOKEN: ... elif not ALLOW_NO_AUTH: refuse` rather than the `if TOKEN:`
    that reads the same and is not the same. A blank token in production is a
    failed secret injection, not permission to serve `/accounts/provision` —
    which takes a mailbox password — to anything that can reach the port. The
    dev escape hatch is explicit and named, per `service-auth-fail-closed`.
    """

    async def dispatch(self, request: Request, call_next):
        if request.url.path in _AUTH_EXEMPT_PATHS:
            return await call_next(request)
        if SERVICE_TOKEN_EMAIL:
            auth = request.headers.get("Authorization", "")
            token = auth.removeprefix("Bearer ").strip()
            # Both operands encoded: a non-ASCII Authorization header makes
            # hmac.compare_digest on two str args raise TypeError -> 500, where
            # a clean 401 is the answer.
            if not hmac.compare_digest(
                token.encode("utf-8", "ignore"),
                SERVICE_TOKEN_EMAIL.encode("utf-8"),
            ):
                return JSONResponse(status_code=401, content={"error": "unauthorized"})
        elif not EMAIL_ALLOW_NO_AUTH:
            return JSONResponse(
                status_code=503,
                content={"error": "service token not configured"},
            )
        return await call_next(request)


app = FastAPI(lifespan=lifespan)
app.add_middleware(ServiceAuthMiddleware)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


class ProvisionRequest(BaseModel):
    """What the orchestrator sends to connect one mailbox.

    🔴 `password` is the only field on this box that arrives as a third-party
    plaintext secret. It exists in this process for the duration of one probe
    and is never logged, never echoed, and never stored — `model_config`
    forbids extra keys so a caller cannot smuggle one past the allow-list.
    """

    model_config = {"extra": "forbid"}

    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    useTls: bool = True
    username: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


@app.post("/accounts/provision")
async def provision_account(body: ProvisionRequest) -> JSONResponse:
    """Verify a mailbox, and return its ciphertext only if it answered.

    The orchestrator writes the row; this service never touches EmailAccount on
    this path. That split is deliberate — see `provision.py`'s header.

    🔴 The response carries a CIPHERTEXT and a closed-set reason, never the
    plaintext and never the IMAP server's own words. A server's rejection
    string is attacker-influenced and routinely echoes the credential back.
    """
    result, ciphertext = await provisioning.provision(
        host=body.host,
        port=body.port,
        use_tls=body.useTls,
        username=body.username,
        password=body.password,
    )
    if not result.ok:
        # 422, not 401: the REQUEST was well-formed and authenticated; the
        # mailbox refused it. A 401 here would read as the orchestrator's own
        # service token being wrong.
        return JSONResponse(
            status_code=422,
            content={"ok": False, "reason": result.reason},
        )
    return JSONResponse(status_code=200, content={"ok": True, "passwordEnc": ciphertext})
