"""WARP-588: create_session_store() must fail loud in production.

The in-memory session store silently loses all chat history on restart and is
not shared across workers. In a shipping deployment (DROPLET_ENV in
{production, prod}, or DROPLET_FIPS_REQUIRED truthy) with no REDIS_URL we now
refuse to boot rather than fall back to it.
"""

import pytest

import sessions.store as store
from sessions.store import create_session_store, InMemorySessionStore


@pytest.fixture(autouse=True)
def _no_prod_env(monkeypatch):
    """Start each test from a clean dev posture (no production signal)."""
    monkeypatch.delenv("DROPLET_ENV", raising=False)
    monkeypatch.delenv("DROPLET_FIPS_REQUIRED", raising=False)
    yield


def test_dev_no_redis_uses_in_memory(monkeypatch):
    monkeypatch.setattr(store, "REDIS_URL", "")
    s = create_session_store()
    assert isinstance(s, InMemorySessionStore)


def test_production_no_redis_raises(monkeypatch):
    monkeypatch.setattr(store, "REDIS_URL", "")
    monkeypatch.setenv("DROPLET_ENV", "production")
    with pytest.raises(RuntimeError, match="REDIS_URL"):
        create_session_store()


def test_prod_alias_no_redis_raises(monkeypatch):
    monkeypatch.setattr(store, "REDIS_URL", "")
    monkeypatch.setenv("DROPLET_ENV", "prod")
    with pytest.raises(RuntimeError, match="REDIS_URL"):
        create_session_store()


def test_fips_required_no_redis_raises(monkeypatch):
    monkeypatch.setattr(store, "REDIS_URL", "")
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "true")
    with pytest.raises(RuntimeError, match="REDIS_URL"):
        create_session_store()


def test_production_with_redis_does_not_raise(monkeypatch):
    # With REDIS_URL set, production is fine — it builds the Redis store.
    # We don't connect here; constructing RedisSessionStore is enough to prove
    # the factory took the Redis branch instead of raising.
    monkeypatch.setattr(store, "REDIS_URL", "redis://localhost:6379/0")
    monkeypatch.setenv("DROPLET_ENV", "production")
    s = create_session_store()
    assert not isinstance(s, InMemorySessionStore)
