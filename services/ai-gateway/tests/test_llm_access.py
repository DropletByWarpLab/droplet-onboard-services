"""WARP-3452 — /llm/*: the box's model runtime for employees' coding tools.

The orchestrator (introspection + usage) is mocked with respx; the model
runtime is an httpx.MockTransport that records every call it receives, so
"never reaches the runtime" is an assertion, not a hope.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest
import respx

import llm_access
import main
from scheduler import InferenceScheduler, Priority, QueueFullError

ORCH = "http://orch.test"
RUNTIME = "http://runtime.test"
TOKEN = "dlk_test-member-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ACTIVE = "docker.io/ai/gpt-oss:20B-F16"
PRINCIPAL = {"tokenId": "tok_1", "userId": "u_1", "role": "family", "activeModel": ACTIVE, "contextWindow": 16384}


class Runtime:
    """The model runtime behind ai-gateway: records each call, answers from ``routes``."""

    def __init__(self, routes: dict | None = None):
        self.routes = routes or {}
        self.calls: list[tuple[str, str, bytes]] = []

    def __call__(self, request: httpx.Request):
        self.calls.append((request.method, request.url.path, request.content))
        answer = self.routes.get((request.method, request.url.path))
        if answer is None:
            return httpx.Response(599, text="unexpected runtime call")
        return answer(request)


class Stream(httpx.AsyncByteStream):
    """A runtime body that arrives chunk by chunk. With ``hold``, it stops
    before the second chunk (setting ``held``) until ``hold`` is set."""

    def __init__(self, chunks: list[bytes], hold: asyncio.Event | None = None):
        self.chunks = chunks
        self.hold = hold
        self.held = asyncio.Event()

    async def __aiter__(self):
        for i, chunk in enumerate(self.chunks):
            if i == 1 and self.hold is not None:
                self.held.set()
                await self.hold.wait()
            yield chunk


def streamed(content_type: str, stream: httpx.AsyncByteStream):
    return lambda _request: httpx.Response(200, headers={"content-type": content_type}, stream=stream)


def answer(status: int = 200, **kwargs):
    return lambda _request: httpx.Response(status, **kwargs)


@pytest.fixture
def orch():
    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{ORCH}/api/llm-access/_introspect", name="introspect").mock(
            return_value=httpx.Response(200, json=PRINCIPAL)
        )
        mock.post(f"{ORCH}/api/llm-access/_usage", name="usage").mock(return_value=httpx.Response(204))
        yield mock


@asynccontextmanager
async def box(monkeypatch, runtime: Runtime | None = None, *, dmr: bool = False):
    """ai-gateway wired to a fake runtime and a real scheduler owned by THIS
    test: the ASGI transport runs no lifespan, and a scheduler left installed
    from another test's loop hangs (see test_model_load_failure._chat_globals)."""
    sched = InferenceScheduler()
    await sched.start()
    rt_client = httpx.AsyncClient(base_url=RUNTIME, transport=httpx.MockTransport(runtime or Runtime()))
    monkeypatch.setattr(main, "provider_router", SimpleNamespace(local=SimpleNamespace(client=rt_client)))
    monkeypatch.setattr(main, "inference_scheduler", sched)
    monkeypatch.setattr(llm_access, "_IS_DMR", dmr)
    monkeypatch.setattr(llm_access, "ORCHESTRATOR_URL", ORCH)
    monkeypatch.setattr(llm_access, "AI_GATEWAY_SAMPLER_TOKEN", "sampler-token")
    monkeypatch.setattr(llm_access, "_in_flight", set())
    monkeypatch.setattr(llm_access, "_recent", {})
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
            yield client
    finally:
        await sched.stop()
        await rt_client.aclose()


async def settle() -> None:
    """Let the non-blocking usage reports land."""
    await asyncio.gather(*list(llm_access._background))


def usage_sent(orch) -> dict:
    return json.loads(orch.routes["usage"].calls.last.request.content)


# ── Authentication ───────────────────────────────────────────────────────


async def test_missing_or_foreign_bearer_is_401_without_asking_the_orchestrator(orch, monkeypatch):
    async with box(monkeypatch) as client:
        bare = await client.get("/llm/v1/models")
        foreign = await client.get("/llm/v1/models", headers={"Authorization": "Bearer sk-not-a-dlk-token"})
    assert bare.status_code == foreign.status_code == 401
    assert bare.json()["error"]["code"] == "invalid_token"
    assert not orch.routes["introspect"].called


@pytest.mark.parametrize(
    "status,code",
    [(401, "invalid_token"), (401, "revoked"), (401, "expired"),
     (403, "disabled"), (403, "role_not_allowed"), (403, "no_active_model")],
)
async def test_introspection_refusals_reach_the_client(orch, monkeypatch, status, code):
    orch.routes["introspect"].mock(return_value=httpx.Response(status, json={"error": code}))
    runtime = Runtime()
    async with box(monkeypatch, runtime) as client:
        resp = await client.post("/llm/v1/chat/completions", headers=AUTH, json={"model": ACTIVE})
    assert resp.status_code == status
    assert resp.json()["error"]["code"] == code
    assert runtime.calls == []


@pytest.mark.parametrize(
    "trouble",
    [httpx.ConnectError("refused"), httpx.Response(500), httpx.Response(200, json={"tokenId": "tok_1"})],
    ids=["orchestrator-down", "orchestrator-500", "malformed-200"],
)
async def test_introspection_trouble_fails_closed_with_503(orch, monkeypatch, trouble):
    route = orch.routes["introspect"]
    if isinstance(trouble, Exception):
        route.mock(side_effect=trouble)
    else:
        route.mock(return_value=trouble)
    runtime = Runtime()
    async with box(monkeypatch, runtime) as client:
        resp = await client.get("/llm/api/tags", headers=AUTH)
    assert resp.status_code == 503
    assert runtime.calls == []


async def test_no_sampler_token_fails_closed_without_calling_out(orch, monkeypatch):
    async with box(monkeypatch) as client:
        monkeypatch.setattr(llm_access, "AI_GATEWAY_SAMPLER_TOKEN", "")
        resp = await client.get("/llm/v1/models", headers=AUTH)
    assert resp.status_code == 503
    assert not orch.routes["introspect"].called


async def test_every_request_is_introspected_as_the_ai_gateway_principal(orch, monkeypatch):
    """No cache: a revoke must refuse the very next request."""
    orch.routes["introspect"].mock(side_effect=[
        httpx.Response(200, json=PRINCIPAL), httpx.Response(401, json={"error": "revoked"}),
    ])
    async with box(monkeypatch) as client:
        first = await client.get("/llm/v1/models", headers=AUTH)
        second = await client.get("/llm/v1/models", headers=AUTH)
    assert (first.status_code, second.status_code) == (200, 401)
    assert orch.routes["introspect"].call_count == 2
    sent = orch.routes["introspect"].calls.last.request
    assert json.loads(sent.content) == {"token": TOKEN}
    assert sent.headers["authorization"] == "Bearer sampler-token"


async def test_service_token_still_guards_ai_and_does_not_block_llm(orch, monkeypatch):
    monkeypatch.setattr(main, "SERVICE_TOKEN_AI_GATEWAY", "svc-token")
    monkeypatch.setattr(main, "AI_GATEWAY_ALLOW_NO_AUTH", False)
    async with box(monkeypatch) as client:
        ai = await client.get("/ai/keys", headers=AUTH)
        llm = await client.get("/llm/v1/models", headers=AUTH)
        smuggled = await client.get("/llm/ai/keys", headers={"Authorization": "Bearer svc-token"})
    assert ai.status_code == 401
    assert llm.status_code == 200
    assert smuggled.status_code == 404


# ── Deny by default ──────────────────────────────────────────────────────

DENIED = [
    ("POST", "/api/pull"), ("POST", "/api/push"), ("POST", "/api/create"), ("POST", "/api/copy"),
    ("DELETE", "/api/delete"), ("POST", "/api/blobs/sha256:abc"), ("HEAD", "/api/blobs/sha256:abc"),
    ("POST", "/api/embed"), ("POST", "/api/embeddings"), ("GET", "/api/ps"), ("POST", "/v1/embeddings"),
    ("GET", "/models"), ("POST", "/models/create"), ("DELETE", "/models/ai/gpt-oss"),
    ("POST", "/engines/_configure"), ("POST", "/engines/v1/chat/completions"),
    ("GET", "/ai/keys"), ("POST", "/ai/keys/openai"), ("GET", "/ai/sessions"), ("POST", "/ai/chat"),
    ("POST", "/api/version"), ("GET", "/api/chat"), ("GET", f"/v1/models/{ACTIVE}"), ("GET", "/"),
]


@pytest.mark.parametrize("method,path", DENIED)
async def test_every_path_off_the_allowlist_is_404_and_never_reaches_the_runtime(orch, monkeypatch, method, path):
    runtime = Runtime()
    async with box(monkeypatch, runtime, dmr=True) as client:
        body = {"model": ACTIVE} if method in ("POST", "DELETE") else None
        resp = await client.request(method, f"/llm{path}", headers=AUTH, json=body)
    assert resp.status_code == 404
    assert runtime.calls == []
    assert not orch.routes["introspect"].called


# ── Runtime paths ────────────────────────────────────────────────────────


@pytest.mark.parametrize("dmr", [False, True], ids=["ollama", "dmr"])
@pytest.mark.parametrize(
    "path,ollama_path,dmr_path",
    [
        ("/v1/chat/completions", "/v1/chat/completions", "/engines/v1/chat/completions"),
        ("/v1/completions", "/v1/completions", "/engines/v1/completions"),
        ("/api/chat", "/api/chat", "/api/chat"),
        ("/api/generate", "/api/generate", "/api/generate"),
        ("/v1/messages", "/v1/messages", "/anthropic/v1/messages"),
    ],
)
async def test_generation_paths_map_per_runtime(orch, monkeypatch, path, ollama_path, dmr_path, dmr):
    upstream = dmr_path if dmr else ollama_path
    runtime = Runtime({("POST", upstream): answer(json={"ok": True})})
    async with box(monkeypatch, runtime, dmr=dmr) as client:
        resp = await client.post(f"/llm{path}", headers=AUTH, json={"model": ACTIVE, "stream": False})
        await settle()
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert [(m, p) for m, p, _ in runtime.calls] == [("POST", upstream)]


async def test_dmr_answers_version_itself_and_refuses_the_responses_api(orch, monkeypatch):
    runtime = Runtime()
    async with box(monkeypatch, runtime, dmr=True) as client:
        version = await client.get("/llm/api/version", headers=AUTH)
        responses = await client.post("/llm/v1/responses", headers=AUTH, json={"model": ACTIVE, "input": "hi"})
    assert version.status_code == 200
    assert tuple(int(p) for p in version.json()["version"].split(".")) >= (0, 6, 4)  # Copilot's minimum
    assert responses.status_code == 501
    assert "Responses API" in responses.json()["error"]["message"]
    assert runtime.calls == []


async def test_ollama_serves_version_and_the_responses_api_itself(orch, monkeypatch):
    runtime = Runtime({
        ("GET", "/api/version"): answer(json={"version": "0.12.3"}),
        ("POST", "/v1/responses"): answer(json={"output": []}),
    })
    async with box(monkeypatch, runtime) as client:
        version = await client.get("/llm/api/version", headers=AUTH)
        responses = await client.post("/llm/v1/responses", headers=AUTH, json={"model": ACTIVE, "input": "hi"})
        await settle()
    assert version.json() == {"version": "0.12.3"}
    assert responses.status_code == 200
    assert [p for _, p, _ in runtime.calls] == ["/api/version", "/v1/responses"]


async def test_dmr_show_gets_capabilities_and_the_box_context_window(orch, monkeypatch):
    runtime = Runtime({("POST", "/api/show"): answer(json={"details": {"family": "gpt-oss", "parameter_size": "20B"}})})
    async with box(monkeypatch, runtime, dmr=True) as client:
        resp = await client.post("/llm/api/show", headers=AUTH, json={"model": ACTIVE})
    show = resp.json()
    assert show["capabilities"] == ["completion", "tools"]
    assert show["model_info"] == {"general.architecture": "gpt-oss", "gpt-oss.context_length": 16384}
    assert show["details"]["parameter_size"] == "20B"


async def test_ollama_show_passes_through_untouched(orch, monkeypatch):
    upstream = {"capabilities": ["completion"], "model_info": {"llama.context_length": 131072}}
    runtime = Runtime({("POST", "/api/show"): answer(json=upstream)})
    async with box(monkeypatch, runtime) as client:
        resp = await client.post("/llm/api/show", headers=AUTH, json={"model": ACTIVE})
    assert resp.json() == upstream


# ── Model rules ──────────────────────────────────────────────────────────


async def test_only_the_active_model_is_listed(orch, monkeypatch):
    runtime = Runtime({("GET", "/api/tags"): answer(json={"models": [
        {"name": "llama3.2:3b", "model": "llama3.2:3b"}, {"name": ACTIVE, "model": ACTIVE},
    ]})})
    async with box(monkeypatch, runtime) as client:
        models = await client.get("/llm/v1/models", headers=AUTH)
        tags = await client.get("/llm/api/tags", headers=AUTH)
    assert [m["id"] for m in models.json()["data"]] == [ACTIVE]
    assert [m["name"] for m in tags.json()["models"]] == [ACTIVE]
    assert [p for _, p, _ in runtime.calls] == ["/api/tags"]  # /v1/models never reaches the runtime


@pytest.mark.parametrize(
    "path,dialect",
    [("/v1/chat/completions", "openai"), ("/v1/completions", "openai"), ("/api/chat", "ollama"),
     ("/api/generate", "ollama"), ("/api/show", "ollama"), ("/v1/messages", "anthropic")],
)
async def test_another_model_is_404_in_the_clients_dialect_and_loads_nothing(orch, monkeypatch, path, dialect):
    runtime = Runtime()
    async with box(monkeypatch, runtime) as client:
        resp = await client.post(f"/llm{path}", headers=AUTH, json={"model": "llama3.2:3b", "messages": []})
    assert resp.status_code == 404
    body = resp.json()
    if dialect == "openai":
        assert body["error"]["code"] == "model_not_found"
    elif dialect == "ollama":
        assert "llama3.2:3b" in body["error"]
    else:
        assert body["type"] == "error" and body["error"]["type"] == "not_found_error"
    assert runtime.calls == []


async def test_a_coding_tool_cannot_unload_or_resize_the_box_model(orch, monkeypatch):
    runtime = Runtime({("POST", "/api/chat"): answer(json={"done": True})})
    async with box(monkeypatch, runtime) as client:
        await client.post("/llm/api/chat", headers=AUTH, json={
            "model": ACTIVE, "stream": False, "keep_alive": 0, "options": {"num_ctx": 131072, "temperature": 0.2},
        })
        await settle()
    sent = json.loads(runtime.calls[0][2])
    assert "keep_alive" not in sent
    assert sent["options"] == {"temperature": 0.2}


# ── Scheduling and limits ────────────────────────────────────────────────


async def test_priority_is_automation_whatever_the_client_sends(orch, monkeypatch):
    runtime = Runtime({("POST", "/api/chat"): answer(json={"done": True})})
    async with box(monkeypatch, runtime) as client:
        sched = main.inference_scheduler
        real_enqueue = sched.enqueue
        seen = []

        async def spy(priority, request, preempt=None):
            seen.append((priority, preempt is not None))
            return await real_enqueue(priority, request, preempt)

        monkeypatch.setattr(sched, "enqueue", spy)
        resp = await client.post(
            "/llm/api/chat", headers={**AUTH, "X-Request-Priority": "0"}, json={"model": ACTIVE, "stream": False}
        )
        await settle()
    assert resp.status_code == 200
    assert seen == [(Priority.AUTOMATION, True)]  # preemptible by the box's own chat


async def test_one_request_in_flight_per_token(orch, monkeypatch):
    runtime = Runtime({("POST", "/api/chat"): answer(json={"done": True})})
    body = {"model": ACTIVE, "stream": False}
    async with box(monkeypatch, runtime) as client:
        llm_access._in_flight.add(PRINCIPAL["tokenId"])
        busy = await client.post("/llm/api/chat", headers=AUTH, json=body)
        llm_access._in_flight.clear()
        ok = await client.post("/llm/api/chat", headers=AUTH, json=body)
        await settle()
    assert busy.status_code == 429 and busy.headers["retry-after"]
    assert ok.status_code == 200
    assert len(runtime.calls) == 1
    assert llm_access._in_flight == set()  # released once the response is done


async def test_per_token_rpm_answers_429_with_retry_after(orch, monkeypatch):
    async with box(monkeypatch) as client:
        monkeypatch.setattr(llm_access, "_RPM", 2)
        responses = [await client.get("/llm/v1/models", headers=AUTH) for _ in range(3)]
    assert [r.status_code for r in responses] == [200, 200, 429]
    assert int(responses[2].headers["retry-after"]) >= 1


async def test_a_full_scheduler_queue_answers_429_with_retry_after(orch, monkeypatch):
    runtime = Runtime()
    async with box(monkeypatch, runtime) as client:
        async def full(*_args, **_kwargs):
            raise QueueFullError("busy", queue_depth=5, retry_after=10)

        monkeypatch.setattr(main.inference_scheduler, "enqueue", full)
        resp = await client.post("/llm/v1/chat/completions", headers=AUTH, json={"model": ACTIVE})
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "10"
    assert runtime.calls == []
    assert llm_access._in_flight == set()


async def test_box_chat_preempts_a_coding_tool_mid_stream(orch, monkeypatch):
    stream = Stream([b'data: {"choices":[{"delta":{"content":"he"}}]}\n\n', b"data: [DONE]\n\n"], hold=asyncio.Event())
    runtime = Runtime({("POST", "/v1/chat/completions"): streamed("text/event-stream", stream)})
    async with box(monkeypatch, runtime) as client:
        sched = main.inference_scheduler
        call = asyncio.create_task(client.post(
            "/llm/v1/chat/completions", headers=AUTH, json={"model": ACTIVE, "messages": [], "stream": True}
        ))
        await asyncio.wait_for(stream.held.wait(), 5)  # the first chunk is out, the slot is held
        box_chat = await sched.enqueue(Priority.USER, "box chat")
        resp = await asyncio.wait_for(call, 5)
        assert await asyncio.wait_for(box_chat, 5) == "box chat"
        await sched.release()
        await settle()
    assert resp.status_code == 200
    assert resp.text.index('"he"') < resp.text.index("preempted_for_chat")
    assert "[DONE]" not in resp.text
    assert llm_access._in_flight == set()


async def test_box_chat_preempts_a_coding_tool_before_it_starts(orch, monkeypatch):
    gate = asyncio.Event()

    async def slow_runtime(_request):
        await gate.wait()
        return httpx.Response(200, json={"ok": True})

    runtime = Runtime({("POST", "/v1/chat/completions"): slow_runtime})
    async with box(monkeypatch, runtime) as client:
        sched = main.inference_scheduler
        call = asyncio.create_task(client.post("/llm/v1/chat/completions", headers=AUTH, json={"model": ACTIVE}))
        for _ in range(200):
            if runtime.calls:
                break
            await asyncio.sleep(0.01)
        box_chat = await sched.enqueue(Priority.USER, "box chat")
        resp = await asyncio.wait_for(call, 5)
        assert await asyncio.wait_for(box_chat, 5) == "box chat"
        await sched.release()
        await settle()
    assert resp.status_code == 503
    assert resp.headers["retry-after"]
    assert resp.json()["error"]["code"] == "preempted_for_chat"


# ── Streaming and usage ──────────────────────────────────────────────────


async def test_ndjson_stream_passes_through_unchanged(orch, monkeypatch):
    chunks = [b'{"message":{"content":"he"},"done":false}\n', b'{"message":{"content":"llo"},"done":false}\n',
              b'{"done":true,"prompt_eval_count":4,"eval_count":2}\n']
    runtime = Runtime({("POST", "/api/chat"): streamed("application/x-ndjson", Stream(chunks))})
    async with box(monkeypatch, runtime) as client:
        resp = await client.post("/llm/api/chat", headers=AUTH, json={"model": ACTIVE, "messages": []})
        await settle()
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    assert resp.content == b"".join(chunks)


async def test_stream_reaches_the_client_before_the_runtime_finishes(orch, monkeypatch):
    """Drive the ASGI app directly: the ASGI test transport collects a whole
    body before returning, so it could not tell streaming from buffering."""
    stream = Stream([b'{"message":{"content":"he"}}\n', b'{"done":true}\n'], hold=asyncio.Event())
    runtime = Runtime({("POST", "/api/chat"): streamed("application/x-ndjson", stream)})
    async with box(monkeypatch, runtime):
        sent: asyncio.Queue = asyncio.Queue()
        request_body = json.dumps({"model": ACTIVE, "messages": []}).encode()
        delivered = False

        async def receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": request_body, "more_body": False}
            await asyncio.Event().wait()  # the client never hangs up

        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
            "scheme": "http", "path": "/llm/api/chat", "raw_path": b"/llm/api/chat", "query_string": b"",
            "root_path": "", "client": ("192.168.20.50", 50000), "server": ("test", 80),
            "headers": [(b"authorization", AUTH["Authorization"].encode()), (b"content-type", b"application/json")],
        }
        app = asyncio.create_task(main.app(scope, receive, sent.put))
        start = await asyncio.wait_for(sent.get(), 5)
        assert start["type"] == "http.response.start" and start["status"] == 200
        first = b""
        while not first:
            first = (await asyncio.wait_for(sent.get(), 5)).get("body", b"")
        assert first == b'{"message":{"content":"he"}}\n'
        assert not app.done()  # the runtime is still generating
        stream.hold.set()
        await asyncio.wait_for(app, 5)
        await settle()


@pytest.mark.parametrize(
    "path,content_type,chunks,expected",
    [
        ("/v1/chat/completions", "application/json",
         [b'{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}'], (11, 7)),
        ("/v1/chat/completions", "text/event-stream",
         [b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          b'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\n', b"data: [DONE]\n\n"], (9, 3)),
        ("/api/chat", "application/x-ndjson",
         [b'{"message":{"content":"hi"},"done":false}\n', b'{"done":true,"prompt_eval_',
          b'count":12,"eval_count":34}\n'], (12, 34)),
        ("/v1/messages", "text/event-stream",
         [b'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
          b'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n'], (5, 9)),
    ],
    ids=["openai-json", "openai-sse", "ollama-ndjson-split-line", "anthropic-sse"],
)
async def test_usage_is_reported_with_the_token_counts(orch, monkeypatch, path, content_type, chunks, expected):
    runtime = Runtime({("POST", path): streamed(content_type, Stream(chunks))})
    async with box(monkeypatch, runtime) as client:
        resp = await client.post(f"/llm{path}", headers=AUTH, json={"model": ACTIVE, "messages": []})
        await settle()
    assert resp.status_code == 200
    assert usage_sent(orch) == {
        "tokenId": "tok_1", "promptTokens": expected[0], "completionTokens": expected[1], "error": False,
    }


async def test_a_runtime_error_passes_through_and_is_reported_as_one(orch, monkeypatch):
    runtime = Runtime({("POST", "/v1/chat/completions"): answer(400, json={"error": {"message": "context too long"}})})
    async with box(monkeypatch, runtime) as client:
        resp = await client.post("/llm/v1/chat/completions", headers=AUTH, json={"model": ACTIVE})
        await settle()
    assert resp.status_code == 400
    assert "context too long" in resp.text
    assert usage_sent(orch) == {"tokenId": "tok_1", "promptTokens": 0, "completionTokens": 0, "error": True}


async def test_an_unreachable_runtime_is_502_and_reported(orch, monkeypatch):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    runtime = Runtime({("POST", "/api/generate"): refuse})
    async with box(monkeypatch, runtime) as client:
        resp = await client.post("/llm/api/generate", headers=AUTH, json={"model": ACTIVE, "prompt": "x"})
        await settle()
    assert resp.status_code == 502
    assert usage_sent(orch)["error"] is True
    assert llm_access._in_flight == set()


async def test_no_body_and_no_token_in_the_logs(orch, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    prompt, completion = "TOP-SECRET-PROMPT", "TOP-SECRET-COMPLETION"
    runtime = Runtime({
        ("POST", "/v1/chat/completions"): answer(json={
            "choices": [{"message": {"content": completion}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }),
        ("POST", "/api/chat"): answer(500, text=f"runtime crashed on {completion}"),
    })
    messages = [{"role": "user", "content": prompt}]
    async with box(monkeypatch, runtime) as client:
        for path, model in (("/v1/chat/completions", ACTIVE), ("/api/chat", ACTIVE), ("/v1/chat/completions", "other")):
            await client.post(f"/llm{path}", headers=AUTH, json={"model": model, "messages": messages})
        await settle()
    for secret in (TOKEN, prompt, completion):
        assert secret not in caplog.text
    assert "access_id=tok_1" in caplog.text  # the runtime's 500 is logged, by token id


# ── The Copilot / Ollama-extension sequence ──────────────────────────────


async def test_copilot_discovery_then_a_streamed_tool_call_on_a_dmr_box(orch, monkeypatch):
    """Copilot's Ollama provider and the official Ollama extension call
    version → tags → show → chat. On DMR, version is answered here and show is
    filled so the model looks tool-capable with the box's window."""
    ndjson = [
        json.dumps({"model": ACTIVE, "message": {"role": "assistant", "content": "", "tool_calls": [
            {"function": {"name": "read_file", "arguments": {"path": "a.py"}}}]}, "done": False}).encode() + b"\n",
        json.dumps({"model": ACTIVE, "done": True, "prompt_eval_count": 20, "eval_count": 5}).encode() + b"\n",
    ]
    runtime = Runtime({
        ("GET", "/api/tags"): answer(json={"models": [{"name": ACTIVE, "model": ACTIVE}, {"name": "ai/other", "model": "ai/other"}]}),
        ("POST", "/api/show"): answer(json={"details": {"family": "gpt-oss"}}),
        ("POST", "/api/chat"): streamed("application/x-ndjson", Stream(ndjson)),
    })
    tools = [{"type": "function", "function": {"name": "read_file", "parameters": {
        "type": "object", "properties": {"path": {"type": "string", "maxLength": 4096}}}}}]
    async with box(monkeypatch, runtime, dmr=True) as client:
        version = await client.get("/llm/api/version", headers=AUTH)
        tags = await client.get("/llm/api/tags", headers=AUTH)
        show = await client.post("/llm/api/show", headers=AUTH, json={"model": ACTIVE})
        chat = await client.post("/llm/api/chat", headers=AUTH, json={
            "model": ACTIVE, "messages": [{"role": "user", "content": "open a.py"}], "tools": tools,
        })
        await settle()
    assert version.status_code == 200 and version.json()["version"]
    assert [m["name"] for m in tags.json()["models"]] == [ACTIVE]
    info = show.json()
    assert {"completion", "tools"} <= set(info["capabilities"])
    assert info["model_info"][f"{info['model_info']['general.architecture']}.context_length"] == 16384
    assert chat.status_code == 200
    assert chat.content == b"".join(ndjson)
    assert [p for _, p, _ in runtime.calls] == ["/api/tags", "/api/show", "/api/chat"]
    # WARP-1839: the tool schema reached DMR grammar-safe, as the box's own chat sends it.
    sent_tools = json.loads(runtime.calls[2][2])["tools"]
    assert "maxLength" not in sent_tools[0]["function"]["parameters"]["properties"]["path"]
    assert usage_sent(orch) == {"tokenId": "tok_1", "promptTokens": 20, "completionTokens": 5, "error": False}
