"""WARP-236 — shared internal-mTLS helper for Python services.

Shipped into each image the same way fips_selftest.py is
(`COPY services/_shared/internal_tls.py /app/_shared/internal_tls.py`).
Env contract (see docs/security/internal-mtls.md):
  DROPLET_INTERNAL_TLS=1 enables HTTP/gRPC mTLS; cert paths default to the
  per-service bundle mounted read-only at /data/service-tls/.
MQTT is scheme-gated (mqtts://), not flag-gated — see paho_configure callers.
"""
from __future__ import annotations

import os
import ssl


def _cert() -> str:
    return os.environ.get("DROPLET_TLS_CERT", "/data/service-tls/cert.pem")


def _key() -> str:
    return os.environ.get("DROPLET_TLS_KEY", "/data/service-tls/key.pem")


def _ca() -> str:
    return os.environ.get("DROPLET_TLS_CA", "/data/service-tls/ca.pem")


def enabled() -> bool:
    return os.environ.get("DROPLET_INTERNAL_TLS", "0") == "1"


def base_url(url: str) -> str:
    """Rewrite an internal http:// base URL to https:// when mTLS is on."""
    if enabled() and url.startswith("http://"):
        return "https://" + url[len("http://"):]
    return url


def uvicorn_ssl_kwargs() -> dict:
    """kwargs for uvicorn.run()/uvicorn.Config(): server cert + REQUIRED client cert."""
    if not enabled():
        return {}
    return {
        "ssl_certfile": _cert(),
        "ssl_keyfile": _key(),
        "ssl_ca_certs": _ca(),
        "ssl_cert_reqs": ssl.CERT_REQUIRED,
    }


def httpx_client_kwargs() -> dict:
    """kwargs for httpx request/Client calls to internal peers."""
    if not enabled():
        return {}
    return {"cert": (_cert(), _key()), "verify": _ca()}


def paho_configure(client) -> None:
    """Attach the service bundle to a paho MQTT client (caller gates on mqtts://)."""
    client.tls_set(ca_certs=_ca(), certfile=_cert(), keyfile=_key())


def grpc_server_credentials():
    import grpc

    with open(_key(), "rb") as k, open(_cert(), "rb") as c, open(_ca(), "rb") as a:
        return grpc.ssl_server_credentials(
            [(k.read(), c.read())],
            root_certificates=a.read(),
            require_client_auth=True,
        )


def grpc_channel_credentials():
    import grpc

    with open(_key(), "rb") as k, open(_cert(), "rb") as c, open(_ca(), "rb") as a:
        return grpc.ssl_channel_credentials(
            root_certificates=a.read(),
            private_key=k.read(),
            certificate_chain=c.read(),
        )
