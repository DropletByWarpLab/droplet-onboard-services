"""WARP-236 + WARP-1433 — internal mTLS rides the POOLED httpx.Client.

Before WARP-1433 the client cert + CA were passed on every request's
kwargs (a fresh handshake per call). Now `OrchestratorLLM` builds ONE
`httpx.Client` (via `_new_httpx_client`) carrying the mTLS material once, on
the connection pool. This pins that the https:// base rewrite still happens
and that `cert` + `verify` reach the Client constructor.
"""
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/ for _shared
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # voice-io root

import voice.llm  # noqa: E402


def _capture_client_kwargs(monkeypatch) -> dict:
    """Patch httpx.Client (as seen by voice.llm) to record its constructor
    kwargs, returning a real MockTransport-backed client so construction
    still succeeds."""
    captured: dict = {}
    real_client = httpx.Client

    def _capturing(*args, **kwargs):
        captured.update(kwargs)
        return real_client(
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
        )

    monkeypatch.setattr(voice.llm.httpx, "Client", _capturing)
    return captured


def test_base_url_and_cert_kwargs(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))

    captured = _capture_client_kwargs(monkeypatch)
    client = voice.llm.OrchestratorLLM(base_url="http://orchestrator:3000")

    # https rewrite on the base URL (mTLS on).
    assert client._base_url.startswith("https://orchestrator:3000")
    # Client cert + CA carried once, on the pooled Client constructor.
    assert captured["cert"] == (
        str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"),
    )
    assert captured["verify"] == str(tmp_path / "ca.pem")


def test_no_mtls_material_when_flag_off(monkeypatch):
    monkeypatch.delenv("DROPLET_INTERNAL_TLS", raising=False)
    captured = _capture_client_kwargs(monkeypatch)
    voice.llm.OrchestratorLLM(base_url="http://orchestrator:3000")
    assert "cert" not in captured
    assert "verify" not in captured
