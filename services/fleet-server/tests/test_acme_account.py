"""ACME account-key persistence (acme_issuance/account.py).

The HQ ACME account key is generated once and persisted (HQ-only
secret-file, never tracked). Subsequent boots load the same key so we
keep the same ACME account rather than re-registering each restart.
"""

from __future__ import annotations

from pathlib import Path

import josepy as jose

from acme_issuance import account


def test_generates_and_persists_account_key(tmp_path):
    key_path = tmp_path / "acme-account.key"
    jwk = account.load_or_create_account_key(str(key_path))
    assert isinstance(jwk, jose.JWKRSA)
    assert key_path.exists()
    # 0600-ish: the file should not be empty and should be a JSON JWK.
    assert key_path.read_text().strip().startswith("{")


def test_load_is_stable_across_calls(tmp_path):
    key_path = tmp_path / "acme-account.key"
    a = account.load_or_create_account_key(str(key_path))
    b = account.load_or_create_account_key(str(key_path))
    # Same key material on the second load — no re-generation.
    assert a.key.private_numbers().d == b.key.private_numbers().d


def test_creates_parent_dir(tmp_path):
    key_path = tmp_path / "nested" / "dir" / "acme-account.key"
    account.load_or_create_account_key(str(key_path))
    assert key_path.exists()
