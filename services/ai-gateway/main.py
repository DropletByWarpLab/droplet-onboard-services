"""AI Gateway — Unified inference router for local and cloud AI providers."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from auth import keystore
from auth.byok import save_api_key, delete_api_key
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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global instances
provider_router: ProviderRouter | None = None
model_registry: ModelRegistry | None = None
session_store: SessionStore | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global provider_router, model_registry, session_store
    provider_router = ProviderRouter()
    model_registry = ModelRegistry()
    session_store = create_session_store()
    logger.info("AI Gateway started")
    yield
    if provider_router:
        await provider_router.close()
    if session_store:
        await session_store.close()
    logger.info("AI Gateway shut down")


app = FastAPI(title="Droplet AI Gateway", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Health ---


@app.get("/ai/health")
async def health():
    jetson_reachable = False
    if provider_router:
        jetson_reachable = await provider_router.ollama.is_reachable()
    return {"status": "ok", "jetson_reachable": jetson_reachable}


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
async def chat(request: ChatRequest):
    """Unified chat endpoint — routes to the selected provider."""
    if not provider_router:
        raise HTTPException(status_code=503, detail="Service not ready")

    try:
        result = await provider_router.chat(request)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Chat error: %s", e)
        raise HTTPException(status_code=502, detail=f"Provider error: {str(e)}")

    # Streaming response
    if request.stream:
        return StreamingResponse(
            result,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming response
    return result


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
        logger.error("Session chat error: %s", e)
        raise HTTPException(status_code=502, detail=f"Provider error: {str(e)}")

    if body.stream:
        # For streaming, we collect tokens to save the full response afterward
        async def stream_and_save():
            collected = []
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
            # Save the full assistant response
            full_response = "".join(collected)
            if full_response:
                await session_store.add_message(session_id, "assistant", full_response)

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
