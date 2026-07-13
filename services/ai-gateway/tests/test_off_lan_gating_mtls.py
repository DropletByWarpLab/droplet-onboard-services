"""WARP-1061 (stage: off-LAN gate reconciliation) — the gate's posture read
is a first-party mesh hop. When DROPLET_INTERNAL_TLS=1 it must present the
gateway's client cert and dial https:// so the read keeps succeeding — the
pre-fix behaviour (plaintext GET against the mTLS'd orchestrator listener)
failed at the transport layer, returned None, and the fail-closed gate 451'd
every cloud-LLM call."""
import importlib

import pytest


def _reload_gate(monkeypatch, **env):
    for k in ("DROPLET_INTERNAL_TLS", "DROPLET_TLS_CERT", "DROPLET_TLS_KEY", "DROPLET_TLS_CA"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("AI_GATEWAY_SAMPLER_TOKEN", "sampler-token")
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orchestrator:3000")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    from middleware import off_lan_gating

    gate = importlib.reload(off_lan_gating)
    gate._invalidate_cache_for_tests()
    return gate


def _fake_client(seen, payload):
    class FakeResp:
        status_code = 200

        def json(self):
            return payload

    class FakeClient:
        def __init__(self, **kwargs):
            seen["client_kwargs"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            seen["url"] = url
            return FakeResp()

    return FakeClient


@pytest.mark.asyncio
async def test_flag_on_posture_read_presents_cert_and_https(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    gate = _reload_gate(
        monkeypatch,
        DROPLET_INTERNAL_TLS="1",
        DROPLET_TLS_CERT=str(tmp_path / "cert.pem"),
        DROPLET_TLS_KEY=str(tmp_path / "key.pem"),
        DROPLET_TLS_CA=str(tmp_path / "ca.pem"),
    )

    seen = {}
    payload = {"channels": [{"key": "cloud_model_escape", "enabled": True}]}
    monkeypatch.setattr(gate.httpx, "AsyncClient", _fake_client(seen, payload))

    assert await gate.get_cloud_model_escape() is True
    assert seen["url"] == "https://orchestrator:3000/api/settings/off-lan"
    assert seen["client_kwargs"]["cert"] == (
        str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"),
    )
    assert seen["client_kwargs"]["verify"] == str(tmp_path / "ca.pem")
    # timeout must survive the kwargs merge
    assert seen["client_kwargs"]["timeout"] == 3.0


@pytest.mark.asyncio
async def test_flag_off_posture_read_stays_plain(monkeypatch):
    gate = _reload_gate(monkeypatch)

    seen = {}
    payload = {"channels": [{"key": "cloud_model_escape", "enabled": False}]}
    monkeypatch.setattr(gate.httpx, "AsyncClient", _fake_client(seen, payload))

    assert await gate.get_cloud_model_escape() is False
    assert seen["url"] == "http://orchestrator:3000/api/settings/off-lan"
    assert "cert" not in seen["client_kwargs"]
    assert "verify" not in seen["client_kwargs"]
