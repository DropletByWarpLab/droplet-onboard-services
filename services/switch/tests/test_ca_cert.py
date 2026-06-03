"""NET-07 — SWITCH_CA_CERT must actually control TLS verification.

Previously `connect()` logged "Set SWITCH_CA_CERT to enable verification" but
hardcoded `verify=False` and never read the env var, giving operators silent
false assurance. These tests pin the real behaviour:

  * factory threads SWITCH_CA_CERT into the driver,
  * connect() passes the cert path to httpx `verify=` when set,
  * a configured-but-missing cert fails closed (no silent downgrade),
  * unset keeps the historical insecure default.

`httpx.AsyncClient` is patched to capture the `verify` kwarg so no socket or
real switch is touched.
"""

from __future__ import annotations

import asyncio

import pytest

from drivers import create_driver
from drivers.lantronix import LantronixDriver


class _FakeAsyncClient:
    """Captures constructor kwargs; the driver only sets cookies on it here
    because we stub out the auth call."""

    last_verify = None

    def __init__(self, **kwargs):
        type(self).last_verify = kwargs.get("verify")
        self.cookies = self  # minimal: .cookies.set(...) is a no-op

    def set(self, *a, **k):
        pass


def _make_driver(ca_cert):
    return LantronixDriver(
        host="127.0.0.1", port=443, username="admin", password="pw", ca_cert=ca_cert
    )


def _patch_client_and_auth(monkeypatch):
    monkeypatch.setattr("drivers.lantronix.httpx.AsyncClient", _FakeAsyncClient)

    async def _noop(self):
        return None

    monkeypatch.setattr(LantronixDriver, "_authenticate", _noop)
    monkeypatch.setattr(LantronixDriver, "_keepalive_loop", _noop)


def test_factory_reads_ca_cert_env(monkeypatch, tmp_path):
    cert = tmp_path / "switch-ca.pem"
    cert.write_text("-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n")
    monkeypatch.setenv("SWITCH_DRIVER", "lantronix")
    monkeypatch.setenv("SWITCH_CA_CERT", str(cert))
    driver = create_driver()
    assert driver._ca_cert == str(cert)


def test_factory_unset_ca_cert_is_none(monkeypatch):
    monkeypatch.setenv("SWITCH_DRIVER", "lantronix")
    monkeypatch.delenv("SWITCH_CA_CERT", raising=False)
    driver = create_driver()
    assert driver._ca_cert is None


def test_connect_uses_cert_path_for_verify(monkeypatch, tmp_path):
    cert = tmp_path / "ca.pem"
    cert.write_text("cert")
    _patch_client_and_auth(monkeypatch)
    driver = _make_driver(str(cert))
    asyncio.run(driver.connect())
    assert _FakeAsyncClient.last_verify == str(cert)


def test_connect_unset_keeps_verify_false(monkeypatch):
    _patch_client_and_auth(monkeypatch)
    driver = _make_driver(None)
    asyncio.run(driver.connect())
    assert _FakeAsyncClient.last_verify is False


def test_connect_missing_cert_fails_closed(monkeypatch, tmp_path):
    _patch_client_and_auth(monkeypatch)
    driver = _make_driver(str(tmp_path / "nope.pem"))
    with pytest.raises(ValueError, match="SWITCH_CA_CERT"):
        asyncio.run(driver.connect())
