"""WARP-1061 — cert-presenting container healthcheck client.

The service images' HEALTHCHECKs previously probed plain
``http://localhost:<port>/<path>``; with DROPLET_INTERNAL_TLS=1 those
listeners serve HTTPS and REQUIRE a CA-signed client cert, so a plaintext
probe would flap the container unhealthy forever (the WARP-236 orchestrator
lesson, apps/orchestrator/src/healthcheck.ts). This client presents the
service's own /data/service-tls bundle when the flag is on and stays plain
HTTP when it's off. Exits 0 on 2xx, 1 otherwise.

Usage (Dockerfile HEALTHCHECK CMD): python -m _shared.healthcheck 8086 /health
"""
from __future__ import annotations

import ssl
import sys
import urllib.request

from _shared import internal_tls


def probe_url_and_context(port: str, path: str) -> tuple[str, ssl.SSLContext | None]:
    """Resolve the probe URL + client-cert SSL context from the env contract.

    Split from ``main`` so flag-off ⇒ (http, None) / flag-on ⇒ (https,
    cert-loaded context) is unit-testable without a listening socket.
    """
    if not internal_tls.enabled():
        return f"http://localhost:{port}{path}", None
    # The bundle's SAN always includes DNS:localhost (internal_ca_issue), so
    # default hostname verification against https://localhost holds.
    ctx = ssl.create_default_context(cafile=internal_tls._ca())
    ctx.load_cert_chain(certfile=internal_tls._cert(), keyfile=internal_tls._key())
    return f"https://localhost:{port}{path}", ctx


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    port = argv[0] if argv else "8080"
    path = argv[1] if len(argv) > 1 else "/health"
    url, ctx = probe_url_and_context(port, path)
    try:
        with urllib.request.urlopen(url, timeout=3, context=ctx) as resp:
            return 0 if 200 <= resp.status < 300 else 1
    except Exception:
        return 1


if __name__ == "__main__":
    sys.exit(main())
