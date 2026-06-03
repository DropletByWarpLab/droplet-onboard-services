"""AI Gateway — Unified inference router for local and cloud AI providers."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict


def _run_fips_boot_self_test() -> None:
    """WARP-229: assert the OpenSSL FIPS provider is loaded + enforcing.

    Gating: `DROPLET_FIPS_REQUIRED` env var.
      "true" / "1"           → enforce; exit 1 on failure
      "false" / "0" / unset  → skip (dev/CI default)

    Runs at module import, BEFORE the FastAPI app object is constructed
    and BEFORE any worker is forked, so a non-FIPS image fails closed
    before serving the first request.
    """
    raw = os.environ.get("DROPLET_FIPS_REQUIRED")
    if raw is None or raw.lower() in ("false", "0", "no"):
        return
    sys.path.insert(0, "/app")
    try:
        from _shared.fips_selftest import assert_fips_at_boot_or_exit
    except ImportError as err:
        sys.stderr.write(
            '{"event":"fips_self_test","service":"ai-gateway","fips":false,'
            f'"reason":"helper not importable: {err}"}}\n'
        )
        sys.exit(1)
    assert_fips_at_boot_or_exit("ai-gateway")


# Run BEFORE any other imports that might initiate crypto. Httpx /
# starlette / uvicorn all touch OpenSSL on first import; gating here
# keeps the failure mode clean.
_run_fips_boot_self_test()


import httpx
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from auth import keystore
from auth.byok import save_api_key, delete_api_key
from middleware.rate_limit import RateLimitMiddleware, close_rate_limiter
from models.registry import ModelRegistry
from router import ProviderRouter
from schemas import (
    ApiKeyRequest,
    ChatMessage,
    ChatRequest,
    ChatResponse,
    KeyStatusResponse,
    ModelsResponse,
    SessionChatRequest,
    SessionCreateRequest,
    SessionDetailOut,
    SessionListResponse,
    SessionMessageOut,
    SessionOut,
    SessionUpdateRequest,
)
from sessions.store import SessionStore, create_session_store
from scheduler import InferenceScheduler, QueueFullError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _provider_error_detail(exc: Exception, context: str) -> str:
    """GW-08: log the full provider/LiteLLM exception server-side and return a
    generic, non-leaky message to the client.

    LiteLLM/provider exceptions frequently embed the upstream provider's raw
    error body, request URL, and model names; echoing ``str(exc)`` to the
    caller leaks internal endpoints and turns the gateway into a provider-state
    oracle. We attach a short correlation id so an operator can tie the opaque
    client message back to the detailed server-side log line.
    """
    correlation_id = uuid.uuid4().hex[:12]
    logger.error("%s [correlation_id=%s]: %s", context, correlation_id, exc)
    return f"Upstream provider error (ref: {correlation_id})"


# Global instances
provider_router: ProviderRouter | None = None
model_registry: ModelRegistry | None = None
session_store: SessionStore | None = None
inference_scheduler: InferenceScheduler | None = None
grpc_server = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global provider_router, model_registry, session_store, inference_scheduler, grpc_server
    provider_router = ProviderRouter()
    model_registry = ModelRegistry()
    session_store = create_session_store()
    inference_scheduler = InferenceScheduler()
    await inference_scheduler.start()
    logger.info("AI Gateway started (with scheduler)")

    # Start gRPC server if proto stubs are available
    try:
        from grpc_server import start_grpc_server
        grpc_server = await start_grpc_server(provider_router, inference_scheduler)
        logger.info("gRPC server started on port 50051")
    except ImportError:
        logger.warning("gRPC proto stubs not generated — gRPC server disabled. Run: python -m grpc_tools.protoc ...")
    except Exception as e:
        logger.warning("gRPC server failed to start: %s", e)

    yield

    if grpc_server:
        await grpc_server.stop(grace=5)
    if inference_scheduler:
        await inference_scheduler.stop()
    if provider_router:
        await provider_router.close()
    if session_store:
        await session_store.close()
    await close_rate_limiter()
    logger.info("AI Gateway shut down")


app = FastAPI(title="Droplet AI Gateway", version="0.3.0", lifespan=lifespan)

# --- CORS ---
# Starlette silently drops credentials when `allow_origins=["*"]` and
# `allow_credentials=True`. Reject the misconfiguration at boot so ops notices.
_cors_origins_raw = os.getenv("CORS_ORIGINS", "http://localhost:3001,https://localhost:3001")
_cors_origins = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()]
if "*" in _cors_origins:
    raise RuntimeError(
        "CORS_ORIGINS=* is not allowed with allow_credentials=True. "
        "Set an explicit origin list."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-Priority"],
)

# --- Rate limiting ---
app.add_middleware(RateLimitMiddleware)


# --- Health ---


@app.get("/ai/health")
async def health():
    jetson_reachable = False
    if provider_router:
        jetson_reachable = await provider_router.ollama.is_reachable()
    return {"status": "ok", "jetson_reachable": jetson_reachable}


@app.get("/ai/readiness")
async def readiness():
    """Reflect the underlying appliance health for orchestration purposes.

    Pulls /health from ollama-manager (:8002) so the orchestrator can decide
    whether to accept inference traffic. Distinct from /ai/health, which only
    reports gateway-side liveness.

    XR-05: /health lives on ollama-manager, not on Ollama (:11434). On the
    direct chat path (single-box default) no manager is wired, so we report
    "ok" with appliance=None instead of GETting a non-existent /health and
    reporting a perpetual "degraded".
    """
    if provider_router is None:
        return {"status": "starting", "appliance": None}
    health_url = provider_router.ollama._limits.health_url
    if health_url is None:
        # No ollama-manager configured (direct path). Gateway-side readiness is
        # governed by /ai/health; nothing to probe here.
        return {
            "status": "ok",
            "appliance": None,
            "detail": "ollama-manager not configured (direct path); "
            "set OLLAMA_MANAGER_URL to surface appliance health.",
        }
    appliance: dict | None = None
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            resp = await c.get(health_url)
            if resp.status_code == 200:
                appliance = resp.json()
    except Exception as e:
        appliance = {"status": "unreachable", "error": str(e)}
    overall = "ok" if appliance and appliance.get("status") == "ok" else "degraded"
    return {"status": overall, "appliance": appliance}


# --- Models ---


@app.get("/ai/models", response_model=ModelsResponse)
async def list_models():
    """Return available models from all providers."""
    if not model_registry or not provider_router:
        raise HTTPException(status_code=503, detail="Service not ready")
    models = await model_registry.get_models(provider_router)
    return ModelsResponse(models=models)


# --- Chat (stateless) ---


@app.post("/ai/chat")
async def chat(request: ChatRequest, x_request_priority: int = Header(default=0, alias="X-Request-Priority")):
    """Unified chat endpoint — routes to the selected provider.

    Priority scheduling (via X-Request-Priority header or query param):
    - 0: user-initiated (default)
    - 5: automation
    - 10: background
    """
    if not provider_router or not inference_scheduler:
        raise HTTPException(status_code=503, detail="Service not ready")

    # Enqueue with priority
    try:
        future = await inference_scheduler.enqueue(x_request_priority, request)
        await future
    except QueueFullError as e:
        raise HTTPException(
            status_code=429,
            detail=str(e),
            headers={"Retry-After": str(e.retry_after)},
        )

    # The scheduler slot is now held. It MUST stay held until the work is
    # actually done — and for a streaming response the work isn't done when
    # provider_router.chat() returns (it hands back an async generator that
    # hasn't touched the model yet). Releasing here would let the scheduler
    # admit the next request while N streams are still flowing against the
    # model, defeating max_concurrent for streaming (GW-06). So:
    #   - non-streaming: release as soon as chat() returns (work is complete).
    #   - streaming: hand the slot's release to a wrapper that fires it when
    #     the generator is exhausted OR closed (client disconnect / error /
    #     GC). Exactly one release per acquired slot, in both paths.
    released = False

    async def _release_once() -> None:
        nonlocal released
        if not released:
            released = True
            await inference_scheduler.release()

    try:
        result = await provider_router.chat(request)
    except ValueError as e:
        await _release_once()
        raise HTTPException(status_code=400, detail=str(e))
    except BaseException as e:
        # GW-06: release the held slot on ANY exit from the awaited chat() —
        # including asyncio.CancelledError (a BaseException, raised when the
        # client disconnects mid-await), which a bare `except Exception` would
        # miss, leaking the slot and eventually deadlocking the scheduler at
        # max_concurrent=1. _release_once is idempotent. There is deliberately
        # NO `finally` here: on the streaming SUCCESS path the slot must stay
        # held until the stream drains (released by _slot_held_stream below),
        # so a finally would free it too early.
        await _release_once()
        if isinstance(e, Exception):
            # GW-08: don't echo upstream/LiteLLM error text to the client.
            raise HTTPException(
                status_code=502, detail=_provider_error_detail(e, "Chat error")
            )
        raise  # re-raise CancelledError / KeyboardInterrupt after releasing

    # Streaming response — hold the slot for the lifetime of the stream.
    if request.stream:
        async def _slot_held_stream():
            try:
                async for chunk in result:
                    yield chunk
            finally:
                # Fires when the generator is exhausted, or when Starlette
                # calls aclose() on client disconnect / mid-stream error.
                await _release_once()

        return StreamingResponse(
            _slot_held_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming response — work is complete, release the slot now.
    await _release_once()
    return result


@app.get("/ai/metrics")
async def metrics():
    """Return scheduler metrics for monitoring."""
    if not inference_scheduler:
        raise HTTPException(status_code=503, detail="Service not ready")
    return inference_scheduler.metrics()


# --- Sessions ---


def _session_to_out(session) -> SessionOut:
    return SessionOut(
        id=session.id,
        title=session.title,
        model=session.model,
        created_at=session.created_at,
        updated_at=session.updated_at,
        message_count=len(session.messages),
        system_prompt=session.system_prompt,
    )


def _session_to_detail(session) -> SessionDetailOut:
    return SessionDetailOut(
        id=session.id,
        title=session.title,
        model=session.model,
        created_at=session.created_at,
        updated_at=session.updated_at,
        message_count=len(session.messages),
        system_prompt=session.system_prompt,
        messages=[
            SessionMessageOut(role=m.role, content=m.content, timestamp=m.timestamp)
            for m in session.messages
        ],
    )


@app.post("/ai/sessions", response_model=SessionOut, status_code=201)
async def create_session(body: SessionCreateRequest):
    """Create a new chat session."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    session = await session_store.create(
        model=body.model, title=body.title, system_prompt=body.system_prompt
    )
    return _session_to_out(session)


@app.get("/ai/sessions", response_model=SessionListResponse)
async def list_sessions(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """List chat sessions, most recent first."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    sessions = await session_store.list_sessions(limit=limit, offset=offset)
    return SessionListResponse(sessions=[_session_to_out(s) for s in sessions])


@app.get("/ai/sessions/{session_id}", response_model=SessionDetailOut)
async def get_session(session_id: str):
    """Get a session with all its messages."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    session = await session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_to_detail(session)


@app.patch("/ai/sessions/{session_id}", response_model=SessionOut)
async def update_session(session_id: str, body: SessionUpdateRequest):
    """Update session title."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    updated = await session_store.update_title(session_id, body.title)
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    session = await session_store.get(session_id)
    return _session_to_out(session)


@app.delete("/ai/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a session and its messages."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    deleted = await session_store.delete(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "deleted", "session_id": session_id}


@app.post("/ai/sessions/{session_id}/chat")
async def session_chat(session_id: str, body: SessionChatRequest):
    """Chat within a session — messages are automatically persisted.

    The full conversation history is sent to the provider so the model has context.
    The user message and assistant response are both saved to the session.
    """
    if not session_store or not provider_router:
        raise HTTPException(status_code=503, detail="Service not ready")

    session = await session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Save user message
    await session_store.add_message(session_id, "user", body.message)

    # Build full message history for the provider
    messages: list[ChatMessage] = []
    if session.system_prompt:
        messages.append(ChatMessage(role="system", content=session.system_prompt))
    for m in session.messages:
        messages.append(ChatMessage(role=m.role, content=m.content))
    messages.append(ChatMessage(role="user", content=body.message))

    chat_request = ChatRequest(
        model=session.model,
        messages=messages,
        stream=body.stream,
        temperature=body.temperature,
        max_tokens=body.max_tokens,
        provider=body.provider,
    )

    try:
        result = await provider_router.chat(chat_request)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # GW-08: generic message + correlation id; full error logged server-side.
        raise HTTPException(
            status_code=502, detail=_provider_error_detail(e, "Session chat error")
        )

    if body.stream:
        # For streaming, we collect tokens to save the full response afterward.
        #
        # GW-07: the assistant turn is persisted in a `finally`, not only after
        # the generator fully drains. A client disconnect (browser close, nginx
        # timeout) closes the generator with GeneratorExit, and an upstream
        # error raises mid-stream — in both cases the previous code never
        # reached the save line, so the user turn was stored with NO assistant
        # reply (silent history loss) and the partial text the user already saw
        # was lost. We now save whatever was collected exactly once, whether the
        # stream finished normally or was cut short.
        async def stream_and_save():
            collected: list[str] = []
            completed = False
            saved = False

            async def _persist() -> None:
                nonlocal saved
                if saved:
                    return
                saved = True
                full_response = "".join(collected)
                if not full_response:
                    return
                if not completed:
                    logger.warning(
                        "session %s: stream ended early (client disconnect or "
                        "upstream error) — persisting partial assistant reply "
                        "(%d chars)",
                        session_id,
                        len(full_response),
                    )
                try:
                    await session_store.add_message(
                        session_id, "assistant", full_response
                    )
                except Exception:
                    # Never let a cleanup-time store failure mask the original
                    # disconnect/error; just log it.
                    logger.exception(
                        "session %s: failed to persist assistant reply", session_id
                    )

            try:
                async for chunk in result:
                    yield chunk
                    # Extract content from SSE data for persistence
                    if chunk.startswith("data: ") and chunk.strip() != "data: [DONE]":
                        try:
                            import json
                            parsed = json.loads(chunk[6:].strip())
                            delta = parsed.get("choices", [{}])[0].get("delta", {}).get("content")
                            if delta:
                                collected.append(delta)
                        except (json.JSONDecodeError, IndexError, KeyError):
                            pass
                completed = True
            finally:
                # Runs on normal completion, on client disconnect (GeneratorExit),
                # and on a mid-stream upstream error — so the assistant turn is
                # never silently dropped.
                await _persist()

        return StreamingResponse(
            stream_and_save(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming: save assistant reply
    try:
        assistant_content = result["choices"][0]["message"]["content"]
        await session_store.add_message(session_id, "assistant", assistant_content)
    except (KeyError, IndexError):
        logger.warning("Could not extract assistant response for session persistence")

    return result


# --- API Keys (BYOK) ---


@app.post("/ai/keys/{provider}")
async def store_key(provider: str, body: ApiKeyRequest):
    """Store an API key for a cloud provider."""
    try:
        await save_api_key(provider, body.api_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Invalidate model cache so new provider models appear
    if model_registry:
        model_registry.invalidate()

    return {"status": "ok", "provider": provider}


@app.get("/ai/keys", response_model=KeyStatusResponse)
async def list_keys():
    """List which providers have stored API keys (no key values returned)."""
    providers = await keystore.list_providers_with_keys()
    return KeyStatusResponse(providers=providers)


@app.delete("/ai/keys/{provider}")
async def remove_key(provider: str):
    """Remove a stored API key."""
    deleted = await delete_api_key(provider)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"No key stored for {provider}")

    if model_registry:
        model_registry.invalidate()

    return {"status": "deleted", "provider": provider}
