"""``POST /models/unload`` — make room for the active model (WARP-3047).

Why this exists: Docker Model Runner v1.2.6 has NO memory-aware eviction. Its
loader keeps up to ``min(NumCPU, 8)`` runners and evicts only when every slot
is full or after 5 idle minutes (``pkg/inference/scheduling/loader.go``), so a
switch from A to B starts B's llama-server NEXT TO a resident A with
``-ngl 999`` — and any B that doesn't fit in what A left free fails to load.
The lifecycle sidecar owns residency; nothing else may unload.

Contract pinned here, for BOTH adapters:

  - Every resident CHAT model other than ``keep`` is unloaded; ``keep`` is
    never touched, whatever spelling the daemon reports it under.
  - The answer is re-listed afterwards, never assumed: DMR evicts only runners
    with zero references (``loader.go`` ``evictRunner``), so a model still
    serving a request stays — and is reported in ``still_resident``.
  - The route answers ``{unloaded, still_resident}``; a daemon failure is a
    502, a not-ready sidecar a 503 — never a 200 that hides it.
"""

from __future__ import annotations

import json

import httpx
import pytest
from httpx import Response

from runtime import DmrRuntime, OllamaRuntime

DMR = "http://mock-dmr:12434"
OLLAMA = "http://mock-ollama:11434"

A = "docker.io/ai/gpt-oss:20B-F16"
B = "docker.io/ai/qwen3:8B-Q4_K_M"


def _runner(name: str, *, mode: str = "completion", in_use: bool = False) -> dict:
    """One entry of DMR's GET /engines/ps (scheduling.BackendStatus JSON)."""
    entry = {"backend_name": "llama.cpp", "model_name": name, "mode": mode}
    if in_use:
        entry["in_use"] = True
    return entry


# ── DMR ─────────────────────────────────────────────────────────────────


async def test_dmr_unloads_every_other_chat_runner_and_reports_the_relisting(respx_mock):
    ps = respx_mock.get(f"{DMR}/engines/ps").mock(
        side_effect=[
            Response(200, json=[_runner(A), _runner(B)]),
            Response(200, json=[_runner(B)]),
        ]
    )
    unload = respx_mock.post(f"{DMR}/engines/unload").mock(
        return_value=Response(200, json={"unloaded_runners": 1})
    )
    async with httpx.AsyncClient(base_url=DMR) as c:
        result = await DmrRuntime(c).unload_others(B)

    assert result == {"unloaded": [A], "still_resident": []}
    assert ps.call_count == 2
    # backend "" = every backend (loader.go evictRunner), which also leaves the
    # model's per-model runner config in place for its next load.
    assert json.loads(unload.calls[0].request.content) == {"backend": "", "models": [A]}


async def test_dmr_keeps_the_requested_model_under_any_spelling(respx_mock):
    # The runner is keyed by the ref the LOADING request used; the caller may
    # name the same model registry-qualified. Same model — never unloaded.
    respx_mock.get(f"{DMR}/engines/ps").mock(
        return_value=Response(200, json=[_runner("ai/qwen3:8B-Q4_K_M")])
    )
    unload = respx_mock.post(f"{DMR}/engines/unload")
    async with httpx.AsyncClient(base_url=DMR) as c:
        result = await DmrRuntime(c).unload_others(B)

    assert result == {"unloaded": [], "still_resident": []}
    assert not unload.called


async def test_dmr_a_different_build_of_the_same_repository_is_another_model(respx_mock):
    # Tags are load-bearing: 20B-F16 and the MXFP4 build are different weights
    # and both occupy VRAM.
    respx_mock.get(f"{DMR}/engines/ps").mock(
        side_effect=[
            Response(200, json=[_runner("docker.io/ai/gpt-oss:latest"), _runner(A)]),
            Response(200, json=[_runner(A)]),
        ]
    )
    unload = respx_mock.post(f"{DMR}/engines/unload").mock(
        return_value=Response(200, json={"unloaded_runners": 1})
    )
    async with httpx.AsyncClient(base_url=DMR) as c:
        result = await DmrRuntime(c).unload_others(A)

    assert result["unloaded"] == ["docker.io/ai/gpt-oss:latest"]
    assert json.loads(unload.calls[0].request.content)["models"] == ["docker.io/ai/gpt-oss:latest"]


async def test_dmr_a_bare_ollama_id_keeps_every_build_of_its_repository(respx_mock):
    # `gpt-oss:20b` carries no OCI tag DMR can be matched on; unloading the
    # model the caller asked to KEEP is the worse mistake, so err towards keeping.
    respx_mock.get(f"{DMR}/engines/ps").mock(return_value=Response(200, json=[_runner(A)]))
    unload = respx_mock.post(f"{DMR}/engines/unload")
    async with httpx.AsyncClient(base_url=DMR) as c:
        result = await DmrRuntime(c).unload_others("gpt-oss:20b")

    assert result == {"unloaded": [], "still_resident": []}
    assert not unload.called


async def test_dmr_reports_a_busy_runner_as_still_resident_not_unloaded(respx_mock):
    # DMR only evicts runners with zero references: A is serving a request.
    respx_mock.get(f"{DMR}/engines/ps").mock(
        return_value=Response(200, json=[_runner(A, in_use=True), _runner(B)])
    )
    respx_mock.post(f"{DMR}/engines/unload").mock(
        return_value=Response(200, json={"unloaded_runners": 0})
    )
    async with httpx.AsyncClient(base_url=DMR) as c:
        result = await DmrRuntime(c).unload_others(B)

    assert result == {"unloaded": [], "still_resident": [A]}


async def test_dmr_leaves_non_chat_runners_alone(respx_mock):
    respx_mock.get(f"{DMR}/engines/ps").mock(
        return_value=Response(200, json=[_runner("ai/embeddinggemma", mode="embedding"), _runner(B)])
    )
    unload = respx_mock.post(f"{DMR}/engines/unload")
    async with httpx.AsyncClient(base_url=DMR) as c:
        result = await DmrRuntime(c).unload_others(B)

    assert result == {"unloaded": [], "still_resident": []}
    assert not unload.called


async def test_dmr_listing_failure_raises(respx_mock):
    respx_mock.get(f"{DMR}/engines/ps").mock(return_value=Response(500, text="boom"))
    async with httpx.AsyncClient(base_url=DMR) as c:
        with pytest.raises(httpx.HTTPStatusError):
            await DmrRuntime(c).unload_others(B)


# ── Ollama ──────────────────────────────────────────────────────────────


async def test_ollama_unloads_others_with_keep_alive_zero(respx_mock):
    ps = respx_mock.get(f"{OLLAMA}/api/ps").mock(
        side_effect=[
            Response(200, json={"models": [{"name": "gpt-oss:20b"}, {"name": "qwen3:8b"}]}),
            Response(200, json={"models": [{"name": "qwen3:8b"}]}),
        ]
    )
    generate = respx_mock.post(f"{OLLAMA}/api/generate").mock(
        return_value=Response(200, json={"done": True, "done_reason": "unload"})
    )
    async with httpx.AsyncClient(base_url=OLLAMA) as c:
        result = await OllamaRuntime(c).unload_others("qwen3:8b")

    assert result == {"unloaded": ["gpt-oss:20b"], "still_resident": []}
    assert ps.call_count == 2
    # Ollama's documented unload: a prompt-less generate with keep_alive 0.
    assert json.loads(generate.calls[0].request.content) == {"model": "gpt-oss:20b", "keep_alive": 0}


# ── the route ───────────────────────────────────────────────────────────


async def test_route_unloads_and_answers_the_contract_shape(client, respx_mock):
    respx_mock.get(f"{OLLAMA}/api/ps").mock(
        side_effect=[
            Response(200, json={"models": [{"name": "gpt-oss:20b"}, {"name": "qwen3:8b"}]}),
            Response(200, json={"models": [{"name": "qwen3:8b"}]}),
        ]
    )
    respx_mock.post(f"{OLLAMA}/api/generate").mock(return_value=Response(200, json={}))

    resp = await client.post("/models/unload", json={"keep": "qwen3:8b"})

    assert resp.status_code == 200
    assert resp.json() == {"unloaded": ["gpt-oss:20b"], "still_resident": []}


async def test_route_routes_through_the_dmr_adapter_on_a_dmr_box(client, respx_mock, monkeypatch):
    import main

    monkeypatch.setattr(main, "INFERENCE_RUNTIME", "dmr")
    respx_mock.get(f"{OLLAMA}/engines/ps").mock(
        side_effect=[
            Response(200, json=[_runner(A), _runner(B)]),
            Response(200, json=[_runner(B)]),
        ]
    )
    unload = respx_mock.post(f"{OLLAMA}/engines/unload").mock(
        return_value=Response(200, json={"unloaded_runners": 1})
    )

    resp = await client.post("/models/unload", json={"keep": B})

    assert resp.status_code == 200
    assert resp.json() == {"unloaded": [A], "still_resident": []}
    assert unload.called


@pytest.mark.parametrize("body", [{}, {"keep": ""}, {"keep": "   "}])
async def test_route_requires_a_model_to_keep(client, body):
    resp = await client.post("/models/unload", json=body)
    assert resp.status_code == 422


async def test_route_maps_a_daemon_failure_to_502(client, respx_mock):
    respx_mock.get(f"{OLLAMA}/api/ps").mock(return_value=Response(500, text="boom"))
    resp = await client.post("/models/unload", json={"keep": "qwen3:8b"})
    assert resp.status_code == 502


async def test_route_is_503_before_startup():
    import main
    from httpx import ASGITransport, AsyncClient

    saved = main._client
    main._client = None
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as c:
            resp = await c.post("/models/unload", json={"keep": "qwen3:8b"})
        assert resp.status_code == 503
    finally:
        main._client = saved
