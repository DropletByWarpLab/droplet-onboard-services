"""WARP-963 — env-driven configuration + the telemetry gate.

The fleet-agent is OFF unless BOTH hold:

  1. ``DROPLET_TELEMETRY_ENABLED=1`` (explicit operator opt-in — never
     derived, never defaulted on), AND
  2. credentials are present: either a persisted identity from a prior
     ``/agents/register`` (see state.py) or a one-time
     ``DROPLET_TELEMETRY_PROVISIONING_CODE`` minted by an operator in the
     portal's ``/settings/tokens``.

Geo fields (WARP-433 portal contract): a zero-length ``geoRegion`` 422s
the WHOLE heartbeat server-side, and ``geoCountry`` must be uppercase
ISO 3166-1 alpha-2. The config layer therefore canonicalizes (upper-
cases the country) and translates anything invalid or empty into
OMISSION — the payload never carries an empty string.
"""

from __future__ import annotations

import re
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional

DEFAULT_PORTAL_URL = "https://analytics.warp-lab.ai/api/v1"
DEFAULT_STATE_DIR = "/var/lib/droplet/fleet-agent"
FALLBACK_FIRMWARE_VERSION = "0.0.0+unknown"

_TRUTHY = {"1", "true", "yes", "on"}
_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
_VALID_TIERS = {"home", "business", "enterprise"}


@dataclass(frozen=True)
class AgentConfig:
    flag_enabled: bool
    portal_url: str
    provisioning_code: str
    state_dir: Path
    firmware_version: str
    hostname: str
    tier: str
    hardware_revision: Optional[str]
    geo_country: Optional[str]
    geo_region: Optional[str]
    # Cadences (defaults mirror the portal's RegisterResponse config; a
    # successful registration overrides them with the server-issued values).
    heartbeat_interval_s: int
    metrics_interval_s: int
    network_snapshot_interval_s: int
    command_poll_interval_s: int
    inventory_interval_s: int
    errors_flush_interval_s: int
    # Disk spool bound — oldest heartbeats drop beyond this.
    spool_max: int


def _canonical_country(raw: Optional[str]) -> Optional[str]:
    """Uppercase ISO 3166-1 alpha-2 or omission — never an invalid value."""
    if not raw:
        return None
    candidate = raw.strip().upper()
    if _COUNTRY_RE.match(candidate):
        return candidate
    return None


def _canonical_region(raw: Optional[str]) -> Optional[str]:
    """1–100 chars or omission — an empty string would 422 the heartbeat."""
    if not raw:
        return None
    candidate = raw.strip()
    if 1 <= len(candidate) <= 100:
        return candidate
    return None


def _int_env(env: Mapping[str, str], key: str, default: int) -> int:
    raw = (env.get(key) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def load_config(env: Mapping[str, str]) -> AgentConfig:
    flag = (env.get("DROPLET_TELEMETRY_ENABLED") or "").strip().lower()
    tier = (env.get("DROPLET_TIER") or "home").strip().lower()
    if tier not in _VALID_TIERS:
        tier = "home"
    hostname = (env.get("DROPLET_HOSTNAME") or "").strip() or socket.gethostname()
    firmware = (
        env.get("DROPLET_FIRMWARE_VERSION") or ""
    ).strip() or FALLBACK_FIRMWARE_VERSION
    hardware_revision = (env.get("DROPLET_HARDWARE_REVISION") or "").strip() or None

    return AgentConfig(
        flag_enabled=flag in _TRUTHY,
        portal_url=(
            (env.get("DROPLET_TELEMETRY_PORTAL_URL") or DEFAULT_PORTAL_URL)
            .strip()
            .rstrip("/")
        ),
        provisioning_code=(
            env.get("DROPLET_TELEMETRY_PROVISIONING_CODE") or ""
        ).strip(),
        state_dir=Path(
            (env.get("DROPLET_TELEMETRY_STATE_DIR") or DEFAULT_STATE_DIR).strip()
        ),
        firmware_version=firmware,
        hostname=hostname,
        tier=tier,
        hardware_revision=hardware_revision,
        geo_country=_canonical_country(env.get("DROPLET_TELEMETRY_GEO_COUNTRY")),
        geo_region=_canonical_region(env.get("DROPLET_TELEMETRY_GEO_REGION")),
        heartbeat_interval_s=_int_env(env, "DROPLET_TELEMETRY_HEARTBEAT_SEC", 30),
        metrics_interval_s=_int_env(env, "DROPLET_TELEMETRY_METRICS_SEC", 60),
        network_snapshot_interval_s=_int_env(
            env, "DROPLET_TELEMETRY_NETWORK_SEC", 300
        ),
        command_poll_interval_s=_int_env(
            env, "DROPLET_TELEMETRY_COMMAND_POLL_SEC", 15
        ),
        inventory_interval_s=_int_env(
            env, "DROPLET_TELEMETRY_INVENTORY_SEC", 6 * 3600
        ),
        errors_flush_interval_s=_int_env(env, "DROPLET_TELEMETRY_ERRORS_SEC", 5),
        spool_max=_int_env(env, "DROPLET_TELEMETRY_SPOOL_MAX", 1000),
    )
