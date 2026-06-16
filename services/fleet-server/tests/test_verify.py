"""Issuance-contract signature + nonce verification (auth/verify.py).

The box proves possession of its TPM key (WARP-230: ECC P-256) by
signing the EXACT string::

    droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>

against the registry's stored public key. ECDSA P-256 / ecdsa-sha256 is
the primary sig_alg; rsa-pss is also accepted.
"""

from __future__ import annotations

import base64

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import (
    encode_dss_signature,
)

from auth import verify
from issuance import subdomain


def _ec_keypair():
    priv = ec.generate_private_key(ec.SECP256R1())
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return priv, pub_pem


def _rsa_keypair():
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return priv, pub_pem


def _sign_ec(priv, message: str) -> str:
    sig = priv.sign(message.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    return base64.b64encode(sig).decode("ascii")


def _sign_rsa_pss(priv, message: str) -> str:
    sig = priv.sign(
        message.encode("utf-8"),
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.MAX_LENGTH,
        ),
        hashes.SHA256(),
    )
    return base64.b64encode(sig).decode("ascii")


def test_canonical_message_shape():
    msg = verify.build_signed_message(
        nonce="N1", key_fingerprint="FP", public_label="d-abc")
    assert msg == "droplet-cert:v1:N1:FP:d-abc"


def test_valid_ec_signature_passes():
    priv, pub_pem = _ec_keypair()
    label = subdomain.public_label("dev-1")
    msg = verify.build_signed_message("N1", "FP", label)
    sig = _sign_ec(priv, msg)
    assert verify.verify_signature(
        public_key_pem=pub_pem,
        signature_b64=sig,
        sig_alg="ecdsa-sha256",
        nonce="N1",
        key_fingerprint="FP",
        public_label=label,
    ) is True


def test_tampered_ec_signature_fails():
    priv, pub_pem = _ec_keypair()
    label = subdomain.public_label("dev-1")
    sig = _sign_ec(priv, verify.build_signed_message("N1", "FP", label))
    # Tamper: same sig but a different nonce -> message mismatch.
    assert verify.verify_signature(
        public_key_pem=pub_pem,
        signature_b64=sig,
        sig_alg="ecdsa-sha256",
        nonce="DIFFERENT",
        key_fingerprint="FP",
        public_label=label,
    ) is False


def test_wrong_key_fails():
    priv, _ = _ec_keypair()
    _, other_pub = _ec_keypair()
    label = subdomain.public_label("dev-1")
    sig = _sign_ec(priv, verify.build_signed_message("N1", "FP", label))
    assert verify.verify_signature(
        public_key_pem=other_pub,
        signature_b64=sig,
        sig_alg="ecdsa-sha256",
        nonce="N1",
        key_fingerprint="FP",
        public_label=label,
    ) is False


def test_valid_rsa_pss_signature_passes():
    priv, pub_pem = _rsa_keypair()
    label = subdomain.public_label("dev-1")
    sig = _sign_rsa_pss(priv, verify.build_signed_message("N1", "FP", label))
    assert verify.verify_signature(
        public_key_pem=pub_pem,
        signature_b64=sig,
        sig_alg="rsa-pss",
        nonce="N1",
        key_fingerprint="FP",
        public_label=label,
    ) is True


def test_unknown_sig_alg_fails():
    priv, pub_pem = _ec_keypair()
    label = subdomain.public_label("dev-1")
    sig = _sign_ec(priv, verify.build_signed_message("N1", "FP", label))
    assert verify.verify_signature(
        public_key_pem=pub_pem,
        signature_b64=sig,
        sig_alg="hmac-sha256",  # not allowed
        nonce="N1",
        key_fingerprint="FP",
        public_label=label,
    ) is False


def test_garbage_signature_b64_fails_closed():
    _, pub_pem = _ec_keypair()
    assert verify.verify_signature(
        public_key_pem=pub_pem,
        signature_b64="!!!not-base64!!!",
        sig_alg="ecdsa-sha256",
        nonce="N1",
        key_fingerprint="FP",
        public_label="d-abc",
    ) is False


def test_ec_key_with_rsa_alg_fails_closed():
    priv, pub_pem = _ec_keypair()
    label = subdomain.public_label("dev-1")
    sig = _sign_ec(priv, verify.build_signed_message("N1", "FP", label))
    # Caller claims rsa-pss but supplied an EC key — must fail, not crash.
    assert verify.verify_signature(
        public_key_pem=pub_pem,
        signature_b64=sig,
        sig_alg="rsa-pss",
        nonce="N1",
        key_fingerprint="FP",
        public_label=label,
    ) is False
