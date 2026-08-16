"""embed_texts must split oversized calls into gateway-sized batches.

The ai-gateway caps a single EmbedText RPC at MAX_BATCH_SIZE (256,
providers/embeddings.py) and fails the whole request with INTERNAL
"Batch size N exceeds maximum 256" rather than splitting. The watcher hands
embed_texts every chunk of a document at once, so an unsplit call meant any
document over ~256 chunks failed to index entirely — and because the trigger
is document size, the largest files were exactly the ones lost.
"""
from __future__ import annotations

import sys
import types

import pytest

import embedder


GATEWAY_MAX_BATCH_SIZE = 256  # mirrors ai-gateway providers/embeddings.py


class _FakeStub:
    """Records the size of every EmbedText request it receives."""

    def __init__(self) -> None:
        self.batch_sizes: list[int] = []
        self.models: list[str] = []

    def EmbedText(self, request, timeout=None):  # noqa: N802 — gRPC stub naming
        self.batch_sizes.append(len(request.texts))
        self.models.append(request.model)
        # Echo each input back as a 1-dim vector holding its own index within
        # this batch offset by the running total, so the caller's ordering is
        # checkable end to end.
        base = sum(self.batch_sizes[:-1])
        return types.SimpleNamespace(
            embeddings=[
                types.SimpleNamespace(values=[float(base + i)])
                for i in range(len(request.texts))
            ]
        )


@pytest.fixture
def stub(monkeypatch):
    """Install a fake grpc_generated.inference_pb2 and a recording stub.

    grpc_generated is produced by protoc at image-build time and is absent
    from the repo, so tests must supply it.
    """
    pb2 = types.ModuleType("grpc_generated.inference_pb2")

    class EmbedRequest:
        def __init__(self, texts, model):
            self.texts = list(texts)
            self.model = model

    pb2.EmbedRequest = EmbedRequest

    pkg = types.ModuleType("grpc_generated")
    pkg.inference_pb2 = pb2
    monkeypatch.setitem(sys.modules, "grpc_generated", pkg)
    monkeypatch.setitem(sys.modules, "grpc_generated.inference_pb2", pb2)

    fake = _FakeStub()
    monkeypatch.setattr(embedder, "_get_stub", lambda: fake)
    return fake


def test_no_batch_ever_exceeds_the_gateway_cap(stub):
    """The regression: 821 chunks used to go out as one rejected request."""
    embedder.embed_texts([f"chunk {i}" for i in range(821)])

    assert stub.batch_sizes, "no request was sent"
    assert max(stub.batch_sizes) <= GATEWAY_MAX_BATCH_SIZE


def test_all_inputs_are_embedded_in_order(stub, monkeypatch):
    monkeypatch.setattr(embedder, "EMBED_MAX_BATCH", 3)

    vectors = embedder.embed_texts([f"chunk {i}" for i in range(10)])

    assert stub.batch_sizes == [3, 3, 3, 1]
    # One vector per input, in input order — the watcher zips vectors against
    # its chunk list positionally and warns on a count mismatch.
    assert len(vectors) == 10
    assert vectors == [[float(i)] for i in range(10)]


def test_single_batch_sends_exactly_one_request(stub, monkeypatch):
    monkeypatch.setattr(embedder, "EMBED_MAX_BATCH", 256)

    embedder.embed_texts([f"chunk {i}" for i in range(256)])

    assert stub.batch_sizes == [256]


def test_empty_input_sends_no_request(stub):
    assert embedder.embed_texts([]) == []
    assert stub.batch_sizes == []


def test_model_is_forwarded_on_every_batch(stub, monkeypatch):
    monkeypatch.setattr(embedder, "EMBED_MAX_BATCH", 2)

    embedder.embed_texts(["a", "b", "c"], model="all-MiniLM-L6-v2")

    assert stub.models == ["all-MiniLM-L6-v2"] * 2


def test_misconfigured_zero_batch_does_not_hang(stub, monkeypatch):
    """A 0/negative override must degrade to one-per-request, not loop forever."""
    monkeypatch.setattr(embedder, "EMBED_MAX_BATCH", 0)

    vectors = embedder.embed_texts(["a", "b"])

    assert stub.batch_sizes == [1, 1]
    assert len(vectors) == 2
