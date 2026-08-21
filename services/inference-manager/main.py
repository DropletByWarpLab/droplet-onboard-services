"""Inference Manager — model lifecycle for the Droplet inference appliance.

Pulls, lists, and inspects models on the local Ollama instance based on
``model-manifest.json``. VRAM-aware: each manifest entry declares
``min_vram_gb`` and the appliance auto-detects unified memory at boot
to filter eligible models.

This service does NOT host an agent runtime. Inference traffic goes
directly to Ollama at :11434. The orchestrator (separate repo,
``droplet-onboard-services``) owns the agent loop. See
``docs/agentic-workflows.md``.

Lifecycle calls reach the daemon through the ``runtime`` adapter package
(WARP-1743 / ADR-005 §1) rather than a raw client, so which daemon serves
the weights is configuration rather than a hard-coded wire format. The
default is Ollama and stays Ollama — see ``runtime/factory.py``.
"""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
# TIMEOUT_HEALTH and TIMEOUT_PULL moved with the calls that used them — the
# adapters own the health probe and both pull forms now (runtime/base.py,
# runtime/ollama.py). Same values, same call shapes, different file.
from timeouts import TIMEOUT_MGMT
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import disk
from auth import setup_auth
from eligible import build_eligible
from manifest import DEFAULT_MANIFEST_PATH, load_manifest_resilient_with_status
import vram

from logging_config import (
    configure_structlog,
    CorrelationIdMiddleware,
    propagate_trace_id_hook,
    get_logger,
)

from loading_state import LoadingTracker
from runtime import (
    DEFAULT_BASE_URL,
    InferenceRuntime,
    build_runtime,
    pulled_result,
    resolve_base_url,
    resolve_runtime_name,
)

configure_structlog()
logger = get_logger(__name__)

OLLAMA_URL = os.getenv("OLLAMA_URL", DEFAULT_BASE_URL)

# WARP-1743 / ADR-005 §1: which backend serves the weights. Resolved once, at
# import, so an unrecognised value stops the process at startup instead of
# surfacing on the first request — a box configured for a backend it isn't
# running must fail loudly, not serve happily from the wrong one. Unset (the
# only state any deployed appliance is in today) resolves to `ollama`, which
# runs the same code the lifecycle handlers ran before this ticket.
INFERENCE_RUNTIME = resolve_runtime_name()
# Optional base-url override that defaults to OLLAMA_URL, so with no new env var
# this is OLLAMA_URL, character for character. It exists because a second
# backend listens on a different port (DMR: 12434) and pointing at it must not
# require redefining a variable named after the daemon it isn't. Renaming
# OLLAMA_URL is a separate ticket in the WARP-1740 epic, not this one.
INFERENCE_RUNTIME_URL = resolve_base_url()

# Resolved once at import. Default literal comes from the single canonical
# definition in manifest.py so main.py and chat_proxy.py can never drift
# (finding 3 / WARP-195). Tests monkeypatch this attribute directly.
MANIFEST_PATH = os.getenv("MODEL_MANIFEST", DEFAULT_MANIFEST_PATH)

_client: httpx.AsyncClient | None = None


def _runtime() -> InferenceRuntime | None:
    """The configured backend adapter bound to the live management client.

    ``None`` when the client isn't up yet — every handler's existing
    ``if not _client`` 503 guard becomes ``if not runtime`` and keeps meaning
    exactly the same thing. Built per call rather than cached at startup because
    ``_client`` is the single source of truth for the connection (the test suite
    swaps it directly), and an adapter is a stateless wrapper whose construction
    is one attribute assignment.
    """
    if _client is None:
        return None
    return build_runtime(_client, name=INFERENCE_RUNTIME)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _client
    # WARP-2131 (vendored): ONE client. Upstream opens a second one for the
    # observe-and-repair chat proxy (ADR-004); that router is not vendored, so
    # neither is its client. See VENDORED.md.
    _client = httpx.AsyncClient(
        base_url=INFERENCE_RUNTIME_URL,
        timeout=TIMEOUT_MGMT,
        event_hooks={"request": [propagate_trace_id_hook]},
    )
    app.state.loading_tracker = LoadingTracker()
    # `ollama_url` keeps its name and its value: log keys are a contract for
    # whatever greps them. The two new keys make the backend selection visible
    # at boot, which is the only place an operator can confirm what a box is
    # actually running.
    #
    # WARP-1748: the EVENT name moved with the service
    # (`ollama_manager_started` -> `inference_manager_started`). Verified safe
    # before renaming: nothing in droplet-local-LLM or droplet-onboard-services
    # greps for it outside this repo's frozen `docs/superpowers/plans/`
    # snapshots. Note the asymmetry with the `ollama_url` FIELD above, which
    # deliberately does not move — the field's consumers are unknown, the event
    # name's are enumerable.
    logger.info(
        "inference_manager_started",
        ollama_url=OLLAMA_URL,
        inference_runtime=INFERENCE_RUNTIME,
        inference_runtime_url=INFERENCE_RUNTIME_URL,
    )
    yield
    if _client:
        await _client.aclose()


app = FastAPI(title="Inference Manager", version="0.3.0", lifespan=lifespan)
setup_auth(app)

if os.getenv("ENABLE_CORS", "").lower() in ("true", "1"):
    from fastapi.middleware.cors import CORSMiddleware

    # Never wildcard the origin on this gated service: with `allow_origins=["*"]`
    # plus `*` methods/headers, any web page could attempt to drive the
    # lifecycle API (incl. `DELETE /models/{name}`) if it ever obtained the
    # bearer token. Require an explicit allow-list via `CORS_ALLOW_ORIGINS`
    # (comma-separated). If CORS is enabled without that list, fail closed —
    # add the middleware with an empty origin list so no cross-origin request
    # is permitted (rather than silently re-opening the wildcard). See LLM-11.
    _cors_origins = [
        o.strip()
        for o in os.getenv("CORS_ALLOW_ORIGINS", "").split(",")
        if o.strip()
    ]
    if not _cors_origins:
        logger.warning("cors_enabled_without_origins", hint="set CORS_ALLOW_ORIGINS")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

app.add_middleware(CorrelationIdMiddleware)


class PullRequest(BaseModel):
    model: str


# /health response schema version. Bump when adding a key, removing a key, or
# changing the meaning of an existing key. The orchestrator's
# ``OllamaLocalProvider`` reads this and logs a warning when it sees a version
# it doesn't know — so a future shape change surfaces as a noisy warn instead
# of a silent fall-back to defaults. See `docs/model-management.md` for the
# living contract and `docs/2026-05-10-architecture-audit.md` (item 6) for
# the rationale.
#
# Schema history:
#   1 (WARP-284, 2026-05-10): initial versioned shape — `status`,
#       `ollama_reachable`, `models_loading`, `circuit_breaker`,
#       `limits.{num_parallel, max_queue, max_loaded_models}`.
#   2 (WARP-1825, 2026-08-08): added `placement` — GPU-residency report
#       (`state`: ok | degraded | not_applicable | unknown, plus per-model
#       `gpu_fraction`). Consumers to bump: `scripts/verify.sh` and the
#       ai-gateway `_LimitsCache._KNOWN_SCHEMA_VERSION` (onboard repo).
_HEALTH_SCHEMA_VERSION = 2


@app.get("/health")
async def health():
    reachable = False
    runtime = _runtime()
    if runtime:
        # The adapter owns the probe and its swallow-everything semantics
        # (runtime/base.py). `ollama_reachable` keeps meaning "the lifecycle API
        # can talk to the daemon", asked the same way on every backend.
        reachable = await runtime.health()

    from circuit import get_circuit_state
    breaker_state = get_circuit_state()
    overall = "ok" if (reachable and breaker_state == "closed") else "degraded"

    tracker = getattr(app.state, "loading_tracker", None)
    loading = await tracker.list() if tracker is not None else []

    # Placement (WARP-1825) — WARP-2131 (vendored): this build does not
    # perform placement verification. `placement.py` imports the chat-proxy
    # module for a metrics label helper, and brings apscheduler plus a second
    # GPU watchdog that this repo did not ask for; neither is vendored.
    #
    # The v2 SHAPE is kept deliberately rather than reverting to v1. Every
    # field ai-gateway consumes (`limits`) is unchanged, and `_LimitsCache`
    # logs a one-time warning on ANY non-equal `schema_version` — so claiming
    # v1 would make a correct deployment look like a stale appliance forever.
    # `not_applicable` is one of v2's own documented states (ok | degraded |
    # not_applicable | unknown), so this reports the truth in the contract's
    # own vocabulary instead of fabricating a measurement. See VENDORED.md.
    placement_report = {"state": "not_applicable", "models": []}

    return {
        "schema_version": _HEALTH_SCHEMA_VERSION,
        "status": overall,
        "ollama_reachable": reachable,
        "models_loading": loading,
        "circuit_breaker": breaker_state,
        "placement": placement_report,
        "limits": {
            "num_parallel": int(os.getenv("OLLAMA_NUM_PARALLEL", "1")),
            "max_queue": int(os.getenv("OLLAMA_MAX_QUEUE", "16")),
            "max_loaded_models": int(os.getenv("OLLAMA_MAX_LOADED_MODELS", "1")),
        },
    }


@app.get("/models/available")
async def list_available():
    """Models currently pulled into the inference runtime."""
    runtime = _runtime()
    if not runtime:
        raise HTTPException(status_code=503, detail="Not ready")
    try:
        return await runtime.list_installed()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/models/loaded")
async def list_loaded():
    """Models currently resident in GPU/unified memory."""
    runtime = _runtime()
    if not runtime:
        raise HTTPException(status_code=503, detail="Not ready")
    try:
        return await runtime.list_loaded()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/models/manifest")
async def get_manifest():
    """Raw manifest contents (desired state)."""
    path = Path(MANIFEST_PATH)
    if not path.exists():
        return {"models": []}
    with open(path) as f:
        return json.load(f)


@app.get("/models/eligible")
async def list_eligible():
    """Manifest filtered by detected VRAM, augmented with `pulled` flag."""
    runtime = _runtime()
    if not runtime:
        raise HTTPException(status_code=503, detail="Not ready")
    manifest, degraded = load_manifest_resilient_with_status(MANIFEST_PATH)
    # WARP-2129: through the ADAPTER, not the raw client. The comment this
    # replaces argued /models/eligible was "backend-agnostic as written"
    # because both runtimes serve `/api/tags` field-for-field identically
    # (ADR-005 §2). That is true of the ENDPOINT and false of the IDENTIFIERS
    # in its body — which is precisely what this handler compares against the
    # manifest. WARP-1743 fixed that same comparison on /models/sync and scoped
    # itself to the four lifecycle operations, which left this one reporting
    # `pulled: false` for every entry on a DMR box, the serving model included.
    result = await build_eligible(
        manifest=manifest,
        detected_vram_gb=vram.detected_vram_gb(),
        runtime=runtime,
    )
    # WARP-195 finding 2: surface the resilient loader's fallback so a corrupt
    # manifest is observably degraded, not silently indistinguishable from
    # "no eligible models". Additive flag — existing callers are unaffected.
    result["degraded_manifest"] = degraded
    return result


async def _pull_streaming(
    runtime: InferenceRuntime,
    model: str,
    tracker: "LoadingTracker",
    *,
    wire_model: str | None = None,
) -> StreamingResponse:
    """Proxy the runtime's NDJSON pull-progress stream to the caller (WARP-1111 §7.1).

    Keeps ``LoadingTracker`` semantics exactly (add on start, remove on
    finish/error) — the chat pre-flight 503-while-loading guard depends on
    the model staying tracked for the *whole* pull, not just the handler's
    synchronous portion, so the removal happens in the generator's
    ``finally``, not the caller.

    Only the request-construction moved behind the adapter; the status-line,
    tracker and generator handling below are backend-independent and stay here.
    The runtime is passed in rather than re-resolved so the caller's 503 guard
    remains the single readiness check.
    """
    # WARP-2130: `model` is the CALLER's identifier and stays the tracker key —
    # the chat pre-flight guard is keyed on what a chat request names, not on
    # what we ask the registry for. `wire_model` is what goes to the daemon.
    try:
        upstream = await runtime.open_pull_stream(wire_model or model)
    except Exception as e:
        # Transport-level failure before any bytes arrived (connection
        # refused, DNS, etc.) — nothing was streamed, so map it to the same
        # 502 the non-streaming path uses rather than leaking as a bare 500,
        # and clear the tracker (there's no generator `finally` to do it here).
        await tracker.remove(model)
        raise HTTPException(status_code=502, detail=str(e))

    if upstream.status_code != 200:
        # Nothing was streamed yet — close non-2xx instead of committing to a
        # 200 streaming response (§7.1: "non-2xx close if nothing was
        # streamed yet").
        text = await upstream.aread()
        await upstream.aclose()
        await tracker.remove(model)
        raise HTTPException(status_code=upstream.status_code, detail=text.decode(errors="replace"))

    async def _gen():
        try:
            async for line in upstream.aiter_lines():
                if not line:
                    continue
                yield line + "\n"
        except Exception as e:
            # Mid-stream failure (network blip, upstream reset). The status
            # line is already committed to 200 at this point, so the only way
            # to surface the failure is a terminal NDJSON error line — never
            # silently truncate the stream.
            logger.error("pull_stream_failed", model=model, error=str(e))
            yield json.dumps({"status": "error", "error": str(e)}) + "\n"
        finally:
            await upstream.aclose()
            await tracker.remove(model)

    return StreamingResponse(_gen(), media_type="application/x-ndjson", status_code=200)


@app.post("/models/pull")
async def pull_model(body: PullRequest, request: Request, stream: bool = False):
    """Pull a single model into the inference runtime.

    ``?stream=true`` (or an ``Accept: application/x-ndjson`` header) opts
    into real-time NDJSON progress objects (``{status, digest, total,
    completed}``, as emitted by Ollama's own ``stream:true`` pull); the
    default stays the blocking form used by ``/models/sync`` and existing
    callers.
    """
    runtime = _runtime()
    if not runtime:
        raise HTTPException(status_code=503, detail="Not ready")

    # Disk preflight (WARP-1111 §7.2 / closes WARP-196): refuse to start a
    # pull that would exhaust the Ollama data volume. Looked up from the
    # manifest by name-or-pull_tag so an arbitrary/unlisted tag (unknown
    # disk_gb) skips the check rather than blocking indiscriminately.
    manifest, _degraded = load_manifest_resilient_with_status(MANIFEST_PATH)
    entry = manifest.by_identifier(body.model)
    disk_gb = entry.disk_gb if entry else None
    # WARP-2130 / ADR-005 §2: what the DAEMON is asked for. `body.model` is what
    # the caller addressed us with (a manifest `name` or a `pull_tag`); when the
    # entry declares an `oci` reference, that is the identifier this backend
    # must receive — it is the only form that carries a quantization tag through
    # `to_runtime_id`, which drops the tag off a bare Ollama id by design. An
    # unlisted model has no entry and therefore no declaration, so it keeps the
    # caller's identifier exactly as before. The adapter decides: on Ollama this
    # resolves to `pull_tag` unconditionally.
    wire_model = (
        runtime.preferred_id(entry.pull_tag, entry.oci) if entry else body.model
    )
    preflight = disk.check_disk_space(disk_gb)
    if preflight is not None and not preflight.ok:
        logger.warning(
            "pull_rejected_insufficient_disk",
            model=body.model,
            needed_gb=preflight.needed_gb,
            free_gb=preflight.free_gb,
        )
        raise HTTPException(
            status_code=409,
            detail={
                "error": "insufficient_disk",
                "needed_gb": round(preflight.needed_gb, 1),
                "free_gb": round(preflight.free_gb, 1),
            },
        )

    tracker: LoadingTracker = app.state.loading_tracker
    await tracker.add(body.model)
    logger.info("pulling_model", model=body.model)

    want_stream = stream or "application/x-ndjson" in (request.headers.get("accept") or "")
    if want_stream:
        # _pull_streaming owns tracker.remove() in its generator's `finally` —
        # the streamed response outlives this function's own try/finally.
        return await _pull_streaming(
            runtime, body.model, tracker, wire_model=wire_model
        )

    try:
        try:
            # The adapter performs the pull and raise_for_status; the error
            # mapping below is unchanged, and so is the response body — it is
            # built by runtime/base.py's `pulled_result` so both backends can
            # only ever answer this route with the same shape.
            await runtime.pull(wire_model)
            # WARP-2130: answer with the CALLER's identifier. `runtime.pull`
            # keys its result on whatever it was handed, and here it was handed
            # the translated wire id — but `pulled_result`'s contract is that
            # the `/models/*` response is "always the identifier the caller
            # supplied — never a backend-translated one". Rebuilding it here
            # keeps that true now that the two can differ by more than
            # to_runtime_id's derivation.
            return pulled_result(body.model)
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e))
    finally:
        await tracker.remove(body.model)
