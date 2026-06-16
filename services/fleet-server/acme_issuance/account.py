"""ACME account key persistence (ADR-023 §Decision 6 — HQ-only secret).

The HQ holds ONE ACME account, identified by an RSA account key generated
on first boot and persisted to ``ACME_ACCOUNT_KEY_PATH`` (mode 0600).
Subsequent boots load the same key so we reuse the account instead of
re-registering. This key is an HQ-only secret-file — never tracked, never
shipped to a box.
"""

from __future__ import annotations

import logging
import os
import stat
from pathlib import Path

import josepy as jose
from cryptography.hazmat.primitives.asymmetric import rsa

logger = logging.getLogger(__name__)

_ACCOUNT_KEY_BITS = 2048


def load_or_create_account_key(path: str) -> jose.JWKRSA:
    """Return the persisted ACME account JWK, creating + persisting one
    (0600) on first call."""
    key_path = Path(path)
    if key_path.exists():
        jwk = jose.JWKRSA.json_loads(key_path.read_text())
        logger.info("acme: loaded existing account key from %s", path)
        return jwk

    key_path.parent.mkdir(parents=True, exist_ok=True)
    private_key = rsa.generate_private_key(
        public_exponent=65537, key_size=_ACCOUNT_KEY_BITS
    )
    jwk = jose.JWKRSA(key=private_key)
    key_path.write_text(jwk.json_dumps())
    # Best-effort 0600. On Windows chmod is a no-op for group/other, but on
    # the Linux HQ host this enforces the secret-file posture.
    try:
        os.chmod(key_path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:  # pragma: no cover - platform dependent
        pass
    logger.info("acme: generated + persisted new account key at %s", path)
    return jwk
