"""Tests for manifest schema and validators."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def test_load_valid_manifest(tmp_path: Path):
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {
                "name": "llama3.2:3b",
                "pull_tag": "llama3.2:3b",
                "format": "gguf",
                "quantization": "Q4_K_M",
                "min_vram_gb": 4,
                "class": "fast",
                "default": True,
            }
        ]
    }))

    manifest = load_manifest(p)
    assert len(manifest.models) == 1
    assert manifest.models[0].name == "llama3.2:3b"
    assert manifest.models[0].min_vram_gb == 4
    assert manifest.models[0].default is True
    assert manifest.models[0].cls == "fast"


def test_rejects_multiple_defaults(tmp_path: Path):
    from manifest import load_manifest
    from pydantic import ValidationError

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "a", "pull_tag": "a", "format": "gguf", "quantization": "Q4",
             "min_vram_gb": 2, "default": True},
            {"name": "b", "pull_tag": "b", "format": "gguf", "quantization": "Q4",
             "min_vram_gb": 2, "default": True},
        ]
    }))

    with pytest.raises(ValidationError):
        load_manifest(p)


def test_rejects_missing_min_vram_gb(tmp_path: Path):
    from manifest import load_manifest
    from pydantic import ValidationError

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "a", "pull_tag": "a", "format": "gguf", "quantization": "Q4"}
        ]
    }))

    with pytest.raises(ValidationError):
        load_manifest(p)


def test_default_entry_returns_none_when_unset(tmp_path: Path):
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "a", "pull_tag": "a", "format": "gguf", "quantization": "Q4",
             "min_vram_gb": 2}
        ]
    }))

    assert load_manifest(p).default_entry() is None


def test_eligible_filters_by_vram(tmp_path: Path):
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "tiny", "pull_tag": "tiny", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 2},
            {"name": "big",  "pull_tag": "big",  "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 8},
        ]
    }))

    manifest = load_manifest(p)
    assert [m.name for m in manifest.eligible(detected_vram_gb=6)] == ["tiny"]
    assert [m.name for m in manifest.eligible(detected_vram_gb=8)] == ["tiny", "big"]
    assert [m.name for m in manifest.eligible(detected_vram_gb=0)] == []


def test_by_name(tmp_path: Path):
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "alpha", "pull_tag": "alpha", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 2}
        ]
    }))

    manifest = load_manifest(p)
    assert manifest.by_name("alpha").pull_tag == "alpha"
    assert manifest.by_name("missing") is None


def _valid_manifest_text(name: str) -> str:
    return json.dumps({
        "models": [
            {"name": name, "pull_tag": name, "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 0}
        ]
    })


def test_resilient_load_falls_back_to_last_known_good(tmp_path: Path, monkeypatch):
    """WARP-195: a corrupt manifest must NOT crash the runtime — the resilient
    loader keeps serving the last successfully-loaded manifest."""
    import manifest as mod
    monkeypatch.setattr(mod, "_last_good_manifests", {})

    p = tmp_path / "model-manifest.json"
    p.write_text(_valid_manifest_text("alpha"))
    good = mod.load_manifest_resilient(p)
    assert [m.name for m in good.models] == ["alpha"]

    # Corrupt the file — resilient load must not raise and must serve last-good.
    p.write_text("{ not valid json")
    fallback = mod.load_manifest_resilient(p)
    assert [m.name for m in fallback.models] == ["alpha"]


def test_resilient_load_empty_when_no_prior_good(tmp_path: Path, monkeypatch):
    """A corrupt manifest with no prior good load degrades to an empty manifest
    — consistent with the deleted-manifest path — rather than raising (WARP-195)."""
    import manifest as mod
    monkeypatch.setattr(mod, "_last_good_manifests", {})

    p = tmp_path / "model-manifest.json"
    p.write_text("{ broken")
    result = mod.load_manifest_resilient(p)
    assert result.models == []

    # Absent file with no prior good → also empty, never raises.
    assert mod.load_manifest_resilient(tmp_path / "nope.json").models == []


def test_last_known_good_is_path_keyed(tmp_path: Path, monkeypatch):
    """Finding 4: the last-known-good cache must be keyed by resolved path so a
    second manifest at a different path never serves the first file's data as its
    own fallback."""
    import manifest as mod
    monkeypatch.setattr(mod, "_last_good_manifests", {})

    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    a.write_text(_valid_manifest_text("alpha"))
    b.write_text(_valid_manifest_text("beta"))

    assert [m.name for m in mod.load_manifest_resilient(a).models] == ["alpha"]
    assert [m.name for m in mod.load_manifest_resilient(b).models] == ["beta"]

    # Corrupt B — its fallback must be B's last-good ("beta"), NOT A's ("alpha").
    b.write_text("{ broken")
    assert [m.name for m in mod.load_manifest_resilient(b).models] == ["beta"]

    # A corrupt brand-new path with no prior good for it falls back to empty,
    # even though OTHER paths have a cached last-good.
    c = tmp_path / "c.json"
    c.write_text("{ also broken")
    assert mod.load_manifest_resilient(c).models == []


def test_resilient_with_status_reports_degradation(tmp_path: Path, monkeypatch):
    """Finding 2: the resilient loader must be able to tell callers whether it
    fell back, so endpoints can surface a `degraded_manifest` flag."""
    import manifest as mod
    monkeypatch.setattr(mod, "_last_good_manifests", {})

    p = tmp_path / "model-manifest.json"
    p.write_text(_valid_manifest_text("alpha"))

    manifest, degraded = mod.load_manifest_resilient_with_status(p)
    assert [m.name for m in manifest.models] == ["alpha"]
    assert degraded is False

    # Corrupt → still serves last-good, but now flagged degraded.
    p.write_text("{ not valid json")
    manifest, degraded = mod.load_manifest_resilient_with_status(p)
    assert [m.name for m in manifest.models] == ["alpha"]
    assert degraded is True

    # Absent file → degraded too (we can't confirm desired state).
    manifest, degraded = mod.load_manifest_resilient_with_status(tmp_path / "nope.json")
    assert degraded is True


def test_strict_load_still_raises(tmp_path: Path):
    """load_manifest itself stays strict (write-time validation contract)."""
    from manifest import load_manifest
    from pydantic import ValidationError

    p = tmp_path / "model-manifest.json"
    p.write_text("{ not valid json")
    with pytest.raises(ValidationError):
        load_manifest(p)


# ── WARP-1111: catalog metadata fields ──


def test_catalog_fields_default_safely(tmp_path: Path):
    """An entry that omits every new catalog field still loads — the schema
    change must never be able to brick provisioning (architecture brief §6)."""
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "bare:1b", "pull_tag": "bare:1b", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 2}
        ]
    }))

    entry = load_manifest(p).models[0]
    assert entry.display_name == "bare:1b"  # falls back to name
    assert entry.maker is None
    assert entry.description is None
    assert entry.capabilities == []
    assert entry.roles == []
    assert entry.disk_gb is None


def test_catalog_fields_round_trip_when_provided(tmp_path: Path):
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {
                "name": "gemma4:26b", "pull_tag": "gemma4:26b", "format": "gguf",
                "quantization": "Q4_K_M", "min_vram_gb": 14, "class": "smart",
                "display_name": "Gemma 4 26B", "maker": "Google",
                "description": "Best image understanding on capable hardware.",
                "capabilities": ["vision", "tools"], "roles": ["vision"],
                "disk_gb": 17.0,
            }
        ]
    }))

    entry = load_manifest(p).models[0]
    assert entry.display_name == "Gemma 4 26B"
    assert entry.maker == "Google"
    assert entry.description == "Best image understanding on capable hardware."
    assert entry.capabilities == ["vision", "tools"]
    assert entry.roles == ["vision"]
    assert entry.disk_gb == 17.0


def test_disk_gb_rejects_negative(tmp_path: Path):
    from manifest import load_manifest
    from pydantic import ValidationError

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "a", "pull_tag": "a", "format": "gguf", "quantization": "Q4",
             "min_vram_gb": 2, "disk_gb": -1}
        ]
    }))
    with pytest.raises(ValidationError):
        load_manifest(p)


def test_by_identifier_matches_name_or_pull_tag(tmp_path: Path):
    """Callers may present either the manifest `name` or the registry
    `pull_tag` — they differ when an entry pins a quantization. Used by the
    disk preflight and delete guard (WARP-1111)."""
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "foo:7b", "pull_tag": "foo:7b-q4_K_M", "format": "gguf",
             "quantization": "Q4_K_M", "min_vram_gb": 0}
        ]
    }))
    manifest = load_manifest(p)
    assert manifest.by_identifier("foo:7b").pull_tag == "foo:7b-q4_K_M"
    assert manifest.by_identifier("foo:7b-q4_K_M").name == "foo:7b"
    assert manifest.by_identifier("missing") is None


def test_production_catalog_loads_and_validates():
    """The shipped catalog (models/model-manifest.json) — the actual file
    that ships to devices — must parse cleanly and keep the single-default
    invariant. Regression guard for WARP-1111's catalog expansion."""
    from manifest import load_manifest

    # WARP-2131 (vendored): the manifest ships INSIDE this service and is baked
    # into its image, rather than living at the repo root behind a bind mount as
    # it does upstream. See VENDORED.md.
    svc_root = Path(__file__).resolve().parents[1]
    manifest_path = svc_root / "models" / "model-manifest.json"
    manifest = load_manifest(manifest_path)

    assert len(manifest.models) >= 4
    defaults = [m for m in manifest.models if m.default]
    assert len(defaults) == 1
    assert defaults[0].name == "gpt-oss:20b"
    names = {m.name for m in manifest.models}
    assert {"gpt-oss:20b", "gemma4:26b", "qwen3-vl:8b", "llama3.2:3b"} <= names
    # Every shipped entry carries the new catalog metadata.
    for m in manifest.models:
        assert m.display_name
        assert m.roles, f"{m.name} has no roles"


# ── WARP-2130 / ADR-005 §2: the per-entry runtime OCI reference ───────────


def test_oci_is_optional_and_defaults_to_none(tmp_path: Path):
    """An entry that predates the field still validates, and reads as
    undeclared — which is what keeps the derive-from-name path unchanged."""
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "llama3.2:3b", "pull_tag": "llama3.2:3b", "format": "gguf",
             "quantization": "Q4_K_M", "min_vram_gb": 4},
        ]
    }))
    entry = load_manifest(p).models[0]
    assert entry.oci is None


def test_oci_round_trips_when_declared(tmp_path: Path):
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(json.dumps({
        "models": [
            {"name": "foo:31b", "pull_tag": "foo:31b", "format": "gguf",
             "quantization": "Q4_K_M", "min_vram_gb": 4,
             "oci": "ai/foo:reap-q4_K_M"},
        ]
    }))
    assert load_manifest(p).models[0].oci == "ai/foo:reap-q4_K_M"


def test_shipped_manifest_pins_glm_to_the_build_that_fits(tmp_path: Path):
    """Regression guard on the REAL manifest, not a fixture.

    `ai/glm-4.7-flash:reap-q4_K_M` is 13.14 GiB resident and is the ONLY one of
    the repository's eleven published tags that fits a 16 GB card — `latest` is
    byte-identical to `q4_K_M` at 17.05 GiB and does not. Relaxing this entry to
    a bare `ai/glm-4.7-flash` would resolve to `latest` and spill the model off
    the card, which presents as a catastrophic slowdown rather than an error.
    Verified against the Docker Hub registry API 2026-08-20.

    Also asserts `default: false`: promoting the box default is a bench-gated
    decision that moves voice as well as chat (the one-model rule), and must
    never ride in on a manifest edit.
    """
    from manifest import load_manifest

    # WARP-2131 (vendored): the manifest ships INSIDE this service and is
    # baked into its image, rather than living at the repo root behind a
    # bind mount as it does upstream. See VENDORED.md.
    svc_root = Path(__file__).resolve().parents[1]
    manifest = load_manifest(svc_root / "models" / "model-manifest.json")

    entry = manifest.by_name("glm-4.7-flash:31b")
    assert entry is not None, "glm-4.7-flash:31b missing from the shipped manifest"
    assert entry.oci == "ai/glm-4.7-flash:reap-q4_K_M"
    assert entry.default is False
    # The default must still be the incumbent, and there must be exactly one.
    assert manifest.default_entry() is not None
    assert manifest.default_entry().name == "gpt-oss:20b"


def _entry_with_oci(oci: str) -> str:
    return json.dumps({
        "models": [
            {"name": "glm-4.7-flash:31b", "pull_tag": "glm-4.7-flash:31b",
             "oci": oci, "format": "gguf",
             "quantization": "Q4_K_M", "min_vram_gb": 4},
        ]
    })


@pytest.mark.parametrize("blank", ["", "   "])
def test_oci_blank_still_loads_as_undeclared(tmp_path: Path, blank: str):
    """Blank/whitespace stays LOADABLE — `preferred_id` reads it as undeclared
    (its parametrized fallback test covers exactly these values), and refusing
    it would let a compose-style `${VAR:-}` expansion brick a manifest push.
    The shape validation below applies only to a value that is actually set."""
    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(_entry_with_oci(blank))
    assert load_manifest(p).models[0].oci == blank


@pytest.mark.parametrize("malformed", [
    # The exact typo the field invites: forgetting the `ai/` namespace.
    "glm-4.7-flash:reap-q4_K_M",
    "glm-4.7-flash",
])
def test_oci_without_a_namespace_is_refused_at_load(tmp_path: Path, malformed: str):
    """PR #54 review (WARP-2130): a slash-less `oci` is never served, it is
    MANGLED — `runtime/dmr.py::to_runtime_id` branches on `"/" in candidate`,
    so a value missing its namespace falls into the bare-Ollama-id path,
    derives `ai/<repo>` and DROPS the tag. The daemon then resolves `latest`
    (17.05 GiB for GLM) instead of the pinned quant (13.14 GiB) — the precise
    silent failure the field exists to prevent. Refuse it at load, loudly.

    Note this makes the strict loader raise; the resilient runtime loader
    degrades to last-known-good exactly as for any other invalid manifest."""
    from pydantic import ValidationError

    from manifest import load_manifest

    p = tmp_path / "m.json"
    p.write_text(_entry_with_oci(malformed))
    with pytest.raises(ValidationError, match=r"namespace/repository\[:tag\]"):
        load_manifest(p)
