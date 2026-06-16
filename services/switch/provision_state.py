"""Persisted switch-provisioning state (ADR-018 item 12).

``last_provisioned_at`` is net-new state the §7 ``/api/switch/status`` contract
exposes: the timestamp of the last successful reconcile. It is an EXPLICIT
recorded value (rule 10 — never inferred from absence): a fresh box that has
never reconciled returns ``None`` rather than a guessed time.

Storage is a single JSON file under ``SWITCH_STATE_DIR`` (default
``/var/lib/droplet/switch``). This service has no database; a flat file is the
right weight for one timestamp and survives a container restart when the dir is
a mounted volume. Reads tolerate a missing/corrupt file by returning ``None``;
writes are best-effort and never raise into the provisioning path (a failed
stamp must not turn a successful reconcile into an error).
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("droplet.switch.state")

_STATE_FILENAME = "provision-state.json"


def _state_path() -> Path:
    base = os.environ.get("SWITCH_STATE_DIR", "/var/lib/droplet/switch")
    return Path(base) / _STATE_FILENAME


def _utc_now_iso() -> str:
    """UTC, second precision, trailing 'Z' (matches the §7 contract sample)."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def read_last_provisioned_at() -> str | None:
    """Return the persisted ISO-8601 stamp, or None if never provisioned."""
    path = _state_path()
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        logger.warning("provision-state: could not read %s (%s) — treating as unset.", path, exc)
        return None
    value = data.get("last_provisioned_at") if isinstance(data, dict) else None
    return value if isinstance(value, str) else None


def stamp_provisioned_now() -> str | None:
    """Record 'provisioned just now'. Returns the stamp written, or None on
    failure (best-effort — never raises into the provisioning path)."""
    now = _utc_now_iso()
    path = _state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as fh:
            json.dump({"last_provisioned_at": now}, fh)
    except OSError as exc:
        logger.warning("provision-state: could not persist stamp to %s (%s).", path, exc)
        return None
    return now
