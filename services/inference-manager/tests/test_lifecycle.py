"""Tests for model lifecycle endpoints (pull, delete, sync)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from httpx import Response


async def test_pull_model(client, respx_mock):
    """Pull a model via the Ollama API."""
    respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(200, json={"status": "success"})
    )
    resp = await client.post("/models/pull", json={"model": "llama3.2:3b"})

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "pulled"
    assert data["model"] == "llama3.2:3b"


async def test_pull_rejects_when_disk_insufficient(client, respx_mock, manifest_path, monkeypatch, loading_tracker):
    """WARP-1111 §7.2 / closes WARP-196: pull refuses with 409 before ever
    calling Ollama when the disk preflight reports insufficient space, and
    the model is never left registered in the loading tracker."""
    import disk
    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "big", "pull_tag": "big-tag", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 0, "disk_gb": 20},
        ]
    }))
    monkeypatch.setattr(
        disk, "check_disk_space",
        lambda disk_gb, **kw: disk.DiskPreflightResult(ok=False, needed_gb=30.0, free_gb=5.0)
        if disk_gb == 20 else (_ for _ in ()).throw(AssertionError(f"unexpected disk_gb={disk_gb}")),
    )
    pull_route = respx_mock.post("http://mock-ollama:11434/api/pull")

    resp = await client.post("/models/pull", json={"model": "big"})

    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"]["error"] == "insufficient_disk"
    assert body["detail"]["needed_gb"] == 30.0
    assert body["detail"]["free_gb"] == 5.0
    assert not pull_route.called
    assert await loading_tracker.list() == []


async def test_pull_disk_preflight_matches_by_pull_tag(client, respx_mock, manifest_path, monkeypatch):
    """The preflight looks the model up by name OR pull_tag (LLM-13-style
    identifier ambiguity), so a caller pulling by pull_tag still gets its
    manifest disk_gb checked."""
    import disk
    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "big", "pull_tag": "big-tag", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 0, "disk_gb": 20},
        ]
    }))
    seen = {}

    def _fake(disk_gb, **kw):
        seen["disk_gb"] = disk_gb
        return None  # skip — not testing rejection here

    monkeypatch.setattr(disk, "check_disk_space", _fake)
    respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(200, json={"status": "success"})
    )

    resp = await client.post("/models/pull", json={"model": "big-tag"})

    assert resp.status_code == 200
    assert seen["disk_gb"] == 20


async def test_pull_skips_disk_check_for_unlisted_model(client, respx_mock, monkeypatch):
    """A model not in the manifest at all (arbitrary tag) has no known
    disk_gb — the preflight is skipped, not treated as a rejection."""
    import disk
    seen = {}

    def _fake(disk_gb, **kw):
        seen["disk_gb"] = disk_gb
        return None

    monkeypatch.setattr(disk, "check_disk_space", _fake)
    respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(200, json={"status": "success"})
    )

    resp = await client.post("/models/pull", json={"model": "some-arbitrary-tag:1b"})

    assert resp.status_code == 200
    assert seen["disk_gb"] is None


# ── WARP-1111 §7.1: streaming pull progress ──


async def test_pull_stream_emits_progress_lines(client, respx_mock, loading_tracker):
    """?stream=true proxies Ollama's NDJSON progress lines verbatim, and the
    LoadingTracker guard is cleared only after the stream completes."""
    ndjson_body = (
        b'{"status": "pulling manifest"}\n'
        b'{"status": "downloading", "digest": "sha256:abc", "total": 100, "completed": 50}\n'
        b'{"status": "success"}\n'
    )
    respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(
            200, content=ndjson_body, headers={"content-type": "application/x-ndjson"}
        )
    )

    resp = await client.post("/models/pull?stream=true", json={"model": "llama3.2:3b"})

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    lines = [line for line in resp.text.strip().split("\n") if line]
    assert len(lines) == 3
    assert json.loads(lines[0])["status"] == "pulling manifest"
    assert json.loads(lines[1])["completed"] == 50
    assert json.loads(lines[-1])["status"] == "success"
    assert await loading_tracker.list() == []


async def test_pull_stream_via_accept_header(client, respx_mock, loading_tracker):
    """Accept: application/x-ndjson opts into streaming without ?stream=true."""
    respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(200, content=b'{"status": "success"}\n')
    )

    resp = await client.post(
        "/models/pull", json={"model": "llama3.2:3b"},
        headers={"Accept": "application/x-ndjson"},
    )

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")


async def test_pull_stream_transport_failure_before_any_bytes(client, respx_mock, loading_tracker):
    """A connection-level failure before Ollama ever responds (refused,
    DNS, etc.) maps to 502 — same as the non-streaming path — and never
    leaks the model in the loading tracker."""
    import httpx as httpx_mod
    respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        side_effect=httpx_mod.ConnectError("connection refused")
    )

    resp = await client.post("/models/pull?stream=true", json={"model": "llama3.2:3b"})

    assert resp.status_code == 502
    assert await loading_tracker.list() == []


async def test_pull_stream_upstream_rejects_before_streaming(client, respx_mock, loading_tracker):
    """If Ollama rejects the pull immediately (bad tag, etc.), the response
    is a plain non-2xx — never a committed 200 streaming body. See §7.1:
    'non-2xx close if nothing was streamed yet'."""
    respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(404, content=b'{"error": "model not found"}')
    )

    resp = await client.post("/models/pull?stream=true", json={"model": "nope:1b"})

    assert resp.status_code == 404
    assert await loading_tracker.list() == []


async def test_pull_stream_default_pull_unaffected(client, respx_mock):
    """Without ?stream=true or the ndjson Accept header, /models/pull keeps
    its existing blocking-JSON contract (sync + old callers depend on it)."""
    respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(200, json={"status": "success"})
    )

    resp = await client.post("/models/pull", json={"model": "llama3.2:3b"})

    assert resp.status_code == 200
    assert resp.json() == {"status": "pulled", "model": "llama3.2:3b"}


async def test_pull_stream_mid_stream_error_emits_terminal_error_line(client, respx_mock, loading_tracker):
    """A network failure partway through the stream can't change the
    already-committed 200 status — it must surface as a terminal NDJSON
    error line instead of truncating silently."""
    import httpx

    class _FlakyStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'{"status": "pulling manifest"}\n'
            raise httpx.ReadError("connection reset")

        async def aclose(self) -> None:
            return None

    def _side_effect(request):
        return httpx.Response(200, stream=_FlakyStream())

    respx_mock.post("http://mock-ollama:11434/api/pull").mock(side_effect=_side_effect)

    resp = await client.post("/models/pull?stream=true", json={"model": "llama3.2:3b"})

    assert resp.status_code == 200
    lines = [line for line in resp.text.strip().split("\n") if line]
    assert json.loads(lines[0])["status"] == "pulling manifest"
    last = json.loads(lines[-1])
    assert last["status"] == "error"
    assert "connection reset" in last["error"]
    assert await loading_tracker.list() == []


# ── WARP-1111 §7.3: delete guard ──


async def test_pull_adds_and_removes_from_loading_tracker(client, respx_mock, loading_tracker):
    """During pull the model is in loading_tracker; after, it's gone."""
    seen: list[list[str]] = []

    async def _capture_pull(_):
        seen.append(await loading_tracker.list())
        return Response(200, json={"status": "success"})

    respx_mock.post("http://mock-ollama:11434/api/pull").mock(side_effect=_capture_pull)

    resp = await client.post("/models/pull", json={"model": "llama3.2:3b"})
    assert resp.status_code == 200
    assert seen == [["llama3.2:3b"]]
    assert await loading_tracker.list() == []


# ── WARP-2130: the declared OCI reference is what reaches the daemon ──────


async def test_pull_sends_the_declared_oci_reference(
    client, respx_mock, manifest_path, monkeypatch
):
    """End-to-end through the route: caller addresses the model by its catalog
    `name`, the DAEMON is asked for the declared `oci` — tag intact.

    Without the declaration the wire id would be `ai/glm-4.7-flash`, which
    resolves to `latest` (17.05 GiB) instead of the pinned reap build
    (13.14 GiB) and does not fit the card.
    """
    import main
    monkeypatch.setattr(main, "INFERENCE_RUNTIME", "dmr")

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "glm-4.7-flash:31b", "pull_tag": "glm-4.7-flash:31b",
             "oci": "ai/glm-4.7-flash:reap-q4_K_M", "format": "gguf",
             "quantization": "Q4_K_M", "min_vram_gb": 0},
        ]
    }))
    pull_route = respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(200, json={"status": "success"})
    )

    resp = await client.post("/models/pull", json={"model": "glm-4.7-flash:31b"})
    assert resp.status_code == 200

    sent = json.loads(pull_route.calls.last.request.content)
    assert sent["model"] == "ai/glm-4.7-flash:reap-q4_K_M"
    assert sent["name"] == "ai/glm-4.7-flash:reap-q4_K_M"

    # The response still speaks the CALLER's identifier — the OCI id must not
    # leak back to a client that addressed us by catalog name.
    assert resp.json()["model"] == "glm-4.7-flash:31b"


async def test_pull_without_a_declared_oci_is_unchanged(
    client, respx_mock, manifest_path, monkeypatch
):
    """Every entry that predates the field keeps deriving, exactly as before."""
    import main
    monkeypatch.setattr(main, "INFERENCE_RUNTIME", "dmr")

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "gpt-oss:20b", "pull_tag": "gpt-oss:20b", "format": "gguf",
             "quantization": "MXFP4", "min_vram_gb": 0},
        ]
    }))
    pull_route = respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(200, json={"status": "success"})
    )

    resp = await client.post("/models/pull", json={"model": "gpt-oss:20b"})
    assert resp.status_code == 200
    assert json.loads(pull_route.calls.last.request.content)["model"] == "ai/gpt-oss"


async def test_pull_on_ollama_ignores_a_declared_oci(
    client, respx_mock, manifest_path
):
    """The default backend is untouched by the field: an entry carrying an OCI
    reference still pulls its Ollama `pull_tag`, because that is the only
    identifier registry.ollama.ai can resolve."""
    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "glm-4.7-flash:31b", "pull_tag": "glm-4.7-flash:31b",
             "oci": "ai/glm-4.7-flash:reap-q4_K_M", "format": "gguf",
             "quantization": "Q4_K_M", "min_vram_gb": 0},
        ]
    }))
    pull_route = respx_mock.post("http://mock-ollama:11434/api/pull").mock(
        return_value=Response(200, json={"status": "success"})
    )

    resp = await client.post("/models/pull", json={"model": "glm-4.7-flash:31b"})
    assert resp.status_code == 200
    # The Ollama adapter has always sent `name` (its legacy key), not `model`.
    assert json.loads(pull_route.calls.last.request.content)["name"] == (
        "glm-4.7-flash:31b"
    )
