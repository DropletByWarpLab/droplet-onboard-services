"""FIPS 140-3 boot self-test for Python services.

Each service calls ``assert_fips_at_boot(service_name)`` at startup. The
helper:

1. Confirms the OpenSSL FIPS provider is loaded — by way of
   ``cryptography``'s backend ``_fips_enabled`` flag.
2. Negative-confirms by attempting an OpenSSL-backed
   ``_hashlib.new("md5", ..., usedforsecurity=True)`` and asserting it
   raises a FIPS-disabled error. Deliberately NOT ``hashlib.new`` — that
   wrapper silently falls back to the builtin ``_md5`` when OpenSSL
   rejects the digest, masking enforcement (WARP-1018; see
   :func:`md5_should_fail`).
3. Emits a structured JSON log line on stdout so the audit-log integration
   (WARP-237) can ingest it retroactively::

       {"event":"fips_self_test","service":"<name>","fips":true,
        "provider":"OpenSSL 3 FIPS"}

4. On any failure mode raises :class:`FipsSelfTestError`. Callers that
   want fail-closed behavior should let it propagate so the container
   exits non-zero. :func:`assert_fips_at_boot_or_exit` is the shorthand
   for that.

We wrap the runtime check behind one helper so the
``cryptography`` library's internal ``_fips_enabled`` flag — which IS an
internal API — has exactly one place to maintain if the upstream surface
changes on a future ``cryptography`` upgrade. Risk-register entry, design
spec §Risk register.
"""

from __future__ import annotations

import json
import sys
from typing import Callable, Optional, TypedDict

FIPS_PROVIDER_NAME = "OpenSSL 3 FIPS"


class FipsSelfTestResult(TypedDict):
    event: str
    service: str
    fips: bool
    provider: str


class FipsSelfTestError(RuntimeError):
    """Raised when the FIPS boot self-test fails for any reason."""

    def __init__(self, reason: str, service: str) -> None:
        super().__init__(f"FIPS self-test failed for {service}: {reason}")
        self.reason = reason
        self.service = service


def is_fips_enabled() -> bool:
    """Return True if the running OpenSSL has the FIPS provider active.

    Uses ``cryptography.hazmat.backends.default_backend()._fips_enabled``.
    This is internal API by upstream contract, but it is the only stable
    runtime indicator. Wrap behind this helper so a future ``cryptography``
    upgrade is a one-place fix.
    """
    try:
        from cryptography.hazmat.backends import default_backend

        backend = default_backend()
        # _fips_enabled is the internal flag; treat any AttributeError as
        # "no FIPS" — the helper fails closed.
        return bool(getattr(backend, "_fips_enabled", False))
    except Exception:
        return False


def md5_should_fail() -> Optional[str]:
    """Return the FIPS-disabled error string when OpenSSL rejects MD5.

    Returns None if MD5 was *not* proven rejected — which means FIPS is
    not (demonstrably) enforcing and the caller should fail closed.

    Why this probes ``_hashlib`` directly instead of ``hashlib.new``
    (WARP-1018): under an enforcing FIPS provider the OpenSSL-backed
    ``_hashlib.new("md5")`` raises ``ValueError`` (3.12's
    ``_hashlib.UnsupportedDigestmodError`` subclasses it), but CPython's
    ``hashlib.__hash_new`` *catches* that ValueError and silently falls
    back to ``__get_builtin_constructor("md5")`` — the pure-CPython
    ``_md5`` module, which knows nothing about FIPS. The fallback also
    drops all kwargs, so even an explicit ``usedforsecurity=True`` never
    reaches the builtin. Net effect: ``hashlib.new("md5")`` "succeeds"
    under a correctly-enforcing provider and the self-test mis-reports
    FIPS as not enforcing. ``_hashlib.new`` is the unambiguous probe:
    it is the OpenSSL EVP path with no builtin fallback.
    """
    try:
        import _hashlib
    except ImportError:
        # A CPython built without OpenSSL has no `_hashlib`, so the
        # OpenSSL-backed path — the thing FIPS governs — cannot be
        # probed at all. Enforcement is undemonstrated; return None so
        # the caller fails closed, same posture as "md5 succeeded".
        # Unreachable in our images (python:3.12 links OpenSSL), but
        # handled explicitly rather than letting an ImportError escape
        # and masquerade as a probe crash.
        return None

    try:
        # `usedforsecurity=True` is the default; pinning it explicitly so
        # this probe is unambiguous against a future Python that flips
        # the default.
        # fips:allowed: fips-selftest-negative-probe
        _hashlib.new("md5", b"fips-selftest-probe", usedforsecurity=True).hexdigest()
    except ValueError as err:
        return str(err) or "md5 rejected"
    except Exception as err:  # noqa: BLE001 — any reject is acceptable
        return str(err) or "md5 rejected"
    return None


LogSink = Callable[[str], None]


def _default_log_sink(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def assert_fips_at_boot(
    service: str,
    *,
    log: Optional[LogSink] = None,
) -> FipsSelfTestResult:
    """Assert FIPS is loaded and enforcing at boot.

    Emits a structured log line on success. Raises ``FipsSelfTestError``
    on any failure mode:
      - ``_fips_enabled`` is False (OpenSSL FIPS provider not loaded).
      - MD5 succeeds (FIPS provider loaded but not enforcing).

    Callers should let the exception propagate so the process exits non-zero.
    """
    if not service or not isinstance(service, str):
        raise FipsSelfTestError("service name required", str(service))

    if not is_fips_enabled():
        raise FipsSelfTestError(
            "cryptography backend reports FIPS not enabled — "
            "OPENSSL_CONF likely not pointing at the FIPS config",
            service,
        )

    md5_err = md5_should_fail()
    if md5_err is None:
        raise FipsSelfTestError(
            "MD5 digest succeeded — FIPS provider is loaded but not enforcing",
            service,
        )

    result: FipsSelfTestResult = {
        "event": "fips_self_test",
        "service": service,
        "fips": True,
        "provider": FIPS_PROVIDER_NAME,
    }
    sink = log if log is not None else _default_log_sink
    sink(json.dumps(result))
    return result


def assert_fips_at_boot_or_exit(
    service: str,
    *,
    log: Optional[LogSink] = None,
) -> FipsSelfTestResult:
    """Same as :func:`assert_fips_at_boot` but logs+exits non-zero on failure.

    Convenience for top-of-module boot guards.
    """
    try:
        return assert_fips_at_boot(service, log=log)
    except FipsSelfTestError as err:
        payload = {
            "event": "fips_self_test",
            "service": service,
            "fips": False,
            "reason": err.reason,
        }
        sink = log if log is not None else (lambda l: sys.stderr.write(l + "\n"))
        sink(json.dumps(payload))
        sys.exit(1)


def gated_assert_fips_at_boot(service: str) -> None:
    """Env-gated wrapper. Each Python service calls this at module
    import time. Behavior:

      DROPLET_FIPS_REQUIRED=true / 1     → run the boot self-test;
                                            exit 1 on failure.
      DROPLET_FIPS_REQUIRED=false / 0    → skip with no output.
      DROPLET_FIPS_REQUIRED unset        → skip with no output (dev/CI default).

    The default-off-when-unset posture is deliberate. Production
    deployments (the appliance) flip the env to "true" via the
    operator's compose env or systemd unit; dev / CI runs with
    `python:3.12-slim` (no validated `fips.so` available) skip silently.
    """
    import os

    raw = os.environ.get("DROPLET_FIPS_REQUIRED")
    if raw is None:
        return
    if raw.lower() in ("false", "0", "no"):
        return
    assert_fips_at_boot_or_exit(service)
