"""WARP-236 — ops-console probes present certs + rewrite first-party URLs to https."""
import asyncio
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/ for _shared
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # ops-console root


def test_probe_client_kwargs_and_scheme(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))

    import ops.services as svc
    svc = importlib.reload(svc)

    seen = {}

    class FakeResp:
        status_code = 200

    class FakeClient:
        def __init__(self, **kwargs):
            seen["client_kwargs"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, timeout=None):
            seen.setdefault("urls", []).append(url)
            return FakeResp()

    monkeypatch.setattr(svc.httpx, "AsyncClient", FakeClient)

    # A single first-party target — orchestrator health.
    reg = {"orchestrator": "http://orchestrator:3000/api/orchestrator/health"}
    asyncio.run(svc.probe_all(reg))

    assert seen["client_kwargs"]["cert"] == (str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))
    assert seen["client_kwargs"]["verify"] == str(tmp_path / "ca.pem")
    assert seen["urls"] == ["https://orchestrator:3000/api/orchestrator/health"]


def test_exempt_plaintext_targets_not_rewritten(monkeypatch, tmp_path):
    """WARP-1061: frigate/web-dashboard/nextcloud/mcp-server stay http:// even
    with the flag on — their listeners are documented plaintext exemptions."""
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))

    import ops.services as svc
    svc = importlib.reload(svc)

    seen = {}

    class FakeResp:
        status_code = 200

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, timeout=None):
            seen.setdefault("urls", []).append(url)
            return FakeResp()

    monkeypatch.setattr(svc.httpx, "AsyncClient", FakeClient)

    reg = {
        "frigate": "http://frigate:5000/healthz",
        "web-dashboard": "http://web-dashboard:3001/healthz",
        "ai-gateway": "http://ai-gateway:8000/ai/health",
    }
    asyncio.run(svc.probe_all(reg))

    assert sorted(seen["urls"]) == sorted([
        "http://frigate:5000/healthz",          # exempt — untouched
        "http://web-dashboard:3001/healthz",    # exempt — untouched
        "https://ai-gateway:8000/ai/health",    # mesh — rewritten
    ])
