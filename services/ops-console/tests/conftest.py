"""Shared fixtures.

The ops-console package lives at `services/ops-console/` with the
runtime layout `main.py + ops/`. Pytest defaults to running from
that dir (see pytest.ini), so we just make sure it's first on
sys.path even when invoked from the repo root.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG_ROOT = _HERE.parent  # services/ops-console
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

# Set a deterministic OPS_TOKEN BEFORE importing ops.auth — the module
# captures it at import time. Tests that need to flip it use the
# `monkeypatch_token` fixture below to reload the module.
os.environ.setdefault("OPS_TOKEN", "test-token-for-pytest")


import pytest


@pytest.fixture
def reload_auth(monkeypatch):
    """Helper for tests that want to swap OPS_TOKEN — reloads the
    module so the new env value is captured at import time."""
    import importlib
    from ops import auth as auth_mod

    def _reload(new_token: str) -> object:
        monkeypatch.setenv("OPS_TOKEN", new_token)
        return importlib.reload(auth_mod)

    return _reload
