"""Pydantic models for model-manifest.json with VRAM gating."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, model_validator

logger = logging.getLogger(__name__)

# Canonical manifest location. This is the SINGLE source of truth for the
# ``MODEL_MANIFEST`` env-var read and the in-container default path; both
# ``main.py`` (lifecycle endpoints) and ``chat_proxy.py`` (label cache) import
# it instead of duplicating the literal. Lives here — not in ``main.py`` —
# because ``manifest.py`` is already imported by both and has no upstream
# imports, so sharing it cannot introduce an import cycle (finding 3).
DEFAULT_MANIFEST_PATH = "/app/models/model-manifest.json"


def manifest_path() -> str:
    """Resolved manifest path: ``MODEL_MANIFEST`` env override or the default.

    Read at call time (not import time) so tests can ``monkeypatch.setenv``."""
    return os.getenv("MODEL_MANIFEST", DEFAULT_MANIFEST_PATH)


class ManifestEntry(BaseModel):
    name: str
    pull_tag: str
    format: str
    quantization: str
    min_vram_gb: int = Field(ge=0)
    cls: Literal["fast", "balanced", "smart"] | None = Field(default=None, alias="class")
    default: bool = False

    # ── catalog metadata (WARP-1111) ──
    # All optional with safe defaults so a manifest push that omits them can
    # never brick provisioning — the schema change itself must never be the
    # thing that takes a device's model catalog offline. See
    # LOCAL-LLM-MODEL-SWITCHING-ARCHITECTURE-BRIEF.md §6 in the handbook.
    display_name: str | None = None
    maker: str | None = None
    description: str | None = None
    capabilities: list[str] = Field(default_factory=list)
    roles: list[str] = Field(default_factory=list)
    disk_gb: float | None = Field(default=None, ge=0)

    # ── the runtime OCI reference (ADR-005 §2 / WARP-2130) ──
    # ADR-005 §2: "The real incompatibility is not an endpoint — it is the
    # identifier ... and the manifest is where it belongs — a per-entry OCI
    # reference alongside `pull_tag`, not a detail to be discovered in Phase 2."
    # `models/oci-sources.json`'s `_about` block scheduled it for Phase 2;
    # Phase 2 (WARP-1749) shipped without it. This is that field.
    #
    # OPTIONAL, and absent means today's behaviour byte for byte: with no `oci`,
    # `runtime/dmr.py::to_runtime_id` derives `ai/<repo>` from the Ollama id and
    # DROPS the tag by design, letting the daemon resolve its own default.
    # Declaring it is the ONLY way to pin a quantization, because an OCI tag is
    # what selects one and the derivation cannot invent it. Same
    # never-brick-provisioning rationale as the catalog metadata above: a
    # manifest push that omits this must not take a device's catalog offline.
    #
    # NOT the same thing as `oci-sources.json`'s `target_repo`/`target_tag`.
    # Those are a BUILD-time fact — where weights come from when we package an
    # artifact. This is the RUNTIME identifier the daemon is asked to serve.
    oci: str | None = None

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _default_display_name(self) -> "ManifestEntry":
        # display_name defaults to the manifest name so every consumer (the
        # fleet console, /models/eligible callers) always has something
        # human-readable to render, even for older/minimal entries.
        if not self.display_name:
            self.display_name = self.name
        return self


class Manifest(BaseModel):
    models: list[ManifestEntry]

    @model_validator(mode="after")
    def _at_most_one_default(self) -> "Manifest":
        defaults = [m for m in self.models if m.default]
        if len(defaults) > 1:
            names = ", ".join(m.name for m in defaults)
            raise ValueError(f"At most one manifest entry may set default=true, found: {names}")
        return self

    def default_entry(self) -> ManifestEntry | None:
        for m in self.models:
            if m.default:
                return m
        return None

    def by_name(self, name: str) -> ManifestEntry | None:
        for m in self.models:
            if m.name == name:
                return m
        return None

    def by_identifier(self, identifier: str) -> ManifestEntry | None:
        """Look up by manifest ``name`` OR registry ``pull_tag``.

        Callers of the lifecycle API may present either identifier — they
        differ whenever an entry pins a specific quantization (e.g. name
        `foo:7b` vs pull_tag `foo:7b-q4_K_M`). See the LLM-13 note in
        main.py for the same distinction on the sync path.
        """
        for m in self.models:
            if m.name == identifier or m.pull_tag == identifier:
                return m
        return None

    def eligible(self, detected_vram_gb: int) -> list[ManifestEntry]:
        return [m for m in self.models if m.min_vram_gb <= detected_vram_gb]


def load_manifest(path: Path | str) -> Manifest:
    p = Path(path)
    return Manifest.model_validate_json(p.read_text())


# WARP-195: in-memory last-known-good manifests for the resilient runtime
# loader, keyed by resolved path string. Path-keyed (not a bare singleton) so a
# caller reading a *different* manifest path never gets the wrong file's data
# served back as its own last-known-good (finding 4).
_last_good_manifests: dict[str, Manifest] = {}


def load_manifest_resilient_with_status(path: Path | str) -> tuple[Manifest, bool]:
    """Resilient runtime load that never raises, plus a degradation flag (WARP-195).

    Returns ``(manifest, degraded)`` where ``degraded`` is ``True`` whenever the
    loader could NOT confirm the on-disk desired state and fell back — i.e. the
    file was absent, unreadable, or failed validation. ``degraded`` is ``False``
    only when the manifest on disk parsed cleanly.

    ``load_manifest`` is strict — it raises on malformed/invalid JSON and is the
    right tool for write-time validation. But the *running device* must not
    crash its ``/models/eligible`` + ``/models/sync`` surface because a
    fleet-wide manifest push had a typo. This degrades gracefully:

      * valid manifest    → parse, remember as last-known-good, return (it, False)
      * corrupt / invalid → log ERROR, return (last-known-good-for-this-path or
                            empty, True)
      * absent file       → return (last-known-good-for-this-path or empty, True)

    That makes the corrupt-manifest path consistent with the already-graceful
    deleted-manifest path (``get_manifest`` → ``{"models": []}``), so editing
    the file is no longer riskier than deleting it. The ``degraded`` flag lets
    callers surface the fallback to operators instead of silently masking a
    corrupt push as "no eligible models" / "clean no-op sync" (finding 2).
    """
    p = Path(path)
    key = str(p)
    cached = _last_good_manifests.get(key)
    if not p.exists():
        return (cached or Manifest(models=[]), True)
    try:
        manifest = load_manifest(p)
    except (ValidationError, ValueError, OSError) as e:
        logger.error(
            "manifest reload failed (%s); falling back to %s",
            type(e).__name__,
            "last-known-good" if cached is not None else "empty manifest",
        )
        return (cached or Manifest(models=[]), True)
    _last_good_manifests[key] = manifest
    return (manifest, False)


def load_manifest_resilient(path: Path | str) -> Manifest:
    """Resilient runtime load that never raises (WARP-195).

    Thin wrapper over :func:`load_manifest_resilient_with_status` for callers
    that don't need the degradation flag.
    """
    manifest, _degraded = load_manifest_resilient_with_status(path)
    return manifest
