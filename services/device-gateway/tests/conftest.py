"""Shared pytest setup for services/device-gateway.

Env defaults are set before `main` is imported so collection needs no real
network, registry file, or secret.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("SERVICE_SECRET", "pytest-fake-secret")
os.environ.setdefault("DEVICE_GATEWAY_REGISTRY_PATH", "/nonexistent/pytest-registry.json")

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))
# main.py imports `_shared.*` when present; in the repo it lives at
# services/_shared (same pattern as the switch/voice-io conftests).
_SERVICES_DIR = _SERVICE_DIR.parent
if str(_SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICES_DIR))
