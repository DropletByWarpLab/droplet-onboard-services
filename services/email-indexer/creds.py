"""WARP-465 D1 follow-up — Fernet credential decryption.

The orchestrator stores EmailAccount.passwordEnc as a Fernet
ciphertext (URL-safe base64). The Fernet key lives at
/data/secrets/email.key (mode 0600), per-device, generated once by
setup.sh. The orchestrator never sees the plaintext password — only
this service (and the operator at /add-account time) does.

Boot posture:
  - Missing key file → service exits non-zero. Without a key we
    can't decrypt any account; better to fail fast than IDLE-loop
    every account with InvalidToken.
  - Malformed Fernet token at runtime → log + skip the account.
    A single corrupt row can't take the whole service down.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

EMAIL_KEY_PATH = Path(os.environ.get("EMAIL_KEY_PATH", "/data/secrets/email.key"))


_fernet: Optional[Fernet] = None


def init_or_exit() -> None:
    """Load the Fernet key at boot. Exit non-zero on any failure so
    docker logs make the misconfiguration obvious."""
    global _fernet
    if not EMAIL_KEY_PATH.exists():
        sys.stderr.write(
            '{"event":"email_key_missing","path":"%s"}\n' % EMAIL_KEY_PATH,
        )
        sys.exit(1)
    try:
        key = EMAIL_KEY_PATH.read_bytes().strip()
        _fernet = Fernet(key)
    except (ValueError, OSError) as exc:
        sys.stderr.write(
            '{"event":"email_key_invalid","error":"%s"}\n' % exc,
        )
        sys.exit(1)


def decrypt(ciphertext: str) -> Optional[str]:
    """Decrypt a single passwordEnc. None on any failure — the caller
    treats that as "skip this account, log + move on" rather than
    crashing the IDLE pool."""
    if _fernet is None:
        logger.error("decrypt called before init_or_exit")
        return None
    try:
        plain = _fernet.decrypt(ciphertext.encode("utf-8"))
        return plain.decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        logger.warning("Fernet decrypt failed: %s", exc)
        return None


def _set_for_tests(fernet: Optional[Fernet]) -> None:
    """Test-only seam — inject a Fernet with a known key so the
    decryption path is exercisable without /data/secrets present."""
    global _fernet
    _fernet = fernet
