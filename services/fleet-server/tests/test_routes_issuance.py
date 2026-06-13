"""End-to-end issuance-contract route tests (routes/issuance.py).

The whole contract under /api/issuance, driven through the FastAPI app
with an in-memory repo + fake ACME issuer injected. NO live LE /
Cloudflare / Postgres.

Contract recap:
  POST /order/challenge  -> {nonce, expires_at, public_label, fqdn}
  POST /order            -> 202 {order_id, status:"pending", fqdn}
  GET  /order/{id}       -> {order_id, status, fqdn, fullchain_pem?, ...}
  POST /renew            -> same body as /order
  DELETE /registration   -> revoke
Errors: 401 (bad nonce/sig), 403 (not registered / fp / label),
        404 (challenge: device not in registry), 409 (in progress),
        429 (rate limit, Retry-After).
"""

from __future__ import annotations

import base64

import pytest
import pytest_asyncio
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from httpx import ASGITransport, AsyncClient

import main as main_mod
from auth import verify
from issuance import subdomain
from schemas import CertStatus
from tests.fakes import FakeAcmeIssuer, FakeRepository

DEVICE_ID = "dev-001"


def _keypair():
    priv = ec.generate_private_key(ec.SECP256R1())
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return priv, pub_pem


def _make_csr(priv, fqdn):
    req = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, fqdn)]))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(fqdn)]), critical=False)
        .sign(priv, hashes.SHA256())
    )
    return req.public_bytes(serialization.Encoding.PEM).decode("ascii")


def _sign(priv, msg):
    sig = priv.sign(msg.encode(), ec.ECDSA(hashes.SHA256()))
    return base64.b64encode(sig).decode("ascii")


def _leaf(fqdn, days=90):
    import datetime
    key = ec.generate_private_key(ec.SECP256R1())
    subj = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, fqdn)])
    nb = datetime.datetime(2026, 6, 13, tzinfo=datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(subj).issuer_name(subj)
        .public_key(key.public_key()).serial_number(7)
        .not_valid_before(nb).not_valid_after(nb + datetime.timedelta(days=days))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(fqdn)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode("ascii")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest_asyncio.fixture
async def ctx():
    """App wired to an in-memory repo + fake issuer. Returns
    (client, repo, issuer, priv, fingerprint)."""
    repo = FakeRepository()
    priv, pub_pem = _keypair()
    fingerprint = "fp-001"
    repo.seed_device(DEVICE_ID, pub_pem, fingerprint)
    fqdn = subdomain.fqdn_for(DEVICE_ID)
    issuer = FakeAcmeIssuer(fullchain=_leaf(fqdn))

    main_mod.set_dependencies(repo=repo, issuer=issuer, run_background=True)

    transport = ASGITransport(app=main_mod.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, repo, issuer, priv, fingerprint

    main_mod.reset_dependencies()


async def _get_challenge(client, device_id=DEVICE_ID):
    resp = await client.post("/api/issuance/order/challenge", json={"device_id": device_id})
    return resp


def _order_body(priv, fingerprint, nonce, label, fqdn, device_id=DEVICE_ID):
    csr = _make_csr(priv, fqdn)
    msg = verify.build_signed_message(nonce, fingerprint, label)
    return {
        "device_id": device_id,
        "csr_pem": csr,
        "nonce": nonce,
        "signature": _sign(priv, msg),
        "sig_alg": "ecdsa-sha256",
        "key_fingerprint": fingerprint,
    }


# --- POST /order/challenge ---

@pytest.mark.asyncio
async def test_challenge_returns_nonce_label_fqdn(ctx):
    client, repo, *_ = ctx
    resp = await _get_challenge(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["nonce"]
    assert body["public_label"] == subdomain.public_label(DEVICE_ID)
    assert body["fqdn"] == subdomain.fqdn_for(DEVICE_ID)
    assert body["expires_at"]


@pytest.mark.asyncio
async def test_challenge_unknown_device_404(ctx):
    client, *_ = ctx
    resp = await _get_challenge(client, device_id="ghost")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_challenge_rate_limited_429_with_retry_after(ctx):
    client, *_ = ctx
    last = None
    for _ in range(10):
        last = await _get_challenge(client)
    assert last.status_code == 429
    assert "retry-after" in {k.lower() for k in last.headers.keys()}


# --- POST /order ---

@pytest.mark.asyncio
async def test_order_happy_path_202_then_active(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    body = _order_body(priv, fp, ch["nonce"], ch["public_label"], ch["fqdn"])
    resp = await client.post("/api/issuance/order", json=body)
    assert resp.status_code == 202
    data = resp.json()
    assert data["status"] == CertStatus.PENDING.value
    assert data["fqdn"] == subdomain.fqdn_for(DEVICE_ID)
    order_id = data["order_id"]
    # background task ran (run_background=True) -> active.
    cert = await repo.get_cert(DEVICE_ID)
    assert cert.status == CertStatus.ACTIVE
    # box CSR reached the issuer.
    assert issuer.ordered and issuer.ordered[0][1] == ch["fqdn"]
    # GET reflects active + chain.
    got = await client.get(f"/api/issuance/order/{order_id}", params={"device_id": DEVICE_ID})
    assert got.status_code == 200
    assert got.json()["status"] == CertStatus.ACTIVE.value
    assert got.json()["fullchain_pem"]


@pytest.mark.asyncio
async def test_order_bad_signature_401(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    body = _order_body(priv, fp, ch["nonce"], ch["public_label"], ch["fqdn"])
    body["signature"] = base64.b64encode(b"garbage-sig").decode()
    resp = await client.post("/api/issuance/order", json=body)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_order_consumed_nonce_replay_401(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    body = _order_body(priv, fp, ch["nonce"], ch["public_label"], ch["fqdn"])
    first = await client.post("/api/issuance/order", json=body)
    assert first.status_code == 202
    # Replay the SAME nonce -> consumed -> 401.
    replay = await client.post("/api/issuance/order", json=body)
    assert replay.status_code == 401


@pytest.mark.asyncio
async def test_order_expired_nonce_401(ctx):
    import datetime
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    # Force the stored challenge to be already expired.
    repo.challenges[ch["nonce"]].expires_at = datetime.datetime(
        2000, 1, 1, tzinfo=datetime.timezone.utc
    )
    body = _order_body(priv, fp, ch["nonce"], ch["public_label"], ch["fqdn"])
    resp = await client.post("/api/issuance/order", json=body)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_order_unknown_nonce_401(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    body = _order_body(priv, fp, "never-issued-nonce", ch["public_label"], ch["fqdn"])
    resp = await client.post("/api/issuance/order", json=body)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_order_fingerprint_mismatch_403(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    # Sign with the WRONG fingerprint claim -> registry mismatch 403.
    body = _order_body(priv, "WRONG-FP", ch["nonce"], ch["public_label"], ch["fqdn"])
    resp = await client.post("/api/issuance/order", json=body)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_order_csr_san_mismatch_rejected(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    # CSR for a DIFFERENT fqdn than the device's label.
    bad_csr = _make_csr(priv, "evil.example.com")
    msg = verify.build_signed_message(ch["nonce"], fp, ch["public_label"])
    body = {
        "device_id": DEVICE_ID, "csr_pem": bad_csr, "nonce": ch["nonce"],
        "signature": _sign(priv, msg), "sig_alg": "ecdsa-sha256",
        "key_fingerprint": fp,
    }
    resp = await client.post("/api/issuance/order", json=body)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_order_idempotent_same_csr_returns_same_order(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    body = _order_body(priv, fp, ch["nonce"], ch["public_label"], ch["fqdn"])
    first = await client.post("/api/issuance/order", json=body)
    assert first.status_code == 202
    first_order_id = first.json()["order_id"]
    assert (await repo.get_cert(DEVICE_ID)).status == CertStatus.ACTIVE
    n_ordered = len(issuer.ordered)

    # Re-submit the SAME CSR (fresh nonce) -> same order_id, no re-issue.
    ch2 = (await _get_challenge(client)).json()
    body2 = _order_body(priv, fp, ch2["nonce"], ch2["public_label"], ch2["fqdn"])
    body2["csr_pem"] = body["csr_pem"]
    msg2 = verify.build_signed_message(ch2["nonce"], fp, ch2["public_label"])
    body2["signature"] = _sign(priv, msg2)
    second = await client.post("/api/issuance/order", json=body2)
    assert second.status_code == 202
    assert second.json()["order_id"] == first_order_id
    # No additional ACME order was placed.
    assert len(issuer.ordered) == n_ordered


@pytest.mark.asyncio
async def test_order_409_when_in_progress(ctx):
    client, repo, issuer, priv, fp = ctx
    fqdn = subdomain.fqdn_for(DEVICE_ID)
    # Seed a row already in-progress (pending) for this device.
    await repo.upsert_cert_pending(
        device_id=DEVICE_ID, public_label=subdomain.public_label(DEVICE_ID),
        fqdn=fqdn, order_id="ord-existing", csr_fingerprint="fp-existing",
        csr_pem="EXISTING-CSR",
    )
    ch = (await _get_challenge(client)).json()
    body = _order_body(priv, fp, ch["nonce"], ch["public_label"], ch["fqdn"])
    resp = await client.post("/api/issuance/order", json=body)
    assert resp.status_code == 409


# --- GET /order/{id} ---

@pytest.mark.asyncio
async def test_get_order_requires_matching_device(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    body = _order_body(priv, fp, ch["nonce"], ch["public_label"], ch["fqdn"])
    order_id = (await client.post("/api/issuance/order", json=body)).json()["order_id"]
    # Wrong device_id on the GET -> 403/404 (not another device's cert).
    resp = await client.get(f"/api/issuance/order/{order_id}", params={"device_id": "other"})
    assert resp.status_code in (403, 404)


# --- POST /renew ---

@pytest.mark.asyncio
async def test_renew_reissues_same_fqdn(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    body = _order_body(priv, fp, ch["nonce"], ch["public_label"], ch["fqdn"])
    await client.post("/api/issuance/order", json=body)
    assert (await repo.get_cert(DEVICE_ID)).status == CertStatus.ACTIVE

    ch2 = (await _get_challenge(client)).json()
    body2 = _order_body(priv, fp, ch2["nonce"], ch2["public_label"], ch2["fqdn"])
    resp = await client.post("/api/issuance/renew", json=body2)
    assert resp.status_code == 202
    assert resp.json()["fqdn"] == subdomain.fqdn_for(DEVICE_ID)
    # same label/fqdn after renew.
    assert (await repo.get_cert(DEVICE_ID)).fqdn == subdomain.fqdn_for(DEVICE_ID)


# --- DELETE /registration ---

@pytest.mark.asyncio
async def test_deregistration_revokes(ctx):
    client, repo, issuer, priv, fp = ctx
    ch = (await _get_challenge(client)).json()
    body = _order_body(priv, fp, ch["nonce"], ch["public_label"], ch["fqdn"])
    await client.post("/api/issuance/order", json=body)
    assert (await repo.get_cert(DEVICE_ID)).status == CertStatus.ACTIVE

    # Fresh challenge + signature for the DELETE.
    ch2 = (await _get_challenge(client)).json()
    msg = verify.build_signed_message(ch2["nonce"], fp, ch2["public_label"])
    resp = await client.request(
        "DELETE",
        "/api/issuance/registration",
        params={"device_id": DEVICE_ID},
        json={
            "device_id": DEVICE_ID, "nonce": ch2["nonce"],
            "signature": _sign(priv, msg), "sig_alg": "ecdsa-sha256",
            "key_fingerprint": fp,
        },
    )
    assert resp.status_code == 200
    assert (await repo.get_cert(DEVICE_ID)).status == CertStatus.REVOKED
    assert issuer.revoked  # ACME revoke called
