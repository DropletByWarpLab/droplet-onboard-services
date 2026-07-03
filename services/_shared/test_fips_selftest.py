"""Unit tests for fips_selftest helper.

These tests don't assume a FIPS-enabled OpenSSL on the runner (developer
laptops + GitHub runners don't have FIPS by default). They monkeypatch
the two probe primitives (`is_fips_enabled`, `md5_should_fail`) so we
can exercise both the success path and every failure mode against a
non-FIPS interpreter.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

# Make `services/_shared/` importable as a flat module so tests can run
# from the repo root or from this directory.
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fips_selftest  # noqa: E402
from fips_selftest import (  # noqa: E402
    FIPS_PROVIDER_NAME,
    FipsSelfTestError,
    assert_fips_at_boot,
    is_fips_enabled,
    md5_should_fail,
)


def test_md5_should_fail_returns_none_when_md5_works():
    # The dev runner has no FIPS; MD5 succeeds.
    assert md5_should_fail() is None


def test_is_fips_enabled_false_on_non_fips_runner():
    # No FIPS provider loaded on the dev runner.
    assert is_fips_enabled() is False


def test_assert_fips_at_boot_success_path(monkeypatch):
    monkeypatch.setattr(fips_selftest, "is_fips_enabled", lambda: True)
    monkeypatch.setattr(fips_selftest, "md5_should_fail", lambda: "disabled for fips")

    lines: list[str] = []
    result = assert_fips_at_boot("orchestrator", log=lines.append)

    assert result == {
        "event": "fips_self_test",
        "service": "orchestrator",
        "fips": True,
        "provider": FIPS_PROVIDER_NAME,
    }
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["event"] == "fips_self_test"
    assert parsed["service"] == "orchestrator"
    assert parsed["fips"] is True
    assert parsed["provider"] == FIPS_PROVIDER_NAME


def test_assert_fips_at_boot_raises_when_provider_not_loaded(monkeypatch):
    monkeypatch.setattr(fips_selftest, "is_fips_enabled", lambda: False)
    with pytest.raises(FipsSelfTestError) as exc_info:
        assert_fips_at_boot("file-indexer", log=lambda _l: None)
    assert exc_info.value.service == "file-indexer"
    assert "FIPS not enabled" in exc_info.value.reason


def test_assert_fips_at_boot_raises_when_md5_unexpectedly_works(monkeypatch):
    monkeypatch.setattr(fips_selftest, "is_fips_enabled", lambda: True)
    monkeypatch.setattr(fips_selftest, "md5_should_fail", lambda: None)
    with pytest.raises(FipsSelfTestError) as exc_info:
        assert_fips_at_boot("camera-discovery", log=lambda _l: None)
    assert exc_info.value.service == "camera-discovery"
    assert "not enforcing" in exc_info.value.reason


def test_assert_fips_at_boot_requires_service_name():
    with pytest.raises(FipsSelfTestError):
        assert_fips_at_boot("", log=lambda _l: None)


def test_assert_fips_at_boot_or_exit_exits_on_failure(monkeypatch):
    monkeypatch.setattr(fips_selftest, "is_fips_enabled", lambda: False)
    lines: list[str] = []
    with pytest.raises(SystemExit) as exc_info:
        fips_selftest.assert_fips_at_boot_or_exit("routing", log=lines.append)
    assert exc_info.value.code == 1
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["fips"] is False
    assert parsed["service"] == "routing"


# --- md5_should_fail probe (WARP-1018) --------------------------------------
#
# Under an enforcing FIPS provider, the OpenSSL-backed `_hashlib.new("md5")`
# raises, but `hashlib.new("md5")` catches that ValueError and silently falls
# back to the builtin `_md5` module — so a probe routed through `hashlib.new`
# "succeeds" and mis-reports FIPS as not enforcing. These tests simulate the
# enforcing provider by making `_hashlib.new` raise while the builtin `_md5`
# stays importable, exactly the shape of the production image.


def test_md5_probe_detects_openssl_rejection_despite_builtin_fallback(monkeypatch):
    """Regression for WARP-1018: the probe must consult the OpenSSL-backed
    path directly, not `hashlib.new`'s builtin-fallback wrapper."""
    import _hashlib

    def _reject(name, *args, **kwargs):
        raise ValueError("[digital envelope routines] unsupported")

    monkeypatch.setattr(_hashlib, "new", _reject)
    err = md5_should_fail()
    assert err is not None
    assert "unsupported" in err


def test_md5_probe_reports_generic_reason_when_error_message_empty(monkeypatch):
    import _hashlib

    def _reject(name, *args, **kwargs):
        raise ValueError("")

    monkeypatch.setattr(_hashlib, "new", _reject)
    assert md5_should_fail() == "md5 rejected"


def test_md5_probe_fails_closed_when_openssl_hashlib_missing(monkeypatch):
    """A CPython built without OpenSSL has no `_hashlib`. Enforcement can't
    be demonstrated, so the probe must return None → caller fails closed."""
    monkeypatch.setitem(sys.modules, "_hashlib", None)
    assert md5_should_fail() is None


# --- gated_assert_fips_at_boot ---------------------------------------------


@pytest.fixture()
def _reset_droplet_fips_env(monkeypatch):
    monkeypatch.delenv("DROPLET_FIPS_REQUIRED", raising=False)


def test_gated_skip_when_env_unset(_reset_droplet_fips_env):
    # No exception, no SystemExit.
    fips_selftest.gated_assert_fips_at_boot("camera-discovery")


@pytest.mark.parametrize("falsy", ["false", "0", "no", "FALSE", "False", "No"])
def test_gated_skip_when_env_falsy(monkeypatch, falsy):
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", falsy)
    fips_selftest.gated_assert_fips_at_boot("routing")


@pytest.mark.parametrize("truthy", ["true", "1", "TRUE", "True"])
def test_gated_calls_helper_when_env_truthy(monkeypatch, truthy):
    monkeypatch.setenv("DROPLET_FIPS_REQUIRED", truthy)
    # is_fips_enabled returns False on the dev runner → the helper
    # exits 1.
    with pytest.raises(SystemExit) as exc:
        fips_selftest.gated_assert_fips_at_boot("switch")
    assert exc.value.code == 1
