"""WARP-1061 — shared uvicorn launcher wiring SERVER-side internal mTLS.

Replaces the bare ``CMD ["uvicorn", "main:app", ...]`` in the service images
so every first-party FastAPI listener consumes ``uvicorn_ssl_kwargs()``:

  * DROPLET_INTERNAL_TLS unset/0 → ``uvicorn.run`` with no ssl kwargs —
    byte-identical plaintext posture to the old uvicorn CLI invocation.
  * DROPLET_INTERNAL_TLS=1 → serve the /data/service-tls bundle and REQUIRE
    a CA-signed client cert on every connection (ssl.CERT_REQUIRED).

Shipped into each image the same way internal_tls.py is
(``COPY services/_shared/serve.py /app/_shared/serve.py``).

Usage (Dockerfile CMD, exec form):
    python -m _shared.serve main:app --port 8000 [--host 0.0.0.0]
                                     [--no-server-header]
"""
from __future__ import annotations

import argparse
import sys

from _shared.internal_tls import uvicorn_ssl_kwargs


def build_run_args(argv: list[str]) -> tuple[str, dict]:
    """Parse argv into the (app, kwargs) pair handed to ``uvicorn.run``.

    Split from ``main`` so the flag-off ⇒ no-TLS-kwargs / flag-on ⇒
    bundle-kwargs contract is unit-testable without binding a socket.
    """
    parser = argparse.ArgumentParser(prog="python -m _shared.serve")
    parser.add_argument("app", help='ASGI app import string, e.g. "main:app"')
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, required=True)
    # Mirrors the uvicorn CLI flag some images passed (ops-console/voice-io).
    parser.add_argument("--no-server-header", action="store_true")
    args = parser.parse_args(argv)

    kwargs: dict = {"host": args.host, "port": args.port}
    if args.no_server_header:
        kwargs["server_header"] = False
    kwargs.update(uvicorn_ssl_kwargs())
    return args.app, kwargs


def main(argv: list[str] | None = None) -> None:
    import uvicorn  # deferred so parse/kwargs stay importable in unit tests

    app, kwargs = build_run_args(sys.argv[1:] if argv is None else argv)
    uvicorn.run(app, **kwargs)


if __name__ == "__main__":
    main()
