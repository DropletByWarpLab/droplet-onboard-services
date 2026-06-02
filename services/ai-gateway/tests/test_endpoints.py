"""Tests for FastAPI endpoint handlers."""

import pytest
from unittest.mock import patch, AsyncMock

from schemas import ModelInfo


class TestHealthEndpoint:
    async def test_health_ok(self, client):
        resp = await client.get("/ai/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "jetson_reachable" in data


class TestModelsEndpoint:
    async def test_list_models(self, client):
        resp = await client.get("/ai/models")
        # 200 if lifespan ran, 503 if globals not initialized in test
        assert resp.status_code in (200, 503)
        if resp.status_code == 200:
            data = resp.json()
            assert "models" in data
            assert isinstance(data["models"], list)


class TestChatEndpoint:
    async def test_chat_missing_body(self, client):
        resp = await client.post("/ai/chat", json={})
        assert resp.status_code == 422  # Pydantic validation error

    async def test_chat_valid_request_format(self, client):
        """Test that a properly formatted request is accepted (may fail at provider level)."""
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": False,
            },
        )
        # 502 if no Ollama, 503 if globals not initialized in test, but NOT 422
        assert resp.status_code in (200, 502, 503)


class TestKeysEndpoints:
    async def test_list_keys_empty(self, client, keys_dir):
        resp = await client.get("/ai/keys")
        assert resp.status_code == 200
        data = resp.json()
        assert data["providers"] == []

    async def test_store_key(self, client, keys_dir):
        resp = await client.post(
            "/ai/keys/anthropic",
            json={"api_key": "sk-ant-test-key-very-long-enough"},
        )
        assert resp.status_code == 200
        assert resp.json()["provider"] == "anthropic"

    async def test_store_key_then_list(self, client, keys_dir):
        await client.post(
            "/ai/keys/anthropic",
            json={"api_key": "sk-ant-test-key-very-long-enough"},
        )
        resp = await client.get("/ai/keys")
        assert "anthropic" in resp.json()["providers"]

    async def test_store_invalid_key(self, client, keys_dir):
        resp = await client.post(
            "/ai/keys/anthropic",
            json={"api_key": "short"},
        )
        assert resp.status_code == 400

    async def test_delete_key(self, client, keys_dir):
        await client.post(
            "/ai/keys/openai",
            json={"api_key": "sk-test-openai-key-long-enough-here"},
        )
        resp = await client.delete("/ai/keys/openai")
        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"

    async def test_delete_nonexistent_key(self, client, keys_dir):
        resp = await client.delete("/ai/keys/nonexistent")
        assert resp.status_code == 404


class TestReadinessEndpoint:
    """XR-05: /ai/readiness must not 404 against Ollama on the direct path."""

    async def test_readiness_ok_when_no_manager_configured(self, client):
        # conftest sets OLLAMA_URL to the direct :11434 path (no /proxy) and no
        # OLLAMA_MANAGER_URL, so there's no manager /health to probe. The
        # endpoint must report ok with appliance=None, NOT a perpetual degraded.
        import main
        from router import ProviderRouter

        if main.provider_router is None:
            main.provider_router = ProviderRouter()

        # Sanity: the resolved manager health URL is None on this deploy shape.
        assert main.provider_router.ollama._limits.health_url is None

        resp = await client.get("/ai/readiness")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["appliance"] is None
