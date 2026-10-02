"""WARP-3452 — ``/llm/*``: the box's model runtime for employees' coding tools.

GitHub Copilot (Custom Endpoint, or the official Ollama extension), Continue,
Cline, OpenCode, Zed… point at ``https://<box>/llm`` and talk to the runtime
(Docker Model Runner or Ollama) in its own dialects — OpenAI, Ollama native,
Anthropic Messages — through this allowlisting pass-through. Neither runtime
checks credentials, and their model-management endpoints are the CVE surface
(WARP-3452 "Why not just publish the container port"), so:

- every path not in ``_ROUTES`` answers 404 before anything else runs;
- every request carries a member's ``dlk_`` token, checked against the
  orchestrator on EVERY call — no cache, so a revoke takes effect at once;
- only the box's active chat model is listed or served;
- generation goes through the InferenceScheduler at AUTOMATION priority, set
  here, and gives its slot up when the box's own chat needs it (WARP-3306);
- one request in flight and ``LLM_ACCESS_RPM`` requests a minute, per token;
- request and response bodies are never logged: they are the customer's code.

nginx (``location /llm/``) clears X-Droplet-User / X-Request-Priority and
refuses relay and guest peers before a request gets here. main.py's
SERVICE_TOKEN_AI_GATEWAY gate does not apply to this prefix.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections import deque

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from _shared.internal_tls import httpx_client_kwargs
from capabilities import ollama_capabilities_from_show, static_capabilities
from middleware.off_lan_gating import AI_GATEWAY_SAMPLER_TOKEN, ORCHESTRATOR_URL
from middleware.rate_limit import _int_env
from providers.ollama_local import _resolve_inference_runtime, grammar_safe_tools
from request_context import get_request_id
from scheduler import Priority, QueueFullError

logger = logging.getLogger(__name__)

router = APIRouter()

_IS_DMR = _resolve_inference_runtime() == "dmr"
_RPM = _int_env("LLM_ACCESS_RPM", 60)
# DMR has no /api/version. Copilot refuses an Ollama older than 0.6.4, so any
# recent version string does; bump it if a client starts asking for more.
_DMR_OLLAMA_VERSION = "0.13.0"
_PREEMPTED = "The Droplet's own chat needed the model. Retry shortly."
_PREEMPT_RETRY_AFTER_S = 10

# (method, client path) → (Ollama path, DMR path). None = answered here.
# Anything else — /api/pull|push|create|copy|delete|blobs, DMR /models/* and
# _configure, /ai/* — is a 404 that never reaches the runtime. Allowlist, never
# blocklist.
_ROUTES: dict[tuple[str, str], tuple[str | None, str | None]] = {
    ("POST", "/v1/chat/completions"): ("/v1/chat/completions", "/engines/v1/chat/completions"),
    ("POST", "/v1/completions"): ("/v1/completions", "/engines/v1/completions"),
    ("GET", "/v1/models"): (None, None),
    ("GET", "/api/version"): ("/api/version", None),
    ("GET", "/api/tags"): ("/api/tags", "/api/tags"),
    ("POST", "/api/show"): ("/api/show", "/api/show"),
    ("POST", "/api/chat"): ("/api/chat", "/api/chat"),
    ("POST", "/api/generate"): ("/api/generate", "/api/generate"),
    ("POST", "/v1/messages"): ("/v1/messages", "/anthropic/v1/messages"),
    ("POST", "/v1/responses"): ("/v1/responses", None),
}
_METADATA = frozenset({"/v1/models", "/api/version", "/api/tags", "/api/show"})

# Ollama reloads the model for a new value of any of these, and `keep_alive`
# unloads or pins it. Clients such as Continue send them by default; a coding
# tool must not be able to evict or resize the box's own chat model.
_RELOADING_OPTIONS = frozenset(
    {"num_ctx", "num_batch", "num_gpu", "main_gpu", "num_thread", "use_mmap", "use_mlock", "low_vram", "numa"}
)

_AUTH_ERRORS = {
    "invalid_token": "Missing or unknown token. Send Authorization: Bearer dlk_…",
    "revoked": "This token was revoked.",
    "expired": "This token has expired. Renew it in Settings → Coding tools.",
    "disabled": "Coding tools access is turned off on this Droplet.",
    "role_not_allowed": "This account can't use coding tools.",
    "no_active_model": "This Droplet has no active chat model.",
}
_ERROR_TYPES = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    429: "rate_limit_error",
    503: "overloaded_error",
}

# ponytail: in-process limits, correct for the single uvicorn worker
# _shared.serve runs (the InferenceScheduler is in-process too). Move them to
# Redis if ai-gateway ever runs more than one worker.
_recent: dict[str, deque[float]] = {}
_in_flight: set[str] = set()
# Usage reports run after the response; holding the task keeps it from being
# garbage-collected mid-flight.
_background: set[asyncio.Task] = set()


def _error(path: str, status: int, code: str, message: str, retry_after: int | None = None) -> JSONResponse:
    """An error in the dialect the client speaks."""
    kind = _ERROR_TYPES.get(status, "api_error")
    if path == "/v1/messages":
        body: dict = {"type": "error", "error": {"type": kind, "message": message}}
    elif path.startswith("/api/"):
        body = {"error": message}
    else:
        body = {"error": {"message": message, "type": kind, "param": None, "code": code}}
    headers = {"Retry-After": str(retry_after)} if retry_after else None
    return JSONResponse(status_code=status, content=body, headers=headers)


async def _orchestrator(route: str, payload: dict) -> httpx.Response:
    """POST to an internal /api/llm-access route as the ai-gateway principal.

    15 s: introspection can wait on the orchestrator's own model listing from
    ai-gateway, which it allows 10 s on a cold start."""
    async with httpx.AsyncClient(timeout=15.0, **httpx_client_kwargs()) as client:
        return await client.post(
            f"{ORCHESTRATOR_URL}/api/llm-access/{route}",
            json=payload,
            headers={"Authorization": f"Bearer {AI_GATEWAY_SAMPLER_TOKEN}"},
        )


async def _authenticate(request: Request, path: str) -> dict | JSONResponse:
    """The introspected principal, or the refusal to send. Fails closed."""
    auth = request.headers.get("Authorization", "")
    token = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
    if not token.startswith("dlk_"):
        return _error(path, 401, "invalid_token", _AUTH_ERRORS["invalid_token"])
    unavailable = _error(path, 503, "auth_unavailable", "The token check is unavailable. Retry shortly.")
    if not AI_GATEWAY_SAMPLER_TOKEN:
        logger.error("llm_access: AI_GATEWAY_SAMPLER_TOKEN unset — refusing every /llm/ request")
        return unavailable
    try:
        resp = await _orchestrator("_introspect", {"token": token})
        body = resp.json() if resp.status_code in (200, 401, 403) else {}
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("llm_access: introspection failed (%s) — failing closed", type(exc).__name__)
        return unavailable
    if not isinstance(body, dict):
        body = {}
    if resp.status_code == 200 and body.get("tokenId") and body.get("activeModel"):
        return body
    code = body.get("error")
    if resp.status_code in (401, 403) and code in _AUTH_ERRORS:
        return _error(path, resp.status_code, code, _AUTH_ERRORS[code])
    logger.warning("llm_access: introspection answered %d — failing closed", resp.status_code)
    return unavailable


def _rpm_retry_after(token_id: str) -> int | None:
    """Seconds until ``token_id`` may send again; None counts the request."""
    now = time.monotonic()
    window = _recent.setdefault(token_id, deque())
    while window and window[0] <= now - 60:
        window.popleft()
    if len(window) >= _RPM:
        return max(1, math.ceil(window[0] + 60 - now))
    window.append(now)
    return None


def _passthrough(resp: httpx.Response) -> Response:
    return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))


def _unreachable(path: str, token_id: str, exc: Exception) -> JSONResponse:
    logger.warning("llm_access: runtime unreachable access_id=%s path=%s (%s)", token_id, path, type(exc).__name__)
    return _error(path, 502, "runtime_unavailable", "The model runtime did not answer.")


def _dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


class _Usage:
    """Token counts read off the response as it streams past; nothing else is kept."""

    def __init__(self) -> None:
        self.prompt = 0
        self.completion = 0
        self._tail = b""

    def feed(self, chunk: bytes) -> None:
        *lines, self._tail = (self._tail + chunk).split(b"\n")
        for line in lines:
            if b"usage" in line or b"eval_count" in line:
                self._read(line.strip().removeprefix(b"data:").strip())

    def _read(self, line: bytes) -> None:
        try:
            obj = json.loads(line)
        except ValueError:
            return
        if not isinstance(obj, dict):
            return
        # OpenAI `usage`; Anthropic `usage` and message_start's `message.usage`;
        # Responses `response.usage`; Ollama's top-level eval counts. Counts are
        # cumulative (Anthropic sends output_tokens twice), so keep the largest.
        scopes = (_dict(obj.get("usage")), _dict(_dict(obj.get("message")).get("usage")),
                  _dict(_dict(obj.get("response")).get("usage")), obj)
        for scope in scopes:
            for key in ("prompt_tokens", "input_tokens", "prompt_eval_count"):
                if isinstance(scope.get(key), int):
                    self.prompt = max(self.prompt, scope[key])
            for key in ("completion_tokens", "output_tokens", "eval_count"):
                if isinstance(scope.get(key), int):
                    self.completion = max(self.completion, scope[key])


async def _post_usage(token_id: str, usage: _Usage, error: bool) -> None:
    try:
        resp = await _orchestrator(
            "_usage",
            {"tokenId": token_id, "promptTokens": usage.prompt, "completionTokens": usage.completion, "error": error},
        )
        if resp.status_code >= 400:
            logger.warning("llm_access: usage report answered %d access_id=%s", resp.status_code, token_id)
    except httpx.HTTPError as exc:
        logger.warning("llm_access: usage report failed access_id=%s (%s)", token_id, type(exc).__name__)


def _report_usage(token_id: str, usage: _Usage, error: bool) -> None:
    """Best-effort and non-blocking: the response never waits on the report."""
    task = asyncio.create_task(_post_usage(token_id, usage, error))
    _background.add(task)
    task.add_done_callback(_background.discard)


def _preempted_frame(path: str, content_type: str) -> bytes:
    """A last frame telling a streaming client why its answer stopped."""
    body = _error(path, 503, "preempted_for_chat", _PREEMPTED).body
    if "text/event-stream" in content_type:
        return (b"event: error\n" if path == "/v1/messages" else b"") + b"data: " + body + b"\n\n"
    if "ndjson" in content_type:
        return body + b"\n"
    return b""


@router.api_route("/llm/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
async def llm(path: str, request: Request) -> Response:
    path = "/" + path
    route = _ROUTES.get((request.method, path))
    if route is None:
        return _error(path, 404, "not_found", "Not found.")
    principal = await _authenticate(request, path)
    if isinstance(principal, Response):
        return principal
    token_id = str(principal["tokenId"])
    active = str(principal["activeModel"])
    wait = _rpm_retry_after(token_id)
    if wait is not None:
        return _error(path, 429, "rate_limited", f"More than {_RPM} requests a minute from this token.", retry_after=wait)

    upstream = route[1] if _IS_DMR else route[0]
    if path == "/v1/models":
        model = {"id": active, "object": "model", "created": 0, "owned_by": "droplet"}
        return JSONResponse({"object": "list", "data": [model]})
    if path == "/api/version" and upstream is None:
        return JSONResponse({"version": _DMR_OLLAMA_VERSION})
    if path == "/v1/responses" and upstream is None:
        return _error(path, 501, "not_implemented",
                      "This Droplet runs Docker Model Runner, which has no Responses API. Use /llm/v1/chat/completions.")

    body: dict = {}
    if request.method == "POST":
        try:
            parsed = json.loads(await request.body() or b"null")
        except ValueError:
            parsed = None
        if not isinstance(parsed, dict):
            return _error(path, 400, "invalid_request", "The request body must be a JSON object.")
        body = parsed
        # Older Ollama clients name the model `name` on /api/show; Ollama itself prefers `model`.
        requested = body.get("model") or (body.get("name") if path == "/api/show" else None)
        if requested != active:
            return _error(path, 404, "model_not_found",
                          f"Model {requested!r} is not served here. This Droplet serves {active!r}.")

    import main  # deferred: main imports this module to mount `router`

    if main.provider_router is None or main.inference_scheduler is None:
        return _error(path, 503, "not_ready", "Service not ready.")
    client = main.provider_router.local.client
    if path not in _METADATA:
        return await _generate(main, client, path, upstream, body, token_id)
    try:
        if path == "/api/tags":
            resp = await client.get(upstream)
            tags = resp.json() if resp.status_code == 200 else None
            if not isinstance(tags, dict):
                return _passthrough(resp)
            tags["models"] = [m for m in tags.get("models") or []
                              if isinstance(m, dict) and active in (m.get("name"), m.get("model"))]
            return JSONResponse(tags)
        if path == "/api/show":
            return await _show(client, upstream, body, active, principal.get("contextWindow"))
        return _passthrough(await client.get(upstream))  # /api/version on Ollama
    except (httpx.HTTPError, ValueError) as exc:
        return _unreachable(path, token_id, exc)


async def _show(client: httpx.AsyncClient, upstream: str, body: dict, active: str, context_window: object) -> Response:
    resp = await client.post(upstream, json=body)
    show = resp.json() if _IS_DMR and resp.status_code == 200 else None
    if not isinstance(show, dict):
        return _passthrough(resp)
    # DMR's /api/show carries `details` and nothing else (capabilities.py,
    # WARP-1744): Copilot and the Ollama extension would see a model without
    # tools and with their 4k default window. Fill both from what the box knows.
    if "capabilities" not in show:
        caps = static_capabilities(active) or ollama_capabilities_from_show(show)
        show["capabilities"] = ["completion", *(["tools"] if caps.tools else []), *(["vision"] if caps.vision else [])]
    if isinstance(context_window, int) and context_window > 0:
        info = _dict(show.get("model_info"))
        arch = info.setdefault("general.architecture", _dict(show.get("details")).get("family") or "llama")
        info[f"{arch}.context_length"] = context_window
        show["model_info"] = info
    return JSONResponse(show)


async def _generate(main, client: httpx.AsyncClient, path: str, upstream: str, body: dict, token_id: str) -> Response:
    if token_id in _in_flight:
        return _error(path, 429, "too_many_requests", "This token already has a request running. Send one at a time.",
                      retry_after=1)
    if path in ("/api/chat", "/api/generate"):
        body.pop("keep_alive", None)
        if isinstance(body.get("options"), dict):
            body["options"] = {k: v for k, v in body["options"].items() if k not in _RELOADING_OPTIONS}
    if _IS_DMR and isinstance(body.get("tools"), list):
        # WARP-1839: DMR's llama.cpp compiles tool schemas into a grammar and
        # bounded keywords blow it up — the same strip the box's own chat gets.
        body["tools"] = grammar_safe_tools(body["tools"])

    scheduler = main.inference_scheduler
    _in_flight.add(token_id)
    # The box's chat (USER) preempts this slot through `preempt` (WARP-3306).
    preempt = asyncio.Event()
    future = None
    try:
        future = await scheduler.enqueue(Priority.AUTOMATION, None, preempt)
        await future
    except QueueFullError as exc:
        _in_flight.discard(token_id)
        return _error(path, 429, "queue_full", "The model is busy. Retry shortly.", retry_after=exc.retry_after)
    except BaseException:
        # GWV-003: a slot granted just before the cancel must not leak.
        _in_flight.discard(token_id)
        if future is not None and future.done() and not future.cancelled():
            await scheduler.release(preempt)
        raise

    usage = _Usage()
    finished = False

    async def finish(error: bool) -> None:
        nonlocal finished
        if finished:
            return
        finished = True
        _in_flight.discard(token_id)
        await scheduler.release(preempt)
        _report_usage(token_id, usage, error)

    headers = {"Content-Type": "application/json"}
    if rid := get_request_id():
        headers["x-request-id"] = rid
    # Only the parsed body goes upstream: never the client's headers (its dlk_
    # token included), and no duplicate-key JSON the runtime might read differently.
    request = client.build_request("POST", upstream, content=json.dumps(body).encode(), headers=headers)
    try:
        resp = await main._unless_preempted(client.send(request, stream=True), preempt)
    except main._Preempted:
        await finish(False)
        return _error(path, 503, "preempted_for_chat", _PREEMPTED, retry_after=_PREEMPT_RETRY_AFTER_S)
    except BaseException as exc:
        await finish(isinstance(exc, Exception))
        if isinstance(exc, Exception):
            return _unreachable(path, token_id, exc)
        raise

    content_type = resp.headers.get("content-type", "application/json")
    if resp.status_code >= 400:
        logger.warning("llm_access: runtime answered %d access_id=%s path=%s", resp.status_code, token_id, path)

    async def relay():
        # Chunks go out as they arrive (SSE, NDJSON or one JSON body): nothing
        # is buffered beyond the line the usage scanner is reading.
        failed = resp.status_code >= 400
        chunks = resp.aiter_bytes()
        try:
            while True:
                try:
                    chunk = await main._unless_preempted(chunks.__anext__(), preempt)
                except StopAsyncIteration:
                    break
                except main._Preempted:
                    if frame := _preempted_frame(path, content_type):
                        yield frame
                    break
                usage.feed(chunk)
                yield chunk
        except Exception as exc:
            failed = True
            logger.warning("llm_access: stream broke access_id=%s path=%s (%s)", token_id, path, type(exc).__name__)
        finally:
            usage.feed(b"\n")  # a last line the runtime did not terminate
            try:
                await resp.aclose()  # closing stops the runtime generating
            finally:
                await finish(failed)

    return StreamingResponse(
        relay(),
        status_code=resp.status_code,
        media_type=content_type,
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
