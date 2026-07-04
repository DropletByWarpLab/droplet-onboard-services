"""WARP-236 — unit tests for the shared internal-TLS helper (services/_shared)."""
import importlib
import ssl
import sys
from pathlib import Path

SHARED = Path(__file__).resolve().parents[2] / "_shared"
sys.path.insert(0, str(SHARED.parent))


def _reload(monkeypatch, **env):
    for k in ("DROPLET_INTERNAL_TLS", "DROPLET_TLS_CERT", "DROPLET_TLS_KEY", "DROPLET_TLS_CA"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import _shared.internal_tls as it
    return importlib.reload(it)


def test_disabled_by_default(monkeypatch):
    it = _reload(monkeypatch)
    assert it.enabled() is False
    assert it.uvicorn_ssl_kwargs() == {}
    assert it.httpx_client_kwargs() == {}
    assert it.base_url("http://orchestrator:3000") == "http://orchestrator:3000"


def test_enabled_kwargs_and_scheme(monkeypatch, tmp_path):
    cert, key, ca = tmp_path / "c.pem", tmp_path / "k.pem", tmp_path / "ca.pem"
    for f in (cert, key, ca):
        f.write_text("PEM")
    it = _reload(
        monkeypatch,
        DROPLET_INTERNAL_TLS="1",
        DROPLET_TLS_CERT=str(cert),
        DROPLET_TLS_KEY=str(key),
        DROPLET_TLS_CA=str(ca),
    )
    assert it.enabled() is True
    kw = it.uvicorn_ssl_kwargs()
    assert kw == {
        "ssl_certfile": str(cert),
        "ssl_keyfile": str(key),
        "ssl_ca_certs": str(ca),
        "ssl_cert_reqs": ssl.CERT_REQUIRED,
    }
    assert it.httpx_client_kwargs() == {"cert": (str(cert), str(key)), "verify": str(ca)}
    assert it.base_url("http://orchestrator:3000/api") == "https://orchestrator:3000/api"


def test_paho_configure(monkeypatch, tmp_path):
    cert, key, ca = tmp_path / "c.pem", tmp_path / "k.pem", tmp_path / "ca.pem"
    for f in (cert, key, ca):
        f.write_text("PEM")
    it = _reload(monkeypatch, DROPLET_INTERNAL_TLS="1",
                 DROPLET_TLS_CERT=str(cert), DROPLET_TLS_KEY=str(key), DROPLET_TLS_CA=str(ca))

    class FakeClient:
        def __init__(self):
            self.calls = []
        def tls_set(self, ca_certs=None, certfile=None, keyfile=None):
            self.calls.append((ca_certs, certfile, keyfile))

    c = FakeClient()
    it.paho_configure(c)
    assert c.calls == [(str(ca), str(cert), str(key))]
