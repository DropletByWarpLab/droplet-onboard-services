"""WARP-1061 — device-bridge's orchestrator /api/health read under internal
mTLS. Flag off ⇒ plain http + no SSL context (byte-identical to before);
flag on ⇒ https + a client context built from the host-issued
`device-bridge` bundle. Loader mirrors test_device_bridge.py (hyphenated
filename ⇒ importlib)."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for key in ("DROPLET_INTERNAL_TLS", "DROPLET_TLS_CERT", "DROPLET_TLS_KEY",
                "DROPLET_TLS_CA"):
        monkeypatch.delenv(key, raising=False)
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)

    spec = importlib.util.spec_from_file_location("device_bridge_under_test",
                                                  _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_flag_off_plain_url_and_no_context(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    assert bridge._orchestrator_base_url() == "http://127.0.0.1:3000"
    assert bridge._orchestrator_tls_context() is None


def test_flag_on_https_url_and_client_cert_context(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_INTERNAL_TLS": "1",
        "DROPLET_TLS_CERT": str(tmp_path / "cert.pem"),
        "DROPLET_TLS_KEY": str(tmp_path / "key.pem"),
        "DROPLET_TLS_CA": str(tmp_path / "ca.pem"),
    })
    assert bridge._orchestrator_base_url() == "https://127.0.0.1:3000"

    built = {}

    class FakeCtx:
        def load_cert_chain(self, certfile, keyfile):
            built["chain"] = (certfile, keyfile)

    import ssl

    def fake_default_context(cafile=None):
        built["cafile"] = cafile
        return FakeCtx()

    monkeypatch.setattr(ssl, "create_default_context", fake_default_context)
    ctx = bridge._orchestrator_tls_context()
    assert isinstance(ctx, FakeCtx)
    assert built["cafile"] == str(tmp_path / "ca.pem")
    assert built["chain"] == (str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))
