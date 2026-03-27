"""Tests for the encrypted keystore."""

import pytest

from auth.keystore import store_key, get_key, delete_key, list_providers_with_keys


class TestKeystore:
    async def test_store_and_retrieve(self, keys_dir):
        await store_key("anthropic", "sk-ant-test-key-12345678")
        result = await get_key("anthropic")
        assert result == "sk-ant-test-key-12345678"

    async def test_get_nonexistent_key(self, keys_dir):
        result = await get_key("nonexistent")
        assert result is None

    async def test_delete_key(self, keys_dir):
        await store_key("openai", "sk-test-openai-key")
        deleted = await delete_key("openai")
        assert deleted is True
        result = await get_key("openai")
        assert result is None

    async def test_delete_nonexistent(self, keys_dir):
        deleted = await delete_key("nonexistent")
        assert deleted is False

    async def test_list_providers_empty(self, keys_dir):
        providers = await list_providers_with_keys()
        assert providers == []

    async def test_list_providers_with_keys(self, keys_dir):
        await store_key("anthropic", "key1")
        await store_key("openai", "key2")
        providers = await list_providers_with_keys()
        assert sorted(providers) == ["anthropic", "openai"]

    async def test_overwrite_key(self, keys_dir):
        await store_key("anthropic", "old-key")
        await store_key("anthropic", "new-key")
        result = await get_key("anthropic")
        assert result == "new-key"

    async def test_encryption_is_applied(self, keys_dir):
        """Verify the stored file is not plaintext."""
        await store_key("test", "my-secret-key")
        enc_file = keys_dir / "test.enc"
        assert enc_file.exists()
        raw = enc_file.read_bytes()
        assert b"my-secret-key" not in raw
