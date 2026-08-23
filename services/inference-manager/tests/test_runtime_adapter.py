"""Tests for the inference-runtime adapter (WARP-1743 / ADR-005 §1).

Two jobs, in priority order.

**1. Prove the default path did not move.** ``tests/test_lifecycle.py``,
``test_models.py`` and ``test_health.py`` are the real regression guard — they
were written against the pre-adapter code and pass unedited. The Ollama tests
here are the belt to their braces: they pin the exact bytes on the wire
(``{"name": ..., "stream": false}`` to ``/api/pull``, a JSON-body DELETE to
``/api/delete``) so a future "tidy-up" of the adapter cannot quietly change the
request the appliance has always sent.

**2. Cover the DMR path, which nothing else can reach.** It ships dark, so no
end-to-end test exercises it; these are the only tests it has.

Mocking follows the existing suite: ``respx_mock`` intercepting a real
``httpx.AsyncClient`` at the transport layer, so the adapters are exercised
through genuine request construction rather than a hand-rolled double.
"""

from __future__ import annotations

import json
import os

import httpx
import pytest
from httpx import Response

from runtime import (
    DEFAULT_BASE_URL,
    DEFAULT_RUNTIME,
    DmrRuntime,
    InferenceRuntime,
    OllamaRuntime,
    RuntimePullError,
    UnknownRuntimeError,
    build_runtime,
    resolve_base_url,
    resolve_runtime_name,
)
from runtime.dmr import to_runtime_id

OLLAMA_BASE = "http://mock-ollama:11434"
DMR_BASE = "http://mock-dmr:12434"


@pytest.fixture
async def ollama_client():
    async with httpx.AsyncClient(base_url=OLLAMA_BASE) as c:
        yield c


@pytest.fixture
async def dmr_client():
    async with httpx.AsyncClient(base_url=DMR_BASE) as c:
        yield c


# ── factory: selection is an explicit value, never an inference ──


def test_factory_default_is_ollama():
    """No INFERENCE_RUNTIME set — the state every deployed appliance is in
    today — resolves to Ollama. This is the ships-dark assertion (ADR-005 §8):
    the DMR path cannot be reached without someone writing `dmr` down."""
    assert resolve_runtime_name(env={}) == DEFAULT_RUNTIME == "ollama"


def test_factory_builds_ollama_by_default(ollama_client):
    assert isinstance(build_runtime(ollama_client, env={}), OllamaRuntime)


def test_factory_selects_dmr_only_by_explicit_value(dmr_client):
    runtime = build_runtime(dmr_client, env={"INFERENCE_RUNTIME": "dmr"})
    assert isinstance(runtime, DmrRuntime)
    assert runtime.name == "dmr"


@pytest.mark.parametrize("value", ["Ollama", "  DMR  ", "OLLAMA"])
def test_factory_is_case_and_whitespace_tolerant(value, ollama_client):
    """Env vars arrive from compose files and shells; casing/padding is a typo
    class, not a different backend."""
    assert resolve_runtime_name(env={"INFERENCE_RUNTIME": value}) in ("ollama", "dmr")


@pytest.mark.parametrize("value", ["dmr-rocm", "vllm", "ollama2", "true"])
def test_factory_unknown_value_raises(value):
    """An unrecognised backend is fatal, never a silent fall-back to the default.

    A box configured for a backend it is not running would otherwise look
    perfectly healthy while serving from the wrong daemon — the silent-
    degradation failure mode ADR-005 §3 exists to prevent.
    """
    with pytest.raises(UnknownRuntimeError) as excinfo:
        resolve_runtime_name(env={"INFERENCE_RUNTIME": value})
    # The message must name both the offending value and the legal set, or the
    # operator reading a crash loop learns nothing.
    assert value in str(excinfo.value)
    assert "ollama" in str(excinfo.value)
    assert "dmr" in str(excinfo.value)


def test_factory_build_rejects_unknown_name(ollama_client):
    """The guard holds on the explicit-name path too, not just the env path."""
    with pytest.raises(UnknownRuntimeError):
        build_runtime(ollama_client, name="vllm")


@pytest.mark.parametrize("blank", ["", "   "])
def test_factory_blank_value_is_the_default_not_a_crash(blank):
    """`INFERENCE_RUNTIME=${INFERENCE_RUNTIME:-}` in a compose file hands the
    process an empty string. That means *nothing was configured*, so it resolves
    to the default — taking down every appliance shipping that line would be a
    self-inflicted outage. Distinct from an unknown value, which does raise."""
    assert resolve_runtime_name(env={"INFERENCE_RUNTIME": blank}) == "ollama"


# ── factory: base-url resolution defaults to today's value, exactly ──


def test_base_url_defaults_to_ollama_url():
    assert resolve_base_url(env={"OLLAMA_URL": "http://ollama:11434"}) == "http://ollama:11434"


def test_base_url_falls_back_to_the_historical_literal():
    assert resolve_base_url(env={}) == DEFAULT_BASE_URL == "http://localhost:11434"


def test_base_url_override_wins():
    resolved = resolve_base_url(
        env={"OLLAMA_URL": "http://ollama:11434", "INFERENCE_RUNTIME_URL": DMR_BASE}
    )
    assert resolved == DMR_BASE


def test_blank_override_does_not_shadow_ollama_url():
    """The same compose empty-string trap as above: a blank override must not
    blank out the base URL the appliance is actually using."""
    resolved = resolve_base_url(
        env={"OLLAMA_URL": "http://ollama:11434", "INFERENCE_RUNTIME_URL": "  "}
    )
    assert resolved == "http://ollama:11434"


@pytest.mark.skipif(
    bool(os.environ.get("INFERENCE_RUNTIME") or os.environ.get("INFERENCE_RUNTIME_URL")),
    reason="a configured environment invalidates the premise (main resolves these at import)",
)
def test_main_resolves_the_ollama_runtime_with_no_config():
    """End of the ships-dark chain: with no new env var, the module the app
    actually runs selects Ollama and the base URL it always used."""
    import main

    assert main.INFERENCE_RUNTIME == "ollama"
    assert main.INFERENCE_RUNTIME_URL == main.OLLAMA_URL


async def test_main_runtime_helper_binds_the_live_client(client):
    """`_runtime()` hands every handler an Ollama adapter bound to `_client` —
    so `_client` stays the one place the connection is defined, which is what
    lets the pre-existing tests keep swapping it and passing unedited."""
    import main

    runtime = main._runtime()
    assert isinstance(runtime, OllamaRuntime)
    assert runtime.client is main._client


async def test_main_runtime_helper_is_none_before_startup():
    """The 503 "Not ready" guard in every handler still keys off the client."""
    import main

    saved, main._client = main._client, None
    try:
        assert main._runtime() is None
    finally:
        main._client = saved


def test_both_adapters_satisfy_the_contract(ollama_client, dmr_client):
    assert isinstance(OllamaRuntime(ollama_client), InferenceRuntime)
    assert isinstance(DmrRuntime(dmr_client), InferenceRuntime)


# ── Ollama adapter: the wire bytes are pinned ──


async def test_ollama_pull_sends_the_historical_body(ollama_client, respx_mock):
    route = respx_mock.post(f"{OLLAMA_BASE}/api/pull").mock(
        return_value=Response(200, json={"status": "success"})
    )

    result = await OllamaRuntime(ollama_client).pull("llama3.2:3b")

    assert result == {"status": "pulled", "model": "llama3.2:3b"}
    # Byte-for-byte the body main.py sent before WARP-1743 — `name`, not
    # `model`, and an explicit stream:false.
    assert json.loads(route.calls.last.request.content) == {
        "name": "llama3.2:3b",
        "stream": False,
    }


async def test_ollama_delete_sends_a_json_body_not_a_path(ollama_client, respx_mock):
    route = respx_mock.request("DELETE", f"{OLLAMA_BASE}/api/delete").mock(
        return_value=Response(200, json={"status": "success"})
    )

    result = await OllamaRuntime(ollama_client).delete("llama3.2:3b")

    assert result == {"status": "deleted", "model": "llama3.2:3b"}
    assert json.loads(route.calls.last.request.content) == {"name": "llama3.2:3b"}


async def test_ollama_pull_propagates_status_errors_unchanged(ollama_client, respx_mock):
    """main.py maps httpx.HTTPStatusError to the upstream status code. The
    adapter must therefore raise it rather than wrapping it in anything."""
    respx_mock.post(f"{OLLAMA_BASE}/api/pull").mock(
        return_value=Response(404, json={"error": "model not found"})
    )

    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        await OllamaRuntime(ollama_client).pull("nope:1b")
    assert excinfo.value.response.status_code == 404


async def test_ollama_pull_ignores_the_response_body(ollama_client, respx_mock):
    """Pre-WARP-1743 the blocking pull looked only at the status code. DMR gains
    a body check (see below); Ollama must NOT, or the default path moved."""
    respx_mock.post(f"{OLLAMA_BASE}/api/pull").mock(
        return_value=Response(200, content=b'{"status": "error", "error": "disk full"}\n')
    )

    assert await OllamaRuntime(ollama_client).pull("llama3.2:3b") == {
        "status": "pulled",
        "model": "llama3.2:3b",
    }


async def test_ollama_never_translates_the_model_id(ollama_client, respx_mock):
    """Ollama's own ids are what the manifest and every caller already use, so
    an id must reach the daemon exactly as it was handed in."""
    pull = respx_mock.post(f"{OLLAMA_BASE}/api/pull").mock(
        return_value=Response(200, json={"status": "success"})
    )
    delete = respx_mock.request("DELETE", f"{OLLAMA_BASE}/api/delete").mock(
        return_value=Response(200, json={"status": "success"})
    )
    runtime = OllamaRuntime(ollama_client)

    await runtime.pull("gpt-oss:20b")
    await runtime.delete("gpt-oss:20b")

    assert json.loads(pull.calls.last.request.content)["name"] == "gpt-oss:20b"
    assert json.loads(delete.calls.last.request.content)["name"] == "gpt-oss:20b"


# ── model-id translation ──


@pytest.mark.parametrize(
    ("supplied", "expected"),
    [
        ("gpt-oss:20b", "ai/gpt-oss"),
        ("qwen2.5:7b-instruct-q4_K_M", "ai/qwen2.5"),
        ("smollm2", "ai/smollm2"),
        ("  gpt-oss:20b  ", "ai/gpt-oss"),
    ],
)
def test_ollama_ids_become_oci_references(supplied, expected):
    assert to_runtime_id(supplied) == expected


@pytest.mark.parametrize(
    "already_oci",
    ["ai/gpt-oss", "ai/smollm2:360M-Q4_K_M"],
)
def test_translation_keeps_addressable_oci_references_intact(already_oci):
    """A namespaced reference with a MEANINGFUL tag survives untouched.

    The tag is load-bearing — `360M-Q4_K_M` selects a quantization — so
    normalisation must not reach it. Pulling `ai/smollm2` when the caller asked
    for `ai/smollm2:360M-Q4_K_M` would fetch different weights and say nothing.
    """
    assert to_runtime_id(already_oci) == already_oci


@pytest.mark.parametrize(
    ("reported", "expected"),
    [
        # What DMR ACTUALLY emits from /api/tags and /api/ps — verified live on
        # 2026-08-05 against docker/model-runner:v1.2.6, which reported
        # `docker.io/ai/smollm2:latest` for a model pulled as `ai/smollm2`.
        ("docker.io/ai/smollm2:latest", "ai/smollm2"),
        ("docker.io/ai/gpt-oss", "ai/gpt-oss"),
        # A registry host is dropped; a meaningful tag behind it is not.
        ("docker.io/ai/smollm2:360M-Q4_K_M", "ai/smollm2:360M-Q4_K_M"),
        # `:latest` carries no selection information, so it goes.
        ("ai/smollm2:latest", "ai/smollm2"),
        # A registry PORT is not a tag.
        ("localhost:5000/ai/smollm2", "ai/smollm2"),
    ],
)
def test_translation_normalizes_what_dmr_reports(reported, expected):
    """Registry-qualified ids fold back to the form we address by.

    An earlier draft returned anything containing `/` untouched. That leaked
    `docker.io/` straight back into the next request, so nothing DMR reported
    ever compared equal to a manifest entry — the re-pull storm — and the
    three-segment id could not be addressed at all.
    """
    assert to_runtime_id(reported) == expected


@pytest.mark.parametrize(
    "supplied", ["gpt-oss:20b", "ai/gpt-oss", "ai/smollm2:360M-Q4_K_M", "smollm2"]
)
def test_translation_is_idempotent(supplied):
    """The round-trip property that closes the loop: `/models/available` on a
    DMR box lists DMR's own ids, and handing one straight back to
    `/models/pull` must not mangle it into `ai/ai`."""
    once = to_runtime_id(supplied)
    assert to_runtime_id(once) == once
    assert to_runtime_id(to_runtime_id(once)) == once


def test_translation_rejects_an_empty_id():
    with pytest.raises(ValueError):
        to_runtime_id("   ")


@pytest.mark.parametrize(
    ("supplied", "expected"),
    [
        ("gpt-oss:20b", "ai/gpt-oss"),
        ("docker.io/ai/smollm2:latest", "ai/smollm2"),
        ("ai/smollm2:360M-Q4_K_M", "ai/smollm2"),
    ],
)
def test_comparable_id_folds_both_vocabularies_onto_one_key(
    dmr_client, supplied, expected
):
    """Membership asks "is some build of this repository on disk?".

    Manifest names and DMR-reported names have to land on the same key or
    `/models/sync` re-pulls every model on every call. The tag is dropped HERE
    and only here — addressing still goes through `to_runtime_id`, which keeps
    it.
    """
    assert DmrRuntime(dmr_client).comparable_id(supplied) == expected


def test_comparable_id_is_identity_for_ollama(ollama_client):
    """The default path's comparison stays the string equality it always was."""
    assert OllamaRuntime(ollama_client).comparable_id("gpt-oss:20b") == "gpt-oss:20b"


# ── DMR adapter: only delete and the identifier differ ──


async def test_dmr_delete_uses_the_ollama_body_form(dmr_client, respx_mock):
    """Delete is IDENTICAL across the backends — measured, not assumed.

    On 2026-08-05 against a live `docker/model-runner:v1.2.6`,
    `DELETE /api/delete {"name": "ai/smollm2"}` returned 200 and the model
    disappeared from `/api/tags`. An earlier draft assumed the body form was
    Ollama-only and used DMR's native `DELETE /models/{ns}/{name}` instead;
    that bought nothing and could not address the registry-qualified ids DMR
    actually reports.
    """
    route = respx_mock.request("DELETE", f"{DMR_BASE}/api/delete").mock(
        return_value=Response(200, json={"status": "success"})
    )

    result = await DmrRuntime(dmr_client).delete("gpt-oss:20b")

    assert route.called
    assert json.loads(route.calls.last.request.content) == {"name": "ai/gpt-oss"}
    # The caller's identifier comes back, not the OCI one — the /models/* wire
    # contract does not change with the backend.
    assert result == {"status": "deleted", "model": "gpt-oss:20b"}


async def test_dmr_delete_addresses_a_registry_qualified_id(dmr_client, respx_mock):
    """The id DMR itself reports must round-trip into a delete.

    `docker.io/ai/smollm2:latest` is what `/api/tags` hands back. The earlier
    path-form implementation raised ValueError on exactly this shape — three
    segments where the route allows two — so deleting anything the daemon
    listed was impossible.
    """
    route = respx_mock.request("DELETE", f"{DMR_BASE}/api/delete").mock(
        return_value=Response(200, json={"status": "success"})
    )

    await DmrRuntime(dmr_client).delete("docker.io/ai/smollm2:latest")

    assert json.loads(route.calls.last.request.content) == {"name": "ai/smollm2"}


async def test_dmr_pull_translates_the_id_and_hedges_the_key(dmr_client, respx_mock):
    route = respx_mock.post(f"{DMR_BASE}/api/pull").mock(
        return_value=Response(200, content=b'{"status": "success"}\n')
    )

    result = await DmrRuntime(dmr_client).pull("gpt-oss:20b")

    body = json.loads(route.calls.last.request.content)
    assert body["model"] == "ai/gpt-oss"
    assert body["name"] == "ai/gpt-oss"
    assert body["stream"] is False
    assert result == {"status": "pulled", "model": "gpt-oss:20b"}


async def test_dmr_pull_reads_the_streaming_ndjson_shape(dmr_client, respx_mock):
    """DMR's ollama-compat pull streams `{status, digest, total, completed}`
    objects; a blocking pull must accept that body rather than assuming a single
    JSON object."""
    ndjson = (
        b'{"status": "pulling manifest"}\n'
        b'{"status": "downloading", "digest": "sha256:abc", "total": 100, "completed": 50}\n'
        b'{"status": "success"}\n'
    )
    respx_mock.post(f"{DMR_BASE}/api/pull").mock(return_value=Response(200, content=ndjson))

    assert await DmrRuntime(dmr_client).pull("gpt-oss:20b") == {
        "status": "pulled",
        "model": "gpt-oss:20b",
    }


async def test_dmr_pull_surfaces_an_error_reported_inside_a_200(dmr_client, respx_mock):
    """A terminal `{"error": ...}` line in a 200 body is a failed pull. Reporting
    it as `{"status": "pulled"}` would silently lie to /models/sync."""
    ndjson = (
        b'{"status": "pulling manifest"}\n'
        b'{"status": "error", "error": "no space left on device"}\n'
    )
    respx_mock.post(f"{DMR_BASE}/api/pull").mock(return_value=Response(200, content=ndjson))

    with pytest.raises(RuntimePullError) as excinfo:
        await DmrRuntime(dmr_client).pull("gpt-oss:20b")
    assert "no space left on device" in str(excinfo.value)


async def test_dmr_pull_stream_yields_progress_lines(dmr_client, respx_mock):
    """The streaming half: main.py proxies these lines through unchanged, so the
    adapter must hand back a live, iterable upstream response."""
    ndjson = (
        b'{"status": "pulling manifest"}\n'
        b'{"status": "downloading", "digest": "sha256:abc", "total": 100, "completed": 50}\n'
        b'{"status": "success"}\n'
    )
    route = respx_mock.post(f"{DMR_BASE}/api/pull").mock(
        return_value=Response(
            200, content=ndjson, headers={"content-type": "application/x-ndjson"}
        )
    )

    upstream = await DmrRuntime(dmr_client).open_pull_stream("gpt-oss:20b")
    try:
        assert upstream.status_code == 200
        lines = [line async for line in upstream.aiter_lines() if line]
    finally:
        await upstream.aclose()

    assert [json.loads(line)["status"] for line in lines] == [
        "pulling manifest",
        "downloading",
        "success",
    ]
    assert json.loads(lines[1])["completed"] == 50
    assert json.loads(route.calls.last.request.content) == {
        "model": "ai/gpt-oss",
        "name": "ai/gpt-oss",
        "stream": True,
    }


async def test_dmr_pull_stream_hands_back_non_2xx_without_raising(dmr_client, respx_mock):
    """main.py decides what a non-2xx means (close it as a plain error response
    rather than committing to a 200 stream), so the adapter must not raise."""
    respx_mock.post(f"{DMR_BASE}/api/pull").mock(
        return_value=Response(404, content=b'{"error": "model not found"}')
    )

    upstream = await DmrRuntime(dmr_client).open_pull_stream("nope:1b")
    try:
        assert upstream.status_code == 404
    finally:
        await upstream.aclose()


# ── the shared half: identical requests from both adapters ──


@pytest.mark.parametrize("runtime_cls", [OllamaRuntime, DmrRuntime])
async def test_tags_and_ps_are_identical_across_backends(runtime_cls, respx_mock):
    """`/api/tags` and `/api/ps` are field-for-field the same on both daemons
    (ADR-005 §2), so both adapters inherit one implementation. This asserts they
    really do issue the same requests and pass the bodies through untouched —
    including `size_vram`, which Docker's own compat docs omit."""
    base = "http://mock-runtime:11434"
    tags = {"models": [{"name": "m", "size": 1, "details": {"family": "llama"}}]}
    ps = {"models": [{"name": "m", "size": 1, "size_vram": 1, "expires_at": "2099-01-01T00:00:00Z"}]}
    tags_route = respx_mock.get(f"{base}/api/tags").mock(return_value=Response(200, json=tags))
    ps_route = respx_mock.get(f"{base}/api/ps").mock(return_value=Response(200, json=ps))

    async with httpx.AsyncClient(base_url=base) as client:
        runtime = runtime_cls(client)
        assert await runtime.list_installed() == tags
        assert await runtime.list_loaded() == ps
        assert await runtime.health() is True

    assert tags_route.call_count == 2  # list_installed + health
    assert ps_route.call_count == 1


@pytest.mark.parametrize("runtime_cls", [OllamaRuntime, DmrRuntime])
async def test_health_is_false_when_unreachable(runtime_cls, respx_mock):
    base = "http://mock-runtime:11434"
    respx_mock.get(f"{base}/api/tags").mock(side_effect=httpx.ConnectError("nope"))

    async with httpx.AsyncClient(base_url=base) as client:
        assert await runtime_cls(client).health() is False


@pytest.mark.parametrize("runtime_cls", [OllamaRuntime, DmrRuntime])
async def test_health_is_false_on_a_non_200(runtime_cls, respx_mock):
    base = "http://mock-runtime:11434"
    respx_mock.get(f"{base}/api/tags").mock(return_value=Response(500))

    async with httpx.AsyncClient(base_url=base) as client:
        assert await runtime_cls(client).health() is False


@pytest.mark.parametrize("runtime_cls", [OllamaRuntime, DmrRuntime])
async def test_listings_raise_for_status(runtime_cls, respx_mock):
    """`/models/available` maps any failure to 502 via its `except Exception`;
    that only works if the adapter raises instead of returning an error body."""
    base = "http://mock-runtime:11434"
    respx_mock.get(f"{base}/api/tags").mock(return_value=Response(503))

    async with httpx.AsyncClient(base_url=base) as client:
        with pytest.raises(httpx.HTTPStatusError):
            await runtime_cls(client).list_installed()


# ── WARP-2130 / ADR-005 §2: preferred_id — which manifest id addresses this
#    backend. The choice is runtime-dependent, so it lives in the adapter.


def test_ollama_preferred_id_ignores_a_declared_oci(ollama_client):
    """Ollama resolves against registry.ollama.ai, where `ai/foo:bar` names
    nothing. The declared reference is deliberately IGNORED rather than
    preferred, so this path is byte-identical to its pre-field behaviour."""
    runtime = build_runtime(ollama_client, env={})
    assert runtime.name == "ollama"
    assert runtime.preferred_id("foo:31b", "ai/foo:reap-q4_K_M") == "foo:31b"
    assert runtime.preferred_id("foo:31b", None) == "foo:31b"


def test_dmr_preferred_id_prefers_a_declared_oci(dmr_client):
    runtime = build_runtime(dmr_client, env={"INFERENCE_RUNTIME": "dmr"})
    assert runtime.preferred_id("foo:31b", "ai/foo:reap-q4_K_M") == "ai/foo:reap-q4_K_M"


@pytest.mark.parametrize("undeclared", [None, "", "   "])
def test_dmr_preferred_id_falls_back_when_undeclared(dmr_client, undeclared):
    """Every entry predating the field keeps its exact behaviour. A blank value
    counts as undeclared — a compose-style `${VAR:-}` expansion landing in a
    manifest must not address the empty repository."""
    runtime = build_runtime(dmr_client, env={"INFERENCE_RUNTIME": "dmr"})
    assert runtime.preferred_id("foo:31b", undeclared) == "foo:31b"


def test_declared_oci_survives_to_the_wire_with_its_tag(dmr_client):
    """THE point of the field, stated as the property it buys.

    `to_runtime_id` drops the tag off a bare Ollama id on purpose — "the OCI
    equivalent lives in the tag of the OCI reference, which we cannot derive".
    An OCI tag is what selects a quantization, so without a declaration the
    manifest cannot say which build the appliance serves and the daemon
    resolves `latest`.

    A DECLARED reference already carries a namespace separator, so
    `to_runtime_id` normalises rather than derives, and the tag survives.
    """
    runtime = build_runtime(dmr_client, env={"INFERENCE_RUNTIME": "dmr"})

    # Undeclared: the tag is gone by the time it reaches the wire.
    assert to_runtime_id(runtime.preferred_id("glm-4.7-flash:31b", None)) == (
        "ai/glm-4.7-flash"
    )
    # Declared: the tag survives — this is what pins the quantization.
    assert to_runtime_id(
        runtime.preferred_id("glm-4.7-flash:31b", "ai/glm-4.7-flash:reap-q4_K_M")
    ) == "ai/glm-4.7-flash:reap-q4_K_M"


def test_declared_oci_still_compares_equal_for_membership(dmr_client):
    """`comparable_id` asks "is some build of this repository installed?", so a
    declared reference and the derived one must still fold onto ONE key —
    otherwise the catalog's `pulled` flag and /models/sync would disagree about
    the same model depending on which identifier they happened to hold."""
    runtime = build_runtime(dmr_client, env={"INFERENCE_RUNTIME": "dmr"})
    assert runtime.comparable_id("glm-4.7-flash:31b") == "ai/glm-4.7-flash"
    assert runtime.comparable_id("ai/glm-4.7-flash:reap-q4_K_M") == "ai/glm-4.7-flash"
    assert runtime.comparable_id("docker.io/ai/glm-4.7-flash:reap-q4_K_M") == (
        "ai/glm-4.7-flash"
    )
