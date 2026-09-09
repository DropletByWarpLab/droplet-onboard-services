"""WARP-561 → WARP-2871: cloud keys are box-wide, not per-user.

WARP-561 namespaced BYOK keys per authenticated user
(`{user_id}/{provider}.enc`), with a `_shared` namespace for identity-less
server-side callers (model listing, gRPC EmbedText, router reload).

WARP-2871 retires that. Cloud provider keys are admin-managed and box-wide:
the Models page saves and deletes them with no principal, and `GET
/api/models` reports one box-wide `hasKey` per provider. A per-user key that
outlived the retired `ProviderKeyForm` would keep read precedence while being
invisible to the admin's list and delete — key material nobody can see or
remove. So `_shared` is now the ONLY namespace the keystore touches, for
every operation, whatever `user_id` a caller passes; and
`retire_per_user_keys()` deletes the legacy namespaces once at startup.

These tests pin that contract. The traversal-safety property from WARP-561 is
kept: a hostile user id can still never place a file outside KEYS_DIR.
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


def _seed_legacy(keys_dir: Path, namespace: str, provider: str) -> Path:
    """Write a legacy WARP-561 per-user key file directly on disk.

    Deliberately bypasses the keystore API — after WARP-2871 there is no
    supported way to create one, which is exactly why the sweep exists.
    """
    path = keys_dir / namespace / f"{provider}.enc"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"legacy-ciphertext")
    return path


class TestSharedOnly:
    async def test_store_with_user_id_lands_in_shared(self, clean_keys):
        await save_api_key("anthropic", "sk-ant-alice-key-1234567", user_id="alice")

        assert (clean_keys / keystore._SHARED_NAMESPACE / "anthropic.enc").exists()
        assert not (clean_keys / "alice").exists()

    async def test_get_with_any_user_id_reads_shared(self, clean_keys):
        await save_api_key("anthropic", "sk-ant-shared-key-1234567", user_id=None)

        assert await get_api_key("anthropic", user_id=None) == "sk-ant-shared-key-1234567"
        assert await get_api_key("anthropic", user_id="alice") == "sk-ant-shared-key-1234567"
        assert await get_api_key("anthropic", user_id="bob") == "sk-ant-shared-key-1234567"

    async def test_second_user_overwrites_the_one_box_wide_key(self, clean_keys):
        # There is exactly one key per provider now. Two admins saving in turn
        # is a replace, not two namespaces.
        await save_api_key("openai", "sk-proj-first-key-12345678", user_id="alice")
        await save_api_key("openai", "sk-proj-second-key-1234567", user_id="bob")

        assert await get_api_key("openai", user_id=None) == "sk-proj-second-key-1234567"
        assert await keystore.list_providers_with_keys(user_id=None) == ["openai"]

    async def test_list_with_user_id_lists_shared(self, clean_keys):
        await save_api_key("anthropic", "sk-ant-shared-key-1234567", user_id=None)

        assert await keystore.list_providers_with_keys(user_id="alice") == ["anthropic"]
        assert await keystore.list_providers_with_keys(user_id=None) == ["anthropic"]

    async def test_delete_with_user_id_removes_the_shared_key(self, clean_keys):
        # The admin's delete must really remove the box's key material — the
        # WARP-2871 defect was a namespace-exact delete that quietly no-op'd.
        await save_api_key("anthropic", "sk-ant-shared-key-1234567", user_id=None)

        assert await delete_api_key("anthropic", user_id="alice") is True
        assert await get_api_key("anthropic", user_id=None) is None

    async def test_delete_of_absent_key_is_false(self, clean_keys):
        assert await delete_api_key("anthropic", user_id="alice") is False


class TestRetirePerUserKeys:
    async def test_sweep_removes_legacy_namespaces_and_keeps_shared(self, clean_keys):
        await save_api_key("anthropic", "sk-ant-shared-key-1234567", user_id=None)
        _seed_legacy(clean_keys, "alice", "anthropic")
        _seed_legacy(clean_keys, "bob", "openai")

        namespaces, providers = keystore.retire_per_user_keys()

        assert (namespaces, providers) == (2, 2)
        assert not (clean_keys / "alice").exists()
        assert not (clean_keys / "bob").exists()
        assert await get_api_key("anthropic", user_id=None) == "sk-ant-shared-key-1234567"
        assert (clean_keys / ".salt").exists()  # device salt survives

    async def test_sweep_is_idempotent(self, clean_keys):
        _seed_legacy(clean_keys, "alice", "anthropic")

        assert keystore.retire_per_user_keys() == (1, 1)
        assert keystore.retire_per_user_keys() == (0, 0)

    def test_sweep_survives_missing_keys_dir(self, tmp_path, monkeypatch):
        # Startup must not crash on a box whose keys volume has not been
        # created yet (WARP-2871: log and continue).
        monkeypatch.setattr(keystore, "KEYS_DIR", tmp_path / "does-not-exist")
        assert keystore.retire_per_user_keys() == (0, 0)

    def test_sweep_survives_an_unremovable_namespace(self, clean_keys, monkeypatch):
        _seed_legacy(clean_keys, "alice", "anthropic")

        def boom(*_args, **_kwargs):
            raise OSError("read-only file system")

        monkeypatch.setattr(keystore.shutil, "rmtree", boom)
        assert keystore.retire_per_user_keys() == (0, 0)

    def test_sweep_logs_a_count_and_never_a_user_id_or_key(self, clean_keys, caplog):
        _seed_legacy(clean_keys, "alice", "anthropic")
        _seed_legacy(clean_keys, "bob", "openai")

        with caplog.at_level("WARNING", logger="auth.keystore"):
            keystore.retire_per_user_keys()

        warnings = [r for r in caplog.records if r.levelname == "WARNING"]
        assert len(warnings) == 1
        message = warnings[0].getMessage()
        assert "2" in message
        # Rule 19: a retirement notice must never name whose key it removed.
        assert "alice" not in message and "bob" not in message

    def test_sweep_says_nothing_when_there_is_nothing_to_retire(self, clean_keys, caplog):
        with caplog.at_level("WARNING", logger="auth.keystore"):
            assert keystore.retire_per_user_keys() == (0, 0)
        assert [r for r in caplog.records if r.levelname == "WARNING"] == []


class TestNamespaceSafety:
    async def test_traversal_user_id_cannot_escape_keys_dir(self, clean_keys):
        # A hostile id with path separators / parent refs writes inside
        # KEYS_DIR — now because the id never reaches the path at all.
        await save_api_key(
            "anthropic", "sk-ant-key-12345678901234", user_id="../../etc/cron.d/evil"
        )

        written = sorted(p for p in clean_keys.rglob("*.enc"))
        assert written == [clean_keys / keystore._SHARED_NAMESPACE / "anthropic.enc"]
        assert ".." not in written[0].parts

    def test_key_path_stays_inside_keys_dir(self, clean_keys):
        path = keystore._key_path("anthropic")
        keys_dir = Path(os.environ["KEYS_DIR"]).resolve()
        assert keys_dir in path.resolve().parents
        assert ".." not in path.parts
