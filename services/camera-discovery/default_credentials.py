"""Default credential probe list for IP cameras.

Used when an RTSP DESCRIBE or ONVIF probe returns 401 Unauthorized — we
try this small, ordered list of well-known factory defaults before giving
up and marking the camera as needing manual setup.

This is intended for **first-boot auto-configuration in a trusted lab /
home deployment**, not as a substitute for proper credential rotation.
Any camera that still accepts a default password after deployment is a
security issue the operator should fix.

Ordering: most common factory default first (by hit rate across
residential / SMB deployments), then vendor-specific specials. The
trailing entries are tried but rarely hit; we cap at ~15 to keep the
probe cycle bounded.

Tuple format: ``(username, password)``. An empty password is represented
as ``""`` (not ``None``).
"""

from __future__ import annotations

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
    # Ubiquiti UniFi Protect G3 / G4 factory
    ("ubnt", "ubnt"),
]
