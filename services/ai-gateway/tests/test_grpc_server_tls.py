"""WARP-1061 (hop 16, server half) — ai-gateway gRPC :50051 bind contract.

Flag off ⇒ the historical insecure port; flag on ⇒ secure port fed by
grpc_server_credentials() (server cert + REQUIRED CA-signed client cert).
"""
import sys
from pathlib import Path

SHARED = Path(__file__).resolve().parents[2] / "_shared"
sys.path.insert(0, str(SHARED.parent))

import _shared.internal_tls as internal_tls  # noqa: E402

from grpc_server import bind_grpc_port  # noqa: E402


class FakeServer:
    def __init__(self):
        self.insecure = []
        self.secure = []

    def add_insecure_port(self, addr):
        self.insecure.append(addr)

    def add_secure_port(self, addr, creds):
        self.secure.append((addr, creds))


def test_flag_off_binds_insecure_port(monkeypatch):
    monkeypatch.delenv("DROPLET_INTERNAL_TLS", raising=False)
    server = FakeServer()
    bind_grpc_port(server, 50051)
    assert server.insecure == ["[::]:50051"]
    assert server.secure == []


def test_flag_on_binds_secure_port_with_server_credentials(monkeypatch):
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    sentinel = object()
    # bind_grpc_port imports from _shared.internal_tls at call time, so
    # patching the module attribute intercepts the credential build (the
    # real one reads the /data/service-tls bundle from disk).
    monkeypatch.setattr(internal_tls, "grpc_server_credentials", lambda: sentinel)
    server = FakeServer()
    bind_grpc_port(server, 50051)
    assert server.insecure == []
    assert server.secure == [("[::]:50051", sentinel)]
