"""WARP-1061 — shared uvicorn launcher (services/_shared/serve.py) +
cert-presenting healthcheck client (services/_shared/healthcheck.py).

Lives here (not services/_shared/) for the same reason test_internal_tls.py
does: ai-gateway's venv is the canonical Python test runner.
"""
import importlib
import ssl
import sys
from pathlib import Path

SHARED = Path(__file__).resolve().parents[2] / "_shared"
sys.path.insert(0, str(SHARED.parent))


def _fresh(monkeypatch, module, **env):
    for k in ("DROPLET_INTERNAL_TLS", "DROPLET_TLS_CERT", "DROPLET_TLS_KEY", "DROPLET_TLS_CA"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import _shared.internal_tls  # noqa: F401 — reload target below

    importlib.reload(sys.modules["_shared.internal_tls"])
    mod = importlib.import_module(module)
    return importlib.reload(mod)


def _bundle(tmp_path):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    return {
        "DROPLET_TLS_CERT": str(tmp_path / "cert.pem"),
        "DROPLET_TLS_KEY": str(tmp_path / "key.pem"),
        "DROPLET_TLS_CA": str(tmp_path / "ca.pem"),
    }


# --- _shared.serve -----------------------------------------------------------

def test_serve_flag_off_passes_no_tls_kwargs(monkeypatch):
    serve = _fresh(monkeypatch, "_shared.serve")
    app, kwargs = serve.build_run_args(["main:app", "--port", "8000"])
    assert app == "main:app"
    assert kwargs == {"host": "0.0.0.0", "port": 8000}


def test_serve_flag_off_explicit_zero(monkeypatch):
    serve = _fresh(monkeypatch, "_shared.serve", DROPLET_INTERNAL_TLS="0")
    _, kwargs = serve.build_run_args(["main:app", "--port", "8081"])
    assert not any(k.startswith("ssl_") for k in kwargs)


def test_serve_flag_on_serves_bundle_and_requires_client_cert(monkeypatch, tmp_path):
    env = _bundle(tmp_path)
    serve = _fresh(monkeypatch, "_shared.serve", DROPLET_INTERNAL_TLS="1", **env)
    _, kwargs = serve.build_run_args(["main:app", "--port", "8000"])
    assert kwargs["ssl_certfile"] == env["DROPLET_TLS_CERT"]
    assert kwargs["ssl_keyfile"] == env["DROPLET_TLS_KEY"]
    assert kwargs["ssl_ca_certs"] == env["DROPLET_TLS_CA"]
    assert kwargs["ssl_cert_reqs"] == ssl.CERT_REQUIRED


def test_serve_no_server_header_flag(monkeypatch):
    serve = _fresh(monkeypatch, "_shared.serve")
    _, kwargs = serve.build_run_args(
        ["main:app", "--port", "8086", "--no-server-header"]
    )
    assert kwargs["server_header"] is False


def test_serve_main_invokes_uvicorn_run(monkeypatch, tmp_path):
    env = _bundle(tmp_path)
    serve = _fresh(monkeypatch, "_shared.serve", DROPLET_INTERNAL_TLS="1", **env)
    seen = {}

    import uvicorn

    monkeypatch.setattr(
        uvicorn, "run", lambda app, **kw: seen.update({"app": app, **kw})
    )
    serve.main(["main:app", "--host", "0.0.0.0", "--port", "8082"])
    assert seen["app"] == "main:app"
    assert seen["port"] == 8082
    assert seen["ssl_cert_reqs"] == ssl.CERT_REQUIRED


# --- _shared.healthcheck -----------------------------------------------------

def test_healthcheck_flag_off_plain_http(monkeypatch):
    hc = _fresh(monkeypatch, "_shared.healthcheck")
    url, ctx = hc.probe_url_and_context("8086", "/health")
    assert url == "http://localhost:8086/health"
    assert ctx is None


def test_healthcheck_flag_on_presents_client_cert(monkeypatch, tmp_path):
    env = _bundle(tmp_path)
    hc = _fresh(monkeypatch, "_shared.healthcheck", DROPLET_INTERNAL_TLS="1", **env)

    seen = {}

    class FakeCtx:
        def load_cert_chain(self, certfile, keyfile):
            seen["chain"] = (certfile, keyfile)

    def fake_default_context(cafile=None):
        seen["cafile"] = cafile
        return FakeCtx()

    monkeypatch.setattr(hc.ssl, "create_default_context", fake_default_context)
    url, ctx = hc.probe_url_and_context("8090", "/health")
    assert url == "https://localhost:8090/health"
    assert isinstance(ctx, FakeCtx)
    assert seen["cafile"] == env["DROPLET_TLS_CA"]
    assert seen["chain"] == (env["DROPLET_TLS_CERT"], env["DROPLET_TLS_KEY"])


def test_healthcheck_main_exit_codes(monkeypatch):
    hc = _fresh(monkeypatch, "_shared.healthcheck")

    class FakeResp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    seen = {}

    def fake_urlopen(url, timeout, context):
        seen["url"] = url
        return FakeResp()

    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    assert hc.main(["8086", "/health"]) == 0
    assert seen["url"] == "http://localhost:8086/health"

    def raising_urlopen(url, timeout, context):
        raise OSError("connection refused")

    monkeypatch.setattr(hc.urllib.request, "urlopen", raising_urlopen)
    assert hc.main(["8086", "/health"]) == 1
