"""WARP-233 — app-layer PHI/PII column encryption (Python twin of
apps/orchestrator/src/services/column-crypto.service.ts — keep the wire
format in lockstep: dcv1: + base64(iv(12) || ciphertext || tag(16))).
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


def derive_doc_kek(device_secret_key_b64: str) -> bytes:
    ikm = base64.b64decode(device_secret_key_b64)
    if len(ikm) != 32:
        raise ValueError(f"DEVICE_SECRET_KEY must decode to 32 bytes (got {len(ikm)})")
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=_SALT, info=b"doc-kek").derive(ikm)


def generate_dek() -> bytes:
    return os.urandom(32)


def wrap_dek(kek: bytes, dek: bytes, key_id: str) -> str:
    iv = os.urandom(_IV_LEN)
    ct = AESGCM(kek).encrypt(iv, dek, key_id.encode())  # AESGCM appends the 16-byte tag
    return base64.b64encode(iv + ct).decode()


def unwrap_dek(kek: bytes, wrapped: str, key_id: str) -> bytes:
    raw = base64.b64decode(wrapped)
    return AESGCM(kek).decrypt(raw[:_IV_LEN], raw[_IV_LEN:], key_id.encode())


def encrypt_text(dek: bytes, plaintext: str) -> str:
    iv = os.urandom(_IV_LEN)
    ct = AESGCM(dek).encrypt(iv, plaintext.encode("utf-8"), None)
    return ENC_PREFIX + base64.b64encode(iv + ct).decode()


def decrypt_text(dek: bytes, blob: str) -> str:
    if not blob.startswith(ENC_PREFIX):
        raise ValueError("column_crypto: missing dcv1: prefix")
    raw = base64.b64decode(blob[len(ENC_PREFIX):])
    return AESGCM(dek).decrypt(raw[:_IV_LEN], raw[_IV_LEN:], None).decode("utf-8")


def is_encrypted(value: str) -> bool:
    return value.startswith(ENC_PREFIX)
