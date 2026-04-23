"""Default credential probe list for IP cameras.

Used when an RTSP DESCRIBE or ONVIF probe returns 401 Unauthorized — we
try this small, ordered list of well-known factory defaults before giving
up and marking the camera as needing manual setup.

This is intended for **first-boot auto-configuration in a trusted lab /
home deployment**, not as a substitute for proper credential rotation.
Any camera that still accepts a default password after deployment is a
security issue the operator should fix.

**Account lockout warning**: Hanwha, Axis, and some Hikvision firmwares
lock the admin account after ~5 failed auth attempts and return HTTP
490 ("Account Blocked") for several minutes. Always populate
``CAMERA_DEFAULT_PASSWORD`` on a deployed site so the known-good
credential is tried first — the factory-default sweep only exists to
bootstrap a brand-new camera nobody has provisioned yet.

Ordering: most common factory default first (by hit rate across
residential / SMB deployments), then vendor-specific specials. The
trailing entries are tried but rarely hit; we cap at ~15 to keep the
probe cycle bounded.

Tuple format: ``(username, password)``. An empty password is represented
as ``""`` (not ``None``).

Operator-supplied credentials (``CAMERA_DEFAULT_USERNAME`` +
``CAMERA_DEFAULT_PASSWORD`` or the JSON list ``CAMERA_CREDENTIALS_JSON``)
are prepended to the probe list by :func:`get_credentials` so cameras that
have already been provisioned with a site-specific admin password get
adopted on the first probe attempt instead of falling through to the
factory defaults. Both variables are optional; when unset the probe list
matches the historical factory-default-only behavior.
"""

from __future__ import annotations

import json
import logging
import os

logger = logging.getLogger(__name__)

# Ordered by observed hit rate. Modify only with a test plan — changing
# the order affects how long discovery takes on a fresh network.
DEFAULT_CAMERA_CREDENTIALS: list[tuple[str, str]] = [
    # Generic admin + blank password
    ("admin", ""),
    # Most common factory default across Amcrest, Reolink, cheap OEMs
    ("admin", "admin"),
    # Hanwha / Samsung Techwin factory default on older firmware
    ("admin", "admin1234"),
    # Hikvision default on firmware < 5.3 (superseded by first-run setup)
    ("admin", "12345"),
    # Generic numeric
    ("admin", "1234"),
    # Hanwha legacy / pre-Wisenet
    ("admin", "4321"),
    # Common across many white-label brands
    ("admin", "password"),
    # Axis (Classic) — user is the legacy root account
    ("root", "root"),
    # Axis variant seen on some mid-2010s firmwares
    ("root", "pass"),
    # Bosch / Dinion
    ("service", "admin"),
    # ACTi default
    ("user", "user"),
    # Uniview / some Dahua OEMs
    ("admin", "000000"),
    # Lorex default on some models
    ("admin", "9999"),
    # Wyze / few others
    ("admin", "wyze"),
]
# Intentionally NOT including ("ubnt", "ubnt"): that's the factory default
# for Ubiquiti networking gear (EdgeRouter / UniFi APs / switches), not
# their cameras. UniFi Protect cameras are adopted through a controller and
# don't have a local admin/password to probe. Probing ubnt/ubnt here would
# cheerfully try to authenticate against any Ubiquiti router on the LAN.


def _operator_credentials() -> list[tuple[str, str]]:
    """Build the operator-supplied credential list from env vars.

    Two input forms are supported, in precedence order:
      1. ``CAMERA_CREDENTIALS_JSON`` — a JSON array of ``[user, pw]`` pairs
         or ``{"username":..., "password":...}`` objects. Lets the operator
         hand in a small ordered list (e.g. the same admin across several
         cameras plus a legacy viewer account).
      2. ``CAMERA_DEFAULT_USERNAME`` + ``CAMERA_DEFAULT_PASSWORD`` — a
         single (user, pw) pair. Simplest knob for the common case where
         every camera shares one site-wide admin credential.

    Returns an empty list if no env is set or the JSON is malformed; the
    caller always falls through to the factory defaults.
    """
    creds: list[tuple[str, str]] = []

    raw_json = os.getenv("CAMERA_CREDENTIALS_JSON", "").strip()
    if raw_json:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, list):
                for entry in parsed:
                    if isinstance(entry, (list, tuple)) and len(entry) == 2:
                        u, p = entry
                        if isinstance(u, str) and isinstance(p, str):
                            creds.append((u, p))
                    elif isinstance(entry, dict):
                        u = entry.get("username") or entry.get("user")
                        p = entry.get("password") or entry.get("pass")
                        if isinstance(u, str) and isinstance(p, str):
                            creds.append((u, p))
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("Ignoring malformed CAMERA_CREDENTIALS_JSON: %s", exc)

    single_user = os.getenv("CAMERA_DEFAULT_USERNAME", "").strip()
    single_pw = os.getenv("CAMERA_DEFAULT_PASSWORD", "")
    if single_user:
        pair = (single_user, single_pw)
        if pair not in creds:
            creds.append(pair)

    return creds


def get_credentials() -> list[tuple[str, str]]:
    """Return the ordered probe list: operator creds first, factory defaults second.

    Computed on each call so that a config reload (env update + service
    restart) is picked up without reimporting the module.
    """
    operator = _operator_credentials()
    seen = set(operator)
    merged = list(operator)
    for pair in DEFAULT_CAMERA_CREDENTIALS:
        if pair not in seen:
            merged.append(pair)
            seen.add(pair)
    return merged
