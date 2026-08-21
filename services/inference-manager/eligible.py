"""/models/eligible: manifest entries filtered by detected VRAM, augmented with pulled state."""

from __future__ import annotations

from typing import Any

from manifest import Manifest
from runtime import InferenceRuntime


async def build_eligible(
    *,
    manifest: Manifest,
    detected_vram_gb: int,
    runtime: InferenceRuntime,
) -> dict[str, Any]:
    # LLM-006: distinguish "runtime unreachable" from "nothing pulled" — a
    # swallowed /api/tags error otherwise reports every model pulled:false,
    # triggering pointless re-pull decisions (same class WARP-193 fixed in
    # /models/sync). Surface a tags_unreachable flag like degraded_manifest.
    #
    # WARP-2129: this goes through the runtime ADAPTER, not a raw client. The
    # `/api/tags` ENDPOINT is field-for-field identical across backends
    # (ADR-005 §2) — but the IDENTIFIERS in its body are not, and this function
    # compares them. See `available` below.
    tags_unreachable = False
    try:
        installed = await runtime.list_installed()
        # WARP-2129: compare in the RUNTIME's vocabulary, not the manifest's —
        # the same reduction `/models/sync` has applied since WARP-1743, which
        # this endpoint was left out of. Under Ollama `comparable_id` is
        # identity, so this is bit-for-bit the string equality it always was.
        # Under DMR it folds `docker.io/ai/gpt-oss:20B-F16` and manifest
        # `gpt-oss:20b` onto one key; comparing raw strings there matched
        # nothing, so EVERY entry reported `pulled: false` — including the
        # model that was serving at the time.
        available = {
            runtime.comparable_id(m["name"]) for m in installed.get("models", [])
        }
    except Exception:
        available = set()
        tags_unreachable = True

    eligible = manifest.eligible(detected_vram_gb)
    return {
        "detected_vram_gb": detected_vram_gb,
        "tags_unreachable": tags_unreachable,
        "models": [
            {
                "name": m.name,
                # WARP-2129: the registry identifier, emitted separately from
                # the catalog `name` because they are different things and
                # differ on any entry that pins a quantization (manifest.py's
                # `by_identifier` accepts either). The orchestrator sends THIS
                # value to `POST /models/pull` (droplet-onboard-services
                # `routes/models.ts`); while the key was absent its parser read
                # `pull_tag: null` and silently fell back to `name`, which
                # addresses different weights.
                "pull_tag": m.pull_tag,
                "class": m.cls,
                "min_vram_gb": m.min_vram_gb,
                "pulled": runtime.comparable_id(m.name) in available,
                "default": m.default,
                # WARP-1111: catalog metadata for the fleet-console / dashboard
                # role pickers. Additive — existing callers that only read the
                # fields above are unaffected. All optional on the manifest
                # side (manifest.py), so an older/minimal entry still renders
                # (display_name falls back to name; the rest read as
                # null/empty rather than a missing key).
                "display_name": m.display_name,
                "maker": m.maker,
                "description": m.description,
                "capabilities": m.capabilities,
                "roles": m.roles,
                "disk_gb": m.disk_gb,
            }
            for m in eligible
        ],
    }
