"""ops-console FastAPI app.

Two endpoint families:

  /healthz              UNAUTH — for the docker HEALTHCHECK directive.
                        Returns 200 + tiny JSON, never touches docker
                        socket or upstream services. If THIS endpoint
                        is down, the container is genuinely sick.

  /ops/*                AUTH (bearer token from ops/auth.py). Every
                        operator action lives here, AND every request
                        is audit-logged via ops.audit middleware
                        (timestamp, identity, method, path, status,
                        latency). The audit trail is the trust boundary
                        with the customer — after a support engagement
                        the JSONL log shows exactly what was looked at
                        and what was changed.

Why one router, not many: at this scale (single operator, ~10 endpoints)
splitting into APIRouters per module adds indirection without paying
for itself. Revisit when /ops/* grows past 30 routes.

Scope (WARP-337): this is the on-device SUPPORT CLIENT — an API
surface for Warp Lab support to pull logs and machine state when a
deployed Droplet needs hands-on troubleshooting. It is NOT the
operator admin panel and NOT the fleet management plane (those live
on warp-lab.com separately). No HTML UI is shipped — the API is
consumed by support tooling over a reverse SSH/WireGuard tunnel.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from docker.errors import DockerException, NotFound
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.responses import JSONResponse, PlainTextResponse

from ops import audit, auth, docker_client, services as svc_probe, system as sys_probe

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("ops-console")

app = FastAPI(
    title="Droplet ops-console",
    description=(
        "Operator-side monitoring for a deployed Droplet appliance. "
        "Bearer-token gated; mounts /var/run/docker.sock for container "
        "ops; runs under compose profile=ops."
    ),
    version="0.1.0",
    # Disable docs in prod-ish builds — they'd be unauth and would leak
    # the route surface. Set OPS_ENABLE_DOCS=1 to bring them back when
    # iterating locally.
    docs_url="/docs" if os.environ.get("OPS_ENABLE_DOCS") == "1" else None,
    redoc_url=None,
    openapi_url="/openapi.json" if os.environ.get("OPS_ENABLE_DOCS") == "1" else None,
)


# WARP-337: install audit middleware before any route runs. Every
# /ops/* request is recorded with status + latency + identity to
# /var/log/ops-console/audit.jsonl (override with OPS_AUDIT_LOG) and
# mirrored to the structured logger. /healthz and the static root are
# skipped — they'd drown the support-relevant lines in healthcheck
# noise.
audit.install(app)


# ---------------------------------------------------------------------------
# Unauth: /healthz for docker HEALTHCHECK
# ---------------------------------------------------------------------------

@app.get("/healthz", include_in_schema=False)
def healthz() -> dict[str, str]:
    """Liveness — must NOT touch docker socket or upstreams. The whole
    point is "is the FastAPI process answering". Anything heavier
    creates a healthcheck loop that flakes the container."""
    return {"status": "ok", "service": "ops-console"}


# ---------------------------------------------------------------------------
# Auth: /ops/* — every endpoint takes the bearer-token dependency
# ---------------------------------------------------------------------------

@app.get("/ops/health", dependencies=[Depends(auth.require_token)])
def ops_health() -> dict[str, Any]:
    """Authenticated health — returns the same shape as /healthz but
    confirms the token is correct. Useful as the operator's first
    request after pasting their token to verify it works."""
    return {
        "status": "ok",
        "service": "ops-console",
        "token_check": "passed",
    }


@app.get("/ops/system", dependencies=[Depends(auth.require_token)])
def ops_system() -> dict[str, Any]:
    """Host telemetry snapshot — CPU, memory, disk, network, uptime."""
    return sys_probe.snapshot_dict()


@app.get("/ops/containers", dependencies=[Depends(auth.require_token)])
def ops_containers(
    all_states: bool = Query(
        default=True,
        description="Include exited / created containers, not just running.",
    ),
) -> dict[str, Any]:
    """List of containers + a trimmed `docker info` for context."""
    try:
        containers = docker_client.list_containers_dict(all_states=all_states)
        info = docker_client.daemon_info()
    except DockerException as exc:
        # Daemon unreachable — most likely the operator forgot to mount
        # /var/run/docker.sock into this container, OR docker is down
        # on the host. Both are recoverable so 503 (transient) not 500.
        logger.warning("docker unreachable from /ops/containers: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"docker daemon unreachable: {exc.__class__.__name__}",
        )
    return {"daemon": info, "containers": containers}


@app.get(
    "/ops/containers/{name}/logs",
    dependencies=[Depends(auth.require_token)],
    response_class=PlainTextResponse,
)
def ops_container_logs(
    name: str,
    tail: int = Query(default=docker_client.DEFAULT_LOG_TAIL, ge=1),
    since_seconds: int | None = Query(default=None, ge=1),
) -> str:
    """Tail of stdout+stderr for one container. Plain text (not JSON)
    so the UI can render in a <pre> without re-decoding."""
    try:
        return docker_client.get_logs(name, tail=tail, since_seconds=since_seconds)
    except NotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"no container named '{name}'",
        )
    except DockerException as exc:
        logger.warning("docker logs(%s) failed: %s", name, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"docker daemon error: {exc.__class__.__name__}",
        )


@app.post(
    "/ops/containers/{name}/restart",
    dependencies=[Depends(auth.require_token)],
)
def ops_container_restart(
    name: str,
    timeout: int = Query(default=10, ge=1, le=120),
) -> dict[str, Any]:
    """Restart a container by name or short id. Returns the post-
    restart summary. POST not GET because this mutates state."""
    try:
        summary = docker_client.restart_container(name, timeout=timeout)
    except NotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"no container named '{name}'",
        )
    except DockerException as exc:
        logger.warning("docker restart(%s) failed: %s", name, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"docker daemon error: {exc.__class__.__name__}",
        )
    logger.info("ops-console restarted %s (state=%s)", name, summary.state)
    from dataclasses import asdict
    return {"restarted": True, "container": asdict(summary)}


@app.get("/ops/services", dependencies=[Depends(auth.require_token)])
async def ops_services() -> dict[str, Any]:
    """Fan-out probes against every Droplet service's /health endpoint.
    Async because the probes happen in parallel via httpx."""
    results = await svc_probe.probe_all()
    from dataclasses import asdict
    return {
        "summary": svc_probe.summarise(results),
        "results": [asdict(r) for r in results],
    }


# ---------------------------------------------------------------------------
# Root: explicit JSON 404
# ---------------------------------------------------------------------------
#
# No static HTML / SPA is served from this service. The on-device
# support client is API-only; any UI lives on the support side
# (warp-lab.com fleet plane or local tooling) consuming /ops/* over a
# reverse tunnel. Root hits get a JSON 404 so a misrouted browser
# doesn't see a useful response that suggests a UI exists.

@app.get("/", include_in_schema=False)
def _root() -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={
            "detail": "ops-console is an API-only support surface; no UI is served here",
            "see": "/ops/health, /ops/system, /ops/containers, /ops/services",
        },
    )


# ---------------------------------------------------------------------------
# Custom 404 / 500 — keep responses JSON for /ops/*
# ---------------------------------------------------------------------------

@app.exception_handler(404)
async def _not_found(request, exc):  # noqa: ANN001
    if request.url.path.startswith("/ops/"):
        return JSONResponse(
            status_code=404,
            content={"detail": "no such ops route"},
        )
    return JSONResponse(status_code=404, content={"detail": "not found"})
