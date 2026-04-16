"""Tests for `_load_openwrt_password` — covers WARP-37 acceptance.

Resolution order: Docker secret file first, env var fallback. Missing values
must log a warning rather than crash (so dev bring-up without a router works).
"""

from __future__ import annotations

from pathlib import Path

import pytest

import main


def test_reads_from_secret_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    secret = tmp_path / "openwrt_password"
    secret.write_text("secret-value-from-file")
    monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(secret))
    # Env var present but should be ignored when the file has content.
    monkeypatch.setenv("OPENWRT_PASSWORD", "env-value-that-should-not-win")

    assert main._load_openwrt_password() == "secret-value-from-file"


def test_strips_trailing_whitespace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Editors append newlines; .strip() prevents a silent auth failure."""
    secret = tmp_path / "openwrt_password"
    secret.write_text("secret-with-newline\n")
    monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(secret))

    assert main._load_openwrt_password() == "secret-with-newline"


def test_falls_back_to_env_when_file_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    missing = tmp_path / "does-not-exist"
    monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(missing))
    monkeypatch.setenv("OPENWRT_PASSWORD", "env-fallback-value")

    with caplog.at_level("WARNING", logger="droplet.routing"):
        value = main._load_openwrt_password()

    assert value == "env-fallback-value"
    assert any("deprecated" in rec.message.lower() for rec in caplog.records)


def test_falls_back_to_env_when_file_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Empty placeholder file (created by setup.sh when OPENWRT_PASSWORD is unset
    in .env) should not be treated as a valid password."""
    secret = tmp_path / "openwrt_password"
    secret.write_text("")
    monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(secret))
    monkeypatch.setenv("OPENWRT_PASSWORD", "env-fallback-after-empty-file")

    with caplog.at_level("WARNING", logger="droplet.routing"):
        value = main._load_openwrt_password()

    assert value == "env-fallback-after-empty-file"
    assert any("empty" in rec.message.lower() for rec in caplog.records)


def test_returns_empty_when_nothing_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """With neither file nor env, service should start in a degraded state —
    no crash, just an empty password. main.py warns separately when loaded."""
    missing = tmp_path / "does-not-exist"
    monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(missing))
    monkeypatch.delenv("OPENWRT_PASSWORD", raising=False)

    assert main._load_openwrt_password() == ""


def test_handles_unreadable_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Permission errors on the mounted secret should fall back, not crash."""
    secret = tmp_path / "openwrt_password"
    secret.write_text("unreadable")
    secret.chmod(0)  # root-only — current user can't read
    monkeypatch.setenv("OPENWRT_PASSWORD_FILE", str(secret))
    monkeypatch.setenv("OPENWRT_PASSWORD", "env-after-perm-denied")

    try:
        with caplog.at_level("WARNING", logger="droplet.routing"):
            value = main._load_openwrt_password()
    finally:
        # Restore so pytest can clean up.
        secret.chmod(0o600)

    # Behaviour: either file is readable despite chmod 0 (running as root in CI)
    # OR we fell through to the env value. Both are acceptable outcomes.
    assert value in ("unreadable", "env-after-perm-denied")
