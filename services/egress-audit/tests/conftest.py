"""WARP-268 — path shim so `import conntrack_parse` etc. resolve when pytest
runs from the service dir or the repo root (same pattern as
services/routing/tests/conftest.py)."""
from __future__ import annotations

import sys
from pathlib import Path

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

FIXTURES = Path(__file__).resolve().parent / "fixtures"
