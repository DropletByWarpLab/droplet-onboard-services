"""Disk-space preflight for model pulls.

WARP-1111 §7.2 — also closes WARP-196 ("inference-manager — no disk-space
pre-check before model pull"). Before ``POST /models/pull`` starts a
multi-GB download, check whether the Ollama data volume has room for it
plus a safety headroom, and refuse (409) if not.

``shutil.disk_usage`` only needs traversal/stat permission on the mount, not
read access to file contents, so this works even though inference-manager
mounts the Ollama data volume read-only (see docker/docker-compose.yml).
"""

from __future__ import annotations

import os
import shutil
from typing import NamedTuple

from logging_config import get_logger

logger = get_logger(__name__)

_GB = 1024**3

# Extra free space required beyond the model's own size, so a pull never
# wedges a device down to zero free disk. Constant per the architecture
# brief §7.2 — not configurable, to keep the safety margin predictable.
DISK_HEADROOM_GB = 10

# Where the Ollama data volume is bind-mounted (read-only) inside the
# inference-manager container. The volume itself is owned by the `ollama`
# service; this container mounts it purely so `shutil.disk_usage` can read
# the shared filesystem's free-space counters.
DEFAULT_DISK_CHECK_PATH = "/data/ollama"


def disk_check_path() -> str:
    """Resolved mount path: ``OLLAMA_DATA_PATH`` env override or the default.

    Read at call time (not import time) so tests can monkeypatch the env."""
    return os.getenv("OLLAMA_DATA_PATH", DEFAULT_DISK_CHECK_PATH)


class DiskPreflightResult(NamedTuple):
    ok: bool
    needed_gb: float
    free_gb: float


def check_disk_space(
    disk_gb: float | None, *, path: str | None = None
) -> DiskPreflightResult | None:
    """Return a :class:`DiskPreflightResult`, or ``None`` when the check is
    skipped.

    The check is skipped (not failed) in two cases, both logged so the gap
    is observable rather than silent:

    * ``disk_gb`` is unknown (manifest entry has no ``disk_gb``, or the
      pulled tag isn't in the manifest at all) — we have nothing to compare
      free space against.
    * the check path can't be statted (e.g. the volume isn't mounted in a
      local/dev environment) — fail open rather than block every pull on an
      environment quirk; the real Ollama pull will still fail loudly on an
      actually-full disk.
    """
    if disk_gb is None:
        logger.warning("disk_preflight_skipped_unknown_size")
        return None

    check_path = path or disk_check_path()
    try:
        usage = shutil.disk_usage(check_path)
    except OSError as e:
        logger.warning(
            "disk_preflight_unavailable", path=check_path, error=str(e)
        )
        return None

    free_gb = usage.free / _GB
    needed_gb = disk_gb + DISK_HEADROOM_GB
    return DiskPreflightResult(ok=free_gb >= needed_gb, needed_gb=needed_gb, free_gb=free_gb)
