"""WARP-1061 — host-side anomaly shipping under internal mTLS.

Flag off ⇒ plain http:// URL and no SSL context (byte-identical to WARP-268);
flag on ⇒ https:// URL and a client context built from the host-issued
`egress-audit` bundle (paths from the standard DROPLET_TLS_* contract, which
the launcher exports)."""
from __future__ import annotations

import sink


class _FakeResponse:
    status = 202

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_flag_off_plain_url_and_no_context(monkeypatch):
    monkeypatch.delenv("DROPLET_INTERNAL_TLS", raising=False)
    assert sink.internal_tls_context() is None
    assert sink.internal_base_url("http://127.0.0.1:3000") == "http://127.0.0.1:3000"

    seen = {}

    def fake_urlopen(request, timeout, context):
        seen["url"] = request.full_url
        seen["context"] = context
        return _FakeResponse()

    monkeypatch.setattr(sink.urllib.request, "urlopen", fake_urlopen)
    client = sink.OrchestratorClient("http://127.0.0.1:3000", "tok")
    assert client.post_anomaly({"x": 1}) is True
    assert seen["url"] == "http://127.0.0.1:3000/api/security/egress-anomaly"
    assert seen["context"] is None


def test_flag_on_https_url_and_client_cert_context(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))

    built = {}

    class FakeCtx:
        def load_cert_chain(self, certfile, keyfile):
            built["chain"] = (certfile, keyfile)

    def fake_default_context(cafile=None):
        built["cafile"] = cafile
        return FakeCtx()

    monkeypatch.setattr(sink.ssl, "create_default_context", fake_default_context)

    assert sink.internal_base_url("http://127.0.0.1:3000") == "https://127.0.0.1:3000"

    seen = {}

    def fake_urlopen(request, timeout, context):
        seen["url"] = request.full_url
        seen["context"] = context
        return _FakeResponse()

    monkeypatch.setattr(sink.urllib.request, "urlopen", fake_urlopen)
    client = sink.OrchestratorClient("http://127.0.0.1:3000", "tok")
    assert client.post_anomaly({"x": 1}) is True
    assert seen["url"] == "https://127.0.0.1:3000/api/security/egress-anomaly"
    assert isinstance(seen["context"], FakeCtx)
    assert built["cafile"] == str(tmp_path / "ca.pem")
    assert built["chain"] == (str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))
