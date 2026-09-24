"""/models/eligible: manifest entries filtered by detected VRAM, augmented with pulled state."""

from __future__ import annotations

from typing import Any

from manifest import Manifest, ManifestEntry
from runtime import InferenceRuntime


async def build_eligible(
    *,
    manifest: Manifest,
    detected_vram_gb: int | None,
    runtime: InferenceRuntime,
    vram_source: str | None = None,
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
        reported = [m["name"] for m in installed.get("models", [])]
        # WARP-2129: compare in the RUNTIME's vocabulary, not the manifest's —
        # the same reduction `/models/sync` has applied since WARP-1743, which
        # this endpoint was left out of. Under Ollama `comparable_id` is
        # identity, so this is bit-for-bit the string equality it always was.
        # Under DMR it folds `docker.io/ai/gpt-oss:20B-F16` and manifest
        # `gpt-oss:20b` onto one key; comparing raw strings there matched
        # nothing, so EVERY entry reported `pulled: false` — including the
        # model that was serving at the time.
        available = {runtime.comparable_id(name) for name in reported}
        # WARP-3046: the tag-exact twin of `available`, for entries that pin a
        # build (see `_is_pulled`). Empty under Ollama, whose ids pin nothing
        # finer than `comparable_id` already compares.
        available_pinned = {
            pinned for pinned in map(runtime.pinned_id, reported) if pinned
        }
        # WARP-3046 review: the manifest digest of every installed tag, so a
        # pinned build installed under another tag still counts (`_is_pulled`).
        # A runtime that reports none leaves this empty: tag-exact only. Real
        # strings only — an entry with no `oci_digest` (None) must never match
        # a tag the runtime reported without one.
        installed_digests = {
            digest
            for digest in (m.get("digest") for m in installed.get("models", []))
            if isinstance(digest, str) and digest
        }
    except Exception:
        available = set()
        available_pinned = set()
        installed_digests = set()
        tags_unreachable = True

    def _is_pulled(m: ManifestEntry) -> bool:
        # WARP-3046: an entry that pins a build (its `oci` carries a tag) is
        # installed only when THAT build is — compared on the identifier the
        # pull actually addresses. Repository-level membership made installing
        # `ai/gemma4:latest` mark every gemma4 entry installed, and the
        # orchestrator's `already_pulled` 409 then made the real one
        # uninstallable.
        pinned = runtime.pinned_id(runtime.preferred_id(m.pull_tag, m.oci))
        if pinned is not None:
            # ...or when that build is installed under ANOTHER tag: the old
            # catalog pulled `ai/qwen3-vl:latest`, the same digest as the
            # pinned `8B-UD-Q4_K_XL`. Read tag-exactly, such a box was offered
            # a second copy and the `already_pulled` guard never fired. A
            # different build has a different digest, so siblings stay apart.
            return pinned in available_pinned or m.oci_digest in installed_digests
        # PR #53 review: an entry that pins nothing matches BOTH identifiers,
        # not just `name`. The pull ships the registry identifier (main.py
        # calls `runtime.pull(entry.pull_tag)`), so a quantization-pinned
        # Ollama entry is inventoried by the daemon under `pull_tag` — a
        # name-only test reports it `pulled: false` forever and the
        # orchestrator's `already_pulled` 409 guard never trips (full
        # re-download on every re-click). A model could also plausibly have
        # been pulled historically under either identifier, so membership of
        # either counts as installed.
        return (
            runtime.comparable_id(m.name) in available
            or runtime.comparable_id(m.pull_tag) in available
        )

    eligible = manifest.eligible(detected_vram_gb)
    return {
        # WARP-3046: `None` (JSON null) is UNKNOWN — nothing could size this
        # box — and is deliberately not a 0, which read as "no GPU". Paired
        # with `vram_source` (override | device_bridge | dgpu_sysfs |
        # unified_memory | null) so the catalog can say WHY it is empty.
        "detected_vram_gb": detected_vram_gb,
        "vram_source": vram_source,
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
                "pulled": _is_pulled(m),
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
