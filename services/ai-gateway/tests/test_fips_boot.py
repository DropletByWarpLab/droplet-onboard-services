"""WARP-229 — ai-gateway FIPS boot self-test wiring.

Verifies the env-gated `_run_fips_boot_self_test()` shim in `main.py`
behaves correctly. Mirrors `services/file-indexer/tests/test_fips_boot.py`.

We call `_run_fips_boot_self_test()` directly rather than re-importing
`main`. main.py also runs the self-test at module-import time, but
popping `main` from `sys.modules` and re-importing it builds a *second*
`main` module object (with its own `app`/middleware and its own module
globals). Any later test that captured `main` at collection time would
then patch one object while the live `app` reads another's globals —
silently defeating monkeypatch and the auth/global setup in CI. Calling
the function on the single already-imported module avoids that entirely.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make sibling main.py importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # type: ignore  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_env(monkeypatch):
    monkeypatch.delenv("DROPLET_FIPS_REQUIRED", raising=False)


def test_skip_when_env_unset():
    # Env unset → skip path returns cleanly (no SystemExit).
    main._run_fips_boot_self_test()
    assert hasattr(main, "_run_fips_boot_self_test")


def test_skip_when_env_false(monkeypatch):
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "false")
    main._run_fips_boot_self_test()  # should not raise
    assert hasattr(main, "_run_fips_boot_self_test")


def test_required_path_calls_helper(monkeypatch):
    """When DROPLET_FIPS_REQUIRED=true and `_shared.fips_selftest` is
    importable, the function calls into the helper, which fails closed
    (SystemExit(1)) on a non-FIPS dev/CI runner.
    """
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "true")
    # Inject services/_shared's parent so `from _shared.fips_selftest ...`
    # resolves in the test context.
    shared_root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(shared_root))

    with pytest.raises(SystemExit) as exc:
        main._run_fips_boot_self_test()
    assert exc.value.code == 1
