"""Docker daemon access — list / inspect / log-tail / restart containers.

Why this exists
---------------
When the appliance is in the field and a customer calls "the photo
uploader is broken", the operator needs to: (a) see which containers
are running, (b) tail the relevant container's logs, (c) restart the
sick container without `ssh`-ing in. That's the entire surface — we
do NOT expose `exec`, `run`, or volume manipulation. Anything beyond
"look + restart" should land on a real ssh session for accountability.

Talks to the daemon via /var/run/docker.sock mounted into the container.
The mount is the privilege boundary: if you're inside the ops-console
container, you ARE root on the host. The bearer-token gate in
ops/auth.py is what prevents random /ops/* callers from reaching here.

Image / log volume
------------------
Logs grow unbounded if no rotation policy is set on the daemon. We
default to tail=200 lines so a typo in the URL doesn't stream a
gigabyte of nginx-access. Operator can pass ?tail=N up to MAX_LOG_TAIL
which is enforced server-side.

Restart safety
--------------
Containers in `docker-compose.yml` declare `restart: unless-stopped`
or similar — restarting them is idempotent and cheap. We do NOT
support `stop` (would require explicit start to recover, which is
exactly the scenario you do not want triggered remotely by accident).
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, asdict
from typing import Any

import docker
from docker.errors import APIError, DockerException, NotFound

logger = logging.getLogger("ops.docker")

# Server-side cap on log tail. Operator can ask for less; asking for
# more silently clamps. 5000 lines of typical service logs is ~500 KB
# which is fine over the tunnel; multi-MB tails should use `docker
# logs -f` from a real ssh session.
MAX_LOG_TAIL = int(os.environ.get("OPS_MAX_LOG_TAIL", "5000"))
DEFAULT_LOG_TAIL = 200

# Module-level client. The docker SDK's client maintains a connection
# pool to the daemon socket — instantiating per-request leaks fds.
# from_env() reads DOCKER_HOST etc., default unix://var/run/docker.sock.
_client: docker.DockerClient | None = None


def _get_client() -> docker.DockerClient:
    """Lazy + cached. Raises DockerException if the daemon isn't
    reachable — caller should translate to HTTP 503."""
    global _client
    if _client is None:
        _client = docker.from_env()
    return _client


@dataclass
class ContainerSummary:
    id: str                           # short id (12 chars)
    name: str
    image: str                        # repo:tag form
    status: str                       # running | exited | restarting | ...
    state: str                        # raw state string from inspect
    health: str | None                # healthy | unhealthy | starting | None
    started_at: str | None            # ISO8601 from inspect
    restart_count: int
    project: str | None               # docker-compose project label
    service: str | None               # docker-compose service label


def _summarise(c: Any) -> ContainerSummary:
    """Turn a docker SDK Container into our flat shape. We pull
    selected fields out of `attrs` (the full inspect dict) rather
    than expose it raw — `attrs` is huge and changes between SDK /
    API versions."""
    attrs = c.attrs or {}
    state = attrs.get("State") or {}
    config = attrs.get("Config") or {}
    labels = config.get("Labels") or {}

    health_obj = state.get("Health") or {}
    health_status = health_obj.get("Status")  # None if no healthcheck

    image_tags = c.image.tags if c.image else []
    image_str = image_tags[0] if image_tags else (
        c.image.short_id if c.image else "<unknown>"
    )

    return ContainerSummary(
        id=c.short_id,
        name=c.name,
        image=image_str,
        status=c.status,
        state=state.get("Status", c.status),
        health=health_status,
        started_at=state.get("StartedAt"),
        restart_count=int(state.get("RestartCount", 0)),
        project=labels.get("com.docker.compose.project"),
        service=labels.get("com.docker.compose.service"),
    )


def list_containers(*, all_states: bool = True) -> list[ContainerSummary]:
    """All containers known to the daemon. `all_states=False` returns
    only running ones — match docker CLI default."""
    try:
        client = _get_client()
        containers = client.containers.list(all=all_states)
    except DockerException as exc:
        logger.warning("docker list failed: %s", exc)
        raise
    return [_summarise(c) for c in containers]


def list_containers_dict(*, all_states: bool = True) -> list[dict[str, Any]]:
    """Plain-dict variant for endpoint serialisation."""
    return [asdict(s) for s in list_containers(all_states=all_states)]


def get_logs(
    name_or_id: str,
    *,
    tail: int = DEFAULT_LOG_TAIL,
    since_seconds: int | None = None,
) -> str:
    """Fetch the last `tail` lines of stdout+stderr from a container.
    `since_seconds`, if set, restricts to logs newer than that —
    useful when the operator clicks "show logs since I last looked".

    Returns a plain string (decoded UTF-8 with replacement). The
    docker SDK returns bytes; container logs are usually UTF-8 but
    nothing actually enforces that.
    """
    if tail < 1:
        tail = DEFAULT_LOG_TAIL
    if tail > MAX_LOG_TAIL:
        tail = MAX_LOG_TAIL

    kwargs: dict[str, Any] = {
        "stdout": True,
        "stderr": True,
        "tail": tail,
        "timestamps": True,
    }
    if since_seconds is not None and since_seconds > 0:
        # docker SDK takes `since` as either datetime or int seconds
        # since epoch. We pass epoch.
        import time as _time
        kwargs["since"] = int(_time.time() - since_seconds)

    try:
        client = _get_client()
        container = client.containers.get(name_or_id)
        raw: bytes = container.logs(**kwargs)
    except NotFound:
        raise
    except DockerException as exc:
        logger.warning("docker logs(%s) failed: %s", name_or_id, exc)
        raise

    return raw.decode("utf-8", errors="replace")


def restart_container(name_or_id: str, *, timeout: int = 10) -> ContainerSummary:
    """Restart a container by name or short id. `timeout` is how long
    docker waits for graceful SIGTERM before SIGKILL — 10s matches
    docker CLI default. Returns the post-restart summary so the
    caller can show the operator the new state.
    """
    try:
        client = _get_client()
        container = client.containers.get(name_or_id)
        logger.info("ops-console restarting container %s", container.name)
        container.restart(timeout=timeout)
        # Re-fetch — `attrs` is a snapshot, restart changes State /
        # StartedAt / RestartCount.
        container.reload()
    except NotFound:
        raise
    except (APIError, DockerException) as exc:
        logger.warning("docker restart(%s) failed: %s", name_or_id, exc)
        raise
    return _summarise(container)


def daemon_info() -> dict[str, Any]:
    """A trimmed `docker info` for the ops UI header — daemon version,
    container count, image count, storage driver. Helps the operator
    confirm they're talking to the right host."""
    try:
        client = _get_client()
        info = client.info()
    except DockerException as exc:
        logger.warning("docker info failed: %s", exc)
        raise
    return {
        "server_version": info.get("ServerVersion"),
        "containers_total": info.get("Containers"),
        "containers_running": info.get("ContainersRunning"),
        "containers_paused": info.get("ContainersPaused"),
        "containers_stopped": info.get("ContainersStopped"),
        "images": info.get("Images"),
        "driver": info.get("Driver"),
        "kernel_version": info.get("KernelVersion"),
        "operating_system": info.get("OperatingSystem"),
        "architecture": info.get("Architecture"),
        "ncpu": info.get("NCPU"),
        "mem_total": info.get("MemTotal"),
    }
