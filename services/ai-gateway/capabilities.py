"""Model capability resolution — which modalities a model supports.

The gateway is the source of truth for capabilities; the orchestrator reads
them off the models list to drive vision routing. Cloud models use a static
allow-list (their capabilities are stable per id); local Ollama models are
probed via `/api/show`, whose `capabilities` array reports `"vision"` /
`"tools"` for capable models (older daemons fall back to a family heuristic).
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


def ollama_capabilities_from_show(show: dict) -> ModelCapabilities:
    """Map an Ollama `/api/show` response to capabilities.

    Prefers the explicit `capabilities` array; falls back to a `details.families`
    heuristic for daemons that don't report capabilities.
    """
    caps = show.get("capabilities") or []
    families = ((show.get("details") or {}).get("families")) or []
    vision = ("vision" in caps) or any(f in _VISION_FAMILIES for f in families)
    tools = "tools" in caps
    return ModelCapabilities(vision=vision, tools=tools)
