"""WARP-1061 — the off-LAN egress meter + DNS-block meter present certs and
dial https:// when DROPLET_INTERNAL_TLS=1 (mirrors test_scheduler_mtls.py —
the three routing samplers share one posture)."""
import asyncio
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/ for _shared
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # routing root


class _FakeResp:
    status_code = 200
    text = ""


def _fake_client(seen):
    class FakeClient:
        def __init__(self, **kwargs):
            seen["client_kwargs"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, **kwargs):
            seen["url"] = url
            return _FakeResp()

    return FakeClient


def _tls_env(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))
    monkeypatch.setenv("ORCHESTRATOR_SAMPLER_TOKEN", "sampler-token")
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://localhost:3000")
    return {
        "cert": (str(tmp_path / "cert.pem"), str(tmp_path / "key.pem")),
        "verify": str(tmp_path / "ca.pem"),
    }


def test_egress_meter_posts_https_with_cert_kwargs(monkeypatch, tmp_path):
    expected = _tls_env(monkeypatch, tmp_path)

    import egress_meter
    egress_meter = importlib.reload(egress_meter)

    seen = {}
    monkeypatch.setattr(egress_meter.httpx, "AsyncClient", _fake_client(seen))
    asyncio.run(egress_meter._post_batch({"web_fetch": 1024}))

    assert seen["url"].startswith("https://localhost:3000")
    assert seen["client_kwargs"]["cert"] == expected["cert"]
    assert seen["client_kwargs"]["verify"] == expected["verify"]


def test_egress_meter_flag_off_stays_plain(monkeypatch, tmp_path):
    monkeypatch.delenv("DROPLET_INTERNAL_TLS", raising=False)
    monkeypatch.setenv("ORCHESTRATOR_SAMPLER_TOKEN", "sampler-token")
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://localhost:3000")

    import egress_meter
    egress_meter = importlib.reload(egress_meter)

    seen = {}
    monkeypatch.setattr(egress_meter.httpx, "AsyncClient", _fake_client(seen))
    asyncio.run(egress_meter._post_batch({"web_fetch": 1024}))

    assert seen["url"].startswith("http://localhost:3000")
    assert "cert" not in seen["client_kwargs"]
    assert "verify" not in seen["client_kwargs"]


def test_dns_block_meter_posts_https_with_cert_kwargs(monkeypatch, tmp_path):
    expected = _tls_env(monkeypatch, tmp_path)

    import dns_block_meter
    dns_block_meter = importlib.reload(dns_block_meter)

    seen = {}
    monkeypatch.setattr(dns_block_meter.httpx, "AsyncClient", _fake_client(seen))
    asyncio.run(dns_block_meter._post_sample(7))

    assert seen["url"].startswith("https://localhost:3000")
    assert seen["client_kwargs"]["cert"] == expected["cert"]
    assert seen["client_kwargs"]["verify"] == expected["verify"]
