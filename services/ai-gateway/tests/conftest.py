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
os.environ["JETSON_OLLAMA_URL"] = "http://fake-jetson:11434"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    """Async test client for the FastAPI app."""
    from main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def keys_dir() -> Path:
    """Return the test keys directory and clean it before each test."""
    d = Path(os.environ["KEYS_DIR"])
    d.mkdir(parents=True, exist_ok=True)
    # Clean any leftover keys
    for f in d.glob("*.enc"):
        f.unlink()
    return d
