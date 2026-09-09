"""WARP-561: per-user BYOK key isolation.

Keys were device-global (`{provider}.enc`); any caller could read any other
user's cloud key. They are now namespaced per authenticated user
(`{user_id}/{provider}.enc`), with a shared `_shared` namespace for identity-
less server-side callers (model listing, gRPC). WARP-2871: `_shared` also
holds the admin-managed box-wide keys, which `get_key` falls back to when a
user has none of their own. The user-id segment is sanitised so it can never
escape KEYS_DIR.
"""

import os
import shutil
from pathlib import Path

import pytest

from auth import keystore
from auth.byok import save_api_key, get_api_key, delete_api_key


@pytest.fixture
def clean_keys():
    """Wipe the whole KEYS_DIR (including per-user subdirs) around each test."""
    d = Path(os.environ["KEYS_DIR"])
    for child in d.iterdir() if d.exists() else []:
        if child.name == ".salt":
            continue  # keep the device salt stable across tests
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink()
    yield d


class TestPerUserIsolation:
    async def test_two_users_keep_independent_keys(self, clean_keys):
        await save_api_key("anthropic", "sk-ant-alice-key-1234567", user_id="alice")
        await save_api_key("anthropic", "sk-ant-bob-key-7654321", user_id="bob")

        assert await get_api_key("anthropic", user_id="alice") == "sk-ant-alice-key-1234567"
        assert await get_api_key("anthropic", user_id="bob") == "sk-ant-bob-key-7654321"

    async def test_one_user_cannot_read_another(self, clean_keys):
        await save_api_key("openai", "sk-proj-alice-only-1234567", user_id="alice")
        # Bob has no key of his own — must NOT inherit Alice's.
        assert await get_api_key("openai", user_id="bob") is None

    async def test_delete_is_scoped_to_user(self, clean_keys):
        await save_api_key("openai", "sk-proj-alice-key-1234567", user_id="alice")
        await save_api_key("openai", "sk-proj-bob-key-7654321", user_id="bob")

        assert await delete_api_key("openai", user_id="alice") is True
        # Bob's key survives Alice's delete.
        assert await get_api_key("openai", user_id="bob") == "sk-proj-bob-key-7654321"
        assert await get_api_key("openai", user_id="alice") is None

    async def test_list_is_scoped_to_user(self, clean_keys):
        await save_api_key("anthropic", "sk-ant-alice-key-1234567", user_id="alice")
        await save_api_key("openai", "sk-proj-bob-key-7654321", user_id="bob")

        assert await keystore.list_providers_with_keys(user_id="alice") == ["anthropic"]
        assert await keystore.list_providers_with_keys(user_id="bob") == ["openai"]

    async def test_user_without_own_key_falls_back_to_shared(self, clean_keys):
        # WARP-2871: cloud keys are box-wide and admin-managed. The admin
        # saves with no principal (user_id=None → `_shared`), and a user with
        # no personal key must be served by it.
        await save_api_key("anthropic", "sk-ant-shared-key-1234567", user_id=None)
        assert await get_api_key("anthropic", user_id=None) == "sk-ant-shared-key-1234567"
        assert await get_api_key("anthropic", user_id="alice") == "sk-ant-shared-key-1234567"

    async def test_per_user_key_wins_over_shared(self, clean_keys):
        await save_api_key("anthropic", "sk-ant-shared-key-1234567", user_id=None)
        await save_api_key("anthropic", "sk-ant-alice-key-1234567", user_id="alice")
        assert await get_api_key("anthropic", user_id="alice") == "sk-ant-alice-key-1234567"
        # Bob has none of his own → shared, never Alice's.
        assert await get_api_key("anthropic", user_id="bob") == "sk-ant-shared-key-1234567"

    async def test_list_does_not_include_shared_only_providers(self, clean_keys):
        # The admin UI lists/deletes `_shared` explicitly (no header); a
        # user's listing stays namespace-exact.
        await save_api_key("anthropic", "sk-ant-shared-key-1234567", user_id=None)
        assert await keystore.list_providers_with_keys(user_id="alice") == []
        assert await keystore.list_providers_with_keys(user_id=None) == ["anthropic"]

    async def test_delete_never_touches_shared_key(self, clean_keys):
        await save_api_key("anthropic", "sk-ant-shared-key-1234567", user_id=None)
        assert await delete_api_key("anthropic", user_id="alice") is False
        assert await get_api_key("anthropic", user_id=None) == "sk-ant-shared-key-1234567"

class TestNamespaceSafety:
    def test_traversal_user_id_cannot_escape_keys_dir(self, clean_keys):
        # A hostile id with path separators / parent refs collapses to a safe
        # token that stays inside KEYS_DIR.
        path = keystore._key_path("anthropic", "../../etc/cron.d/evil")
        keys_dir = Path(os.environ["KEYS_DIR"]).resolve()
        assert keys_dir in path.resolve().parents
        assert ".." not in path.parts

    def test_dot_only_id_falls_back_to_shared(self, clean_keys):
        assert keystore._user_namespace("..") == keystore._SHARED_NAMESPACE
        assert keystore._user_namespace("") == keystore._SHARED_NAMESPACE
        assert keystore._user_namespace(None) == keystore._SHARED_NAMESPACE
