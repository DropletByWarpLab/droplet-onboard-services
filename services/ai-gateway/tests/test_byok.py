"""Tests for BYOK key validation and management."""

import pytest

from auth.byok import validate_key_format, save_api_key, get_api_key, delete_api_key


class TestValidateKeyFormat:
    async def test_valid_anthropic_key(self):
        assert await validate_key_format("anthropic", "sk-ant-api03-abcdefghijklmnop") is True

    async def test_valid_openai_key(self):
        assert await validate_key_format("openai", "sk-proj-abcdefghijklmnopqrst") is True

    async def test_too_short_key(self):
        assert await validate_key_format("anthropic", "short") is False

    async def test_key_with_spaces(self):
        assert await validate_key_format("openai", "sk-proj with spaces") is False


class TestSaveAndGetApiKey:
    async def test_save_and_get(self, keys_dir):
        await save_api_key("anthropic", "sk-ant-valid-key-here-1234567")
        result = await get_api_key("anthropic")
        assert result == "sk-ant-valid-key-here-1234567"

    async def test_save_invalid_key_raises(self, keys_dir):
        with pytest.raises(ValueError, match="Invalid API key format"):
            await save_api_key("anthropic", "bad")

    async def test_delete(self, keys_dir):
        await save_api_key("openai", "sk-proj-valid-key-here-12345")
        deleted = await delete_api_key("openai")
        assert deleted is True
        result = await get_api_key("openai")
        assert result is None
