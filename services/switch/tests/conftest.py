"""Shared pytest fixtures for services/switch.

Seed test infrastructure for the CI coverage guard (scripts/check-ci-coverage.sh).
Sets safe env-var defaults before the switch `main` module is imported so tests
can be collected without a real switch configured.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("SWITCH_HOST", "127.0.0.1")
os.environ.setdefault("SWITCH_PORT", "80")
os.environ.setdefault("SWITCH_DRIVER", "openwrt")
os.environ.setdefault("SWITCH_USERNAME", "droplet-ai")
os.environ.setdefault("SWITCH_PASSWORD", "pytest-fake-pw")
os.environ.setdefault("SERVICE_SECRET", "pytest-fake-secret")
os.environ.setdefault("ROUTING_SERVICE_TOKEN", "pytest-fake-routing-token")

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))
# WARP-1061 — main.py imports `_shared.internal_tls`. In-container the helper
# is COPY'd to /app/_shared; in the repo it lives at services/_shared, so add
# services/ to the path (same pattern as voice-io's conftest).
_SERVICES_DIR = _SERVICE_DIR.parent
if str(_SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICES_DIR))
