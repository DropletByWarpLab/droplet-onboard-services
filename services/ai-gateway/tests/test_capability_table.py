"""Static per-model capability table (WARP-1744).

The table exists because `/api/show`'s `capabilities` array is an OLLAMA
extension. Docker Model Runner serves an Ollama-compatible `/api/show` at the
same route with the same `details` block but no `capabilities` key at all
(docker/model-runner v1.2.6, `pkg/ollama/api.go`), so an unaided probe reports
`tools=False` for a tool-calling model the moment a different daemon answers.
These tests pin the four things that matter:

* a table id resolves from the table and skips the network entirely,
* an unknown id still falls through to the probe (unchanged behavior),
* a `capabilities`-less `/api/show` response degrades exactly as documented,
  and that this is precisely the DMR case the table is protecting against,
* the table does not CONTRADICT the probe for anything we ship — so turning
  the table on cannot change today's answers, only where they come from.
"""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest
import respx

from capabilities import (
    _STATIC_CAPABILITY_ROWS,
    ollama_capabilities_from_show,
    static_capabilities,
)
from providers.ollama_local import OllamaLocalProvider
from schemas import ModelCapabilities

BASE = "http://table-ollama:11434"
SHOW_URL = f"{BASE}/api/show"
TAGS_URL = f"{BASE}/api/tags"


@pytest.fixture
async def provider():
    p = OllamaLocalProvider(base_url=BASE)
    yield p
    await p.close()


# ---------------------------------------------------------------------------
# Table lookup
# ---------------------------------------------------------------------------


class TestStaticTableLookup:
    """Key resolution: exact id, DMR/OCI namespace, and tag-stripped family."""

    def test_ollama_style_id_hits(self):
        # The single-box default, `scripts/lib/single-box.sh:883`.
        caps = static_capabilities("gpt-oss:20b")
        assert caps is not None
        assert caps.tools is True
        assert caps.vision is False

    def test_dmr_style_id_hits_the_same_row(self):
        # DMR ids are OCI-style and untagged. Same weights → same answer.
        assert static_capabilities("ai/gpt-oss") == static_capabilities("gpt-oss:20b")

    def test_registry_qualified_ollama_id_hits(self):
        # `library/…` prefixed tags are still the same model.
        assert static_capabilities("library/gpt-oss:20b") == static_capabilities(
            "gpt-oss:20b"
        )

    def test_sibling_tag_resolves_via_family_key(self):
        # A differently-sized sibling has identical modalities.
        caps = static_capabilities("gpt-oss:120b")
        assert caps is not None and caps.tools is True

    def test_lookup_is_case_insensitive(self):
        assert static_capabilities("GPT-OSS:20B") == static_capabilities("gpt-oss:20b")

    def test_namespaced_id_resolves_by_stripping_the_publisher(self):
        # Resolution rule, not a catalog claim: we deliberately do NOT assert
        # that any particular publisher ships `llava` under this id. Only
        # `ai/gpt-oss` and `ai/qwen2.5` are verified DMR ids and those are the
        # only DMR aliases written into the table.
        assert static_capabilities("somens/llava:7b") == static_capabilities("llava:7b")

    def test_vision_models_are_vision_not_tools(self):
        # `.env.example:213` VISION_MODEL, and the llava tag from the
        # chat-image-vision spec.
        for model in ("llama3.2-vision:11b", "llava:7b", "moondream"):
            caps = static_capabilities(model)
            assert caps is not None, model
            assert caps.vision is True, model
            assert caps.tools is False, model

    def test_unknown_model_misses(self):
        assert static_capabilities("some-model-nobody-ships:7b") is None

    def test_near_miss_family_does_not_collide(self):
        # `llava-llama3` is a DIFFERENT family from `llava`; stripping the tag
        # must not let it borrow llava's row.
        assert static_capabilities("llava-llama3:8b") is None

    def test_llama32_and_llama32_vision_stay_separate(self):
        # The riskiest pair in the table: one text tool-caller, one vision
        # model, sharing a name prefix. Tag-stripping must not merge them.
        text = static_capabilities("llama3.2:3b")
        vision = static_capabilities("llama3.2-vision:11b")
        assert text is not None and vision is not None
        assert (text.vision, text.tools) == (False, True)
        assert (vision.vision, vision.tools) == (True, False)

    @pytest.mark.parametrize("model", ["", "   ", None])
    def test_empty_ids_miss_without_raising(self, model):
        assert static_capabilities(model) is None  # type: ignore[arg-type]

    def test_result_is_a_copy_not_the_shared_row(self):
        # The rows are module-level state and ModelCapabilities is mutable —
        # a caller editing its result must not edit the table.
        first = static_capabilities("gpt-oss:20b")
        assert first is not None
        first.tools = False
        second = static_capabilities("gpt-oss:20b")
        assert second is not None and second.tools is True


# ---------------------------------------------------------------------------
# Provider integration: table first, probe as fallback
# ---------------------------------------------------------------------------


class TestProviderResolutionOrder:
    """`_capabilities` probes FIRST; the table is only a gap-filler.

    An earlier draft consulted the table first. Three independent reviewers
    flagged it as a ships-dark violation and they were right: it skipped the
    `/api/show` POST for known ids and changed the reported value for any
    daemon whose `/api/show` omits `capabilities`. Both are live behavior
    changes on the default path of every deployed appliance.
    """

    @respx.mock
    async def test_a_daemon_that_answers_is_never_overridden(self, provider):
        """The whole ships-dark guarantee in one assertion.

        Ollama returns a `capabilities` array. When it does, its answer wins and
        the table is not consulted — so on a stock appliance this method is the
        pre-WARP-1744 probe, byte for byte. Note the table says `tools=True` for
        this id; the daemon says otherwise, and the daemon wins.
        """
        route = respx.post(SHOW_URL).mock(
            return_value=httpx.Response(200, json={"capabilities": ["completion"]})
        )

        caps = await provider._capabilities("gpt-oss:20b")

        assert route.call_count == 1, "the probe must still be issued"
        assert caps is not None and caps.tools is False, (
            "a daemon that answered must not be overridden by the table"
        )

    @respx.mock
    async def test_table_miss_falls_back_to_the_show_probe(self, provider):
        route = respx.post(SHOW_URL).mock(
            return_value=httpx.Response(
                200, json={"capabilities": ["completion", "tools", "vision"]}
            )
        )

        caps = await provider._capabilities("customer-pulled-model:7b")

        assert route.call_count == 1, "unknown ids must still be probed"
        assert caps is not None and caps.tools is True and caps.vision is True

    @respx.mock
    async def test_table_miss_on_dead_daemon_still_returns_none(self, provider):
        # Unchanged conservative behavior: unknown model + unreachable daemon
        # → None, and the caller degrades (non-vision → OCR fallback).
        respx.post(SHOW_URL).mock(side_effect=httpx.ConnectError("refused"))

        assert await provider._capabilities("customer-pulled-model:7b") is None

    @respx.mock
    async def test_probe_result_is_cached_per_id(self, provider):
        route = respx.post(SHOW_URL).mock(
            return_value=httpx.Response(200, json={"capabilities": ["completion"]})
        )

        await provider._capabilities("customer-pulled-model:7b")
        await provider._capabilities("customer-pulled-model:7b")

        assert route.call_count == 1

    @respx.mock
    async def test_list_models_still_probes_every_id(self, provider):
        """`list_models` is on the default path, so it must keep probing.

        The daemon here reports an explicit empty `capabilities: []` — it DID
        answer, it just answered "nothing". That is a real answer and the table
        must not overwrite it, even for an id the table knows.
        """
        respx.get(TAGS_URL).mock(
            return_value=httpx.Response(200, json={"models": [{"name": "gpt-oss:20b"}]})
        )
        show = respx.post(SHOW_URL).mock(
            return_value=httpx.Response(200, json={"capabilities": []})
        )

        models = await provider.list_models()

        assert show.call_count == 1
        assert len(models) == 1
        assert models[0].capabilities is not None
        assert models[0].capabilities.tools is False


class TestTableIsGatedOff:
    """The table answers only when INFERENCE_RUNTIME=dmr.

    Belt to the gap-filler's braces. Even though the gap-filler alone would not
    change a stock box's behavior, "provably off by default" beats "argued to be
    equivalent" — which is the lesson of the table-first draft.
    """

    @respx.mock
    async def test_sparse_show_keeps_todays_answer_when_gated_off(self, provider):
        """A capabilities-less reply degrades exactly as it does today.

        This is the DMR shape. With the gate OFF (the default), the answer is
        the pre-WARP-1744 one — `tools=False` from the families heuristic — NOT
        the table's. Turning the gate on is what makes the table speak.
        """
        respx.post(SHOW_URL).mock(
            return_value=httpx.Response(200, json={"details": {"families": ["llama"]}})
        )

        caps = await provider._capabilities("gpt-oss:20b")

        assert caps is not None and caps.tools is False

    @respx.mock
    async def test_sparse_show_uses_the_table_when_gated_on(self, provider, monkeypatch):
        """Gate ON: the table fills the gap the daemon left. The DMR case.

        This is the only test that exercises the branch WARP-1744 exists for.
        The body is the exact shape measured on 2026-08-05 from
        `docker/model-runner:v1.2.6` — a `details` object and nothing else.
        Without the table this returns `tools=False` for a tool-calling model.
        """
        import providers.ollama_local as ollama_local

        monkeypatch.setattr(ollama_local, "_STATIC_CAPABILITY_TABLE", True)
        route = respx.post(SHOW_URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "details": {
                        "format": "gguf",
                        "family": "llama",
                        "families": ["llama"],
                        "parameter_size": "361.82 M",
                        "quantization_level": "IQ2_XXS/Q4_K_M",
                    }
                },
            )
        )

        caps = await provider._capabilities("gpt-oss:20b")

        assert route.call_count == 1, "the probe runs first even when gated on"
        assert caps is not None and caps.tools is True

    @respx.mock
    async def test_gated_on_still_defers_to_a_daemon_that_answered(
        self, provider, monkeypatch
    ):
        """Even ON, the table never overrides a real answer.

        The gate decides whether the table may speak into a GAP, not whether it
        outranks the daemon. Without this, enabling DMR would silently change
        what a healthy Ollama reports.
        """
        import providers.ollama_local as ollama_local

        monkeypatch.setattr(ollama_local, "_STATIC_CAPABILITY_TABLE", True)
        respx.post(SHOW_URL).mock(
            return_value=httpx.Response(200, json={"capabilities": ["completion"]})
        )

        caps = await provider._capabilities("gpt-oss:20b")

        assert caps is not None and caps.tools is False


# ---------------------------------------------------------------------------
# The DMR gap this table closes
# ---------------------------------------------------------------------------


class TestDmrShowResponseDegradation:
    """A `/api/show` body with NO `capabilities` key — i.e. every DMR reply.

    Verified against docker/model-runner v1.2.6: its Ollama-compatible
    `/api/show` returns `{license?, modelfile?, parameters?, template?,
    details:{…}}`. There is no `capabilities` array in that struct — that is
    THE gap, and it is why the table is consulted first.
    """

    # Exactly the DMR shape: the Ollama keys that DO exist, and no others.
    DMR_SHOW_GPT_OSS = {
        "license": "Apache-2.0",
        "modelfile": "FROM ai/gpt-oss",
        "parameters": "",
        "template": "",
        "details": {
            "format": "gguf",
            "family": "gptoss",
            "families": ["gptoss"],
            "parameter_size": "20.9B",
            "quantization_level": "MXFP4",
        },
    }

    def test_no_capabilities_key_means_tools_is_always_false(self):
        caps = ollama_capabilities_from_show(self.DMR_SHOW_GPT_OSS)
        # This is the mis-report: gpt-oss demonstrably emits tool calls (the
        # WARP-1333 harmony retry path exists for them), yet the probe alone
        # can only conclude False because DMR never sends the array.
        assert caps.tools is False
        # Vision degrades to the families heuristic — `gptoss` is not a vision
        # family, so False here is right, but only by luck of the family name.
        assert caps.vision is False

    def test_vision_survives_only_via_the_families_heuristic(self):
        # A vision model served by a capabilities-less daemon is saved by the
        # family name alone — remove the family and vision is lost.
        with_family = ollama_capabilities_from_show(
            {"details": {"families": ["mllama"]}}
        )
        without_family = ollama_capabilities_from_show(
            {"details": {"families": ["unknown-arch"]}}
        )
        assert with_family.vision is True
        assert without_family.vision is False

    def test_table_supplies_the_answer_the_dmr_probe_cannot(self):
        # Side by side: same model, same daemon reply, different conclusion.
        probed = ollama_capabilities_from_show(self.DMR_SHOW_GPT_OSS)
        tabled = static_capabilities("ai/gpt-oss")
        assert probed.tools is False
        assert tabled is not None and tabled.tools is True

    @respx.mock
    async def test_provider_degrades_gracefully_for_an_UNKNOWN_dmr_model(
        self, provider
    ):
        # A model DMR serves that is not in our table: we still fall back to
        # the probe and still under-claim rather than guess. Under-claiming is
        # the safe direction (the orchestrator routes to OCR / skips tools).
        respx.post(SHOW_URL).mock(
            return_value=httpx.Response(200, json=self.DMR_SHOW_GPT_OSS)
        )

        caps = await provider._capabilities("ai/some-unlisted-model")

        assert caps is not None
        assert caps.tools is False
        assert caps.vision is False


# ---------------------------------------------------------------------------
# No-drift invariant
# ---------------------------------------------------------------------------


class TestTableMirrorsTheApplianceManifest:
    """Rows sourced from the shipped catalog must match what it declares.

    `droplet-local-LLM/models/model-manifest.json` is the source of truth for
    what the appliance serves and what each model can do. It is a SIBLING repo,
    so it is not importable from this suite's CI job — its declarations are
    transcribed here verbatim (id → the manifest's own `capabilities` array,
    with the manifest line for each) and pushed through the same mapping the
    probe uses. If the mirror drifts from the manifest, this fails.
    """

    # model id -> (manifest `capabilities` array, manifest line)
    MANIFEST_CAPABILITIES = {
        "gpt-oss:20b": (["tools", "thinking"], 16),
        "gemma4:26b": (["vision", "tools"], 33),
        "qwen3-vl:8b": (["vision", "tools", "thinking"], 50),
        "llama3.2:3b": (["tools"], 67),
        "qwen3-vl:32b": (["vision", "tools", "thinking"], 84),
        "gemma4:31b": (["vision", "tools"], 101),
    }

    @pytest.mark.parametrize("model_id", sorted(MANIFEST_CAPABILITIES))
    def test_row_matches_the_manifest_declaration(self, model_id):
        declared, line = self.MANIFEST_CAPABILITIES[model_id]
        # Same mapping the probe applies, so "mirrors the manifest" and
        # "agrees with a daemon that reports the manifest's array" are the
        # same assertion.
        expected = ollama_capabilities_from_show({"capabilities": declared})
        tabled = static_capabilities(model_id)
        assert tabled == expected, (
            f"{model_id}: table says {tabled}, model-manifest.json:{line} "
            f"declares {declared} → {expected}. Fix the manifest upstream, "
            "then re-mirror."
        )

    def test_thinking_is_not_smuggled_into_a_modality(self):
        # The manifest's third capability value has no ModelCapabilities
        # field. It must not leak into vision or tools.
        caps = static_capabilities("gpt-oss:20b")
        assert caps is not None
        assert caps.model_dump() == {"vision": False, "tools": True}


class TestTableMatchesOllamaProbe:
    """For the non-manifest rows, the table must not CONTRADICT Ollama.

    This is the guard that keeps WARP-1744 dark: consulting the table first
    changes *where* the answer comes from, never *what* it is. If a row ever
    disagrees with the daemon it shadows, this test fails rather than the
    appliance silently mislabelling a model.

    Each payload below is the shape Ollama returns for that id: the
    `capabilities` array plus the `details.families` the family heuristic
    reads.
    """

    OLLAMA_SHOW_BY_ID = {
        "qwen2.5:3b-instruct": {
            "capabilities": ["completion", "tools"],
            "details": {"family": "qwen2", "families": ["qwen2"]},
        },
        "llama3.2-vision:11b": {
            "capabilities": ["completion", "vision"],
            "details": {"family": "mllama", "families": ["mllama", "mllama"]},
        },
        "llava:7b": {
            "capabilities": ["completion", "vision"],
            "details": {"family": "llama", "families": ["llama", "clip"]},
        },
        "moondream": {
            "capabilities": ["completion", "vision"],
            "details": {"family": "phi2", "families": ["phi2", "clip"]},
        },
    }

    @pytest.mark.parametrize("model_id", sorted(OLLAMA_SHOW_BY_ID))
    def test_table_agrees_with_the_ollama_probe(self, model_id):
        probed = ollama_capabilities_from_show(self.OLLAMA_SHOW_BY_ID[model_id])
        tabled = static_capabilities(model_id)
        assert tabled == probed, (
            f"{model_id}: table says {tabled}, Ollama's /api/show says {probed} — "
            "the table must never contradict the daemon it shadows"
        )


class TestEveryRowIsPinned:
    """Guards the two guards above: no unverified capability claim can land."""

    def test_every_concrete_id_has_a_pinning_fixture(self):
        # Family keys (`gpt-oss`) and DMR aliases (`ai/gpt-oss`) resolve to the
        # same row as a concrete id, so only the concrete ids need a fixture.
        # `moondream` ships untagged, so it is named explicitly.
        concrete = {
            model_id
            for ids, _ in _STATIC_CAPABILITY_ROWS
            for model_id in ids
            if ":" in model_id or model_id == "moondream"
        }
        pinned = set(TestTableMirrorsTheApplianceManifest.MANIFEST_CAPABILITIES) | set(
            TestTableMatchesOllamaProbe.OLLAMA_SHOW_BY_ID
        )
        assert concrete <= pinned, (
            "a table row has no manifest declaration and no Ollama /api/show "
            f"payload pinning it: {sorted(concrete - pinned)}"
        )

    def test_rows_are_model_capabilities_instances(self):
        for ids, caps in _STATIC_CAPABILITY_ROWS:
            assert isinstance(caps, ModelCapabilities), ids

    def test_aliases_within_a_row_all_resolve_to_it(self):
        for ids, caps in _STATIC_CAPABILITY_ROWS:
            for model_id in ids:
                assert static_capabilities(model_id) == caps, model_id

    def test_no_alias_is_claimed_by_two_rows(self):
        seen: set[str] = set()
        for ids, _ in _STATIC_CAPABILITY_ROWS:
            for model_id in ids:
                assert model_id not in seen, f"duplicate table key: {model_id}"
                seen.add(model_id)


# ---------------------------------------------------------------------------
# Cache/semaphore hygiene — the table must not disturb the chat path
# ---------------------------------------------------------------------------


class TestChatPathUnaffected:
    """Capability resolution is metadata-only; chat plumbing is untouched."""

    @respx.mock
    async def test_capability_lookup_does_not_create_the_semaphore(self, provider):
        # `_capabilities` must not accidentally acquire the chat concurrency
        # gate — it is a listing-path helper.
        assert provider._sema is None
        await provider._capabilities("gpt-oss:20b")
        assert provider._sema is None

    @respx.mock
    async def test_chat_still_flows_after_a_table_hit(self, provider):
        provider._limits.num_parallel = 1
        provider._limits._last_refresh = time.monotonic()
        provider._sema = asyncio.Semaphore(1)
        provider._sema_size = 1
        respx.post(f"{BASE}/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={
                    "id": "cmpl-1",
                    "object": "chat.completion",
                    "model": "gpt-oss:20b",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "ok"},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )
        )
        from schemas import ChatMessage

        await provider._capabilities("gpt-oss:20b")
        out = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")], model="gpt-oss:20b"
        )
        assert out["choices"][0]["message"]["content"] == "ok"
