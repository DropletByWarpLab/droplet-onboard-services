"""WARP-2196 — EmbedText's model allow-list and repo resolution.

GWV-009 made the allow-list a SECURITY control: `EmbedRequest.model` is an
attacker-influenced string that ends up as `SentenceTransformer(name)`, which
will download any repo on the HuggingFace Hub. Unbounded egress, unbounded
disk, unbounded resident memory, all from one gRPC field.

WARP-2196 adds a second reason the list has to stay closed, and it is not about
egress at all: `bge-small-en-v1.5` and `all-MiniLM-L6-v2` are BOTH 384-dimensional,
so Postgres accepts vectors from either into the same `vector(384)` column
without complaint. They are different vector spaces. Cosine distance between a
MiniLM vector and a bge vector is noise, and nothing anywhere would report it.
The dimension check that catches an obviously-wrong model passes here — which
is exactly why the id, not the width, has to be the gate.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

import pytest

try:
    import grpc  # noqa: F401

    _deps_available = True
except ImportError:
    _deps_available = False

pytestmark = pytest.mark.skipif(
    not _deps_available, reason="gRPC dependencies not installed"
)


# ---------------------------------------------------------------------------
# providers.embeddings — short id -> fully-qualified Hub repo
# ---------------------------------------------------------------------------


def test_default_model_is_bge_small_en_v1_5():
    from providers import embeddings

    assert embeddings.DEFAULT_MODEL == "bge-small-en-v1.5"


def test_repo_for_maps_the_short_id_to_the_baai_org():
    """`SentenceTransformer("bge-small-en-v1.5")` does NOT work.

    With no org, sentence-transformers falls back to `sentence-transformers/`,
    and `sentence-transformers/bge-small-en-v1.5` does not exist — the load
    raises RepositoryNotFoundError. The wire carries the short id, so the
    gateway has to resolve it explicitly.
    """
    from providers import embeddings

    assert embeddings.repo_for("bge-small-en-v1.5") == "BAAI/bge-small-en-v1.5"


def test_empty_model_resolves_to_the_default_repo():
    """`""` is the proto default — "caller expressed no preference"."""
    from providers import embeddings

    assert embeddings.repo_for("") == embeddings.repo_for(embeddings.DEFAULT_MODEL)
    assert embeddings.repo_for(None) == embeddings.repo_for(embeddings.DEFAULT_MODEL)


def test_unsupported_model_never_reaches_the_hub():
    """An unmapped id must raise before any download is attempted."""
    from providers import embeddings

    with pytest.raises(ValueError) as exc:
        embeddings.repo_for("gpt2")
    assert "gpt2" in str(exc.value)


def test_minilm_is_not_resolvable_through_the_gateway():
    """The old model is deliberately NOT reachable any more.

    Mixing MiniLM and bge vectors in one `vector(384)` column is undetectable
    corruption. A box that still has the old id pinned in `.env` must fail
    loudly and stop writing, not quietly poison the corpus it is being
    re-embedded into.
    """
    from providers import embeddings

    with pytest.raises(ValueError):
        embeddings.repo_for("all-MiniLM-L6-v2")


def test_embed_texts_rejects_an_unsupported_model_before_loading(monkeypatch):
    """Defence in depth: the provider gates too, not just the RPC handler."""
    from providers import embeddings

    def _must_not_load(*a, **k):
        raise AssertionError("model load attempted for an unsupported id")

    monkeypatch.setattr(embeddings, "_get_model", _must_not_load)
    with pytest.raises(ValueError):
        embeddings.embed_texts(["hello"], model="some/malicious-repo")


# ---------------------------------------------------------------------------
# grpc_server — the allow-list itself
# ---------------------------------------------------------------------------


def _install_proto_stubs() -> None:
    pkg = types.ModuleType("grpc_generated")
    pkg.__path__ = []  # type: ignore[attr-defined]
    pb2 = types.ModuleType("grpc_generated.inference_pb2")
    for name in (
        "ChatResponse",
        "ChatChunk",
        "ModelList",
        "ModelInfo",
        "Usage",
        "EmbedResponse",
        "FloatArray",
        "RerankResponse",
        "RerankResult",
    ):
        setattr(pb2, name, MagicMock(name=name))
    pb2_grpc = types.ModuleType("grpc_generated.inference_pb2_grpc")

    class _Servicer:
        pass

    pb2_grpc.InferenceServiceServicer = _Servicer
    pkg.inference_pb2 = pb2  # type: ignore[attr-defined]
    pkg.inference_pb2_grpc = pb2_grpc  # type: ignore[attr-defined]
    sys.modules.setdefault("grpc_generated", pkg)
    sys.modules.setdefault("grpc_generated.inference_pb2", pb2)
    sys.modules.setdefault("grpc_generated.inference_pb2_grpc", pb2_grpc)


def test_allowlist_holds_exactly_the_proto_default_and_bge():
    _install_proto_stubs()
    from grpc_server import InferenceServicer

    assert InferenceServicer._EMBED_SUPPORTED_MODELS == frozenset(
        {"", "bge-small-en-v1.5"}
    )


def test_allowlist_cannot_drift_from_the_provider_resolver():
    """The two lists are one list. A new model must be added in one place."""
    _install_proto_stubs()
    from grpc_server import InferenceServicer
    from providers import embeddings

    assert InferenceServicer._EMBED_SUPPORTED_MODELS == frozenset(
        {""} | set(embeddings.SUPPORTED_MODELS)
    )


def test_allowlist_is_still_closed():
    """Regression guard: never a wildcard, never empty, never unbounded."""
    _install_proto_stubs()
    from grpc_server import InferenceServicer

    allowed = InferenceServicer._EMBED_SUPPORTED_MODELS
    assert isinstance(allowed, frozenset)
    for hostile in (
        "gpt2",
        "*",
        "BAAI/bge-large-en-v1.5",
        "../../etc/passwd",
        "attacker/500gb-model",
    ):
        assert hostile not in allowed


# ---------------------------------------------------------------------------
# The RPC handler must actually USE the allow-list
# ---------------------------------------------------------------------------
#
# Re-QA finding: the constant had three tests, its enforcement site had none —
# deleting the INVALID_ARGUMENT block left this suite byte-identical. The
# security property survives regardless (`embed_texts` calls `repo_for`, which
# IS tested, so an unsupported id still cannot reach the Hub), but
# `docs/RAG_RE_EMBED_RUNBOOK.md` section 4 promises the operator
# INVALID_ARGUMENT specifically for a box still pinning the old model id, and
# nothing held that contract.
#
# This enforcement site is pre-existing GWV-009; WARP-2196 changed the
# constant's contents, not the check. These tests close an inherited gap.


class _Aborted(BaseException):
    """Stands in for grpc's abort, which does not return to the caller.

    BaseException so the handler's `except Exception` cannot swallow it and
    blur what the test is asserting.
    """


def _abort_context():
    import grpc as _grpc

    ctx = MagicMock()
    seen = {}

    async def _abort(code, details):
        seen["code"] = code
        seen["details"] = details
        raise _Aborted()

    ctx.abort = _abort
    ctx._seen = seen
    ctx._grpc = _grpc
    return ctx, seen


def _embed_request(model):
    req = MagicMock()
    req.texts = ["hello"]
    req.model = model
    req.HasField = MagicMock(return_value=model is not None)
    return req


def _servicer_with_stub_embedder(monkeypatch, recorder):
    _install_proto_stubs()
    mod = types.ModuleType("providers.embeddings")
    mod.embed_texts = recorder
    pkg = types.ModuleType("providers")
    monkeypatch.setitem(sys.modules, "providers", pkg)
    monkeypatch.setitem(sys.modules, "providers.embeddings", mod)

    from grpc_server import InferenceServicer

    return InferenceServicer(MagicMock(), MagicMock())


@pytest.mark.asyncio
async def test_embed_text_aborts_invalid_argument_for_an_unsupported_model(
    monkeypatch,
):
    import grpc

    calls = []
    servicer = _servicer_with_stub_embedder(
        monkeypatch, lambda *a, **k: calls.append(a) or [[0.0]]
    )
    ctx, seen = _abort_context()

    with pytest.raises(_Aborted):
        await servicer.EmbedText(_embed_request("gpt2"), ctx)

    assert seen["code"] == grpc.StatusCode.INVALID_ARGUMENT
    assert "gpt2" in seen["details"]
    assert calls == [], "the model must never reach the embedder"


@pytest.mark.asyncio
async def test_embed_text_aborts_for_the_retired_minilm_id(monkeypatch):
    """The exact case runbook section 4 tells the operator to expect.

    A box that still pins EMBEDDING_MODEL=all-MiniLM-L6-v2 must fail closed
    and loudly rather than write vectors from a second model into the corpus.
    """
    import grpc

    calls = []
    servicer = _servicer_with_stub_embedder(
        monkeypatch, lambda *a, **k: calls.append(a) or [[0.0]]
    )
    ctx, seen = _abort_context()

    with pytest.raises(_Aborted):
        await servicer.EmbedText(_embed_request("all-MiniLM-L6-v2"), ctx)

    assert seen["code"] == grpc.StatusCode.INVALID_ARGUMENT
    assert "all-MiniLM-L6-v2" in seen["details"]
    # The message names what IS allowed, so the operator can act on it.
    assert "bge-small-en-v1.5" in seen["details"]
    assert calls == []


@pytest.mark.asyncio
async def test_embed_text_allows_the_supported_model(monkeypatch):
    """The gate must not be a wall — the shipped id has to get through."""
    calls = []

    def _recorder(texts, model):
        calls.append(model)
        return [[0.1, 0.2]]

    servicer = _servicer_with_stub_embedder(monkeypatch, _recorder)
    ctx, seen = _abort_context()

    await servicer.EmbedText(_embed_request("bge-small-en-v1.5"), ctx)

    assert seen == {}, "a supported model must not abort"
    assert calls == ["bge-small-en-v1.5"]


@pytest.mark.asyncio
async def test_embed_text_allows_the_proto_default(monkeypatch):
    """`model` unset means "no preference" and resolves to DEFAULT_MODEL."""
    calls = []

    def _recorder(texts, model):
        calls.append(model)
        return [[0.1, 0.2]]

    servicer = _servicer_with_stub_embedder(monkeypatch, _recorder)
    ctx, seen = _abort_context()

    await servicer.EmbedText(_embed_request(None), ctx)

    assert seen == {}
    assert calls == [None]
