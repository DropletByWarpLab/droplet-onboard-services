"""Hermetic test for the factory-reset host executor script (WARP-825).

scripts/host/droplet-factory-reset.sh is the host-mutation layer the
device-bridge spawns (detached) for an owner-confirmed factory reset. It is a
thin, auditable wrapper around the canonical scripts/factory-reset.sh --yes; the
bridge never runs `docker compose down -v` itself, and this wrapper never
re-implements the wipe — it delegates to the one canonical reset script so the
wipe list / safety backup / audit-key era boundary stay in ONE place.

SAFETY: every test here runs the script with DROPLET_FACTORY_RESET_DRY_RUN=1, so
the real scripts/factory-reset.sh is NEVER invoked and nothing is wiped. The
dry-run prints the exact command it WOULD run instead of running it. Skipped
automatically if a POSIX `bash` isn't on PATH.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "scripts" / "host" / "droplet-factory-reset.sh"
)
CANONICAL = (
    Path(__file__).resolve().parents[3] / "scripts" / "factory-reset.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def _run(params: dict, extra_env: dict | None = None):
    env = dict(os.environ)
    # Never actually wipe in tests — dry-run prints the command instead.
    env["DROPLET_FACTORY_RESET_DRY_RUN"] = "1"
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [BASH, str(SCRIPT), json.dumps(params)],
        env=env, capture_output=True, text=True, timeout=30,
    )


def test_script_exists_and_is_executable_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    first = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("#!") and "bash" in first


def test_dry_run_delegates_to_canonical_reset_with_yes():
    """The wrapper must delegate to scripts/factory-reset.sh --yes — it must NOT
    re-implement `docker compose down -v` / volume removal itself (single source
    of truth for the wipe list + safety backup + audit-key era boundary)."""
    proc = _run({"jobId": "job-1", "targetName": "droplet-home"})
    assert proc.returncode == 0, proc.stderr
    out = proc.stdout
    # It delegates to the canonical reset script, non-interactively.
    assert "factory-reset.sh" in out
    assert "--yes" in out
    # It does NOT hand-roll the wipe.
    assert "down -v" not in out
    assert "docker volume rm" not in out


def test_dry_run_does_not_invoke_docker():
    proc = _run({"jobId": "job-1", "targetName": "droplet-home"})
    assert proc.returncode == 0, proc.stderr
    # No raw docker invocation leaks from the wrapper itself.
    assert "docker compose down" not in proc.stdout


def test_runs_without_params_arg():
    """The job context is informational; a missing/empty arg must not crash the
    wrapper (the wipe targets the whole box regardless)."""
    env = dict(os.environ)
    env["DROPLET_FACTORY_RESET_DRY_RUN"] = "1"
    proc = subprocess.run(
        [BASH, str(SCRIPT)],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr


def test_canonical_reset_script_is_present():
    """The wrapper is useless without the canonical reset script it delegates
    to; assert the repo layout the wrapper depends on."""
    assert CANONICAL.exists(), f"missing {CANONICAL}"
