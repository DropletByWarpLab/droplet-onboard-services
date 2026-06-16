"""Warp fleet HQ — per-device TLS issuance service (ADR-023, C1).

FastAPI app deployed to hq.warp-lab.com (NOT to a box). Issues
publicly-trusted Let's Encrypt certs to Droplet boxes via Cloudflare
DNS-01, using a box-supplied CSR (the box private key never leaves the
box). Mirrors the house service layout: env config, apscheduler lifecycle
(no `while True`), idempotent startup migrations, FIPS boot hook.

----------------------------------------------------------------------
SCOPE-NOTES (deviations / decisions, for the box-side + PR body)
----------------------------------------------------------------------
1. Local package ``acme_issuance/`` (not ``acme/``) so it never shadows
   the PyPI ``acme`` library on the service's sys.path.
2. The signed PoP string is EXACTLY
       droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>
   The box MUST build the byte-identical string. ECDSA-P256
   (``ecdsa-sha256``) is primary (WARP-230 TPM key); ``rsa-pss`` accepted.
   Signature is base64; ECDSA signature is DER (r,s) — the encoding
   ``EllipticCurvePrivateKey.sign`` emits.
3. The order/renew response is 202 ``{order_id, status:"pending", fqdn}``;
   the ACME dance runs as a background task. Poll GET /order/{id}.
4. ``csr_pem`` is stored on the row so the unattended renewal job can
   re-finalize against the SAME box serving keypair without box
   interaction (ADR-023 D5). The box must keep its serving keypair stable
   across renewals (which it does — the LE cert overwrites the same files).
5. DELETE /registration takes its auth fields (nonce/signature/sig_alg/
   key_fingerprint) in the request BODY plus ``device_id`` as a query
   param; revocation proceeds (label freed) even if the upstream ACME
   revoke errors, since the box is being factory-reset.
6. ACME directory defaults to LE *staging* — flip ACME_DIRECTORY_URL to
   prod only after plumbing is verified (ADR-023 §Risk: LE rate limits).
7. NOT added to the box docker-compose (it deploys to HQ). A standalone
   services/fleet-server/docker-compose.yml + README cover the HQ deploy.
8. The contract lists 502 for "ACME/Cloudflare upstream". Because
   issuance is ASYNC (202 then poll), an upstream ACME/Cloudflare failure
   during the background dance surfaces via GET /order/{id} as
   status="failed" + last_error — NOT as a synchronous 502 on /order.
   A synchronous 502 would only apply if issuance were inline; it isn't.
9. The unattended renewal path re-finalizes against the stored CSR, so a
   box that ROTATES its serving key must POST /renew with the fresh CSR
   itself (the daily job alone keeps the existing key's cert alive).
"""

from __future__ import annotations

import sys as _sys

# WARP-229: FIPS boot self-test (env-gated; no-op unless
# DROPLET_FIPS_REQUIRED=true). Mirrors camera-discovery/main.py.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("fleet-server")
except ImportError:
    pass

import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI

import config
import db
from acme_issuance import account, client as acme_client
from acme_issuance.cloudflare_dns import CloudflareDns
from issuance import flow as flow_mod
from issuance import renewal as renewal_mod
from repository import PgIssuanceRepository
from routes import health as health_routes
from routes import issuance as issuance_routes

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Warp Fleet HQ — TLS Issuance", version="0.1.0")
app.include_router(health_routes.router)
app.include_router(issuance_routes.router)

# Dependencies live on app.state so tests can inject in-memory fakes.
app.state.repo = None
app.state.issuer = None
app.state.run_background = False

_scheduler: AsyncIOScheduler | None = None


# --- test seam --------------------------------------------------------------

def set_dependencies(*, repo, issuer, run_background: bool = False) -> None:
    """Inject the repository + ACME issuer (tests use in-memory fakes)."""
    app.state.repo = repo
    app.state.issuer = issuer
    app.state.run_background = run_background


def reset_dependencies() -> None:
    app.state.repo = None
    app.state.issuer = None
    app.state.run_background = False


# --- ACME issuer construction (production) -----------------------------------

def _build_acme_issuer():
    """Construct the real AcmeIssuer from env. Imported lazily so the app
    imports cleanly in a test context without LE/Cloudflare reachability."""
    from acme import client as real_acme_client
    from acme import messages

    account_key = account.load_or_create_account_key(config.ACME_ACCOUNT_KEY_PATH)
    net = real_acme_client.ClientNetwork(
        account_key, user_agent="warp-fleet-hq/0.1"
    )
    directory = real_acme_client.ClientV2.get_directory(
        config.ACME_DIRECTORY_URL, net
    )
    acme_v2 = real_acme_client.ClientV2(directory, net=net)
    # Register (or reuse) the account.
    regr = messages.NewRegistration.from_data(
        email=config.ACME_CONTACT_EMAIL or None, terms_of_service_agreed=True
    )
    try:
        net.account = acme_v2.new_account(regr)
    except Exception as exc:  # noqa: BLE001 — already-registered is fine
        logger.info("acme: new_account note (likely already registered): %s", exc)

    dns = CloudflareDns(
        api_token=config.cloudflare_api_token(),
        zone_id=config.cloudflare_zone_id(),
        api_base=config.CLOUDFLARE_API_BASE,
        propagation_timeout_sec=config.DNS_PROPAGATION_TIMEOUT_SEC,
        poll_sec=config.DNS_PROPAGATION_POLL_SEC,
    )
    return acme_client.AcmeIssuer(
        acme_client_v2=acme_v2,
        account_key=account_key,
        dns=dns,
        order_timeout_sec=config.ACME_ORDER_TIMEOUT_SEC,
    )


# --- renewal job ------------------------------------------------------------

async def _renew_one(*, repo, device_id: str) -> None:
    """Renew a single device: renewing -> (re-order stored CSR) ->
    active|failed. Reuses run_order_flow against the row's stored CSR."""
    cert = await repo.get_cert(device_id)
    if cert is None or not cert.csr_pem:
        logger.warning("renewal: %s has no stored CSR; skipping", device_id)
        return
    if not renewal_mod.assert_renewing_allowed(cert):
        logger.warning("renewal: %s is not in ACTIVE state, skipping", device_id)
        return
    await repo.mark_cert_renewing(device_id=device_id)
    await flow_mod.run_order_flow(
        repo=repo, issuer=app.state.issuer, device_id=device_id,
        csr_pem=cert.csr_pem, fqdn=cert.fqdn,
    )


async def _renewal_tick() -> None:
    if app.state.repo is None or app.state.issuer is None:
        return
    try:
        await renewal_mod.run_renewal_cycle(
            app.state.repo,
            renew_before_days=config.RENEW_BEFORE_DAYS,
            renew_one=_renew_one,
            now=datetime.now(timezone.utc),
        )
    except Exception as exc:  # noqa: BLE001 — never tear down the schedule
        logger.error("renewal tick error: %s", exc)


def _build_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        _renewal_tick,
        "cron",
        hour=config.RENEWAL_CRON_HOUR,
        id="fleet-tls-renewal",
        max_instances=1,
        coalesce=True,
    )
    return scheduler


# --- lifespan ---------------------------------------------------------------

@app.on_event("startup")
async def startup():
    global _scheduler
    # In a test context dependencies are injected via set_dependencies and
    # DATABASE_URL points at a throwaway DSN — skip the real wiring.
    if app.state.repo is not None:
        logger.info("fleet-server: deps pre-injected (test mode); skipping wiring")
        return

    await db.init_pool()
    applied = await db.run_migrations_on_pool()
    if applied:
        logger.info("fleet-server: applied migrations: %s", applied)

    app.state.repo = PgIssuanceRepository(db.get_pool())
    app.state.issuer = _build_acme_issuer()
    app.state.run_background = False

    _scheduler = _build_scheduler()
    _scheduler.start()
    logger.info("fleet-server: renewal scheduler started (cron hour=%d)",
                config.RENEWAL_CRON_HOUR)


@app.on_event("shutdown")
async def shutdown():
    global _scheduler
    if _scheduler is not None:
        try:
            _scheduler.shutdown(wait=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("scheduler shutdown failed: %s", exc)
        _scheduler = None
    await db.close_pool()
