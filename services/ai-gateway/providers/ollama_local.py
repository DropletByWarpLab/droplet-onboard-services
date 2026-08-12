"""Ollama provider — routes to the local Ollama instance.

Deployment-shape-aware: targets the bundled `ollama` container (single-box),
a separate Ollama host over LAN (multi-box), or a host-installed Ollama
(local dev) — driven entirely by OLLAMA_URL. The provider has no
opinion about the underlying hardware (discrete GPU, integrated GPU,
NPU, CPU fallback, etc.) — it just talks HTTP.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from collections.abc import AsyncGenerator

import httpx

from capabilities import ollama_capabilities_from_show, static_capabilities
from providers.base import BaseProvider
from request_context import get_request_id
from schemas import ChatMessage, ModelCapabilities, ModelInfo

logger = logging.getLogger(__name__)

# Canonical chat path: direct to Ollama (port 11434), NOT through
# ollama-manager's /proxy on :8002. ollama-manager owns model lifecycle
# (pull/delete/manifest) and exposes an OPT-IN /proxy that adds tool-call
# observability + JSON repair, but its 120s read timeout (TIMEOUT_PROXY
# in droplet-local-LLM/services/ollama-manager/timeouts.py) is too tight
# for the orchestrator's agent loop on CPU. The compose default below
# (`host.docker.internal:11434`) targets a host-installed Ollama for
# local Docker Desktop dev — note ai-gateway does not currently have the
# `extra_hosts: host.docker.internal:host-gateway` mapping, so this only
# resolves on Docker Desktop, not stock Linux. On the single-box PoC the
# orchestrator runs with OLLAMA_URL=http://droplet-ollama:11434 (the
# bundled Ollama container on the compose default network); on a
# multi-box deployment with a separate inference host, point at its
# static IP. Override via OLLAMA_URL to opt into the /proxy if you want
# the tool-call repair + circuit-breaker for a specific deploy.
# See ADR-004 in the droplet-local-LLM repo for the original rationale.
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://host.docker.internal:11434")

# XR-05: /health (the appliance limits + readiness contract) lives on the
# model-lifecycle manager (:8002), NOT on Ollama (:11434). On the canonical
# DIRECT chat path OLLAMA_URL points at :11434, so probing "{OLLAMA_URL}/health"
# 404s — the limits never size (outbound concurrency stuck at 1) and
# /ai/readiness is perpetually "degraded". INFERENCE_MANAGER_URL decouples the
# lifecycle/health endpoint from the chat endpoint. When it's unset AND
# OLLAMA_URL isn't the opt-in /proxy path (i.e. the manager isn't deployed —
# single-box today), we skip the probe entirely and run with sane default limits
# rather than spamming 404s. See droplet-local-LLM/services/ollama-manager (the
# /health owner).
#
# WARP-1748 — the variable was `OLLAMA_MANAGER_URL`. WARP-1743 turned that
# service into a runtime-AGNOSTIC model-lifecycle manager (runtime/{base,ollama,
# dmr,factory}.py, selected by INFERENCE_RUNTIME which defaults to `ollama`), so
# the `OLLAMA_` prefix now names an implementation detail instead of the
# contract — the same class of debt as a "poc"/"test" prefix on a shipping
# surface. INFERENCE_MANAGER_URL is the canonical name; the old one still works.
#
# 🔴 Why the old name MUST keep working: `OLLAMA_MANAGER_URL` is set in the .env
# of deployed boxes, and docker/docker-compose.yml wires the ai-gateway service
# with `env_file: ../.env` (see the ai-gateway block, docker-compose.yml:979-981)
# — so that key reaches this process verbatim on every appliance in the field. A
# rename that simply dropped it would break the appliance-limits probe
# everywhere, and it would fail SOFT (limits never size, outbound concurrency
# pinned at 1, /ai/readiness stuck "degraded") — strictly worse than failing
# loud, because nobody notices for weeks.
#
# The migration shape is copied verbatim from ADR-011's `JETSON_OLLAMA_URL` →
# `OLLAMA_URL` rename (docs/ADR-011-hardware-agnostic-codebase.md §"Decision"):
# read the new name, fall back to the old one with a logged deprecation warning,
# and delete the fallback in a follow-up once every provisioned box has
# migrated. Do NOT invent a different idiom for the next one.
_MANAGER_URL_ENV = "INFERENCE_MANAGER_URL"
_LEGACY_MANAGER_URL_ENV = "OLLAMA_MANAGER_URL"


def _resolve_manager_url() -> str | None:
    """Resolve the model-lifecycle manager root from the environment.

    Precedence (WARP-1748):
      1. ``INFERENCE_MANAGER_URL`` — the canonical name, wins outright.
      2. ``OLLAMA_MANAGER_URL`` — deprecated; honored with a WARNING so a
         field box that has not migrated its .env keeps sizing its limits.
      3. ``None`` — no manager wired. Unchanged from today; the caller falls
         through to the ``/proxy`` derivation and then to "skip the probe".

    An explicitly-EMPTY value counts as UNSET at every step. docker-compose
    passes optional settings through as ``${VAR:-}``, which delivers ``""``
    (not "unset") into the container — so a blank ``INFERENCE_MANAGER_URL``
    must not shadow a real legacy ``OLLAMA_MANAGER_URL``, and a blank legacy
    value must not defeat the default. Same defensive idiom as
    ``_resolve_chat_path`` below and router.py's LLM_MODEL read.

    No default is introduced and no default changes: "nothing configured"
    still resolves to ``None``.
    """
    canonical = (os.getenv(_MANAGER_URL_ENV) or "").strip()
    legacy = (os.getenv(_LEGACY_MANAGER_URL_ENV) or "").strip()

    if canonical:
        if legacy:
            # Both names present. The new one wins, but say so loudly: two
            # names for one endpoint is exactly how a box ends up probing a
            # stale manager after someone edits only the line they remember.
            # Values are deliberately NOT logged (an operator could embed
            # credentials in a URL) — the var names and the file are what
            # make this actionable.
            logger.warning(
                "%s and the deprecated %s are BOTH set — using %s and ignoring "
                "%s. Delete the %s line from the repo-root .env (the file "
                "docker/docker-compose.yml passes to ai-gateway via env_file) "
                "so the two cannot drift.",
                _MANAGER_URL_ENV,
                _LEGACY_MANAGER_URL_ENV,
                _MANAGER_URL_ENV,
                _LEGACY_MANAGER_URL_ENV,
                _LEGACY_MANAGER_URL_ENV,
            )
        return canonical

    if legacy:
        logger.warning(
            "%s is DEPRECATED — rename it to %s in the repo-root .env (the file "
            "docker/docker-compose.yml passes to ai-gateway via env_file), then "
            "restart the ai-gateway container. The service it points at became a "
            "runtime-agnostic model-lifecycle manager in WARP-1743 (INFERENCE_RUNTIME "
            "selects the backend), so the OLLAMA_ prefix names an implementation "
            "detail rather than the contract. Honoring the deprecated name for now; "
            "a future ticket removes this fallback once every deployed box has "
            "migrated.",
            _LEGACY_MANAGER_URL_ENV,
            _MANAGER_URL_ENV,
        )
        return legacy

    return None


# Resolved ONCE at import so the deprecation warning is emitted once per
# process, not once per health probe (mirrors ADR-011's import-time warn).
INFERENCE_MANAGER_URL = _resolve_manager_url()


def _resolve_manager_health_url(base_url: str) -> str | None:
    """Return the manager's /health URL, or None if no manager is wired.

    Precedence:
      1. explicit INFERENCE_MANAGER_URL (or the deprecated OLLAMA_MANAGER_URL
         — see `_resolve_manager_url`) → ``{manager}/health``
      2. OLLAMA_URL ending in ``/proxy`` (the opt-in manager chat path) →
         strip ``/proxy`` and use that root's ``/health`` (preserves the prior
         behavior for that specific deploy)
      3. otherwise None — the manager isn't deployed; skip the probe.
    """
    if INFERENCE_MANAGER_URL:
        return f"{INFERENCE_MANAGER_URL.rstrip('/')}/health"
    if base_url.endswith("/proxy"):
        return f"{base_url[: -len('/proxy')].rstrip('/')}/health"
    return None

# Cold-loading a large model can take 30-90s (e.g. 8B Q4 with partial GPU
# offload), and long completions can stream for minutes. The previous flat
# 60s timeout aborted the request mid-load, returning HTTP 499 to the user
# and an apparent "slow" chat. Override via OLLAMA_READ_TIMEOUT for slower
# hardware or larger models.
_READ_TIMEOUT_S = float(os.getenv("OLLAMA_READ_TIMEOUT", "300"))
_OLLAMA_TIMEOUT = httpx.Timeout(
    connect=10.0,
    read=_READ_TIMEOUT_S,
    write=30.0,
    pool=10.0,
)

# Upper bound on the httpx connection pool. The REAL concurrency gate is the
# in-flight semaphore (`_sema`), which is sized from the appliance's
# `num_parallel` and resized on a 503 scale-up. The connection pool only has to
# stay at-or-above whatever the semaphore admits, so we size it to a generous
# fixed cap rather than pinning it at construction-time `num_parallel` (which is
# 1 before the first /health refresh — the GW-13 bug, where a later scale-up
# resized the semaphore but left the pool serializing every chat through one
# connection). Connection reuse to a single Ollama host is cheap; an over-large
# cap costs nothing because the semaphore never lets that many requests run at
# once. Override for exotic deploys via OLLAMA_MAX_CONNECTIONS.
_MAX_CONNECTIONS = int(os.getenv("OLLAMA_MAX_CONNECTIONS", "64"))

# WARP-1284 (F2): per-request timeout for the /api/tags METADATA call in
# list_models. It must NOT ride the shared client's chat-sized read timeout
# (300s, see _OLLAMA_TIMEOUT above): degraded listings are never TTL-cached,
# so while Ollama is slow-not-down the wizard's 8s poll and the dashboard's
# 30s SWR re-run the listing — a hung /api/tags would pile those requests
# onto the shared connection pool that chat also uses. A healthy appliance
# answers /api/tags in milliseconds.
_TAGS_TIMEOUT_S = 5.0

# We ALWAYS talk to the daemon's OpenAI-compatible chat endpoint, never a
# native `/api/chat`. This keeps the request/response shape identical to the
# cloud providers (one code path in router.py) and is the canonical
# direct-to-:11434 contract. The body therefore uses OpenAI field names
# (top-level `temperature` / `max_tokens`); see the note in `chat()` (GW-12).
#
# WARP-1744: the PATH is configurable, the SHAPE is not. Ollama serves the
# OpenAI-compatible surface under `/v1/…`; Docker Model Runner (DMR — the
# alternative local runtime evaluated in WARP-1740..1748) serves the identical
# OpenAI surface under `/engines/v1/…`, i.e.
# `POST /engines/v1/chat/completions` (docker/model-runner v1.2.6). Same body,
# same response, different prefix — so a one-line path override is the whole
# delta, and nothing downstream of this constant has to know which daemon is
# on the other end.
#
# The default is the exact literal this provider has always used, so an unset
# OLLAMA_CHAT_PATH leaves every request byte-identical to pre-WARP-1744
# behavior.
#
# NOTE (verified live 2026-08-05 against docker/model-runner:v1.2.6): DMR
# serves the OpenAI surface at BOTH `/engines/v1/chat/completions` and the bare
# `/v1/chat/completions` — the bare path returns 200. So a DMR deployment does
# NOT have to set this at all; the default already works against it. This knob
# is kept for explicitness and for a future DMR that mounts only the prefixed
# form, not because the migration needs it. The desk analysis originally
# assumed the `/engines` prefix was mandatory; measurement said otherwise.
#
# The path is resolved RELATIVE to OLLAMA_URL, so it composes with the opt-in
# `/proxy` base the same way the hardcoded literal did.
_DEFAULT_CHAT_PATH = "/v1/chat/completions"


def _resolve_chat_path(raw: str | None) -> str:
    """Chat path from the raw env value, falling back to the Ollama default.

    An explicitly-EMPTY value falls back rather than posting to the daemon
    root: docker-compose.yml passes optional settings through as
    `${VAR:-}`, which delivers "" (not "unset") to the container, and an
    empty path would silently retarget every chat request. Same defensive
    idiom as `_resolve_manager_url` / router.py's LLM_MODEL read.
    """
    return (raw or "").strip() or _DEFAULT_CHAT_PATH


_CHAT_PATH = _resolve_chat_path(os.getenv("OLLAMA_CHAT_PATH"))

# WARP-1744 — is the static capability table allowed to answer?
#
# OFF by default, which makes the default path provably byte-identical: with
# the table disabled `_capabilities` is exactly the pre-WARP-1744 probe. It is
# switched on by the same `INFERENCE_RUNTIME=dmr` that selects the Docker Model
# Runner backend in droplet-local-LLM's ollama-manager (WARP-1743) — one word
# for the whole epic rather than a knob per service, so a box cannot end up
# half-migrated.
#
# Even when enabled the table never overrides a daemon that answered: see the
# gap-filler condition in `_capabilities`. The switch exists because three
# independent reviewers flagged an earlier table-first draft as a ships-dark
# violation, and "provably off" beats "argued to be equivalent".
def _resolve_inference_runtime(runtime: str | None = None, url: str | None = None) -> str:
    """The selected runtime, shouting when the configuration is incoherent.

    WARP-1870. `INFERENCE_RUNTIME` is read ONCE, at module import, by both
    module constants below, and it defaults to "ollama". On a DMR box that
    default is a silent trap: lose the variable — a compose `${VAR:-}` that
    resolves against the wrong env file, or a `docker restart`, which re-reads
    nothing at all (only `--force-recreate` does) — and both flags quietly flip
    off. Every DMR model then reports `tools=false` with no error anywhere, and
    the WARP-1839 grammar outage returns.

    The contradiction is cheap to spot: `OLLAMA_URL` still points at DMR.
    Runtime "ollama" plus a DMR chat URL cannot both be true, and the only way
    to reach it is a lost variable. Log it at ERROR rather than degrade in
    silence — a box serving without tools looks "up" from every angle except
    the one that matters.

    Returns the runtime string. Deliberately does NOT auto-correct: inferring
    the runtime from a URL would be its own guessing game, and an operator who
    genuinely wants Ollama against a DMR-shaped URL deserves to be obeyed and
    warned, not overridden.
    """
    resolved = (runtime if runtime is not None else os.getenv("INFERENCE_RUNTIME", "ollama"))
    resolved = (resolved or "").strip().lower() or "ollama"
    chat_url = (url if url is not None else OLLAMA_URL) or ""
    looks_like_dmr = "dmr" in chat_url.lower() or ":12434" in chat_url
    if resolved != "dmr" and looks_like_dmr:
        logger.error(
            "INFERENCE_RUNTIME=%r but OLLAMA_URL=%r points at the Docker Model "
            "Runner. The runtime variable was almost certainly lost (a compose "
            "${VAR:-} resolving against the wrong env file, or a `docker "
            "restart`, which re-reads nothing — use --force-recreate). Serving "
            "with DMR support OFF: every model will report tools=false and "
            "tool schemas will not be grammar-stripped (WARP-1839).",
            resolved,
            chat_url,
        )
    return resolved


_STATIC_CAPABILITY_TABLE = _resolve_inference_runtime() == "dmr"

# WARP-1839 — grammar-safe tool schemas for the DMR runtime.
#
# llama.cpp (DMR's inference backend) compiles the request's `tools` JSON
# schemas into a GBNF grammar for constrained tool-call decoding, and bounded
# schema keywords (`minLength`/`maxLength`, `minItems`/`maxItems`, `pattern`,
# `format`) expand into repeated rule copies at grammar-build time. One real
# tool — `memory_extract_fact`, whose `fact` field carries `maxLength: 2000` —
# multiplies past llama.cpp's "sane defaults" repetition guard, the sampler
# fails to initialize, and the whole request 400s ("Failed to initialize
# samplers: failed to parse grammar"). With the full catalog attached that
# meant EVERY tools-bearing chat on the box failed. Ollama does not
# grammar-constrain tool calls, so the identical catalog worked before the
# flip; the WARP-1839 bisect on the live box pins all of this.
#
# Same gate word as the capability table above, for the same reason: with the
# flag off the ollama wire shape stays provably byte-identical (rollback stays
# honest), and one env word migrates the whole box.
#
# Nothing is lost by stripping: tools-core handlers re-validate these bounds
# at execution time (memory/extract.ts rejects >2000-char facts with
# INVALID_ARGS), which is exactly where they were enforced under Ollama too —
# the model never saw grammar-enforced bounds before the flip either.
_GRAMMAR_SAFE_TOOL_SCHEMAS = _resolve_inference_runtime() == "dmr"

# JSON Schema keywords that generate bounded repetitions in llama.cpp's
# json-schema→GBNF conversion. `format` is included because llama.cpp expands
# known formats (date-time, uuid, …) into pattern-like bounded grammars.
_GRAMMAR_UNSAFE_KEYWORDS = frozenset(
    {"pattern", "format", "minLength", "maxLength", "minItems", "maxItems"}
)

# Keys whose values are maps of NAMES to subschemas — a child key here is a
# property/definition name, never a schema keyword. The catalog really does
# ship a tool (`regex_test`) with a property literally named `pattern`; it
# must survive sanitization.
_SCHEMA_NAME_MAPS = frozenset(
    {"properties", "patternProperties", "$defs", "definitions"}
)

# Keys whose values are DATA, not schema — never recursed into (an enum
# member or default object could legitimately contain a key named
# `maxLength`) and never stripped.
_SCHEMA_DATA_KEYS = frozenset({"enum", "const", "default", "examples"})


def _strip_grammar_unsafe(schema: object) -> object:
    """Return ``schema`` minus grammar-unsafe keywords, recursively."""
    if isinstance(schema, list):
        return [_strip_grammar_unsafe(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    out: dict = {}
    for key, value in schema.items():
        if key in _GRAMMAR_UNSAFE_KEYWORDS:
            continue
        if key in _SCHEMA_DATA_KEYS:
            out[key] = value
        elif key in _SCHEMA_NAME_MAPS and isinstance(value, dict):
            out[key] = {
                name: _strip_grammar_unsafe(sub) for name, sub in value.items()
            }
        else:
            out[key] = _strip_grammar_unsafe(value)
    return out


def grammar_safe_tools(tools: list) -> list:
    """Sanitize OpenAI-format tool definitions for a grammar-compiling runtime.

    Only ``function.parameters`` is rewritten — that is the sole input to
    llama.cpp's grammar builder. Names and descriptions pass through, and the
    caller's dicts are never mutated in place.
    """
    safe: list = []
    for tool in tools:
        fn = tool.get("function") if isinstance(tool, dict) else None
        if isinstance(fn, dict) and "parameters" in fn:
            safe.append(
                {
                    **tool,
                    "function": {
                        **fn,
                        "parameters": _strip_grammar_unsafe(fn["parameters"]),
                    },
                }
            )
        else:
            safe.append(tool)
    return safe


# WARP-1333: gpt-oss's harmony parser intermittently 500s when the model
# emits a tool call whose function name carries channel tokens
# (harmonyparser.go "no reverse mapping found for function name"); the
# identical retry succeeds. Bounded retry budget for that tool-call path.
# WARP-1606 puts the STREAMING path on the same budget (pre-first-byte
# only — see the boundary note in _stream_chat).
_HARMONY_500_RETRIES = 2
_HARMONY_500_BACKOFF_S = 0.5


def _log_harmony_500_retry(path: str, attempt: int, attempts: int) -> None:
    """Emit the one harmony-500 retry event shared by both chat paths.

    WARP-1606: both the blocking and the streaming branch log through here so
    the flake stays observable under a SINGLE event token
    (``harmony_500_retry``, the field the WARP-1333 log-based counting already
    keys on), with a ``path=blocking|streaming`` label to tell them apart.
    ``attempt`` is 1-based and counts the attempt that just failed.
    """
    logger.warning(
        "harmony_500_retry: path=%s POST %s returned 500 "
        "(attempt %d/%d) — retrying",
        path, _CHAT_PATH, attempt, attempts,
    )


class _LimitsCache:
    """Tiny cache of the appliance's /health.limits — refreshed on 503 or on init.

    The inference layer exposes its Ollama queue limits via /health so the
    orchestrator can size outbound concurrency. We debounce refreshes so a
    burst of 503s doesn't hammer /health.

    Schema-version awareness (WARP-284):

    The appliance ships ``schema_version`` as a top-level integer in the
    /health response. This class carries ``_KNOWN_SCHEMA_VERSION`` — the
    version this orchestrator was built against — and logs a structured
    warning whenever the live appliance's version differs:

    * absent: pre-WARP-284 appliance — log warning, fall back to existing
      behavior (read limits by name).
    * equal: silent. Happy path.
    * newer: log warning. The appliance has been updated; the orchestrator
      may be ignoring new fields. Update ``_KNOWN_SCHEMA_VERSION`` and any
      consumers, then redeploy.
    * older: log warning. The appliance is on stale code; pull and
      re-run setup.sh on it.

    The point is forward compatibility — we never hard-fail on version
    mismatch, so a planned appliance bump can roll out independently. The
    warning log is the canary; until the shared-contracts package lands
    (audit option B) this is the cheapest drift detector available.
    """

    # Version of the /health schema this code knows. Bump in lockstep with
    # ``services/inference-manager/main.py::_HEALTH_SCHEMA_VERSION`` in the
    # appliance repo. See ``droplet-local-LLM/docs/model-management.md``
    # for the canonical schema-history table.
    # v2 (WARP-1825/1826): appliance added the `placement` GPU-residency
    # block. This cache still only consumes `limits`; the placement block
    # is read by the orchestrator's model metrics path, not here.
    _KNOWN_SCHEMA_VERSION = 2

    # Sentinel for "we haven't observed a schema_version yet" — distinct
    # from None ("appliance returned no schema_version key"). Without this,
    # the first observation of a missing key would silently equal the
    # initial state and skip the warning log.
    _SCHEMA_VERSION_UNOBSERVED = object()

    def __init__(self, base_url: str):
        self.base_url = base_url
        self.num_parallel = 1
        self.max_queue = 16
        self.max_loaded_models = 1
        self._last_refresh = 0.0
        self._refresh_min_interval = 30.0  # seconds; debounce
        # XR-05: the ollama-manager /health URL, or None when no manager is
        # deployed (the direct :11434 path). None → skip the probe + keep
        # default limits instead of 404-ing against Ollama.
        self._manager_health_url: str | None = _resolve_manager_health_url(base_url)
        # Logged-once flag so a no-manager deploy notes the skip a single time
        # rather than on every refresh attempt.
        self._logged_no_manager = False
        # Track the last observed schema version so we only log on each new
        # observation, not on every refresh while the version is "wrong".
        # Starts at a sentinel distinct from None so a missing version key
        # is correctly detected as a first observation.
        self._last_seen_schema_version: object = self._SCHEMA_VERSION_UNOBSERVED

    @property
    def health_url(self) -> str | None:
        """ollama-manager's /health URL, or None when no manager is wired."""
        return self._manager_health_url

    def _check_schema_version(self, body: dict) -> None:
        """Compare the appliance's schema_version against what we know.

        Logs a warning on first observation of any non-equal version. Silent
        on subsequent refreshes that observe the same version, so a long-lived
        appliance/orchestrator pair on different versions doesn't spam.
        """
        observed = body.get("schema_version")
        if observed == self._last_seen_schema_version:
            return  # already logged (or already silent on equal)
        self._last_seen_schema_version = observed

        if observed is None:
            logger.warning(
                "appliance_schema_version_missing: pre-WARP-284 appliance "
                "(known=%d). Reading limits by name; redeploy the appliance "
                "to pick up the versioned contract.",
                self._KNOWN_SCHEMA_VERSION,
            )
            return
        if not isinstance(observed, int):
            logger.warning(
                "appliance_schema_version_invalid: got %r, expected int",
                observed,
            )
            return
        if observed == self._KNOWN_SCHEMA_VERSION:
            return  # happy path — silent
        if observed > self._KNOWN_SCHEMA_VERSION:
            logger.warning(
                "appliance_schema_version_newer_than_known: "
                "appliance=%d orchestrator=%d. The appliance has been "
                "updated; the orchestrator may be ignoring new /health "
                "fields. Bump _KNOWN_SCHEMA_VERSION in ollama_local.py "
                "and any consumers.",
                observed,
                self._KNOWN_SCHEMA_VERSION,
            )
            return
        logger.warning(
            "appliance_schema_version_older_than_known: "
            "appliance=%d orchestrator=%d. The appliance is on stale "
            "code; pull and re-run setup.sh on the inference host.",
            observed,
            self._KNOWN_SCHEMA_VERSION,
        )

    async def refresh(self, client: httpx.AsyncClient) -> None:
        now = time.monotonic()
        if now - self._last_refresh < self._refresh_min_interval:
            return
        self._last_refresh = now
        # XR-05: no ollama-manager wired (direct :11434 path) → don't probe a
        # non-existent /health on Ollama. Keep the sane defaults and note it
        # once. Marking _last_refresh above means _ensure_limits treats limits
        # as "settled" (at defaults) and won't retry every call.
        health_url = self.health_url
        if health_url is None:
            if not self._logged_no_manager:
                self._logged_no_manager = True
                # WARP-1748: names the CANONICAL var. An operator who still has
                # the deprecated OLLAMA_MANAGER_URL set never reaches this line
                # (health_url is non-None), so pointing them at the new name
                # here can't strand anyone.
                logger.info(
                    "appliance_limits_probe_skipped: no INFERENCE_MANAGER_URL and "
                    "OLLAMA_URL is the direct path — using default limits "
                    "(num_parallel=%d, max_queue=%d, max_loaded_models=%d). "
                    "Set INFERENCE_MANAGER_URL to size outbound concurrency.",
                    self.num_parallel,
                    self.max_queue,
                    self.max_loaded_models,
                )
            return
        try:
            resp = await client.get(health_url, timeout=5.0)
            if resp.status_code == 200:
                body = resp.json()
                self._check_schema_version(body)
                limits = body.get("limits") or {}
                self.num_parallel = int(limits.get("num_parallel", self.num_parallel))
                self.max_queue = int(limits.get("max_queue", self.max_queue))
                self.max_loaded_models = int(
                    limits.get("max_loaded_models", self.max_loaded_models)
                )
                logger.info(
                    "appliance_limits_refreshed: num_parallel=%d max_queue=%d max_loaded_models=%d",
                    self.num_parallel,
                    self.max_queue,
                    self.max_loaded_models,
                )
        except Exception as e:
            logger.warning("appliance_limits_refresh_failed: %s", e)


def prettify_model_name(raw: str) -> str:
    """Turn a local model id into a display name.

    'llama3.1:8b'                   -> 'Llama 3.1 8B'
    'docker.io/ai/gpt-oss:20B-F16'  -> 'Gpt-oss 20B F16'

    Other providers already return curated display names (e.g. 'Claude Sonnet 4');
    the local runtimes return raw ids, so match the convention at the provider
    edge.

    WARP-1926 — the registry path must be stripped FIRST. Ollama ids are bare
    tags (`llama3.1:8b`), but Docker Model Runner reports FULLY QUALIFIED OCI
    references, and this function used to title-case the whole thing: the box's
    own model rendered as **'Docker.io/ai/gpt-oss 20B F16'** in the chat picker,
    the models page and the setup wizard. Only the last path segment is a model
    name; everything before the final `/` is registry host + namespace, which
    carries no display information (the unique id is kept separately in
    `ModelInfo.id`, so nothing is lost).
    """
    # Registry host / namespace -> drop. `rsplit` is safe for a bare Ollama tag
    # (no slash -> unchanged) and for a port-bearing host (`localhost:5000/ai/x`
    # -> `x`), because the split is on `/` and the tag is parsed AFTER it.
    raw = raw.rsplit("/", 1)[-1]
    base, _, tag = raw.partition(":")
    base_spaced = re.sub(r"([A-Za-z])(\d)", r"\1 \2", base)
    base_pretty = " ".join(
        part[:1].upper() + part[1:] if part and part[0].isalpha() else part
        for part in base_spaced.split()
    )
    if not tag:
        return base_pretty
    # Tag fragments: size first (uppercased), then any '-instruct'-style qualifiers.
    size, *qualifiers = tag.split("-")
    tag_pretty = size.upper() + "".join(
        f" {q[:1].upper() + q[1:]}" for q in qualifiers if q
    )
    return f"{base_pretty} {tag_pretty}".strip()


# WARP-1442: the model families that honor a `reasoning_effort` control on
# Ollama's OpenAI-compat endpoint. Today that's OpenAI's open-weights gpt-oss
# family (the single-box default, gpt-oss:20b) — its harmony format maps a
# top-level `reasoning_effort` to the "Reasoning: <level>" directive. Match on
# a substring so registry-prefixed tags (e.g. "library/gpt-oss:20b") still
# resolve. Kept as a tuple so a future reasoning family is a one-line add.
_REASONING_MODEL_MARKERS = ("gpt-oss",)


def model_supports_reasoning_effort(model: str) -> bool:
    """True when `model` belongs to a family that honors `reasoning_effort`.

    The knob is deliberately scoped to this set rather than passed through
    blindly: a non-reasoning model (llama/mistral/…) served on the same
    OpenAI-compat endpoint would otherwise receive a field it doesn't
    understand, risking a 400. Guarding here keeps every non-gpt-oss request
    byte-for-byte unchanged.
    """
    m = model.lower()
    return any(marker in m for marker in _REASONING_MODEL_MARKERS)


class OllamaLocalProvider(BaseProvider):
    """Provider for the local Ollama instance.

    Endpoint is configured via OLLAMA_URL; works against the bundled
    `ollama` compose service (single-box), a separate inference host
    over LAN (multi-box), or a host-installed Ollama (local dev).
    """

    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or OLLAMA_URL).rstrip("/")
        self._limits = _LimitsCache(self.base_url)
        self._sema: asyncio.Semaphore | None = None
        # Track the size used to construct the current `_sema`. asyncio.Semaphore
        # only exposes the private CPython attr `_value` (current free slots,
        # not the original size), which can't be relied on for resize decisions
        # mid-flight or across Python versions. We keep our own copy.
        self._sema_size: int = 0
        # Connection pool is sized to a generous fixed cap, NOT to
        # `num_parallel`. The in-flight semaphore (`_sema`, resized on scale-up)
        # is the authoritative concurrency limit; the pool just has to stay at
        # or above it. Pinning the pool at construction-time `num_parallel` (1,
        # pre-first-refresh) was GW-13: a later semaphore resize was defeated
        # because httpx still serialized every chat through a single connection.
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=_OLLAMA_TIMEOUT,
            limits=httpx.Limits(max_connections=_MAX_CONNECTIONS),
        )
        # Per-model capability cache (vision/tools). Model capabilities are
        # immutable for a given tag, so we resolve once per id (static table,
        # else an `/api/show` probe — see _capabilities) and reuse the result
        # across list_models calls.
        self._caps_cache: dict[str, ModelCapabilities | None] = {}

    def _build_sema(self, num_parallel: int) -> None:
        """(Re)build the in-flight semaphore at the requested size."""
        size = max(1, num_parallel)
        self._sema = asyncio.Semaphore(size)
        self._sema_size = size

    async def _handle_appliance_503(self, retry_after: str, body_preview: str) -> None:
        """Shared 503 handler for both streaming and non-streaming chat paths.

        The appliance signals overload via 503 (model_loading, circuit_open, or
        queue full). Refresh ``/health`` so we pick up the current
        ``num_parallel``, and rebuild the semaphore if it changed so subsequent
        calls match the appliance's new slot count.

        Both ``chat()`` (non-streaming) and ``_stream_chat()`` MUST go through
        this so the streaming path doesn't silently miss a scale-up event
        (silver-tier review issue I-4).
        """
        await self._limits.refresh(self.client)
        if self._sema_size != self._limits.num_parallel:
            self._build_sema(self._limits.num_parallel)
        logger.warning(
            "appliance_503_received: retry_after=%s body=%s",
            retry_after,
            body_preview,
        )

    async def _ensure_limits(self) -> None:
        """Lazy first-call refresh of the appliance's limits + semaphore creation."""
        if self._limits._last_refresh > 0:
            if self._sema is None:
                self._build_sema(self._limits.num_parallel)
            return
        await self._limits.refresh(self.client)
        if self._sema is None:
            self._build_sema(self._limits.num_parallel)

    async def _capabilities(self, model: str) -> ModelCapabilities | None:
        """Capabilities for a local model id, cached per id.

        WARP-1744 — resolution order is `/api/show` probe FIRST, then the
        static table strictly as a GAP-FILLER:

        1. The best-effort ``/api/show`` probe, exactly as before. When the
           daemon returns a ``capabilities`` array its answer wins outright.
           Ollama reports that array, so on a stock appliance this method is
           byte-identical to pre-WARP-1744 behavior: same POST, same parse,
           same result, and step 2 is never reached.
        2. ``capabilities.static_capabilities``, consulted ONLY when the probe
           came back without a ``capabilities`` array (or failed outright) AND
           the table is enabled. That is the Docker Model Runner case: verified
           live on 2026-08-05 against ``docker/model-runner:v1.2.6``, DMR's
           Ollama-compatible ``/api/show`` returns ``details`` and nothing else,
           so ``ollama_capabilities_from_show`` degrades to ``tools=False`` for
           every model and ``vision`` to the ``details.families`` heuristic.

        The probe-first order matters. An earlier draft consulted the table
        first, which skipped the ``/api/show`` POST entirely for known ids and
        changed the reported value for any sparse-``/api/show`` daemon — a live
        behavior change on the default path, i.e. not dark. Capability really
        is a property of the model rather than of the daemon, but acting on
        that belief has to wait for the runtime it was written for.

        Returns None when the daemon is unreachable AND the table is disabled
        or has no row — callers treat unknown capabilities conservatively
        (non-vision → OCR fallback).
        """
        if model in self._caps_cache:
            return self._caps_cache[model]
        caps: ModelCapabilities | None = None
        show: dict | None = None
        try:
            resp = await self.client.post("/api/show", json={"model": model})
            resp.raise_for_status()
            show = resp.json()
            caps = ollama_capabilities_from_show(show)
        except Exception as e:  # noqa: BLE001 — probe is best-effort
            logger.debug("ollama /api/show failed for %s: %s", model, e)
        # Gap-filler only. `show is None` = probe failed; a show without
        # `capabilities` = a daemon that cannot answer the question (DMR).
        # Both are cases where today's answer is a guess, never cases where
        # we are overriding a daemon that DID answer.
        if _STATIC_CAPABILITY_TABLE and (show is None or "capabilities" not in show):
            tabled = static_capabilities(model)
            if tabled is not None:
                caps = tabled
        self._caps_cache[model] = caps
        return caps

    async def list_models(self) -> list[ModelInfo]:
        """List the locally pulled models via /api/tags.

        WARP-1284 (F1): transport/HTTP failures PROPAGATE instead of being
        swallowed into `return []`. The router fan-out (list_all_models —
        the only production caller) classifies the raise into
        `degraded_providers` via asyncio.gather(return_exceptions=True), so
        a dead Ollama is distinguishable from an empty registry. The old
        swallow made that signal dead code: the wizard showed "model still
        downloading" for an unreachable AI service. A REACHABLE Ollama with
        no models pulled yet (first boot) still returns [] — that is the
        one honest empty-list case.

        The tags GET uses a short per-request timeout (_TAGS_TIMEOUT_S):
        it's a metadata call and must not hold a shared-pool connection for
        the chat-sized 300s read timeout while Ollama is slow-not-down.
        """
        resp = await self.client.get("/api/tags", timeout=_TAGS_TIMEOUT_S)
        resp.raise_for_status()
        data = resp.json()
        out: list[ModelInfo] = []
        for m in data.get("models", []):
            name = m["name"]
            out.append(
                ModelInfo(
                    id=name,
                    # WARP-1926: `local` names WHERE inference runs, not which
                    # daemon serves it. Was `ollama`, which became a lie the
                    # day DMR shipped as the default runtime (WARP-1870) —
                    # this endpoint reported `ollama` while Docker Model
                    # Runner served every token.
                    provider="local",
                    name=prettify_model_name(name),
                    context_window=None,
                    capabilities=await self._capabilities(name),
                )
            )
        return out

    async def chat(
        self, messages: list[ChatMessage], model: str, stream: bool = False, **kwargs
    ) -> dict | AsyncGenerator[str, None]:
        await self._ensure_limits()
        body = {
            "model": model,
            "messages": [m.model_dump(exclude_none=True) for m in messages],
            "stream": stream,
        }
        has_tools = bool(kwargs.get("tools"))
        # When tools are present, default temperature=0 so tool-call output is stable.
        if has_tools and kwargs.get("temperature") is None:
            body["temperature"] = 0.0
        # Pass through supported generation controls (caller's explicit value
        # overrides our default).
        #
        # GW-12: these are OpenAI-compat field names — `temperature` and
        # `max_tokens` at the TOP LEVEL — which is correct because we always
        # POST to Ollama's OpenAI-compat `/v1/chat/completions` (see
        # _CHAT_PATH and the direct-to-:11434 rule in this module's header).
        # Ollama's NATIVE `/api/chat` ignores these top-level keys and instead
        # reads `options.{temperature,num_predict}`, so `max_tokens` would
        # silently become a no-op there. We deliberately do NOT support the
        # native endpoint; if that ever changes, map max_tokens→
        # options.num_predict and temperature→options.temperature here rather
        # than dropping them.
        for k in ("temperature", "max_tokens"):
            if kwargs.get(k) is not None:
                body[k] = kwargs[k]
        # WARP-1442 — reasoning-effort control. Set as a TOP-LEVEL field on the
        # OpenAI-compat body (same shape/rationale as temperature/max_tokens in
        # the GW-12 note above — we always POST to /v1/chat/completions). Ollama
        # maps `reasoning_effort` to gpt-oss's harmony "Reasoning: <level>"
        # directive, trimming the inaudible reasoning-token overhead on short
        # replies (the voice principal defaults this to "low" server-side in the
        # orchestrator). Guarded to the gpt-oss family so a non-reasoning model's
        # request stays byte-for-byte unchanged; unset → the field is never added.
        reasoning_effort = kwargs.get("reasoning_effort")
        if reasoning_effort is not None and model_supports_reasoning_effort(model):
            body["reasoning_effort"] = reasoning_effort
        if has_tools:
            tools_payload = [
                t.model_dump() if hasattr(t, "model_dump") else t
                for t in kwargs["tools"]
            ]
            # WARP-1839: DMR's llama.cpp compiles these schemas into a GBNF
            # grammar and bounded keywords blow its complexity guard — see
            # _GRAMMAR_SAFE_TOOL_SCHEMAS above.
            if _GRAMMAR_SAFE_TOOL_SCHEMAS:
                tools_payload = grammar_safe_tools(tools_payload)
            body["tools"] = tools_payload

        if not stream:
            rid = get_request_id()
            headers = {"x-request-id": rid} if rid else None
            assert self._sema is not None  # set by _ensure_limits
            # WARP-1333: only the tool-call path hits the harmony flake, and
            # every agent-loop step passes through here — retry transient
            # 500s when tools are present, re-acquiring the semaphore per
            # attempt so concurrency limits stay honest. A 500 without tools
            # (or one that persists past the budget) is a real error.
            attempts = (_HARMONY_500_RETRIES + 1) if has_tools else 1
            for attempt in range(attempts):
                async with self._sema:
                    resp = await self.client.post(
                        _CHAT_PATH, json=body, headers=headers
                    )
                if resp.status_code == 500 and attempt < attempts - 1:
                    _log_harmony_500_retry("blocking", attempt + 1, attempts)
                    await asyncio.sleep(_HARMONY_500_BACKOFF_S * (attempt + 1))
                    continue
                break
            if resp.status_code == 503:
                # Appliance overload (model_loading / circuit_open / queue full).
                # Refresh limits + rebuild sema, then bubble up so the caller can
                # honor Retry-After and decide whether to retry.
                await self._handle_appliance_503(
                    resp.headers.get("Retry-After", "30"),
                    resp.text[:200],
                )
            resp.raise_for_status()
            return resp.json()

        return self._stream_chat(body)

    async def _stream_chat(self, body: dict) -> AsyncGenerator[str, None]:
        """Stream Ollama's SSE frames through verbatim.

        WARP-1606 — harmony-500 retry, and where it STOPS. Streaming is the
        shipped dashboard path (WARP-1442), so it runs the same bounded
        WARP-1333 retry the blocking branch does: same budget, same backoff,
        tools-present only. The boundary is that a retry is only legal
        BEFORE the first frame has been yielded — once the caller has a delta
        in hand it has already been appended to the assistant turn (and, on
        /ai/chat, flushed to the client), so replaying the request would
        duplicate every delta emitted so far.

        That boundary is structural, not a heuristic: the status code arrives
        with the response HEADERS, so the retry decision below is taken before
        the `async for` that yields anything. Anything that fails LATER —
        a mid-stream connection reset, a truncated body, a 200 that dies
        halfway — is raised from inside that loop and propagates straight out
        of this generator, exactly as it did before WARP-1606. Never move the
        retry decision below the yield loop.
        """
        # Streaming path is also semaphore-gated so we don't exceed num_parallel.
        rid = get_request_id()
        headers = {"x-request-id": rid} if rid else None
        assert self._sema is not None  # set by _ensure_limits in chat()
        # Same tools-present condition as the blocking branch: a 500 without
        # tools isn't the harmony flake, so it stays a real error. `body` is
        # what chat() built, so the tools key is the authoritative signal.
        has_tools = bool(body.get("tools"))
        attempts = (_HARMONY_500_RETRIES + 1) if has_tools else 1
        for attempt in range(attempts):
            async with self._sema:
                async with self.client.stream(
                    "POST", _CHAT_PATH, json=body, headers=headers
                ) as resp:
                    retryable_500 = (
                        resp.status_code == 500 and attempt < attempts - 1
                    )
                    if not retryable_500:
                        if resp.status_code == 503:
                            # Same handler the non-streaming branch uses, so a
                            # scale-up signaled via 503 is not silently missed
                            # here (I-4). 503 never enters the 500 retry loop.
                            body_preview = (await resp.aread()).decode(
                                errors="replace"
                            )[:200]
                            await self._handle_appliance_503(
                                resp.headers.get("Retry-After", "30"),
                                body_preview,
                            )
                        resp.raise_for_status()
                        async for line in resp.aiter_lines():
                            if line.startswith("data: "):
                                yield f"{line}\n\n"
                        return
                    # Retryable harmony 500, and nothing has been yielded yet:
                    # the retry is invisible to the caller. Drain the error body
                    # so the connection goes back to the pool.
                    await resp.aread()
                    _log_harmony_500_retry("streaming", attempt + 1, attempts)
            # Back off OUTSIDE the semaphore, and re-acquire it per attempt, so
            # a retrying stream doesn't hold a concurrency slot while it waits
            # (mirrors the blocking branch).
            await asyncio.sleep(_HARMONY_500_BACKOFF_S * (attempt + 1))

    async def is_reachable(self) -> bool:
        try:
            resp = await self.client.get("/api/tags", timeout=3.0)
            return resp.status_code == 200
        except Exception:
            return False

    async def close(self):
        await self.client.aclose()
