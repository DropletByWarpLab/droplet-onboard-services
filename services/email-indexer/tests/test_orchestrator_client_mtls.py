"""WARP-236 — email-indexer orchestrator client presents certs + https base."""
import asyncio
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/ for _shared
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # email-indexer root


def test_ingest_uses_https_and_cert_kwargs(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))
    monkeypatch.setenv("ORCHESTRATOR_SERVICE_TOKEN", "svc-token")
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orchestrator:3000")

    import orchestrator_client as oc
    oc = importlib.reload(oc)

    seen = {}

    class FakeResp:
        status_code = 201
        text = ""

    class FakeClient:
        def __init__(self, **kwargs):
            seen["client_kwargs"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, **kwargs):
            seen["url"] = url
            return FakeResp()

    monkeypatch.setattr(oc.httpx, "AsyncClient", FakeClient)

    ok = asyncio.run(oc.ingest_message("acct1", {"x": 1}))
    assert ok is True
    assert seen["url"].startswith("https://orchestrator:3000")
    assert seen["client_kwargs"]["cert"] == (str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))
    assert seen["client_kwargs"]["verify"] == str(tmp_path / "ca.pem")
