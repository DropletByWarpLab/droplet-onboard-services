"""Mock Ollama server for local testing without a Jetson.

Simulates Ollama's API surface so the ai-gateway can be tested locally
on macOS/Linux without GPU hardware. Returns canned responses that
exercise the full request/response pipeline including streaming.

Usage:
    python testing/ollama_mock.py              # runs on :11434
    python testing/ollama_mock.py --port 11435 # custom port

The mock supports:
    GET  /api/tags         — list models
    GET  /api/ps           — loaded models
    POST /api/pull         — fake pull
    POST /v1/chat/completions — chat (streaming and non-streaming)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
import uuid

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Ollama Mock", version="0.1.0")

MOCK_MODELS = [
    {
        "name": "llama3.2:3b",
        "model": "llama3.2:3b",
        "modified_at": "2024-01-01T00:00:00Z",
        "size": 2_000_000_000,
        "digest": "mock-digest-llama3",
        "details": {
            "parent_model": "",
            "format": "gguf",
            "family": "llama",
            "parameter_size": "3B",
            "quantization_level": "Q4_K_M",
        },
    },
    {
        "name": "mistral:7b",
        "model": "mistral:7b",
        "modified_at": "2024-01-01T00:00:00Z",
        "size": 4_000_000_000,
        "digest": "mock-digest-mistral",
        "details": {
            "parent_model": "",
            "format": "gguf",
            "family": "mistral",
            "parameter_size": "7B",
            "quantization_level": "Q4_K_M",
        },
    },
]

CANNED_RESPONSES = {
    "default": "I'm a mock AI running locally for testing. The real model would be running on the Jetson GPU.",
    "hello": "Hello! I'm the Droplet AI assistant. How can I help you today?",
    "test": "This is a test response from the mock Ollama server. Everything is working correctly.",
}


def _get_response(messages: list[dict]) -> str:
    last_msg = messages[-1]["content"].lower() if messages else ""
    for key, response in CANNED_RESPONSES.items():
        if key in last_msg:
            return response
    return CANNED_RESPONSES["default"]


# --- Ollama native API ---


@app.get("/api/tags")
async def list_models():
    return {"models": MOCK_MODELS}


@app.get("/api/ps")
async def list_running():
    return {
        "models": [
            {
                "name": MOCK_MODELS[0]["name"],
                "model": MOCK_MODELS[0]["name"],
                "size": MOCK_MODELS[0]["size"],
                "digest": MOCK_MODELS[0]["digest"],
                "expires_at": "2099-01-01T00:00:00Z",
                "size_vram": MOCK_MODELS[0]["size"],
            }
        ]
    }


class PullRequest(BaseModel):
    name: str
    stream: bool = False


@app.post("/api/pull")
async def pull_model(body: PullRequest):
    logger.info("Mock pull: %s", body.name)
    return {"status": "success"}


class DeleteRequest(BaseModel):
    name: str


@app.delete("/api/delete")
async def delete_model(body: DeleteRequest):
    logger.info("Mock delete: %s", body.name)
    return {"status": "success"}


# --- OpenAI-compatible API ---


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    stream: bool = False
    temperature: float = 0.7
    max_tokens: int | None = None


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    response_text = _get_response([m.model_dump() for m in request.messages])
    completion_id = f"chatcmpl-mock-{uuid.uuid4().hex[:8]}"

    if not request.stream:
        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": request.model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": response_text},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": sum(len(m.content.split()) for m in request.messages),
                "completion_tokens": len(response_text.split()),
                "total_tokens": sum(len(m.content.split()) for m in request.messages) + len(response_text.split()),
            },
        }

    # Streaming response — emit word-by-word like a real LLM
    async def stream():
        words = response_text.split()
        for i, word in enumerate(words):
            token = f" {word}" if i > 0 else word
            chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": request.model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": token} if i > 0 else {"role": "assistant", "content": token},
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(chunk)}\n\n"
            await asyncio.sleep(0.05)  # simulate token generation delay

        # Final chunk
        done_chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": request.model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        yield f"data: {json.dumps(done_chunk)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Mock Ollama server for local testing")
    parser.add_argument("--port", type=int, default=11434, help="Port to listen on")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    args = parser.parse_args()

    logger.info("Starting mock Ollama on %s:%d", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port)
