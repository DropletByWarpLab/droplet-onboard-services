"""Shared test fixtures for the AI Gateway test suite."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

# Ensure the ai-gateway root is on sys.path so imports work
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Override KEYS_DIR to a temp directory for tests
os.environ["KEYS_DIR"] = tempfile.mkdtemp(prefix="droplet-test-keys-")
os.environ["DEVICE_SECRET"] = "test-secret-for-unit-tests"
os.environ["OLLAMA_URL"] = "http://fake-ollama:11434"
# No REDIS_URL — forces InMemorySessionStore and in-memory middleware backends
# High rate limit so tests don't trip over each other
os.environ["RATE_LIMIT_RPM"] = "10000"
os.environ["RATE_LIMIT_BURST"] = "10000"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _reset_chat_globals():
    """Reset the chat-path module globals after every test.

    The plain ASGI test transport does NOT run the app lifespan, so several
    tests lazily set ``main.provider_router`` / ``main.inference_scheduler``
    themselves (and ``start()`` the scheduler) when they need the chat path.
    pytest-asyncio runs each test on a FRESH event loop, but these globals
    persist across tests — so a scheduler started on test A's (now-closed)
    loop carries its ``_process_loop`` task and ``asyncio.Event`` into test B.
    When test B's ``/ai/chat`` enqueues a request, the future is created on
    B's loop but the only thing that resolves it (the processor task) is dead
    on A's loop, so ``await future`` HANGS FOREVER. (Same trap for the Ollama
    provider's loop-bound semaphore.)

    Tearing these down after each test — stopping the scheduler on the loop
    that started it, then nulling the globals — restores isolation. Every
    consumer re-initialises lazily via ``if main.X is None``, so resetting to
    None is safe.
    """
    yield

    import main

    if main.inference_scheduler is not None:
        try:
            await main.inference_scheduler.stop()
        except Exception:
            pass
        main.inference_scheduler = None

    if main.provider_router is not None:
        try:
            await main.provider_router.close()
        except Exception:
            pass
        main.provider_router = None


@pytest.fixture
async def client():
    """Async test client for the FastAPI app with lifespan support."""
    from main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def keys_dir() -> Path:
    """Return the test keys directory and clean it before each test.

    WARP-561: keys are now namespaced per user under subdirs
    (`{user_id}/{provider}.enc`, `_shared/{provider}.enc`), so cleanup is
    recursive — leftover per-namespace keys would otherwise bleed across tests.
    The device `.salt` is preserved so the Fernet key stays stable."""
    import shutil

    d = Path(os.environ["KEYS_DIR"])
    d.mkdir(parents=True, exist_ok=True)
    for child in d.iterdir():
        if child.name == ".salt":
            continue
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink()
    return d


@pytest.fixture
async def client_with_sessions():
    """Client that also resets session store between tests."""
    from main import app, session_store
    from sessions.store import InMemorySessionStore

    # Ensure globals are initialized for tests
    import main
    if main.session_store is None:
        main.session_store = InMemorySessionStore()
    if main.provider_router is None:
        from router import ProviderRouter
        main.provider_router = ProviderRouter()
    if main.model_registry is None:
        from models.registry import ModelRegistry
        main.model_registry = ModelRegistry()

    # Reset session store
    if isinstance(main.session_store, InMemorySessionStore):
        main.session_store._sessions.clear()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
