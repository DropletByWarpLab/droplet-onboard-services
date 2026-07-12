"""WARP-1061 (hop 13) — camera-discovery → routing client presents certs +
https when DROPLET_INTERNAL_TLS=1, stays plaintext when off. The client is
built at module import, so each case reloads main with httpx.AsyncClient
intercepted."""
import importlib

import httpx


def _capture_async_client(monkeypatch, seen):
    real = httpx.AsyncClient

    class CapturingClient(real):
        def __init__(self, **kwargs):
            seen.append(dict(kwargs))
            # Drop the TLS kwargs before delegating: the test's placeholder
            # PEM files aren't loadable and no test sends real traffic —
            # what's asserted is the kwargs the module PASSED, captured above.
            kwargs.pop("cert", None)
            kwargs.pop("verify", None)
            super().__init__(**kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", CapturingClient)


def _routing_kwargs(seen):
    for kwargs in seen:
        if str(kwargs.get("base_url", "")).find(":8080") != -1:
            return kwargs
    raise AssertionError(f"no routing AsyncClient captured in {seen}")


def test_flag_on_routing_client_gets_cert_and_https(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))

    seen: list[dict] = []
    _capture_async_client(monkeypatch, seen)

    import main
    importlib.reload(main)

    kwargs = _routing_kwargs(seen)
    assert str(kwargs["base_url"]).startswith("https://")
    assert kwargs["cert"] == (str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))
    assert kwargs["verify"] == str(tmp_path / "ca.pem")


def test_flag_off_routing_client_stays_plain(monkeypatch):
    monkeypatch.delenv("DROPLET_INTERNAL_TLS", raising=False)

    seen: list[dict] = []
    _capture_async_client(monkeypatch, seen)

    import main
    importlib.reload(main)

    kwargs = _routing_kwargs(seen)
    assert str(kwargs["base_url"]).startswith("http://")
    assert "cert" not in kwargs
    assert "verify" not in kwargs
