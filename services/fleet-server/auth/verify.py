"""Issuance-contract proof-of-possession verification (ADR-023 §Decision 7).

The box proves possession of its TPM key by signing the canonical string

    droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>

with the private key whose public half is stored in the device registry.
The nonce binds the signature to a single, short-lived, single-use HQ
challenge; the key_fingerprint + public_label bind it to this device and
its label (so a signature can't be replayed against another device's
order).

ECDSA P-256 / ``ecdsa-sha256`` is the primary algorithm (WARP-230's TPM
key is ECC P-256). ``rsa-pss`` (RSA-PSS / SHA-256) is also accepted.
Everything here fails CLOSED: any malformed input, mismatched key type,
unknown algorithm, or bad signature returns ``False`` — never raises.
"""

from __future__ import annotations

import base64
import logging

from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePublicKey
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey

logger = logging.getLogger(__name__)

#: Canonical signed-message version. Bump only with a coordinated box
#: change — the box builds the identical string.
SIGNED_MESSAGE_PREFIX = "droplet-cert:v1"

# Accepted sig_alg tokens (lower-cased on input).
SIG_ALG_ECDSA = "ecdsa-sha256"
SIG_ALG_RSA_PSS = "rsa-pss"
SUPPORTED_SIG_ALGS = frozenset({SIG_ALG_ECDSA, SIG_ALG_RSA_PSS})


def build_signed_message(nonce: str, key_fingerprint: str, public_label: str) -> str:
    """Build the exact string the box signs. The box MUST build the
    byte-identical string; any divergence is a verification failure."""
    return f"{SIGNED_MESSAGE_PREFIX}:{nonce}:{key_fingerprint}:{public_label}"


def _verify_ec(pubkey: EllipticCurvePublicKey, signature: bytes, message: bytes) -> bool:
    # cryptography expects a DER-encoded (r, s) ECDSA signature — the same
    # encoding `EllipticCurvePrivateKey.sign(...)` emits, which is what the
    # box's TPM stack produces.
    pubkey.verify(signature, message, ec.ECDSA(hashes.SHA256()))
    return True


def _verify_rsa_pss(pubkey: RSAPublicKey, signature: bytes, message: bytes) -> bool:
    pubkey.verify(
        signature,
        message,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.MAX_LENGTH,
        ),
        hashes.SHA256(),
    )
    return True


def verify_signature(
    *,
    public_key_pem: str,
    signature_b64: str,
    sig_alg: str,
    nonce: str,
    key_fingerprint: str,
    public_label: str,
) -> bool:
    """Return True iff ``signature_b64`` is a valid signature over the
    canonical message for ``public_key_pem`` under ``sig_alg``.

    Fails closed on every error path.
    """
    alg = (sig_alg or "").strip().lower()
    if alg not in SUPPORTED_SIG_ALGS:
        logger.warning("verify_signature: unsupported sig_alg %r", sig_alg)
        return False

    try:
        signature = base64.b64decode(signature_b64, validate=True)
    except (ValueError, TypeError):
        logger.warning("verify_signature: signature is not valid base64")
        return False
    if not signature:
        return False

    try:
        pubkey = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
    except (ValueError, UnsupportedAlgorithm, TypeError):
        logger.warning("verify_signature: registry public key did not parse")
        return False

    message = build_signed_message(nonce, key_fingerprint, public_label).encode("utf-8")

    try:
        if alg == SIG_ALG_ECDSA:
            if not isinstance(pubkey, EllipticCurvePublicKey):
                return False
            return _verify_ec(pubkey, signature, message)
        if alg == SIG_ALG_RSA_PSS:
            if not isinstance(pubkey, RSAPublicKey):
                return False
            return _verify_rsa_pss(pubkey, signature, message)
    except InvalidSignature:
        return False
    except Exception as exc:  # noqa: BLE001 — verification must fail closed
        logger.warning("verify_signature: unexpected error, failing closed: %s", exc)
        return False
    return False
