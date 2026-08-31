"""Tests for the encrypted keystore."""

import pytest

from auth import keystore
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
        """Verify the stored file is not plaintext.

        WARP-561: a no-user store lands in the shared namespace subdir."""
        await store_key("test", "my-secret-key")
        enc_file = keys_dir / keystore._SHARED_NAMESPACE / "test.enc"
        assert enc_file.exists()
        raw = enc_file.read_bytes()
        assert b"my-secret-key" not in raw


class TestDeviceSecretSafety:
    """GW-09: refuse / warn when DEVICE_SECRET is the public dev default."""

    def test_real_secret_is_silent(self, monkeypatch, caplog):
        monkeypatch.setattr(keystore, "DEVICE_SECRET", "a-real-per-device-secret")
        monkeypatch.setenv("DROPLET_ENV", "production")
        with caplog.at_level("ERROR", logger="auth.keystore"):
            keystore._assert_device_secret_safe()  # must not raise
        assert not any("DEVICE_SECRET" in r.getMessage() for r in caplog.records)

    def test_dev_default_logs_error_but_does_not_raise_in_dev(self, monkeypatch, caplog):
        monkeypatch.setattr(keystore, "DEVICE_SECRET", keystore._DEV_DEFAULT_SECRET)
        monkeypatch.delenv("DROPLET_ENV", raising=False)
        monkeypatch.delenv("DROPLET_FIPS_REQUIRED", raising=False)
        with caplog.at_level("ERROR", logger="auth.keystore"):
            keystore._assert_device_secret_safe()  # dev: warn, don't crash
        assert any("DEVICE_SECRET" in r.getMessage() for r in caplog.records)
        # CodeQL py/clear-text-logging-sensitive-data: the line names the
        # constant, it never prints its value.
        assert not any(
            keystore._DEV_DEFAULT_SECRET in r.getMessage() for r in caplog.records
        )

    def test_dev_default_fails_closed_in_production(self, monkeypatch):
        monkeypatch.setattr(keystore, "DEVICE_SECRET", keystore._DEV_DEFAULT_SECRET)
        monkeypatch.setenv("DROPLET_ENV", "production")
        with pytest.raises(RuntimeError, match="DEVICE_SECRET"):
            keystore._assert_device_secret_safe()

    def test_dev_default_fails_closed_when_fips_required(self, monkeypatch):
        monkeypatch.setattr(keystore, "DEVICE_SECRET", keystore._DEV_DEFAULT_SECRET)
        monkeypatch.delenv("DROPLET_ENV", raising=False)
        monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "true")
        with pytest.raises(RuntimeError, match="DEVICE_SECRET"):
            keystore._assert_device_secret_safe()


class TestPathContainment:
    """CodeQL py/path-injection: neither the provider (URL path segment) nor
    the user id may steer the key file outside KEYS_DIR."""

    @pytest.mark.parametrize(
        "bad", ["../escape", "..", ".", "a/b", "/abs", "", "x" * 65, "open ai", "-dash"]
    )
    async def test_store_rejects_non_token_provider(self, keys_dir, bad):
        with pytest.raises(ValueError):
            await store_key(bad, "sk-test-key-1234567890")
        assert not (keys_dir.parent / "escape.enc").exists()
        assert not list(keys_dir.rglob("*.enc"))

    async def test_get_and_delete_treat_bad_provider_as_absent(self, keys_dir):
        assert await get_key("../escape") is None
        assert await delete_key("../../escape") is False

    async def test_dotted_and_dashed_provider_names_still_work(self, keys_dir):
        await store_key("my-provider.v2", "sk-test-key-1234567890")
        assert await get_key("my-provider.v2") == "sk-test-key-1234567890"
        assert await delete_key("my-provider.v2") is True

    async def test_user_id_traversal_stays_under_keys_dir(self, keys_dir):
        await store_key("openai", "sk-test-key-1234567890", user_id="../../outside")
        files = list(keys_dir.rglob("openai.enc"))
        assert len(files) == 1
        assert files[0].resolve().is_relative_to(keys_dir.resolve())
        assert not (keys_dir.parent.parent / "outside").exists()
        assert await get_key("openai", user_id="../../outside") == "sk-test-key-1234567890"
