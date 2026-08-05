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


import hmac

import httpx
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.base import BaseHTTPMiddleware

from auth import keystore
from auth.byok import save_api_key, delete_api_key
from middleware.rate_limit import RateLimitMiddleware, close_rate_limiter
from middleware.request_id import RequestIdMiddleware
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

from request_context import configure_logging

configure_logging()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# WARP-560: inbound service-to-service authentication
# ---------------------------------------------------------------------------
# The gateway had NO inbound auth — every /ai/* route was reachable by anything
# that could open the socket (chat, session read, BYOK key CRUD). It is a
# service-to-service component whose sole legitimate caller is the orchestrator,
# so we require a shared bearer service token (same proven shape as
# services/switch/main.py's ServiceAuthMiddleware). Empty token → fail closed
# (401 on every non-health route) unless AI_GATEWAY_ALLOW_NO_AUTH=1; setup.sh provisions a real one.
SERVICE_TOKEN_AI_GATEWAY = (os.environ.get("SERVICE_TOKEN_AI_GATEWAY") or "").strip()
# Fail CLOSED when the service token is unset/blank: every non-health /ai/*
# route returns 401 (auth required) rather than silently running
# unauthenticated. A blank token in prod means a failed secret injection at
# deploy — without this gate that would expose BYOK key CRUD, cloud chat, and
# session reads to any host that can open the socket, with the per-user
# namespace coming from the attacker-controlled X-Droplet-User header. Opt back
# into the old open behaviour for local dev with AI_GATEWAY_ALLOW_NO_AUTH=1.
# Mirrors camera-discovery's CAMERA_ALLOW_NO_AUTH contract.
AI_GATEWAY_ALLOW_NO_AUTH = os.environ.get("AI_GATEWAY_ALLOW_NO_AUTH", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
if not SERVICE_TOKEN_AI_GATEWAY:
    if AI_GATEWAY_ALLOW_NO_AUTH:
        logger.warning(
            "SERVICE_TOKEN_AI_GATEWAY not set and AI_GATEWAY_ALLOW_NO_AUTH is "
            "set — /ai/* endpoints are unauthenticated. Local dev only; NEVER "
            "set this in production."
        )
    else:
        logger.error(
            "SERVICE_TOKEN_AI_GATEWAY not set — failing closed (401) on every "
            "non-health /ai/* route. Set SERVICE_TOKEN_AI_GATEWAY, or "
            "AI_GATEWAY_ALLOW_NO_AUTH=1 for local dev."
        )

# Header the orchestrator sets to forward the end-user principal so the gateway
# can namespace BYOK keys (WARP-561) and scope session ownership (WARP-560).
PRINCIPAL_HEADER = "X-Droplet-User"

# Paths that bypass the inbound auth gate. /ai/health is the liveness probe
# wired into the compose healthcheck and ops-console probe; it must answer
# without a token (mirrors switch's /health exemption).
_AUTH_EXEMPT_PATHS = frozenset({"/ai/health"})


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Reject /ai/* requests without a valid SERVICE_TOKEN_AI_GATEWAY bearer.

    On success it records the forwarded end-user principal on
    ``request.state.principal`` (None for an identity-less service call) so the
    route handlers can scope per-user BYOK keys and session ownership.
    """

    async def dispatch(self, request: Request, call_next):
        # Let CORS preflight through untouched (no Authorization header on it).
        if request.method == "OPTIONS":
            return await call_next(request)
        if request.url.path in _AUTH_EXEMPT_PATHS:
            request.state.principal = None
            return await call_next(request)
        if SERVICE_TOKEN_AI_GATEWAY:
            auth = request.headers.get("Authorization", "")
            token = auth.removeprefix("Bearer ").strip()
            # Encode both operands: a non-ASCII Authorization header (latin-1
            # decoded by Starlette) makes hmac.compare_digest on two str args
            # raise TypeError → 500. Comparing bytes keeps it a clean 401.
            if not hmac.compare_digest(
                token.encode("utf-8", "ignore"),
                SERVICE_TOKEN_AI_GATEWAY.encode("utf-8"),
            ):
                return JSONResponse(
                    status_code=401,
                    content={"error": "Invalid or missing service token"},
                )
        elif not AI_GATEWAY_ALLOW_NO_AUTH:
            # Fail closed: no token configured and dev escape hatch not set. A
            # blank token in prod is a failed secret injection — refuse rather
            # than serve every route unauthenticated.
            return JSONResponse(
                status_code=401,
                content={"error": "Service auth not configured"},
            )
        principal = request.headers.get(PRINCIPAL_HEADER, "").strip() or None
        request.state.principal = principal
        return await call_next(request)


def _principal(request: Request) -> str | None:
    """Return the forwarded end-user principal recorded by the auth middleware.

    Falls back to reading the header directly so handlers stay correct even if
    the middleware is bypassed (e.g. the unauthenticated dev path)."""
    principal = getattr(request.state, "principal", None)
    if principal is not None:
        return principal
    return request.headers.get(PRINCIPAL_HEADER, "").strip() or None


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

# Middleware execution order is the REVERSE of add order (Starlette prepends).
# We want, outermost → innermost: CORS → ServiceAuth → RateLimit → app, so:
#   - CORS outermost so OPTIONS preflight + CORS headers apply even to 401s,
#   - ServiceAuth next so unauthenticated traffic is rejected before it can
#     consume a rate-limit bucket,
#   - RateLimit innermost (only authenticated requests get metered).
# Add in reverse of that order.

# --- Rate limiting ---
app.add_middleware(RateLimitMiddleware)

# --- Inbound service auth (WARP-560) ---
app.add_middleware(ServiceAuthMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-Priority", "x-request-id", PRINCIPAL_HEADER],
)

# --- Inbound request-id propagation (WARP-108) ---
# Outermost: pure ASGI (not BaseHTTPMiddleware) so the contextvar it sets is
# visible in the endpoint and downstream provider calls. Added last so
# Starlette applies it first/outermost — it must see every request, including
# ones CORS or auth would reject, so the response always carries x-request-id.
app.add_middleware(RequestIdMiddleware)


# --- Health ---


@app.get("/ai/health")
async def health():
    inference_reachable = False
    if provider_router:
        inference_reachable = await provider_router.ollama.is_reachable()
    return {"status": "ok", "inference_reachable": inference_reachable}


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
            # WARP-1748: the canonical name. This branch is only reached when
            # NEITHER INFERENCE_MANAGER_URL nor the deprecated
            # OLLAMA_MANAGER_URL is set, so advertising only the new name here
            # cannot mislead a box that is still on the old one.
            "detail": "inference manager not configured (direct path); "
            "set INFERENCE_MANAGER_URL to surface appliance health.",
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
    """Return available models from all providers.

    Model discovery is device-wide (the cached list is shared), so this uses
    the shared/device key namespace rather than a per-user one — a user's own
    BYOK key only changes which CLOUD models their CHAT turns can reach, gated
    separately in /ai/chat (WARP-561) and the off-LAN allowlist (WARP-468).

    WARP-1284: `degraded_providers` (additive) names providers whose
    list_models() raised, so an empty `models` from a dead Ollama is
    distinguishable from a genuine first-boot model pull. Degraded listings
    are never TTL-cached (see ModelRegistry.get_models), so the signal
    clears on the first healthy refresh.
    """
    if not model_registry or not provider_router:
        raise HTTPException(status_code=503, detail="Service not ready")
    result = await model_registry.get_models(provider_router)
    return ModelsResponse(
        models=result.models, degraded_providers=result.degraded_providers
    )


# --- Chat (stateless) ---


@app.post("/ai/chat")
async def chat(
    request: ChatRequest,
    http_request: Request,
    x_request_priority: int = Header(default=0, alias="X-Request-Priority"),
):
    """Unified chat endpoint — routes to the selected provider.

    Priority scheduling (via the X-Request-Priority header):
    - 0: user-initiated (default)
    - 5: automation
    - 10: background
    """
    if not provider_router or not inference_scheduler:
        raise HTTPException(status_code=503, detail="Service not ready")

    # WARP-561: the requesting user's BYOK keys (not a device-global key).
    principal = _principal(http_request)

    # Enqueue with priority
    future = None
    try:
        future = await inference_scheduler.enqueue(x_request_priority, request)
        await future
    except QueueFullError as e:
        raise HTTPException(
            status_code=429,
            detail=str(e),
            headers={"Retry-After": str(e.retry_after)},
        )
    except asyncio.CancelledError:
        # GWV-003: the client disconnected while this request was queued. If the
        # scheduler already GRANTED the slot (resolved the future + incremented
        # _active_count) before we were cancelled, that slot would leak — one
        # leaked slot at max_concurrent=1 permanently deadlocks every /ai/chat.
        # Release it iff the grant actually landed, then re-raise the cancel.
        if future is not None and future.done() and not future.cancelled():
            await inference_scheduler.release()
        raise

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
        result = await provider_router.chat(request, user_id=principal)
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


def _assert_session_owner(session, principal: str | None) -> None:
    """WARP-560: refuse cross-user access to a session.

    A session created by an identified principal can only be read/mutated by
    that same principal. Legacy/identity-less sessions (``owner is None``) stay
    open so existing data and the unauthenticated dev path keep working; once a
    real principal owns a session, everyone else gets 404 (not 403 — we don't
    confirm the session exists to a non-owner).
    """
    owner = getattr(session, "owner", None)
    if owner is not None and owner != principal:
        raise HTTPException(status_code=404, detail="Session not found")


@app.post("/ai/sessions", response_model=SessionOut, status_code=201)
async def create_session(body: SessionCreateRequest, request: Request):
    """Create a new chat session owned by the calling principal."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    session = await session_store.create(
        model=body.model,
        title=body.title,
        system_prompt=body.system_prompt,
        owner=_principal(request),
    )
    return _session_to_out(session)


@app.get("/ai/sessions", response_model=SessionListResponse)
async def list_sessions(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """List chat sessions for the calling principal, most recent first."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    sessions = await session_store.list_sessions(limit=limit, offset=offset, owner=_principal(request))
    return SessionListResponse(sessions=[_session_to_out(s) for s in sessions])


@app.get("/ai/sessions/{session_id}", response_model=SessionDetailOut)
async def get_session(session_id: str, request: Request):
    """Get a session with all its messages (owner-scoped)."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    session = await session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _assert_session_owner(session, _principal(request))
    return _session_to_detail(session)


@app.patch("/ai/sessions/{session_id}", response_model=SessionOut)
async def update_session(session_id: str, body: SessionUpdateRequest, request: Request):
    """Update session title (owner-scoped)."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    session = await session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _assert_session_owner(session, _principal(request))
    await session_store.update_title(session_id, body.title)
    session = await session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_to_out(session)


@app.delete("/ai/sessions/{session_id}")
async def delete_session(session_id: str, request: Request):
    """Delete a session and its messages (owner-scoped)."""
    if not session_store:
        raise HTTPException(status_code=503, detail="Service not ready")
    session = await session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _assert_session_owner(session, _principal(request))
    deleted = await session_store.delete(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "deleted", "session_id": session_id}


@app.post("/ai/sessions/{session_id}/chat")
async def session_chat(session_id: str, body: SessionChatRequest, request: Request):
    """Chat within a session — messages are automatically persisted.

    The full conversation history is sent to the provider so the model has context.
    The user message and assistant response are both saved to the session.
    """
    if not session_store or not provider_router:
        raise HTTPException(status_code=503, detail="Service not ready")

    principal = _principal(request)
    session = await session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _assert_session_owner(session, principal)

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
        result = await provider_router.chat(chat_request, user_id=principal)
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
async def store_key(provider: str, body: ApiKeyRequest, request: Request):
    """Store an API key for a cloud provider in the caller's namespace."""
    try:
        await save_api_key(provider, body.api_key, user_id=_principal(request))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Invalidate model cache so new provider models appear
    if model_registry:
        model_registry.invalidate()

    return {"status": "ok", "provider": provider}


@app.get("/ai/keys", response_model=KeyStatusResponse)
async def list_keys(request: Request):
    """List which providers have stored API keys (no key values returned)."""
    providers = await keystore.list_providers_with_keys(user_id=_principal(request))
    return KeyStatusResponse(providers=providers)


@app.delete("/ai/keys/{provider}")
async def remove_key(provider: str, request: Request):
    """Remove a stored API key from the caller's namespace."""
    deleted = await delete_api_key(provider, user_id=_principal(request))
    if not deleted:
        raise HTTPException(status_code=404, detail=f"No key stored for {provider}")

    if model_registry:
        model_registry.invalidate()

    return {"status": "deleted", "provider": provider}
