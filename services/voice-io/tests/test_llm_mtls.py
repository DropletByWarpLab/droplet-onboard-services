"""WARP-236 — llm client sends client certs + https base when mTLS is on."""
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/ for _shared
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # voice-io root


def test_base_url_and_cert_kwargs(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))

    import voice.llm as llm
    llm = importlib.reload(llm)

    calls = {}

    def fake_post(url, **kwargs):
        calls["url"] = url
        calls["kwargs"] = kwargs
        raise RuntimeError("stop-after-capture")

    monkeypatch.setattr(llm.httpx, "post", fake_post)
    client = llm.OrchestratorLLM(base_url="http://orchestrator:3000")
    try:
        client.reply("hello")
    except RuntimeError:
        pass
    assert calls["url"].startswith("https://orchestrator:3000")
    assert calls["kwargs"]["cert"] == (str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))
    assert calls["kwargs"]["verify"] == str(tmp_path / "ca.pem")
