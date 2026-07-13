"""WARP-1061 (hop 13) — switch → routing cross-check presents certs + https
when DROPLET_INTERNAL_TLS=1, stays plaintext when off."""
import asyncio
import importlib


def _fake_client(seen, payload):
    class FakeResp:
        status_code = 200
        is_success = True
        text = ""

        def json(self):
            return payload

        def raise_for_status(self):
            pass

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


def test_flag_on_presents_cert_and_https(monkeypatch, tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))

    import main
    main = importlib.reload(main)

    seen = {}
    monkeypatch.setattr(
        main.httpx, "AsyncClient",
        _fake_client(seen, {"cameras": {"present": True}}),
    )
    check = main.RoutingCamerasCrossCheck("http://localhost:8080")
    assert asyncio.run(check.cameras_present()) is True
    assert seen["url"] == "https://localhost:8080/network/interfaces"
    assert seen["client_kwargs"]["cert"] == (
        str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"),
    )
    assert seen["client_kwargs"]["verify"] == str(tmp_path / "ca.pem")


def test_flag_off_stays_plain(monkeypatch):
    monkeypatch.delenv("DROPLET_INTERNAL_TLS", raising=False)

    import main
    main = importlib.reload(main)

    seen = {}
    monkeypatch.setattr(
        main.httpx, "AsyncClient",
        _fake_client(seen, {"cameras": {"present": False}}),
    )
    check = main.RoutingCamerasCrossCheck("http://localhost:8080")
    assert asyncio.run(check.cameras_present()) is False
    assert seen["url"] == "http://localhost:8080/network/interfaces"
    assert "cert" not in seen["client_kwargs"]
