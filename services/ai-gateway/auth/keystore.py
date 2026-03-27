"""Encrypted API key storage using device-unique key."""

from __future__ import annotations

import os
import logging
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

KEYS_DIR = Path(os.getenv("KEYS_DIR", "/data/keys"))
DEVICE_SECRET = os.getenv("DEVICE_SECRET", "dev-secret-change-in-production")


def _get_fernet() -> Fernet:
    """Derive a Fernet key from the device secret."""
    import hashlib
    import base64

    # Derive a 32-byte key from the secret
    key = hashlib.sha256(DEVICE_SECRET.encode()).digest()
    fernet_key = base64.urlsafe_b64encode(key)
    return Fernet(fernet_key)


async def store_key(provider: str, api_key: str) -> None:
    """Encrypt and store an API key for a provider."""
    KEYS_DIR.mkdir(parents=True, exist_ok=True)
    fernet = _get_fernet()
    encrypted = fernet.encrypt(api_key.encode())
    key_path = KEYS_DIR / f"{provider}.enc"
    key_path.write_bytes(encrypted)
    logger.info("Stored API key for provider: %s", provider)


async def get_key(provider: str) -> str | None:
    """Retrieve and decrypt an API key for a provider."""
    key_path = KEYS_DIR / f"{provider}.enc"
    if not key_path.exists():
        return None

    try:
        fernet = _get_fernet()
        encrypted = key_path.read_bytes()
        return fernet.decrypt(encrypted).decode()
    except InvalidToken:
        logger.error("Failed to decrypt key for %s — possible secret mismatch", provider)
        return None


async def delete_key(provider: str) -> bool:
    """Remove a stored API key."""
    key_path = KEYS_DIR / f"{provider}.enc"
    if key_path.exists():
        key_path.unlink()
        logger.info("Deleted API key for provider: %s", provider)
        return True
    return False


async def list_providers_with_keys() -> list[str]:
    """Return provider names that have stored keys."""
    if not KEYS_DIR.exists():
        return []
    return [p.stem for p in KEYS_DIR.glob("*.enc")]
