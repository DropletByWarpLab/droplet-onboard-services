"""WARP-229 — ai-gateway FIPS boot self-test wiring.

Verifies the env-gated `_run_fips_boot_self_test()` shim in `main.py`
behaves correctly. Mirrors `services/file-indexer/tests/test_fips_boot.py`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Make sibling main.py importable. main.py runs the boot self-test at
# module import; we reload it explicitly per test under monkeypatched env.
import importlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def _reset_env(monkeypatch):
    monkeypatch.delenv("DROPLET_FIPS_REQUIRED", raising=False)


def test_skip_when_env_unset():
    # main.py imports cleanly when env is unset (skip path).
    sys.modules.pop("main", None)
    import main  # noqa: F401  # successful import == skip path didn't exit
    assert hasattr(main, "_run_fips_boot_self_test")


def test_skip_when_env_false(monkeypatch):
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "false")
    sys.modules.pop("main", None)
    import main  # noqa: F401  # should also import cleanly
    assert hasattr(main, "_run_fips_boot_self_test")


def test_required_path_calls_helper(monkeypatch):
    """When DROPLET_FIPS_REQUIRED=true and `_shared.fips_selftest` is
    importable, the function should call into the helper and SystemExit
    on the dev runner (no FIPS).
    """
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "true")
    # Inject services/_shared into path so the import resolves.
    shared_root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(shared_root))

    sys.modules.pop("main", None)
    sys.modules.pop("_shared", None)
    sys.modules.pop("_shared.fips_selftest", None)

    with pytest.raises(SystemExit) as exc:
        # Re-importing main re-runs the module-level boot self-test.
        import main  # noqa: F401
    assert exc.value.code == 1
