"""WARP-465 D1 follow-up — Fernet credential helper.

Boot-path tests use a real Fernet round-trip to confirm we can
decrypt what the orchestrator (via setup.sh) would have encrypted.
"""
from __future__ import annotations

from cryptography.fernet import Fernet

import creds


def test_round_trip_with_test_key():
    f = Fernet(Fernet.generate_key())
    creds._set_for_tests(f)
    try:
        plaintext = "swordfish-correct-horse-battery"
        ciphertext = f.encrypt(plaintext.encode("utf-8")).decode("utf-8")
        assert creds.decrypt(ciphertext) == plaintext
    finally:
        creds._set_for_tests(None)


def test_invalid_token_returns_none():
    f = Fernet(Fernet.generate_key())
    creds._set_for_tests(f)
    try:
        assert creds.decrypt("not-a-fernet-token") is None
    finally:
        creds._set_for_tests(None)


def test_decrypt_before_init_returns_none():
    creds._set_for_tests(None)
    assert creds.decrypt("anything") is None
