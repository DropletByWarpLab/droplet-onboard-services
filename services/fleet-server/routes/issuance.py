"""Issuance contract routes (ADR-023 §issuance contract).

Base path ``/api/issuance``. Implements the contract the box is built
against in parallel — see the SCOPE-NOTES at the bottom of main.py for
the exact strings and any deviations.

Auth model: no bearer. POST /order/challenge hands out a single-use,
120s nonce (it grants nothing). Security is the signature on
``droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>`` verified
against the registry's stored public key for the device.

Dependencies (repo, issuer, the order-launcher) live on
``request.app.state`` so tests can inject in-memory fakes.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, Response

import config
from auth import verify
from issuance import csr as csr_mod
from issuance import flow as flow_mod
from issuance import state, subdomain
from repository import new_nonce, new_order_id
from schemas import (
    CertStatus,
    ChallengeResponse,
    OrderAcceptedResponse,
    OrderRequest,
    OrderStatusResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/issuance", tags=["issuance"])

# Statuses for which a new order is considered "already in progress".
_IN_PROGRESS = {CertStatus.PENDING, CertStatus.RENEWING}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _repo(request: Request):
    return request.app.state.repo


def _issuer(request: Request):
    return request.app.state.issuer


async def _launch_order_flow(request: Request, *, device_id: str, csr_pem: str, fqdn: str,
                             background: BackgroundTasks) -> None:
    """Kick off the ACME dance. In production it's a BackgroundTask; in
    tests app.state.run_background drives it inline so assertions see the
    final state deterministically."""
    repo = _repo(request)
    issuer = _issuer(request)
    run_bg = getattr(request.app.state, "run_background", False)

    async def _run():
        await flow_mod.run_order_flow(
            repo=repo, issuer=issuer, device_id=device_id, csr_pem=csr_pem, fqdn=fqdn
        )

    if run_bg:
        await _run()
    else:
        background.add_task(_run)


# --- POST /order/challenge --------------------------------------------------

@router.post("/order/challenge", response_model=ChallengeResponse)
async def order_challenge(request: Request, body: dict):
    device_id = (body or {}).get("device_id")
    if not device_id:
        raise HTTPException(status_code=422, detail="device_id required")
    repo = _repo(request)

    device = await repo.get_device(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="device_id not in registry")

    # Per-device rate limit.
    since = _utcnow() - timedelta(seconds=config.CHALLENGE_RATE_WINDOW_SEC)
    recent = await repo.count_recent_challenges(device_id, since=since)
    if recent >= config.CHALLENGE_RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="too many challenge requests",
            headers={"Retry-After": str(config.CHALLENGE_RATE_WINDOW_SEC)},
        )

    nonce = new_nonce()
    expires_at = _utcnow() + timedelta(seconds=config.NONCE_TTL_SEC)
    await repo.create_challenge(nonce=nonce, device_id=device_id, expires_at=expires_at)

    label = subdomain.public_label(device_id)
    return ChallengeResponse(
        nonce=nonce,
        expires_at=expires_at.isoformat(),
        public_label=label,
        fqdn=subdomain.fqdn_for_label(label),
    )


# --- shared signature-auth verification -------------------------------------

async def _verify_order_auth(request: Request, *, device_id: str, nonce: str,
                             signature: str, sig_alg: str, key_fingerprint: str) -> str:
    """Verify the full PoP for an order/renew/deregister. Returns the
    device's public_label on success. Raises the contract's HTTP errors:
      401 — unknown/expired/used nonce, or bad signature.
      403 — device not registered / fingerprint mismatch.
    Consumes the nonce (single-use) only AFTER the signature checks out.
    """
    repo = _repo(request)

    device = await repo.get_device(device_id)
    if device is None:
        raise HTTPException(status_code=403, detail="device_id not registered")
    if key_fingerprint != device.key_fingerprint:
        raise HTTPException(status_code=403, detail="key_fingerprint mismatch")

    # Nonce must exist, belong to this device, be unexpired + unconsumed.
    challenge = await repo.get_challenge(nonce)
    if challenge is None or challenge.device_id != device_id:
        raise HTTPException(status_code=401, detail="invalid nonce")
    if challenge.consumed_at is not None:
        raise HTTPException(status_code=401, detail="nonce already used")
    if state.is_nonce_expired(challenge.expires_at, now=_utcnow()):
        raise HTTPException(status_code=401, detail="nonce expired")

    label = subdomain.public_label(device_id)
    ok = verify.verify_signature(
        public_key_pem=device.public_key_pem,
        signature_b64=signature,
        sig_alg=sig_alg,
        nonce=nonce,
        key_fingerprint=key_fingerprint,
        public_label=label,
    )
    if not ok:
        raise HTTPException(status_code=401, detail="signature verification failed")

    # Consume the nonce ATOMICALLY (single-use even under concurrency).
    consumed = await repo.consume_challenge(nonce, now=_utcnow())
    if not consumed:
        # Lost the race / expired between checks — fail closed.
        raise HTTPException(status_code=401, detail="nonce could not be consumed")
    return label


async def _order_or_renew(request: Request, body: OrderRequest,
                          background: BackgroundTasks) -> OrderAcceptedResponse:
    repo = _repo(request)
    label = await _verify_order_auth(
        request, device_id=body.device_id, nonce=body.nonce,
        signature=body.signature, sig_alg=body.sig_alg,
        key_fingerprint=body.key_fingerprint,
    )
    fqdn = subdomain.fqdn_for_label(label)

    # CSR must be valid and its only SAN == fqdn.
    try:
        csr_mod.validate_csr(body.csr_pem, expected_fqdn=fqdn)
    except csr_mod.CsrValidationError as exc:
        raise HTTPException(status_code=400, detail=f"invalid CSR: {exc}")
    csr_fp = csr_mod.csr_fingerprint(body.csr_pem)

    existing = await repo.get_cert(body.device_id)
    if existing is not None:
        # 403 if the device has been deregistered. The row is retained for
        # audit; a REVOKED device must not self-reinstate via /order or /renew.
        if existing.status == CertStatus.REVOKED:
            raise HTTPException(status_code=403, detail="device has been deregistered")
        # 409 if an order is already in progress for this device.
        if existing.status in _IN_PROGRESS:
            raise HTTPException(status_code=409, detail="order already in progress")
        # Idempotent on (device_id, csr_fingerprint): an identical CSR that
        # already produced an active cert returns the SAME order, no re-issue.
        if (
            existing.status == CertStatus.ACTIVE
            and existing.csr_fingerprint == csr_fp
            and existing.order_id
        ):
            logger.info("order: idempotent hit for %s (same CSR)", body.device_id)
            return OrderAcceptedResponse(
                order_id=existing.order_id, status=existing.status, fqdn=fqdn
            )

    order_id = new_order_id()
    await repo.upsert_cert_pending(
        device_id=body.device_id, public_label=label, fqdn=fqdn,
        order_id=order_id, csr_fingerprint=csr_fp, csr_pem=body.csr_pem,
    )
    await _launch_order_flow(
        request, device_id=body.device_id, csr_pem=body.csr_pem, fqdn=fqdn,
        background=background,
    )
    return OrderAcceptedResponse(order_id=order_id, status=CertStatus.PENDING, fqdn=fqdn)


@router.post("/order", status_code=202, response_model=OrderAcceptedResponse)
async def create_order(request: Request, body: OrderRequest,
                       background: BackgroundTasks):
    return await _order_or_renew(request, body, background)


@router.post("/renew", status_code=202, response_model=OrderAcceptedResponse)
async def renew_order(request: Request, body: OrderRequest,
                      background: BackgroundTasks):
    return await _order_or_renew(request, body, background)


# --- GET /order/{order_id} --------------------------------------------------

@router.get("/order/{order_id}", response_model=OrderStatusResponse)
async def get_order(request: Request, order_id: str,
                    device_id: str = Query(...)):
    repo = _repo(request)
    cert = await repo.get_cert_by_order(order_id)
    if cert is None or cert.device_id != device_id:
        # Don't disclose another device's order; 404 either way.
        raise HTTPException(status_code=404, detail="order not found")
    return OrderStatusResponse(
        order_id=order_id,
        status=cert.status,
        fqdn=cert.fqdn,
        fullchain_pem=cert.fullchain_pem,
        not_after=cert.not_after.isoformat() if cert.not_after else None,
        last_error=cert.last_error,
    )


# --- DELETE /registration ---------------------------------------------------

@router.delete("/registration")
async def deregister(request: Request, body: dict, device_id: str = Query(...)):
    """Revoke the device's cert + free its label (box factory-reset).

    Same signature-auth as /order, via a fresh challenge — the body
    carries {device_id, nonce, signature, sig_alg, key_fingerprint}.
    """
    body = body or {}
    nonce = body.get("nonce")
    signature = body.get("signature")
    sig_alg = body.get("sig_alg")
    key_fingerprint = body.get("key_fingerprint")
    if not all([nonce, signature, sig_alg, key_fingerprint]):
        raise HTTPException(status_code=422, detail="missing auth fields")

    await _verify_order_auth(
        request, device_id=device_id, nonce=nonce, signature=signature,
        sig_alg=sig_alg, key_fingerprint=key_fingerprint,
    )

    repo = _repo(request)
    issuer = _issuer(request)
    cert = await repo.get_cert(device_id)
    if cert is None:
        raise HTTPException(status_code=404, detail="no certificate for device")

    # ACME-revoke best-effort; revocation must proceed even if the upstream
    # revoke errors (the box is being reset — the label must be freed).
    if cert.fullchain_pem:
        try:
            await issuer.revoke_certificate(cert.fullchain_pem)
        except Exception as exc:  # noqa: BLE001
            logger.warning("deregister: ACME revoke failed for %s: %s", device_id, exc)

    await repo.mark_cert_revoked(device_id=device_id)
    return {"device_id": device_id, "status": CertStatus.REVOKED.value}
