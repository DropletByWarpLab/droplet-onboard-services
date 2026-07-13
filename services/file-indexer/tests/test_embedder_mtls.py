"""WARP-1061 (hop 16, client half) — file-indexer → ai-gateway gRPC channel.

Flag off ⇒ the historical insecure channel; flag on ⇒ secure channel fed by
grpc_channel_credentials() (client cert + trust pinned to the internal CA).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/ for _shared
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # file-indexer root

import _shared.internal_tls as internal_tls  # noqa: E402

import embedder  # noqa: E402


def test_flag_off_uses_insecure_channel(monkeypatch):
    monkeypatch.delenv("DROPLET_INTERNAL_TLS", raising=False)
    seen = {}
    monkeypatch.setattr(
        embedder.grpc, "insecure_channel",
        lambda target: seen.setdefault("insecure", target),
    )
    monkeypatch.setattr(
        embedder.grpc, "secure_channel",
        lambda target, creds: seen.setdefault("secure", (target, creds)),
    )
    embedder._create_channel()
    assert seen == {"insecure": embedder.AI_GATEWAY_GRPC_URL}


def test_flag_on_uses_secure_channel_with_bundle_credentials(monkeypatch):
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    sentinel = object()
    # _create_channel imports from _shared.internal_tls at call time, so
    # patching the module attribute intercepts the credential build (the
    # real one reads the /data/service-tls bundle from disk).
    monkeypatch.setattr(internal_tls, "grpc_channel_credentials", lambda: sentinel)
    seen = {}
    monkeypatch.setattr(
        embedder.grpc, "insecure_channel",
        lambda target: seen.setdefault("insecure", target),
    )
    monkeypatch.setattr(
        embedder.grpc, "secure_channel",
        lambda target, creds: seen.setdefault("secure", (target, creds)),
    )
    embedder._create_channel()
    assert seen == {"secure": (embedder.AI_GATEWAY_GRPC_URL, sentinel)}
