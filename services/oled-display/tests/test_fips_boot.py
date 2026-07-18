"""WARP-1023 — oled-display FIPS boot self-test wiring.

Mirrors `services/file-indexer/tests/test_fips_boot.py`, adapted to this
service's wiring: main.py has no `_run_fips_boot_self_test()` shim — it
calls `_shared.fips_selftest.gated_assert_fips_at_boot("oled-display")`
directly at module-import time (WARP-229). So the env matrix is exercised
against the gated helper itself, and the required-path boot is exercised
by importing `main` in a subprocess (re-importing main in-process would
build a second module object and defeat monkeypatching in sibling tests —
see services/ai-gateway/tests/test_fips_boot.py's docstring).

We don't exercise the passing assert path (that requires a FIPS OpenSSL);
services/_shared/test_fips_selftest.py covers the helper's contract.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_SERVICE_DIR = Path(__file__).resolve().parents[1]
_SERVICES_DIR = _SERVICE_DIR.parent

# Unlike services/switch, this service's conftest.py only adds the service
# dir to sys.path — add services/ so `_shared.*` resolves (in-container the
# helper is COPY'd to /app/_shared).
if str(_SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICES_DIR))

from _shared import fips_selftest  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_env(monkeypatch):
    monkeypatch.delenv("DROPLET_FIPS_REQUIRED", raising=False)


def test_skip_when_env_unset(capsys):
    assert fips_selftest.gated_assert_fips_at_boot("oled-display") is None
    out, err = capsys.readouterr()
    assert out == "" and err == ""


def test_skip_when_env_false(monkeypatch, capsys):
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "false")
    assert fips_selftest.gated_assert_fips_at_boot("oled-display") is None
    out, err = capsys.readouterr()
    assert out == "" and err == ""


def test_skip_when_env_zero(monkeypatch, capsys):
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "0")
    assert fips_selftest.gated_assert_fips_at_boot("oled-display") is None
    out, err = capsys.readouterr()
    assert out == "" and err == ""


def test_required_fails_closed_on_non_fips_runner(monkeypatch):
    """DROPLET_FIPS_REQUIRED=true → the helper fails closed (SystemExit 1)
    on a non-FIPS dev/CI runner."""
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", "true")
    with pytest.raises(SystemExit) as exc:
        fips_selftest.gated_assert_fips_at_boot("oled-display")
    assert exc.value.code == 1


def test_boot_wires_the_gate(tmp_path):
    """Booting main.py with DROPLET_FIPS_REQUIRED=true must exit 1 via the
    module-level gate, emitting the structured fips_self_test failure line
    — proving the boot block actually runs (a refactor dropping it would
    import cleanly and fail this test)."""
    env = os.environ.copy()
    env["DROPLET_FIPS_REQUIRED"] = "true"
    env["PYTHONPATH"] = str(_SERVICES_DIR)
    proc = subprocess.run(
        [sys.executable, "-c", "import main"],
        cwd=_SERVICE_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 1, proc.stderr
    payload = json.loads(proc.stderr.strip().splitlines()[-1])
    assert payload["event"] == "fips_self_test"
    assert payload["service"] == "oled-display"
    assert payload["fips"] is False
    assert payload["reason"]


def test_cryptography_dependency_pinned():
    """WARP-1023: is_fips_enabled() needs the `cryptography` package; the
    probe swallows ImportError and mis-reports "FIPS not enabled" if the
    dep is missing. Pin must stay in requirements.txt (nothing else in
    this service pulls it transitively) and the probe must be callable."""
    requirements = (_SERVICE_DIR / "requirements.txt").read_text()
    assert any(
        line.startswith("cryptography>=") or line.startswith("cryptography==")
        for line in requirements.splitlines()
    ), "cryptography pin missing from services/oled-display/requirements.txt"
    import cryptography  # noqa: F401 — the pinned dep must be importable

    assert isinstance(fips_selftest.is_fips_enabled(), bool)
