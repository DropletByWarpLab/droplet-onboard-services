"""BYOK (Bring Your Own Key) validation and storage."""

from __future__ import annotations

import logging

from auth import keystore

logger = logging.getLogger(__name__)

# Minimum key length per provider (basic sanity check)
MIN_KEY_LENGTHS = {
    "anthropic": 20,
    "openai": 20,
}

# Upper bound on any accepted key. Real provider keys are ~100-200 chars; a
# body beyond this is junk/abuse. Bounding here (in addition to
# ApiKeyRequest.max_length) keeps the limit enforced for any direct caller of
# save_api_key, not just the HTTP route, so an oversized blob is never PBKDF2'd
# and written to disk. See GW-10.
MAX_KEY_LENGTH = 512


async def validate_key_format(provider: str, api_key: str) -> bool:
    """Basic validation that an API key looks reasonable."""
    min_length = MIN_KEY_LENGTHS.get(provider, 10)
    if len(api_key) < min_length:
        return False
    if len(api_key) > MAX_KEY_LENGTH:
        return False
    if " " in api_key:
        return False
    return True


# WARP-561 scoped these to the calling user; WARP-2871 made cloud keys
# box-wide and admin-managed, so the keystore ignores `user_id` on every
# operation. The parameter stays because callers still forward the request
# principal — see auth/keystore.py for why it is no longer honoured.


async def save_api_key(provider: str, api_key: str, user_id: str | None = None) -> None:
    """Validate and store the box-wide API key for a provider (WARP-2871)."""
    if not await validate_key_format(provider, api_key):
        raise ValueError(f"Invalid API key format for {provider}")
    await keystore.store_key(provider, api_key, user_id=user_id)


async def get_api_key(provider: str, user_id: str | None = None) -> str | None:
    """Retrieve the box-wide API key for a provider (WARP-2871)."""
    return await keystore.get_key(provider, user_id=user_id)


async def delete_api_key(provider: str, user_id: str | None = None) -> bool:
    """Remove the box-wide API key for a provider (WARP-2871)."""
    return await keystore.delete_key(provider, user_id=user_id)
