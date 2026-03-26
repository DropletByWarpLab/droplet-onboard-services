"""AI Gateway — Unified inference router for local and cloud AI providers."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Droplet AI Gateway", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/ai/health")
async def health():
    return {"status": "ok"}


@app.get("/ai/models")
async def list_models():
    """Return available models grouped by provider."""
    # TODO: Query Jetson Ollama + configured cloud providers
    return {"local": [], "anthropic": [], "openai": []}


@app.post("/ai/chat")
async def chat():
    """Unified chat endpoint — routes to the selected provider."""
    # TODO: Implement LiteLLM routing
    pass
