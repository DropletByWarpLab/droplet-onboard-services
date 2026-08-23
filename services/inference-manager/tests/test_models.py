"""Tests for model listing endpoints."""

from __future__ import annotations

from pathlib import Path

from httpx import Response


MOCK_TAGS = {
    "models": [
        {"name": "llama3.2:3b", "size": 2_000_000_000},
        {"name": "test-model:7b", "size": 4_000_000_000},
    ]
}

MOCK_PS = {
    "models": [
        {
            "name": "llama3.2:3b",
            "model": "llama3.2:3b",
            "size": 2_000_000_000,
            "digest": "abc123",
            "expires_at": "2099-01-01T00:00:00Z",
            "size_vram": 2_000_000_000,
        }
    ]
}


async def test_list_available(client, respx_mock):
    """Returns available models from Ollama."""
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json=MOCK_TAGS)
    )
    resp = await client.get("/models/available")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data["models"]) == 2


async def test_list_loaded(client, respx_mock):
    """Returns loaded models from Ollama."""
    respx_mock.get("http://mock-ollama:11434/api/ps").mock(
        return_value=Response(200, json=MOCK_PS)
    )
    resp = await client.get("/models/loaded")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data["models"]) == 1
    assert data["models"][0]["name"] == "llama3.2:3b"


async def test_get_manifest(client, respx_mock):
    """Returns the model manifest."""
    resp = await client.get("/models/manifest")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["models"]) == 1
    assert data["models"][0]["name"] == "test-model:7b"


async def test_get_manifest_missing_file(client, respx_mock, tmp_path):
    """Returns empty models when manifest file doesn't exist."""
    import main as mgr_main
    old_path = mgr_main.MANIFEST_PATH
    mgr_main.MANIFEST_PATH = str(tmp_path / "nonexistent.json")

    resp = await client.get("/models/manifest")
    assert resp.status_code == 200
    assert resp.json() == {"models": []}

    mgr_main.MANIFEST_PATH = old_path
