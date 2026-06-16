"""Shared pytest fixtures for services/oled-display.

Created by WARP-624 (boot/shutdown screens). Mirrors the
services/routing/tests/conftest.py pattern: set the env that the service
modules read at import time *before* importing them, and put the service
directory on sys.path so `import display` / `import main` work when pytest
is invoked from the repo root.

`main.py` raises at import unless SERVICE_SECRET is set (fail-closed auth),
so we seed a deterministic test token here. `display.py` forces the `sim`
backend so no test ever touches a real /dev/ttyACM* serial device.

On non-Linux test hosts (Windows CI / dev laptops) the stdlib `zoneinfo`
module has no IANA database to read, so `display.py`'s module-level
ZoneInfo("America/Los_Angeles") raises. The `tzdata` pip package supplies
that database cross-platform; it is a test/dev convenience only — the
shipped container is Linux and reads the system zoneinfo. See the
oled-display test notes in the WARP-624 handoff.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# --- Pre-import env setup (must run before `import main` / `import display`) ---
TEST_SERVICE_SECRET = "pytest-oled-secret"
os.environ.setdefault("SERVICE_SECRET", TEST_SERVICE_SECRET)
# Force the simulated backend: never probe or open a real serial port in tests.
os.environ.setdefault("DISPLAY_BACKEND", "sim")
# Keep preview PNGs out of the way of the device's default /tmp path and make
# the location explicit + writable on any OS.
os.environ.setdefault(
    "SIM_OUTPUT", str(Path(__file__).resolve().parent / "_artifacts" / "tft_preview.png")
)

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

import pytest  # noqa: E402

import display as display_module  # noqa: E402


@pytest.fixture
def sim_display(monkeypatch: pytest.MonkeyPatch) -> display_module.TFTDisplay:
    """A freshly-constructed TFTDisplay on the sim backend.

    The cycle thread is NOT started — tests that exercise the readiness
    transition drive `_readiness_tick` directly with an injected clock so
    they stay deterministic (no real sleeps, no background thread, no
    network).
    """
    return display_module.TFTDisplay()
