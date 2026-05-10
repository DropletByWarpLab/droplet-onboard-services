"""WARP-229 — file-indexer FIPS boot self-test wiring.

Verifies the env-gated `_run_fips_boot_self_test()` shim in `main.py`
behaves correctly across:
  - DROPLET_FIPS_REQUIRED unset → skip
  - DROPLET_FIPS_REQUIRED=false / 0 / no → skip
  - DROPLET_FIPS_REQUIRED=true → tries to import the helper

We don't actually exercise the assert path (that requires a FIPS
OpenSSL); the existing services/_shared/test_fips_selftest.py covers
the helper's contract.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Make sibling main.py importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # type: ignore  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_env(monkeypatch):
    monkeypatch.delenv("DROPLET_FIPS_REQUIRED", raising=False)


def test_skip_when_env_unset(caplog):
    with caplog.at_level("INFO", logger="file-indexer"):
        main._run_fips_boot_self_test()
    assert any("FIPS boot self-test skipped" in r.message for r in caplog.records)


def test_skip_when_env_false(monkeypatch, caplog):
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "false")
    with caplog.at_level("INFO", logger="file-indexer"):
        main._run_fips_boot_self_test()
    assert any("FIPS boot self-test skipped" in r.message for r in caplog.records)


def test_skip_when_env_zero(monkeypatch, caplog):
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "0")
    with caplog.at_level("INFO", logger="file-indexer"):
        main._run_fips_boot_self_test()
    assert any("FIPS boot self-test skipped" in r.message for r in caplog.records)


def test_required_imports_helper(monkeypatch):
    """When DROPLET_FIPS_REQUIRED is true and `_shared.fips_selftest` IS
    importable, the function calls into the helper. The helper itself
    will fail-closed on a non-FIPS dev runner (see services/_shared/
    test_fips_selftest.py); we just verify the import path resolves.
    """
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "true")
    # Make `_shared.fips_selftest` importable in the test context by
    # injecting the path that the production image places it at.
    shared_src = Path(__file__).resolve().parents[2] / "_shared"
    if not shared_src.exists():
        pytest.skip("services/_shared not laid out for this test")
    monkeypatch.syspath_prepend(str(shared_src.parent))

    # The helper will detect non-FIPS and SystemExit(1). Catch that.
    with pytest.raises(SystemExit) as exc:
        main._run_fips_boot_self_test()
    assert exc.value.code == 1
