"""AI Gateway — Unified inference router for local and cloud AI providers."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from auth import keystore
from auth.byok import save_api_key, delete_api_key
from models.registry import ModelRegistry
from router import ProviderRouter
from schemas import (
    ApiKeyRequest,
    ChatRequest,
    ChatResponse,
    KeyStatusResponse,
    ModelsResponse,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global instances
provider_router: ProviderRouter | None = None
model_registry: ModelRegistry | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global provider_router, model_registry
    provider_router = ProviderRouter()
    model_registry = ModelRegistry()
    logger.info("AI Gateway started")
    yield
    if provider_router:
        await provider_router.close()
    logger.info("AI Gateway shut down")


app = FastAPI(title="Droplet AI Gateway", version="0.1.0", lifespan=lifespan)

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


# --- Chat ---


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
