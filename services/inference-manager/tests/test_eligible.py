"""Tests for /models/eligible — manifest filtered by detected VRAM."""

from __future__ import annotations

import json

from httpx import Response


async def test_eligible_filters_by_vram(client, respx_mock, manifest_path):
    """Models with min_vram_gb > detected are excluded."""
    import vram
    vram._cached_gb = 6  # simulate an 8GB unified-memory device after 2GB reserve

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "small", "pull_tag": "small", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 2},
            {"name": "big", "pull_tag": "big", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 8},
        ]
    }))

    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": [{"name": "small"}]})
    )

    resp = await client.get("/models/eligible")
    assert resp.status_code == 200
    data = resp.json()
    assert data["detected_vram_gb"] == 6
    names = [m["name"] for m in data["models"]]
    assert names == ["small"]
    assert data["models"][0]["pulled"] is True


async def test_eligible_marks_unpulled(client, respx_mock, manifest_path):
    """Eligible entries report pulled=true/false based on /api/tags."""
    import vram
    vram._cached_gb = 14

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "small", "pull_tag": "small", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 2},
            {"name": "big", "pull_tag": "big", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 8},
        ]
    }))

    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": [{"name": "small"}]})
    )

    resp = await client.get("/models/eligible")
    data = resp.json()
    pulled = {m["name"]: m["pulled"] for m in data["models"]}
    assert pulled == {"small": True, "big": False}


async def test_eligible_not_degraded_on_healthy_manifest(client, respx_mock, manifest_path):
    """Finding 2: a clean manifest reports degraded_manifest=false."""
    import vram
    vram._cached_gb = 8

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "small", "pull_tag": "small", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 2},
        ]
    }))
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )

    resp = await client.get("/models/eligible")
    assert resp.status_code == 200
    assert resp.json()["degraded_manifest"] is False


async def test_eligible_includes_catalog_metadata(client, respx_mock, manifest_path):
    """WARP-1111: /models/eligible surfaces the new catalog fields, additive
    alongside the existing name/class/min_vram_gb/pulled/default keys."""
    import vram
    vram._cached_gb = 16

    manifest_path.write_text(json.dumps({
        "models": [
            {
                "name": "gemma4:26b", "pull_tag": "gemma4:26b", "format": "gguf",
                "quantization": "Q4_K_M", "min_vram_gb": 14, "class": "smart",
                "display_name": "Gemma 4 26B", "maker": "Google",
                "description": "Best image understanding.",
                "capabilities": ["vision", "tools"], "roles": ["vision"],
                "disk_gb": 17.0,
            }
        ]
    }))
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )

    resp = await client.get("/models/eligible")
    assert resp.status_code == 200
    model = resp.json()["models"][0]
    assert model["display_name"] == "Gemma 4 26B"
    assert model["maker"] == "Google"
    assert model["description"] == "Best image understanding."
    assert model["capabilities"] == ["vision", "tools"]
    assert model["roles"] == ["vision"]
    assert model["disk_gb"] == 17.0


async def test_eligible_defaults_display_name_to_name(client, respx_mock, manifest_path):
    """An entry with no explicit display_name still renders one (falls back
    to `name`) rather than surfacing null in the fleet console."""
    import vram
    vram._cached_gb = 8

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "bare:1b", "pull_tag": "bare:1b", "format": "gguf",
             "quantization": "Q4", "min_vram_gb": 2},
        ]
    }))
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )

    resp = await client.get("/models/eligible")
    model = resp.json()["models"][0]
    assert model["display_name"] == "bare:1b"
    assert model["maker"] is None
    assert model["capabilities"] == []
    assert model["roles"] == []
    assert model["disk_gb"] is None


async def test_eligible_flags_degraded_on_corrupt_manifest(client, respx_mock, manifest_path):
    """Finding 2: a corrupt manifest still returns 200 (last-known-good / empty)
    but now flags degraded_manifest=true so the corruption is observable instead
    of masquerading as 'no eligible models'."""
    import vram
    vram._cached_gb = 8

    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )
    # Corrupt the seeded manifest with no prior good load for this path.
    manifest_path.write_text("{ not valid json")

    resp = await client.get("/models/eligible")
    assert resp.status_code == 200
    data = resp.json()
    assert data["degraded_manifest"] is True
    assert data["models"] == []


# ── WARP-2129: the two identifier defects ────────────────────────────────
#
# Both tests below fail against the pre-fix `build_eligible`. Every OTHER
# fixture in this file sets `pull_tag == name` and speaks Ollama vocabulary on
# both sides of the `pulled` comparison, which is exactly why neither defect
# was ever exercised: the payload could omit `pull_tag` entirely and the
# membership test could compare across two incompatible id vocabularies with
# the suite staying green.


async def test_eligible_emits_pull_tag_distinct_from_name(
    client, respx_mock, manifest_path
):
    """`pull_tag` is a SEPARATE field, and it survives differing from `name`.

    The orchestrator sends this value — not the catalog `name` — to
    `POST /models/pull` (droplet-onboard-services `routes/models.ts`: "the
    identifier that goes ON THE WIRE"). When the key is absent its parser
    yields `pull_tag: null` and falls back to `name`, so an entry that pins a
    quantization installs different weights than the catalog advertised. The
    two identifiers differ for every such entry, which is why `by_identifier`
    accepts either one.
    """
    import vram
    vram._cached_gb = 16

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "test-model:7b", "pull_tag": "test-model:7b-q4_K_M",
             "format": "gguf", "quantization": "Q4_K_M", "min_vram_gb": 4},
        ]
    }))
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )

    resp = await client.get("/models/eligible")
    assert resp.status_code == 200
    model = resp.json()["models"][0]
    assert model["name"] == "test-model:7b"
    assert model["pull_tag"] == "test-model:7b-q4_K_M"


async def test_eligible_pulled_matches_dmr_registry_qualified_id(
    client, respx_mock, manifest_path, monkeypatch
):
    """On DMR, `pulled` is true for a model the daemon reports under its OWN id.

    DMR answers `/api/tags` with registry-qualified OCI references
    (`docker.io/ai/gpt-oss:20B-F16`) where the manifest carries Ollama-style
    names (`gpt-oss:20b`). The endpoint is field-for-field identical across
    runtimes (ADR-005 §2); the IDENTIFIERS in its body are not. A raw string
    membership test therefore never matches, and every entry reports
    `pulled: false` — including the model that is currently serving.

    This is the same fault WARP-1743 fixed on `/models/sync` by routing both
    sides through `runtime.comparable_id`; `/models/eligible` was left out.
    """
    import main
    import vram
    vram._cached_gb = 16
    monkeypatch.setattr(main, "INFERENCE_RUNTIME", "dmr")

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "gpt-oss:20b", "pull_tag": "gpt-oss:20b", "format": "gguf",
             "quantization": "MXFP4", "min_vram_gb": 14},
        ]
    }))
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(
            200, json={"models": [{"name": "docker.io/ai/gpt-oss:20B-F16"}]}
        )
    )

    resp = await client.get("/models/eligible")
    assert resp.status_code == 200
    assert resp.json()["models"][0]["pulled"] is True


async def test_eligible_pulled_stays_exact_under_ollama(
    client, respx_mock, manifest_path
):
    """The Ollama path keeps string equality — `comparable_id` is identity there.

    Guards the fix from over-reaching: folding the comparison behind the
    adapter must not start matching two DIFFERENT Ollama tags onto each other.
    `llama3.2:3b` is not installed just because `llama3.2:1b` is.
    """
    import vram
    vram._cached_gb = 16

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "llama3.2:3b", "pull_tag": "llama3.2:3b", "format": "gguf",
             "quantization": "Q4_K_M", "min_vram_gb": 4},
        ]
    }))
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": [{"name": "llama3.2:1b"}]})
    )

    resp = await client.get("/models/eligible")
    assert resp.json()["models"][0]["pulled"] is False


async def test_eligible_pulled_true_when_installed_under_pull_tag(
    client, respx_mock, manifest_path
):
    """`pulled` is true for an entry the daemon inventories under its PULL_TAG.

    The pull itself ships the registry identifier — main.py calls
    `runtime.pull(entry.pull_tag)` — so for any entry that pins a quantization
    the daemon inventories the weights under `pull_tag`, never under the
    catalog `name`. Matching `name` alone therefore reports an INSTALLED
    pinned entry `pulled: false` forever, the orchestrator's `already_pulled`
    409 guard never trips, and every re-click is a full re-download. A model
    could also plausibly have been pulled historically under either
    identifier, so BOTH are matched against the daemon's inventory (PR #53
    review). No other test combines `name != pull_tag` with a non-empty
    inventory: the one distinct-identifier fixture above mocks `/api/tags`
    empty, so `pulled` is false under either comparison.
    """
    import vram
    vram._cached_gb = 16

    manifest_path.write_text(json.dumps({
        "models": [
            {"name": "test-model:7b", "pull_tag": "test-model:7b-q4_K_M",
             "format": "gguf", "quantization": "Q4_K_M", "min_vram_gb": 4},
        ]
    }))
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(
            200, json={"models": [{"name": "test-model:7b-q4_K_M"}]}
        )
    )

    resp = await client.get("/models/eligible")
    assert resp.status_code == 200
    assert resp.json()["models"][0]["pulled"] is True


# ── WARP-3046: unknown VRAM is reported, not disguised as 0 ──────────────


async def test_eligible_reports_unknown_vram_as_null_with_no_source(
    client, respx_mock, manifest_path, monkeypatch, tmp_path
):
    """Nothing could size the box: the list is empty, and the payload SAYS it
    is empty because the VRAM is unknown — `detected_vram_gb: null`, not the
    `0` that read as "this Droplet has no GPU" on .195."""
    import vram
    monkeypatch.delenv("VRAM_OVERRIDE_GB", raising=False)
    monkeypatch.setattr(vram, "_MEMINFO_PATH", str(tmp_path / "unreadable"))
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )

    resp = await client.get("/models/eligible")
    assert resp.status_code == 200
    data = resp.json()
    assert data["detected_vram_gb"] is None
    assert data["vram_source"] is None
    assert data["models"] == []


async def test_eligible_names_the_vram_source(client, respx_mock, manifest_path):
    import vram
    vram._cached_gb = 16
    vram._cached_source = vram.SOURCE_BRIDGE
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": []})
    )

    data = (await client.get("/models/eligible")).json()
    assert data["detected_vram_gb"] == 16
    assert data["vram_source"] == "device_bridge"


# ── WARP-3046: `pulled` is tag-exact for an entry that pins a build ──────
#
# `comparable_id` folds every build of a repository onto one key. With the tag
# dropped on the wire as well, that at least agreed with itself; with `oci`
# pinning builds it does not: after "Gemma 4 26B" pulled `ai/gemma4:latest`
# (the 12B), BOTH gemma4 entries read `pulled: true`, their cards vanished,
# and the orchestrator's `already_pulled` 409 made the real 26B uninstallable.


def _two_gemma_builds() -> str:
    return json.dumps({
        "models": [
            {"name": "gemma4:26b", "pull_tag": "gemma4:26b",
             "oci": "ai/gemma4:26b-a4b-q4_K_M", "format": "gguf",
             "quantization": "Q4_K_M", "min_vram_gb": 4},
            {"name": "gemma4:31b", "pull_tag": "gemma4:31b",
             "oci": "ai/gemma4:31b-q4_K_M", "format": "gguf",
             "quantization": "Q4_K_M", "min_vram_gb": 4},
        ]
    })


async def test_eligible_sibling_builds_are_not_pulled_by_another_build(
    client, respx_mock, manifest_path, monkeypatch
):
    import main
    import vram
    vram._cached_gb = 16
    monkeypatch.setattr(main, "INFERENCE_RUNTIME", "dmr")
    manifest_path.write_text(_two_gemma_builds())
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": [{"name": "docker.io/ai/gemma4:latest"}]})
    )

    pulled = {m["name"]: m["pulled"] for m in (await client.get("/models/eligible")).json()["models"]}
    assert pulled == {"gemma4:26b": False, "gemma4:31b": False}


async def test_eligible_installing_one_build_marks_only_that_build(
    client, respx_mock, manifest_path, monkeypatch
):
    import main
    import vram
    vram._cached_gb = 16
    monkeypatch.setattr(main, "INFERENCE_RUNTIME", "dmr")
    manifest_path.write_text(_two_gemma_builds())
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(
            200, json={"models": [{"name": "docker.io/ai/gemma4:26b-a4b-q4_K_M"}]}
        )
    )

    pulled = {m["name"]: m["pulled"] for m in (await client.get("/models/eligible")).json()["models"]}
    assert pulled == {"gemma4:26b": True, "gemma4:31b": False}


async def test_eligible_shipped_manifest_on_the_16gb_dmr_box(
    client, respx_mock, manifest_path, monkeypatch
):
    """The REAL manifest against .195's real inventory (one model,
    `docker.io/ai/gpt-oss:20B-F16`) at 16 GB: the serving model reads
    installed, nothing else does, and only builds that fit are offered."""
    from pathlib import Path

    import main
    import vram
    vram._cached_gb = 16
    shipped = Path(__file__).resolve().parents[1] / "models" / "model-manifest.json"
    monkeypatch.setattr(main, "MANIFEST_PATH", str(shipped))
    monkeypatch.setattr(main, "INFERENCE_RUNTIME", "dmr")
    respx_mock.get("http://mock-ollama:11434/api/tags").mock(
        return_value=Response(200, json={"models": [{"name": "docker.io/ai/gpt-oss:20B-F16"}]})
    )

    data = (await client.get("/models/eligible")).json()
    pulled = {m["name"]: m["pulled"] for m in data["models"]}
    assert pulled == {
        "gpt-oss:20b": True,
        "qwen3-vl:8b": False,
        "llama3.2:3b": False,
        "glm-4.7-flash:31b": False,
    }
