"""Tests for FastAPI endpoint handlers."""

import asyncio

import httpx
import pytest
import respx
from unittest.mock import patch, AsyncMock, MagicMock

from schemas import ChatRequest, ModelInfo


class TestHealthEndpoint:
    async def test_health_ok(self, client):
        resp = await client.get("/ai/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "inference_reachable" in data


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


class TestChatSlotReleaseOnCancel:
    """GWV-003 / WARP-1178: /ai/chat cancelled while parked on the scheduler
    grant (`await future`) must release the slot iff the grant already landed —
    a leaked slot at max_concurrent=1 deadlocks every subsequent /ai/chat until
    restart. The fix shipped in #953 without a regression test; these pin it
    (the gRPC handlers get the same coverage in test_grpc.py)."""

    @staticmethod
    def _pending_scheduler():
        """Mock scheduler whose enqueue returns a PENDING future the test
        controls, so the grant / cancel ordering can be chosen exactly."""
        scheduler = MagicMock()
        futures: list[asyncio.Future] = []

        async def _enqueue(*args, **kwargs):
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            futures.append(fut)
            return fut

        scheduler.enqueue = AsyncMock(side_effect=_enqueue)
        scheduler.release = AsyncMock()
        return scheduler, futures

    @staticmethod
    def _start_chat(monkeypatch, scheduler) -> asyncio.Task:
        """Call the endpoint handler directly with mocked globals."""
        import main

        monkeypatch.setattr(main, "inference_scheduler", scheduler)
        monkeypatch.setattr(main, "provider_router", MagicMock())

        http_request = MagicMock()
        http_request.state.principal = None
        http_request.headers = {}
        request = ChatRequest(
            model="llama3:8b",
            messages=[{"role": "user", "content": "hello"}],
        )
        return asyncio.create_task(
            main.chat(request, http_request, x_request_priority=0)
        )

    @staticmethod
    async def _park_on_grant(futures) -> None:
        for _ in range(20):
            if futures:
                return
            await asyncio.sleep(0)
        raise AssertionError("endpoint never reached the scheduler")

    async def test_cancelled_after_grant_releases_slot(self, monkeypatch):
        """Client disconnect landing between the grant and the task resuming:
        the slot was already counted, so the handler must release it."""
        scheduler, futures = self._pending_scheduler()
        task = self._start_chat(monkeypatch, scheduler)
        await self._park_on_grant(futures)

        # Grant the slot and cancel the handler in the same loop step: the
        # task is still parked on `await future`, so the CancelledError is
        # delivered before it can resume with the granted slot.
        futures[0].set_result(None)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        scheduler.release.assert_awaited_once()

    async def test_cancelled_before_grant_does_not_release(self, monkeypatch):
        """Cancellation while still queued (future pending) cancels the future
        itself — no slot was counted, so nothing may be released (a release
        here would double-free once the real active request completes)."""
        scheduler, futures = self._pending_scheduler()
        task = self._start_chat(monkeypatch, scheduler)
        await self._park_on_grant(futures)

        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        assert futures[0].cancelled()
        scheduler.release.assert_not_awaited()


class TestModelsDegradedSignal:
    """WARP-1284 — /ai/models must NAME the providers whose list_models()
    raised via `degraded_providers` instead of silently returning a shorter
    (possibly empty) list. Without the signal, an unreachable Ollama was
    indistinguishable from a genuine first-boot model pull, so the setup
    wizard showed "still downloading" for a dead AI service."""

    @staticmethod
    def _wire(monkeypatch, *, ollama_side_effect=None, ollama_models=None):
        """Install a real router + fresh registry with a scripted Ollama."""
        import main
        from models.registry import ModelRegistry
        from router import ProviderRouter

        router = ProviderRouter()
        if ollama_side_effect is not None:
            router.local.list_models = AsyncMock(side_effect=ollama_side_effect)
        else:
            router.local.list_models = AsyncMock(return_value=ollama_models or [])
        monkeypatch.setattr(main, "provider_router", router)
        monkeypatch.setattr(main, "model_registry", ModelRegistry())

    async def test_reports_degraded_provider_when_ollama_listing_raises(
        self, client, monkeypatch
    ):
        with patch("router.get_api_key", new_callable=AsyncMock, return_value=None):
            self._wire(
                monkeypatch,
                ollama_side_effect=RuntimeError("connection refused"),
            )
            resp = await client.get("/ai/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["models"] == []
        assert data["degraded_providers"] == ["local"]

    async def test_degraded_providers_empty_when_all_providers_succeed(
        self, client, monkeypatch
    ):
        with patch("router.get_api_key", new_callable=AsyncMock, return_value=None):
            self._wire(
                monkeypatch,
                ollama_models=[
                    ModelInfo(
                        id="gpt-oss:20b", provider="local", name="gpt-oss:20b"
                    )
                ],
            )
            resp = await client.get("/ai/models")
        assert resp.status_code == 200
        data = resp.json()
        assert [m["id"] for m in data["models"]] == ["gpt-oss:20b"]
        # Existing consumers that only read `models` are unaffected; the new
        # field is present-but-empty on a healthy listing.
        assert data.get("degraded_providers", []) == []

    @respx.mock
    async def test_dead_ollama_reports_degraded_end_to_end(
        self, client, monkeypatch
    ):
        """WARP-1284 F1 regression — exercises the REAL provider failure
        seam, not a mock on list_models. The provider used to swallow the
        connect error into `return []`, which made the router's
        degraded_providers classification dead code in production: the wire
        below (respx raising on the actual /api/tags GET) is exactly what a
        dead Ollama looks like, and it must surface through /ai/models."""
        import main
        from models.registry import ModelRegistry
        from router import ProviderRouter

        # conftest pins OLLAMA_URL to http://fake-ollama:11434; the ASGI test
        # client is NOT intercepted by respx (explicit ASGITransport), so the
        # only mocked wire is the provider's own outbound tags call.
        respx.get("http://fake-ollama:11434/api/tags").mock(
            side_effect=httpx.ConnectError("connection refused")
        )
        with patch("router.get_api_key", new_callable=AsyncMock, return_value=None):
            monkeypatch.setattr(main, "provider_router", ProviderRouter())
            monkeypatch.setattr(main, "model_registry", ModelRegistry())
            resp = await client.get("/ai/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["models"] == []
        assert data["degraded_providers"] == ["local"]


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
        # conftest sets OLLAMA_URL to the direct :11434 path (no /proxy) and
        # neither INFERENCE_MANAGER_URL nor the deprecated OLLAMA_MANAGER_URL
        # (WARP-1748), so there's no manager /health to probe. The
        # endpoint must report ok with appliance=None, NOT a perpetual degraded.
        import main
        from router import ProviderRouter

        if main.provider_router is None:
            main.provider_router = ProviderRouter()

        # Sanity: the resolved manager health URL is None on this deploy shape.
        assert main.provider_router.local._limits.health_url is None

        resp = await client.get("/ai/readiness")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["appliance"] is None
