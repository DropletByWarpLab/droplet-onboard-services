"""Tests for `drivers._load_switch_password` — ADR-018 T1 acceptance.

Mirrors services/routing/tests/test_password_loader.py. The managed-switch
credential resolves from the Docker secret file first, then the deprecated
SWITCH_PASSWORD env var. Missing/empty values must NOT crash — the factory
keeps today's graceful "disconnected" behaviour so boxes without a managed
switch are unaffected (AC #1).
"""

from __future__ import annotations

from pathlib import Path

import pytest

import drivers


def test_reads_from_secret_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    secret = tmp_path / "switch_password"
    secret.write_text("secret-value-from-file")
    monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(secret))
    # Env var present but must be ignored when the file has content.
    monkeypatch.setenv("SWITCH_PASSWORD", "env-value-that-should-not-win")

    assert drivers._load_switch_password() == "secret-value-from-file"


def test_strips_trailing_whitespace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Editors append newlines; .strip() prevents a silent auth failure."""
    secret = tmp_path / "switch_password"
    secret.write_text("secret-with-newline\n")
    monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(secret))

    assert drivers._load_switch_password() == "secret-with-newline"


def test_falls_back_to_env_when_file_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    missing = tmp_path / "does-not-exist"
    monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(missing))
    monkeypatch.setenv("SWITCH_PASSWORD", "env-fallback-value")

    with caplog.at_level("WARNING", logger="droplet.switch.factory"):
        value = drivers._load_switch_password()

    assert value == "env-fallback-value"
    assert any("deprecated" in rec.message.lower() for rec in caplog.records)


def test_falls_back_to_env_when_file_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Empty placeholder file (written by setup.sh when SWITCH_PASSWORD is unset
    in .env) must not be treated as a valid password — fall through to env."""
    secret = tmp_path / "switch_password"
    secret.write_text("")
    monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(secret))
    monkeypatch.setenv("SWITCH_PASSWORD", "env-fallback-after-empty-file")

    with caplog.at_level("WARNING", logger="droplet.switch.factory"):
        value = drivers._load_switch_password()

    assert value == "env-fallback-after-empty-file"
    assert any("empty" in rec.message.lower() for rec in caplog.records)


def test_returns_empty_when_nothing_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Neither file nor env: the factory stays graceful (empty password →
    'disconnected' at connect-time), so a box without a managed switch is
    unaffected. No crash."""
    missing = tmp_path / "does-not-exist"
    monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(missing))
    monkeypatch.delenv("SWITCH_PASSWORD", raising=False)

    assert drivers._load_switch_password() == ""


def test_handles_unreadable_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Permission errors on the mounted secret should fall back, not crash."""
    secret = tmp_path / "switch_password"
    secret.write_text("unreadable")
    secret.chmod(0)  # root-only — current user can't read
    monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(secret))
    monkeypatch.setenv("SWITCH_PASSWORD", "env-after-perm-denied")

    try:
        with caplog.at_level("WARNING", logger="droplet.switch.factory"):
            value = drivers._load_switch_password()
    finally:
        # Restore so pytest can clean up.
        secret.chmod(0o600)

    # Either the file is readable despite chmod 0 (running as root in CI) OR we
    # fell through to the env value. Both are acceptable outcomes.
    assert value in ("unreadable", "env-after-perm-denied")


def test_factory_threads_secret_file_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """End-to-end: create_driver() resolves the password via the secret file and
    threads it into the driver (not the raw SWITCH_PASSWORD env)."""
    secret = tmp_path / "switch_password"
    secret.write_text("file-password")
    monkeypatch.setenv("SWITCH_DRIVER", "openwrt")
    monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(secret))
    monkeypatch.setenv("SWITCH_PASSWORD", "env-should-not-win")

    driver = drivers.create_driver()
    assert driver._password == "file-password"
