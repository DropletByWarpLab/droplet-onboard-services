"""gRPC server for the AI Gateway inference service.

Runs alongside FastAPI on port 50051. Provides low-latency inference
for the orchestrator per design doc Section 7: "gRPC is used for
latency-sensitive internal calls between the orchestrator and the LLM service."
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path

import grpc
import httpx
from grpc import aio as grpc_aio

# Proto-generated modules (generated from proto/inference.proto)
from grpc_generated import inference_pb2, inference_pb2_grpc

from request_context import new_request_id, set_request_id
from router import ProviderRouter
from schemas import ChatMessage, ChatRequest, ModelInfo
from scheduler import InferenceScheduler, QueueFullError

logger = logging.getLogger(__name__)

GRPC_PORT = 50051

# WARP-3070: Kev decision model (droplet-local-LLM `decision-model` sidecar,
# ADR-006). Off unless DECISION_MODEL_URL is set.
DECIDE_DEFAULT_TIMEOUT_MS = 2000
DECIDE_DEFAULT_MODEL = "kev-latest"
_DECIDE_DETAIL_MAX = 300


def _provider_error_detail(exc: Exception, context: str) -> str:
    """GW-08: log the full provider/LiteLLM exception server-side and return a
    generic, non-leaky detail string for ``context.set_details``.

    Mirrors the HTTP path in ``main.py`` so the gRPC surface doesn't echo
    upstream provider error bodies/URLs/model names to callers. A short
    correlation id ties the opaque client message to the server-side log.
    """
    correlation_id = uuid.uuid4().hex[:12]
    logger.error("%s [correlation_id=%s]: %s", context, correlation_id, exc)
    return f"Upstream provider error (ref: {correlation_id})"


class InferenceServicer(inference_pb2_grpc.InferenceServiceServicer):
    """gRPC implementation of the InferenceService."""

    # WARP-286: Rerank handler accepts an empty model field (proto default)
    # or the canonical name. Unknown ids fail closed with INVALID_ARGUMENT
    # rather than silently falling back to a default.
    _RERANK_SUPPORTED_MODELS = frozenset({"", "bge-reranker-base"})
    # GWV-009: mirror the Rerank allowlist for EmbedText — an arbitrary model
    # name would be handed to SentenceTransformer, which downloads any HF repo
    # (unbounded egress + disk/memory), and mixed dimensions could corrupt pgvector.
    #
    # WARP-2196: `""` is the proto default ("caller expressed no preference")
    # and resolves to providers.embeddings.DEFAULT_MODEL.
    #
    # Written out literally rather than derived from
    # `providers.embeddings.SUPPORTED_MODELS`: that module is imported LAZILY
    # inside EmbedText (so a gateway without sentence-transformers still
    # serves chat), and a module-level import here would both undo that and
    # break the test stubs that replace `providers.embeddings`. The two lists
    # are held in agreement by
    # tests/test_embed_model_allowlist.py::test_allowlist_cannot_drift_from_the_provider_resolver
    # instead — adding a model in one place and not the other fails CI.
    #
    # `all-MiniLM-L6-v2` was REMOVED, not joined by bge. Both are 384-dim, so
    # pgvector accepts either into `FileContentChunk.embedding` and the
    # dimension check that normally catches a wrong model passes — while
    # cosine distance across the two spaces is meaningless. Keeping both
    # allowed would make undetectable corpus poisoning a supported config,
    # precisely while the corpus is mid-re-embed. See providers/embeddings.py.
    _EMBED_SUPPORTED_MODELS = frozenset({"", "bge-small-en-v1.5"})

    def __init__(self, provider_router: ProviderRouter, scheduler: InferenceScheduler):
        self._router = provider_router
        self._scheduler = scheduler
        self._decide_client: httpx.AsyncClient | None = None  # lazy, reused across calls

    async def Chat(self, request, context):
        """Unary chat completion."""
        set_request_id(new_request_id())
        future = None
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
        except asyncio.CancelledError:
            # GWV-003: the caller cancelled the RPC while this request was
            # queued. If the scheduler already GRANTED the slot (resolved the
            # future + incremented _active_count) before we were cancelled,
            # that slot would leak — one leaked slot at max_concurrent=1
            # permanently deadlocks every subsequent chat. Release it iff the
            # grant actually landed, then re-raise the cancel. Mirrors the
            # /ai/chat HTTP path in main.py.
            if future is not None and future.done() and not future.cancelled():
                await self._scheduler.release()
            raise

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
            # GW-08: don't echo upstream/LiteLLM error text to the caller.
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(_provider_error_detail(e, "gRPC Chat error"))
            return inference_pb2.ChatResponse()
        finally:
            await self._scheduler.release()

    async def StreamChat(self, request, context):
        """Server-side streaming chat completion."""
        set_request_id(new_request_id())
        future = None
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
        except asyncio.CancelledError:
            # GWV-003: same granted-but-cancelled window as Chat above —
            # release the slot iff the grant actually landed, then re-raise.
            if future is not None and future.done() and not future.cancelled():
                await self._scheduler.release()
            raise

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
            # GW-08: generic message + correlation id; full error logged server-side.
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(_provider_error_detail(e, "gRPC StreamChat error"))
        finally:
            await self._scheduler.release()

    async def ListModels(self, request, context):
        """List available models from all providers.

        WARP-1284: list_all_models now returns a ModelListResult; the gRPC
        surface keeps its existing ModelList shape (proto unchanged) and
        only forwards the models — `degraded_providers` is consumed by the
        HTTP /ai/models path.
        """
        set_request_id(new_request_id())
        try:
            result = await self._router.list_all_models()
            return inference_pb2.ModelList(
                models=[
                    inference_pb2.ModelInfo(
                        id=m.id,
                        provider=m.provider,
                        name=m.name,
                        context_window=m.context_window,
                    )
                    for m in result.models
                ]
            )
        except Exception as e:
            # GW-08: don't echo upstream/provider error text to the caller.
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(_provider_error_detail(e, "gRPC ListModels error"))
            return inference_pb2.ModelList()

    async def EmbedText(self, request, context):
        """Compute embeddings for a batch of texts.

        Uses sentence-transformers locally on CPU. The model is loaded lazily
        on first call (~2s cold start, ~80 MB download). Subsequent calls are
        instant. Blocks the event loop for the encode step — acceptable for the
        file-indexer's batch workload; a threadpool offload can be added later
        if interactive latency matters.
        """
        set_request_id(new_request_id())
        try:
            from providers.embeddings import embed_texts

            texts = list(request.texts)
            if not texts:
                return inference_pb2.EmbedResponse()

            model_name = request.model if request.HasField("model") else None
            if model_name is not None and model_name not in self._EMBED_SUPPORTED_MODELS:
                await context.abort(
                    grpc.StatusCode.INVALID_ARGUMENT,
                    f"Unsupported embed model '{model_name}'. "
                    f"Supported: {sorted(m for m in self._EMBED_SUPPORTED_MODELS if m)}",
                )

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
            # GW-08: don't echo upstream/provider error text to the caller.
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(_provider_error_detail(e, "gRPC EmbedText error"))
            return inference_pb2.EmbedResponse()

    async def Rerank(self, request, context):
        """WARP-286 — score (query, passage) pairs via a cross-encoder.

        Delegates to `reranker.RerankerSingleton`. The first call lazy-loads
        BGE-reranker-base from the on-disk cache (or downloads ~280 MB
        from HF on a cold appliance). The model `compute_score` step runs
        on CPU; we offload to a threadpool to avoid blocking the asyncio
        loop while batches are running.
        """
        set_request_id(new_request_id())
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
            from reranker import RerankerSingleton, RerankerUnavailable

            try:
                instance = RerankerSingleton.instance()
            except RerankerUnavailable:
                # WARP-644: model import/load is broken (already logged once
                # at WARNING by the singleton). Degrade gracefully: return
                # empty scores with OK status so the orchestrator falls back
                # to unranked retrieval instead of getting a 500.
                return inference_pb2.RerankResponse(scores=[])

            pairs = [[request.query, p] for p in passages]
            loop = asyncio.get_running_loop()
            scores = await loop.run_in_executor(
                None, instance.compute_score, pairs
            )
            return inference_pb2.RerankResponse(scores=scores)
        except Exception as e:
            # GW-08: don't echo upstream/provider error text to the caller.
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(_provider_error_detail(e, "gRPC Rerank error"))
            return inference_pb2.RerankResponse()

    async def ClassifyQuery(self, request, context):
        """Zero-shot query classifier; routes orchestrator's retrieval presets.

        Delegates to `query_classifier.QueryClassifierSingleton`. First call
        lazy-loads the model (~110 MB int8). Subsequent calls are ~50 ms CPU.
        Returns 'unknown' when confidence falls below CLASSIFIER_CONFIDENCE_FLOOR.
        """
        set_request_id(new_request_id())
        try:
            query = request.query
            if not query:
                return inference_pb2.ClassifyQueryResponse(**{"class": "unknown", "confidence": 0.0})

            from query_classifier import QueryClassifierSingleton

            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, QueryClassifierSingleton.instance().classify, query
            )
            return inference_pb2.ClassifyQueryResponse(**{
                "class": result.cls,
                "confidence": result.confidence,
            })
        except Exception as e:
            # GW-08: don't echo upstream/provider error text to the caller.
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(_provider_error_detail(e, "gRPC ClassifyQuery error"))
            return inference_pb2.ClassifyQueryResponse(**{"class": "unknown", "confidence": 0.0})

    async def Decide(self, request, context):
        """Calibrated decision model (Kev, WARP-3070) via the decision-model sidecar.

        Fails soft AS DATA: not configured, timeout, connection error, 5xx or
        401 -> DECIDE_STATUS_UNAVAILABLE; 422 -> DECIDE_STATUS_INVALID. Never
        sets a gRPC error code, so a caller's only branch is the status enum.
        Logs question ids, status and latency; never the key or the state.
        """
        set_request_id(new_request_id())
        started = time.monotonic()
        qids = sorted(request.questions.keys())

        def done(status, detail="", answers=None, model="", latency_ms=None):
            if latency_ms is None:
                latency_ms = (time.monotonic() - started) * 1000
            logger.info(
                "Decide questions=%s status=%s latency_ms=%.1f",
                qids, inference_pb2.DecideStatus.Name(status), latency_ms,
            )
            return inference_pb2.DecideResponse(
                status=status, answers=answers or {}, latency_ms=latency_ms,
                model=model, detail=detail[:_DECIDE_DETAIL_MAX],
            )

        base_url = os.environ.get("DECISION_MODEL_URL", "").strip()
        if not base_url:
            return done(inference_pb2.DECIDE_STATUS_UNAVAILABLE, "decision-model not configured")

        try:
            questions = {qid: _decide_question_json(q) for qid, q in request.questions.items()}
        except ValueError as e:
            return done(inference_pb2.DECIDE_STATUS_INVALID, str(e))

        body = {
            "state": request.state,
            "model": request.model or DECIDE_DEFAULT_MODEL,
            "questions": questions,
        }
        timeout_s = (request.timeout_ms or DECIDE_DEFAULT_TIMEOUT_MS) / 1000
        headers = {"Authorization": f"Bearer {os.environ.get('DECISION_MODEL_API_KEY', '')}"}
        if self._decide_client is None:
            self._decide_client = httpx.AsyncClient()
        try:
            resp = await self._decide_client.post(
                base_url.rstrip("/") + "/v1/systemone",
                json=body, headers=headers, timeout=timeout_s,
            )
        except httpx.TimeoutException:
            return done(inference_pb2.DECIDE_STATUS_UNAVAILABLE, f"timeout after {timeout_s * 1000:.0f} ms")
        except (httpx.HTTPError, httpx.InvalidURL) as e:
            # InvalidURL is not an HTTPError: a mistyped DECISION_MODEL_URL still fails soft.
            return done(inference_pb2.DECIDE_STATUS_UNAVAILABLE, f"connection error: {type(e).__name__}")

        if resp.status_code == 422:
            return done(inference_pb2.DECIDE_STATUS_INVALID, _decide_422_detail(resp))
        if resp.status_code == 401:
            return done(inference_pb2.DECIDE_STATUS_UNAVAILABLE, "decision-model rejected the API key (401)")
        if resp.status_code != 200:
            return done(inference_pb2.DECIDE_STATUS_UNAVAILABLE, f"decision-model returned HTTP {resp.status_code}")

        try:
            data = resp.json()
            answers = {qid: _decide_answer_pb(a) for qid, a in data["answers"].items()}
            latency = data.get("latency_ms")
            return done(
                inference_pb2.DECIDE_STATUS_OK, answers=answers, model=str(data.get("model", "")),
                latency_ms=float(latency) if latency is not None else None,
            )
        except (ValueError, KeyError, TypeError, AttributeError) as e:
            return done(inference_pb2.DECIDE_STATUS_UNAVAILABLE, f"malformed decision-model response: {type(e).__name__}")


def _decide_question_json(q) -> dict:
    """DecideQuestion proto -> one System One question. ValueError on an unset type."""
    if q.type == inference_pb2.DECIDE_QUESTION_TYPE_NOUL:
        out = {"type": "noul", "instructions": q.instructions}
        criteria = {k: v for k, v in (("true", q.true_description), ("false", q.false_description)) if v}
        if criteria:
            out["criteria"] = criteria
        return out
    if q.type == inference_pb2.DECIDE_QUESTION_TYPE_CHOICE:
        # dict keeps insertion order and Kev reads option order: keep the caller's.
        return {"type": "choice", "instructions": q.instructions,
                "criteria": {o.name: (o.description or None) for o in q.options}}
    if q.type == inference_pb2.DECIDE_QUESTION_TYPE_SCORE:
        return {"type": "score", "instructions": q.instructions, "criteria": list(q.levels)}
    raise ValueError("question type is unspecified")


def _decide_answer_pb(a: dict):
    """One System One answer -> DecideAnswer proto."""
    kind = a["type"]
    if kind == "noul":
        return inference_pb2.DecideAnswer(type=inference_pb2.DECIDE_QUESTION_TYPE_NOUL, noul=float(a["noul"]))
    probs = {str(k): float(v) for k, v in a.get("probabilities", {}).items()}
    if kind == "choice":
        return inference_pb2.DecideAnswer(
            type=inference_pb2.DECIDE_QUESTION_TYPE_CHOICE, choice=str(a["choice"]),
            confidence=float(a.get("confidence", 0.0)), probabilities=probs,
        )
    if kind == "score":
        return inference_pb2.DecideAnswer(
            type=inference_pb2.DECIDE_QUESTION_TYPE_SCORE, score=float(a["score"]),
            confidence=float(a.get("confidence", 0.0)), probabilities=probs,
            legend={str(k): str(v) for k, v in a.get("legend", {}).items()},
        )
    raise ValueError(f"unknown answer type {kind!r}")


def _decide_422_detail(resp) -> str:
    """The sidecar's 422 reason WITHOUT echoing input: FastAPI validation items
    carry an `input` field that can hold the state text, so keep loc + msg only."""
    try:
        detail = resp.json().get("detail")
    except (ValueError, AttributeError):
        return "invalid request (422)"
    if isinstance(detail, list):
        return "; ".join(
            f"{'.'.join(str(p) for p in d.get('loc', []))}: {d.get('msg', '')}"
            for d in detail if isinstance(d, dict)
        ) or "invalid request (422)"
    return str(detail) if detail else "invalid request (422)"


async def start_grpc_server(
    provider_router: ProviderRouter,
    scheduler: InferenceScheduler,
    port: int = GRPC_PORT,
) -> grpc_aio.Server:
    """Start the async gRPC server."""
    server = grpc_aio.server()
    servicer = InferenceServicer(provider_router, scheduler)
    inference_pb2_grpc.add_InferenceServiceServicer_to_server(servicer, server)
    bind_grpc_port(server, port)
    await server.start()
    logger.info("gRPC server started on port %d", port)
    return server


def bind_grpc_port(server, port: int) -> None:
    """Bind :50051 per the internal-mTLS contract (WARP-1061, hop 16).

    DROPLET_INTERNAL_TLS=1 → serve the /data/service-tls bundle and REQUIRE a
    CA-signed client cert (file-indexer's embedder presents its own bundle
    via grpc_channel_credentials). Unset/0 → the historical insecure port,
    byte-identical to before. Split from start_grpc_server so the flag
    contract is unit-testable without model/scheduler bring-up.
    """
    from _shared.internal_tls import enabled, grpc_server_credentials

    if enabled():
        server.add_secure_port(f"[::]:{port}", grpc_server_credentials())
    else:
        server.add_insecure_port(f"[::]:{port}")
