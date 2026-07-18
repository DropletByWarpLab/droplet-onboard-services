"""WARP-233 — app-layer PHI/PII column encryption (Python twin of
apps/orchestrator/src/services/column-crypto.service.ts — keep the wire
format in lockstep: dcv1: + base64(iv(12) || ciphertext || tag(16))).

WARP-242: the doc-KEK master key is the dedicated keyfile
data/secrets/doc-kek.key (raw 32 bytes, minted by setup.sh) — NOT
DEVICE_SECRET_KEY, which travels inside every restic snapshot via .env and
would make snapshots self-decrypting. The keyfile is excluded from the
backup set (droplet-backup.sh), so deleting a wrapped DEK crypto-shreds its
ciphertext even against restored backups. TPM-sealing the KEK is WARP-1033.
"""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

ENC_PREFIX = "dcv1:"
_SALT = b"droplet-column-crypto-v1"
_IV_LEN = 12


def derive_doc_kek(ikm: bytes) -> bytes:
    """HKDF the doc-KEK from the raw 32-byte master key (keyfile bytes).

    WARP-242: signature changed from base64(DEVICE_SECRET_KEY) to raw keyfile
    bytes — see the module docstring for why the ikm source moved.
    """
    if len(ikm) != 32:
        raise ValueError(f"doc-KEK master key must be 32 bytes (got {len(ikm)})")
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=_SALT, info=b"doc-kek").derive(ikm)


def load_doc_kek(path: str) -> bytes:
    """Read the doc-KEK master keyfile and derive the KEK. Fails closed
    (raises) when the file is missing or malformed — brain indexing must
    never silently fall back to writing plaintext."""
    try:
        with open(path, "rb") as f:
            ikm = f.read()
    except OSError as e:
        raise RuntimeError(
            f"doc-KEK keyfile unreadable at {path} — run scripts/setup.sh "
            f"(mints data/secrets/doc-kek.key): {e}"
        ) from e
    return derive_doc_kek(ikm)


def generate_dek() -> bytes:
    return os.urandom(32)


def wrap_dek(kek: bytes, dek: bytes, key_id: str) -> str:
    iv = os.urandom(_IV_LEN)
    ct = AESGCM(kek).encrypt(iv, dek, key_id.encode())  # AESGCM appends the 16-byte tag
    return base64.b64encode(iv + ct).decode()


def unwrap_dek(kek: bytes, wrapped: str, key_id: str) -> bytes:
    raw = base64.b64decode(wrapped)
    return AESGCM(kek).decrypt(raw[:_IV_LEN], raw[_IV_LEN:], key_id.encode())


def encrypt_text(dek: bytes, plaintext: str, aad: str | None = None) -> str:
    """WARP-242: optional ``aad`` binds the ciphertext to its document
    identity (chunk text passes the DEK's keyId, e.g. "brain:<itemId>").
    AAD is authenticated by the GCM tag but not stored — decrypt must supply
    the same value. Omitting it keeps WARP-233 callers unchanged."""
    iv = os.urandom(_IV_LEN)
    ct = AESGCM(dek).encrypt(iv, plaintext.encode("utf-8"), aad.encode() if aad else None)
    return ENC_PREFIX + base64.b64encode(iv + ct).decode()


def decrypt_text(dek: bytes, blob: str, aad: str | None = None) -> str:
    if not blob.startswith(ENC_PREFIX):
        raise ValueError("column_crypto: missing dcv1: prefix")
    raw = base64.b64decode(blob[len(ENC_PREFIX):])
    return AESGCM(dek).decrypt(
        raw[:_IV_LEN], raw[_IV_LEN:], aad.encode() if aad else None
    ).decode("utf-8")


def is_encrypted(value: str) -> bool:
    return value.startswith(ENC_PREFIX)
