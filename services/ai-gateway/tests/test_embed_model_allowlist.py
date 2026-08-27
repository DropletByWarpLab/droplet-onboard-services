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
