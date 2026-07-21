"""WARP-1470 — reconcile_stale_sending signals module-disabled distinctly."""
import asyncio
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/ for _shared
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # email-indexer root


def _reload_client(monkeypatch):
    monkeypatch.setenv("ORCHESTRATOR_SERVICE_TOKEN", "svc-token")
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orchestrator:3000")
    monkeypatch.delenv("DROPLET_INTERNAL_TLS", raising=False)
    import orchestrator_client as oc
    return importlib.reload(oc)


def _install_fake(monkeypatch, oc, status_code, body):
    class FakeResp:
        def __init__(self):
            self.status_code = status_code
        def json(self):
            return body
    class FakeClient:
        def __init__(self, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, url, **kwargs):
            return FakeResp()
    monkeypatch.setattr(oc.httpx, "AsyncClient", FakeClient)


def test_returns_count_on_200(monkeypatch):
    oc = _reload_client(monkeypatch)
    _install_fake(monkeypatch, oc, 200, {"reconciled": 3})
    assert asyncio.run(oc.reconcile_stale_sending()) == 3


def test_returns_none_on_module_disabled_404(monkeypatch):
    oc = _reload_client(monkeypatch)
    _install_fake(monkeypatch, oc, 404, {"error": "module_disabled", "module": "email"})
    assert asyncio.run(oc.reconcile_stale_sending()) is None


def test_returns_zero_on_other_404(monkeypatch):
    oc = _reload_client(monkeypatch)
    _install_fake(monkeypatch, oc, 404, {"error": "not_found"})
    assert asyncio.run(oc.reconcile_stale_sending()) == 0


def test_returns_zero_on_500(monkeypatch):
    oc = _reload_client(monkeypatch)
    _install_fake(monkeypatch, oc, 500, {})
    assert asyncio.run(oc.reconcile_stale_sending()) == 0
