"""Shared test fixtures for the inference-manager test suite."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

# Ensure the inference-manager root is on sys.path so imports work
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Point Ollama URL at a non-existent host for unit tests
os.environ["OLLAMA_URL"] = "http://mock-ollama:11434"


def _seed_manifest(path: Path) -> None:
    # Generic placeholder so tests don't appear to test a specific model.
    # The actual production manifest lives at models/model-manifest.json.
    path.write_text(json.dumps({
        "models": [
            {
                "name": "test-model:7b",
                "version": "1.0",
                "format": "gguf",
                "quantization": "Q4_K_M",
                "source": "ollama",
                "pull_tag": "test-model:7b-q4_K_M",
                "min_vram_gb": 0,
            }
        ]
    }))


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_vram_cache(monkeypatch):
    import vram
    vram._cached_gb = None
    vram._cached_source = None
    # Isolate tests from the *real* host's dGPU sysfs — a CI runner or dev
    # machine may or may not have one, which would make the /proc/meminfo-path
    # tests nondeterministic. Point the glob at a path that can never match;
    # tests exercising the dGPU path override this explicitly.
    monkeypatch.setattr(
        vram, "_DGPU_VRAM_GLOB", "/nonexistent-test-path/card*/device/mem_info_vram_total"
    )
    yield
    vram._cached_gb = None
    vram._cached_source = None


@pytest.fixture
def manifest_path(tmp_path, monkeypatch) -> Path:
    """Per-test manifest file. Tests can overwrite it freely."""
    p = tmp_path / "model-manifest.json"
    _seed_manifest(p)
    monkeypatch.setenv("MODEL_MANIFEST", str(p))

    import main
    monkeypatch.setattr(main, "MANIFEST_PATH", str(p))
    return p


@pytest.fixture
async def client(respx_mock, manifest_path):
    """Async test client for the FastAPI app."""
    import main
    from loading_state import LoadingTracker

    main._client = httpx.AsyncClient(
        base_url="http://mock-ollama:11434", timeout=600.0
    )
    main.app.state.loading_tracker = LoadingTracker()

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

    if main._client:
        await main._client.aclose()
        main._client = None
    main.app.state.loading_tracker = None


from loading_state import LoadingTracker as _LoadingTrackerForFixture


@pytest.fixture
def loading_tracker():
    """Per-test LoadingTracker mounted on app.state.loading_tracker.

    Overrides the default empty tracker installed by the `client` fixture
    so individual tests can pre-populate model names.
    """
    import main
    tracker = _LoadingTrackerForFixture()
    main.app.state.loading_tracker = tracker
    yield tracker
    main.app.state.loading_tracker = None


@pytest.fixture(autouse=True)
def _reset_circuit():
    from circuit import reset_circuit
    reset_circuit()
    yield
    reset_circuit()



@pytest.fixture(autouse=True)
def _reset_last_good_manifests():
    """Clear the resilient loader's path-keyed last-known-good cache between tests.

    The cache is module-level and persists for the session; without a reset a
    healthy load in one test would serve as another test's last-known-good when
    it exercises the corrupt/absent fallback path (WARP-195, finding 4).
    """
    import manifest
    manifest._last_good_manifests.clear()
    yield
    manifest._last_good_manifests.clear()
