"""gRPC server for the AI Gateway inference service.

Runs alongside FastAPI on port 50051. Provides low-latency inference
for the orchestrator per design doc Section 7: "gRPC is used for
latency-sensitive internal calls between the orchestrator and the LLM service."
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import grpc
from grpc import aio as grpc_aio

# Proto-generated modules (generated from proto/inference.proto)
from grpc_generated import inference_pb2, inference_pb2_grpc

from router import ProviderRouter
from schemas import ChatMessage, ChatRequest, ModelInfo
from scheduler import InferenceScheduler, QueueFullError

logger = logging.getLogger(__name__)

GRPC_PORT = 50051


class InferenceServicer(inference_pb2_grpc.InferenceServiceServicer):
    """gRPC implementation of the InferenceService."""

    # WARP-286: Rerank handler accepts an empty model field (proto default)
    # or the canonical name. Unknown ids fail closed with INVALID_ARGUMENT
    # rather than silently falling back to a default.
    _RERANK_SUPPORTED_MODELS = frozenset({"", "bge-reranker-base"})

    def __init__(self, provider_router: ProviderRouter, scheduler: InferenceScheduler):
        self._router = provider_router
        self._scheduler = scheduler

    async def Chat(self, request, context):
        """Unary chat completion."""
        try:
            # Enqueue with priority
            future = await self._scheduler.enqueue(
                priority=request.priority,
                request=request,
            )
            # Wait for our turn
            await future
        except QueueFullError as e:
            context.set_code(grpc.StatusCode.RESOURCE_EXHAUSTED)
            context.set_details(str(e))
            context.set_trailing_metadata([("retry-after", str(e.retry_after))])
            return inference_pb2.ChatResponse()

        try:
            # Build ChatRequest from proto
            messages = [
                ChatMessage(role=m.role, content=m.content)
                for m in request.messages
            ]
            chat_req = ChatRequest(
                model=request.model,
                messages=messages,
                stream=False,
                temperature=request.temperature,
                max_tokens=request.max_tokens if request.HasField("max_tokens") else None,
                provider=request.provider if request.HasField("provider") else None,
            )

            result = await self._router.chat(chat_req)

            # Extract response
            choice = result.get("choices", [{}])[0]
            message = choice.get("message", {})
            usage = result.get("usage", {})

            return inference_pb2.ChatResponse(
                content=message.get("content", ""),
                model=result.get("model", request.model),
                usage=inference_pb2.Usage(
                    prompt_tokens=usage.get("prompt_tokens", 0),
                    completion_tokens=usage.get("completion_tokens", 0),
                ),
                finish_reason=choice.get("finish_reason", "stop"),
            )
        except Exception as e:
            logger.error("gRPC Chat error: %s", e)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Inference error: {str(e)}")
            return inference_pb2.ChatResponse()
        finally:
            await self._scheduler.release()

    async def StreamChat(self, request, context):
        """Server-side streaming chat completion."""
        try:
            future = await self._scheduler.enqueue(
                priority=request.priority,
                request=request,
            )
            await future
        except QueueFullError as e:
            context.set_code(grpc.StatusCode.RESOURCE_EXHAUSTED)
            context.set_details(str(e))
            return

        try:
            messages = [
                ChatMessage(role=m.role, content=m.content)
                for m in request.messages
            ]
            chat_req = ChatRequest(
                model=request.model,
                messages=messages,
                stream=True,
                temperature=request.temperature,
                max_tokens=request.max_tokens if request.HasField("max_tokens") else None,
                provider=request.provider if request.HasField("provider") else None,
            )

            result = await self._router.chat(chat_req)

            # result is an async generator of SSE strings
            async for chunk_str in result:
                if not chunk_str.startswith("data: "):
                    continue
                data_str = chunk_str[6:].strip()
                if data_str == "[DONE]":
                    yield inference_pb2.ChatChunk(delta="", done=True)
                    break

                try:
                    parsed = json.loads(data_str)
                    delta = parsed.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    yield inference_pb2.ChatChunk(delta=delta, done=False)
                except (json.JSONDecodeError, IndexError, KeyError):
                    continue
        except Exception as e:
            logger.error("gRPC StreamChat error: %s", e)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Streaming error: {str(e)}")
        finally:
            await self._scheduler.release()

    async def ListModels(self, request, context):
        """List available models from all providers."""
        try:
            models = await self._router.list_all_models()
            return inference_pb2.ModelList(
                models=[
                    inference_pb2.ModelInfo(
                        id=m.id,
                        provider=m.provider,
                        name=m.name,
                        context_window=m.context_window,
                    )
                    for m in models
                ]
            )
        except Exception as e:
            logger.error("gRPC ListModels error: %s", e)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return inference_pb2.ModelList()

    async def EmbedText(self, request, context):
        """Compute embeddings for a batch of texts.

        Uses sentence-transformers locally on CPU. The model is loaded lazily
        on first call (~2s cold start, ~80 MB download). Subsequent calls are
        instant. Blocks the event loop for the encode step — acceptable for the
        file-indexer's batch workload; a threadpool offload can be added later
        if interactive latency matters.
        """
        try:
            from providers.embeddings import embed_texts

            texts = list(request.texts)
            if not texts:
                return inference_pb2.EmbedResponse()

            model_name = request.model if request.HasField("model") else None

            # Run the synchronous encode in a thread to keep the event loop responsive.
            loop = asyncio.get_running_loop()
            vectors = await loop.run_in_executor(
                None, embed_texts, texts, model_name
            )

            return inference_pb2.EmbedResponse(
                embeddings=[
                    inference_pb2.FloatArray(values=vec)
                    for vec in vectors
                ]
            )
        except Exception as e:
            logger.error("gRPC EmbedText error: %s", e)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Embedding error: {str(e)}")
            return inference_pb2.EmbedResponse()

    async def Rerank(self, request, context):
        """WARP-286 — score (query, passage) pairs via a cross-encoder.

        Delegates to `reranker.RerankerSingleton`. The first call lazy-loads
        BGE-reranker-base from the on-disk cache (or downloads ~280 MB
        from HF on a cold appliance). The model `compute_score` step runs
        on CPU; we offload to a threadpool to avoid blocking the asyncio
        loop while batches are running.
        """
        # Validate model id up-front. Empty (proto default) maps to the
        # canonical name; anything else is rejected.
        if request.model not in self._RERANK_SUPPORTED_MODELS:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details(
                f"Unsupported reranker model {request.model!r}. "
                f"Supported: {sorted(m for m in self._RERANK_SUPPORTED_MODELS if m)}"
            )
            return inference_pb2.RerankResponse()
        passages = list(request.passages)
        if not passages:
            return inference_pb2.RerankResponse(scores=[])
        try:
            from reranker import RerankerSingleton

            pairs = [[request.query, p] for p in passages]
            loop = asyncio.get_running_loop()
            scores = await loop.run_in_executor(
                None, RerankerSingleton.instance().compute_score, pairs
            )
            return inference_pb2.RerankResponse(scores=scores)
        except Exception as e:
            logger.error("gRPC Rerank error: %s", e)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Rerank error: {str(e)}")
            return inference_pb2.RerankResponse()


async def start_grpc_server(
    provider_router: ProviderRouter,
    scheduler: InferenceScheduler,
    port: int = GRPC_PORT,
) -> grpc_aio.Server:
    """Start the async gRPC server."""
    server = grpc_aio.server()
    servicer = InferenceServicer(provider_router, scheduler)
    inference_pb2_grpc.add_InferenceServiceServicer_to_server(servicer, server)
    server.add_insecure_port(f"[::]:{port}")
    await server.start()
    logger.info("gRPC server started on port %d", port)
    return server
