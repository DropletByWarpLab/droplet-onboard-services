"""WARP-1061 — the :8090 trigger server consumes uvicorn_ssl_kwargs().

Flag off ⇒ plain-HTTP uvicorn.Config (byte-identical to before); flag on ⇒
the /data/service-tls bundle is served and a CA-signed client cert REQUIRED.
"""
from __future__ import annotations

import importlib
import ssl
import sys
from pathlib import Path

# services/ on sys.path for _shared (same pattern as the sibling services'
# mtls tests); the service dir itself comes from conftest.py.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def _fresh_main(monkeypatch, **env):
    for k in ("DROPLET_INTERNAL_TLS", "DROPLET_TLS_CERT", "DROPLET_TLS_KEY", "DROPLET_TLS_CA"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import main

    return importlib.reload(main)


def test_flag_off_config_has_no_ssl(monkeypatch):
    main = _fresh_main(monkeypatch)
    cfg = main.build_uvicorn_config("server:app")
    assert cfg.ssl_certfile is None
    assert cfg.ssl_keyfile is None
    assert cfg.is_ssl is False


def test_flag_on_config_serves_bundle_and_requires_client_cert(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    main = _fresh_main(
        monkeypatch,
        DROPLET_INTERNAL_TLS="1",
        DROPLET_TLS_CERT=str(tmp_path / "cert.pem"),
        DROPLET_TLS_KEY=str(tmp_path / "key.pem"),
        DROPLET_TLS_CA=str(tmp_path / "ca.pem"),
    )
    cfg = main.build_uvicorn_config("server:app")
    assert cfg.ssl_certfile == str(tmp_path / "cert.pem")
    assert cfg.ssl_keyfile == str(tmp_path / "key.pem")
    assert cfg.ssl_ca_certs == str(tmp_path / "ca.pem")
    assert cfg.ssl_cert_reqs == ssl.CERT_REQUIRED
    assert cfg.is_ssl is True
