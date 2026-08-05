"""Model capability resolution — which modalities a model supports.

The gateway is the source of truth for capabilities; the orchestrator reads
them off the models list to drive vision routing. Cloud models use a static
allow-list (their capabilities are stable per id); local models resolve
against a static per-model table first (WARP-1744) and fall back to an
`/api/show` probe, whose `capabilities` array reports `"vision"` / `"tools"`
for capable models (older daemons fall back to a family heuristic).
"""

from __future__ import annotations

from schemas import ModelCapabilities

# Cloud model ids (or id prefixes) that accept image input. Kept explicit
# rather than guessed — every entry is a model we've confirmed is multimodal.
_CLOUD_VISION_EXACT = {"gpt-4o", "gpt-4o-mini", "gpt-4-turbo"}
_CLOUD_VISION_PREFIX = (
    "gpt-4o",
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
    "claude-sonnet-4",
    "claude-3-7-sonnet",
)

# Ollama model families that indicate a vision projector when the daemon is too
# old to report a `capabilities` array.
_VISION_FAMILIES = {"clip", "mllama", "llava", "qwen2vl", "qwen2.5vl", "minicpmv"}


def cloud_capabilities(model: str) -> ModelCapabilities:
    """Capabilities for a hosted cloud model id. Cloud models are tool-capable."""
    vision = model in _CLOUD_VISION_EXACT or model.startswith(_CLOUD_VISION_PREFIX)
    return ModelCapabilities(vision=vision, tools=True)


# --- Static per-model capability table (WARP-1744) ---------------------------
#
# Capability is a property of the MODEL, not of the daemon serving it. gpt-oss
# emits harmony tool calls and llama3.2-vision reads images regardless of which
# HTTP server loaded the weights — so the answer should not change when the
# server does.
#
# Today it does. `/api/show`'s `capabilities` array is an Ollama extension.
# Docker Model Runner (DMR — the alternative local runtime evaluated in
# WARP-1740..1748) serves an Ollama-compatible `/api/show` at the same route
# with the same `details` block, but its response carries NO `capabilities`
# key at all (docker/model-runner v1.2.6, `pkg/ollama/api.go` /
# `pkg/ollama/http_handler.go`). Feed that response to
# `ollama_capabilities_from_show` below and `tools` is unconditionally False
# while `vision` silently degrades to the `details.families` heuristic — the
# same model, mis-reported, purely because a different daemon answered.
#
# So: state the capabilities for the ids this appliance actually configures
# here, once, and keep the probe as the fallback for everything else (a model
# a customer pulled that we've never heard of).
#
# UPSTREAM (read this before editing a row): the appliance's shipped model
# catalog — `droplet-local-LLM/models/model-manifest.json` — ALREADY declares a
# `capabilities` array per model, and it is the source of truth. The first
# block below mirrors it entry for entry; a manifest change is fixed THERE
# first and mirrored here, never the other way round. Wiring the manifest in as
# a live input (shipping it into this image, or serving it from
# ollama-manager) is deliberately out of scope for WARP-1744 — it is a
# cross-repo delivery problem, and the mirror is what makes the DMR path
# testable without a daemon in the meantime.
#
# The second block covers ids this repo configures that the manifest does not
# carry. Every one of those has its citation on the row. None are invented.
#
# NOTE (scope): `tools` remains INFORMATIONAL. The orchestrator owns tool
# dispatch (router.py:188 forwards `tools[]` untouched; ADR-011 / WARP-104),
# and nothing gates on this flag. Making it load-bearing is a behavior change
# with its own ticket — do not wire it into dispatch here.
_STATIC_CAPABILITY_ROWS: tuple[tuple[tuple[str, ...], ModelCapabilities], ...] = (
    # --- Mirrored from droplet-local-LLM/models/model-manifest.json ---------
    #
    # gpt-oss:20b — manifest :4-19, `"capabilities": ["tools", "thinking"]`
    # (:16), `"default": true`. Also THE single-box model in this repo:
    # `scripts/lib/single-box.sh:883` writes `LLM_MODEL=gpt-oss:20b`
    # (`docs/SINGLE_BOX.md:35`, `scripts/setup.sh:291`). `thinking` is not a
    # modality we model — ModelCapabilities carries vision/tools only.
    (
        ("gpt-oss", "gpt-oss:20b", "ai/gpt-oss"),
        ModelCapabilities(vision=False, tools=True),
    ),
    # llama3.2:3b — manifest :55-70, `"capabilities": ["tools"]`, the "fast"
    # role. Text-only tool caller.
    (
        ("llama3.2", "llama3.2:3b"),
        ModelCapabilities(vision=False, tools=True),
    ),
    # gemma4 — manifest :21-36 (26b) and :89-104 (31b), both
    # `"capabilities": ["vision", "tools"]`. One row: same family, same
    # modalities, only the VRAM gate differs.
    (
        ("gemma4", "gemma4:26b", "gemma4:31b"),
        ModelCapabilities(vision=True, tools=True),
    ),
    # qwen3-vl — manifest :38-53 (8b) and :72-87 (32b), both
    # `"capabilities": ["vision", "tools", "thinking"]`.
    (
        ("qwen3-vl", "qwen3-vl:8b", "qwen3-vl:32b"),
        ModelCapabilities(vision=True, tools=True),
    ),
    # --- Configured by THIS repo, absent from the manifest ------------------
    #
    # qwen2.5 — the voice assistant's configured model,
    # `docker/docker-compose.yml:1909`
    # (`LLM_MODEL=${LLM_MODEL:-qwen2.5:3b-instruct}` on voice-io).
    # `docs/LLM_AGENT.md:30` picks it precisely as a "tool-calling model" and
    # :191 names it the current default. Text-only.
    (
        ("qwen2.5", "qwen2.5:3b-instruct", "ai/qwen2.5"),
        ModelCapabilities(vision=False, tools=True),
    ),
    # llama3.2-vision — the documented local vision model for chat image
    # attachments, `.env.example:213` (`VISION_MODEL=llama3.2-vision:11b`).
    # Vision yes, tools no: Ollama reports `capabilities: ["completion",
    # "vision"]` for this family, and the orchestrator only ever routes an
    # image turn to it (never a tool turn). Distinct family from the
    # `llama3.2` row above — `llama3.2-vision:11b` strips to
    # `llama3.2-vision`, so the two never collide.
    (
        ("llama3.2-vision", "llama3.2-vision:11b"),
        ModelCapabilities(vision=True, tools=False),
    ),
    # llava — the other supported local vision tag, named in
    # `docs/superpowers/specs/2026-06-23-chat-image-vision-design.md:199` and
    # exercised as the vision model in
    # `apps/orchestrator/src/__tests__/vision-attachments.service.test.ts:47`.
    # Vision-only (it is also what the `_VISION_FAMILIES` heuristic below
    # catches by family, so the table just makes the answer exact).
    (
        ("llava", "llava:7b"),
        ModelCapabilities(vision=True, tools=False),
    ),
    # moondream — the caption-first VLM chosen in
    # `docs/ADR-003-rag-techniques-adoption.md:233` and scheduled for pre-pull
    # in :240. Ships untagged (`moondream`). Vision-only: it is a captioner,
    # it has no tool-calling surface.
    (
        ("moondream",),
        ModelCapabilities(vision=True, tools=False),
    ),
)

# Flattened lookup. Built from the rows above so a model's aliases stay
# visually attached to the citation that justifies them.
_STATIC_CAPABILITIES: dict[str, ModelCapabilities] = {
    model_id: caps for ids, caps in _STATIC_CAPABILITY_ROWS for model_id in ids
}


def _capability_lookup_keys(model: str) -> tuple[str, ...]:
    """Ordered lookup keys for a model id, most specific first.

    Local model ids arrive in three shapes and all three name the same
    weights:

    * Ollama tag         — ``gpt-oss:20b``
    * Ollama, registry-qualified — ``library/gpt-oss:20b``
    * DMR / OCI          — ``ai/gpt-oss`` (no tag; the namespace is the
      publisher)

    So we try the id as given, then without its registry/publisher namespace,
    then with the tag dropped. Dropping the tag is safe because the table is
    keyed on model FAMILY names (``gpt-oss``, ``llava``) — a differently-sized
    sibling (``gpt-oss:120b``) has identical modalities, while a genuinely
    different family (``llava-llama3:8b`` → ``llava-llama3``) does NOT collide
    and correctly falls through to the probe.
    """
    normalized = (model or "").strip().lower()
    if not normalized:
        return ()
    candidates = [normalized]
    # Strip an OCI-style namespace: `ai/gpt-oss` → `gpt-oss`,
    # `library/gpt-oss:20b` → `gpt-oss:20b`.
    unqualified = normalized.rpartition("/")[2]
    if unqualified and unqualified != normalized:
        candidates.append(unqualified)
    # Strip the Ollama tag: `gpt-oss:20b` → `gpt-oss`. DMR ids carry no tag,
    # so this is a no-op for them.
    for candidate in list(candidates):
        base = candidate.partition(":")[0]
        if base and base != candidate:
            candidates.append(base)
    seen: set[str] = set()
    ordered: list[str] = []
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)
    return tuple(ordered)


def static_capabilities(model: str) -> ModelCapabilities | None:
    """Capabilities for a model id we ship or reference, or None if unknown.

    Consulted BEFORE any network probe: capability is a property of the model,
    not of the daemon serving it, so a table entry is strictly better evidence
    than an answer whose completeness depends on which HTTP server happened to
    reply (see the DMR `/api/show` gap documented above the table).

    Returns None for anything not in the table — the caller then falls back to
    `/api/show` + `ollama_capabilities_from_show`, which is the right answer
    for a model a customer pulled themselves.

    The returned object is a COPY: the table entries are shared module state
    and `ModelCapabilities` is mutable, so a caller must never be able to
    edit the table by editing its result.
    """
    for key in _capability_lookup_keys(model):
        caps = _STATIC_CAPABILITIES.get(key)
        if caps is not None:
            return caps.model_copy()
    return None


def ollama_capabilities_from_show(show: dict) -> ModelCapabilities:
    """Map an Ollama `/api/show` response to capabilities.

    Prefers the explicit `capabilities` array; falls back to a `details.families`
    heuristic for daemons that don't report capabilities.

    WARP-1744 — the daemons that "don't report capabilities" are no longer only
    old Ollama builds. Docker Model Runner's Ollama-compatible `/api/show`
    NEVER emits the `capabilities` key, so every model it serves resolves here
    as `tools=False` plus a families-only vision guess. That degradation is
    deliberate and conservative (under-claiming a capability is safe; the
    orchestrator falls back to OCR for a model it believes can't see), but it
    is also why `static_capabilities()` exists and is consulted first.
    """
    caps = show.get("capabilities") or []
    families = ((show.get("details") or {}).get("families")) or []
    vision = ("vision" in caps) or any(f in _VISION_FAMILIES for f in families)
    tools = "tools" in caps
    return ModelCapabilities(vision=vision, tools=tools)
