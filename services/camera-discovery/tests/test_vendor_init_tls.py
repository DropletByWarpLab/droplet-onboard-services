"""WARP-583 — CAMERA_INIT_CA_CERT must control TLS verification for the
camera first-run (vendor-init) HTTPS clients.

Previously ``check_status()`` / ``initialize_camera()`` hardcoded
``httpx.AsyncClient(verify=False)``, leaving the first-run admin-password
set open to an on-LAN MITM. These tests pin the fixed behaviour, mirroring
services/switch/tests/test_ca_cert.py (SWITCH_CA_CERT, NET-07):

  * a configured CAMERA_INIT_CA_CERT path is passed to httpx ``verify=``,
  * unset keeps the historical unverified client but logs a loud warning
    (once per process — the scan loop calls check_status every tick),
  * a configured-but-missing cert fails closed (no silent downgrade).

``httpx.AsyncClient`` is patched to capture the ``verify`` kwarg and
``detect_vendor`` is stubbed out so no camera (or socket) is ever touched.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

import vendor_init


class _FakeAsyncClient:
    """Captures constructor kwargs; used only as an async context manager
    because detect_vendor is stubbed to return None."""

    last_verify = None

    def __init__(self, **kwargs):
        type(self).last_verify = kwargs.get("verify")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def _patch_client(monkeypatch):
    monkeypatch.setattr(vendor_init.httpx, "AsyncClient", _FakeAsyncClient)

    async def _no_vendor(client, ip):
        return None

    monkeypatch.setattr(vendor_init, "detect_vendor", _no_vendor)
    monkeypatch.delenv("CAMERA_INIT_CA_CERT", raising=False)
    # Reset the warn-once latch so every test observes its own logging.
    monkeypatch.setattr(vendor_init, "_unverified_tls_warned", False)
    _FakeAsyncClient.last_verify = None


def test_check_status_passes_pinned_cert_to_verify(monkeypatch, tmp_path):
    cert = tmp_path / "camera-ca.pem"
    cert.write_text("-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n")
    monkeypatch.setenv("CAMERA_INIT_CA_CERT", str(cert))
    asyncio.run(vendor_init.check_status("192.0.2.10"))
    assert _FakeAsyncClient.last_verify == str(cert)


def test_initialize_camera_passes_pinned_cert_to_verify(monkeypatch, tmp_path):
    cert = tmp_path / "camera-ca.pem"
    cert.write_text("cert")
    monkeypatch.setenv("CAMERA_INIT_CA_CERT", str(cert))
    result = asyncio.run(vendor_init.initialize_camera("192.0.2.10", "admin", "pw"))
    assert _FakeAsyncClient.last_verify == str(cert)
    # detect_vendor is stubbed to None — the call still completes cleanly.
    assert result.success is False
    assert result.vendor == "unknown"


def test_unset_keeps_unverified_client_and_warns(caplog):
    with caplog.at_level(logging.WARNING, logger="vendor_init"):
        asyncio.run(vendor_init.check_status("192.0.2.10"))
    assert _FakeAsyncClient.last_verify is False
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("CAMERA_INIT_CA_CERT" in message for message in warnings)


def test_unverified_warning_fires_once_per_process(caplog):
    with caplog.at_level(logging.WARNING, logger="vendor_init"):
        asyncio.run(vendor_init.check_status("192.0.2.10"))
        asyncio.run(vendor_init.check_status("192.0.2.11"))
    warnings = [
        r
        for r in caplog.records
        if r.levelno == logging.WARNING and "CAMERA_INIT_CA_CERT" in r.getMessage()
    ]
    assert len(warnings) == 1


def test_missing_cert_fails_closed(monkeypatch, tmp_path):
    monkeypatch.setenv("CAMERA_INIT_CA_CERT", str(tmp_path / "nope.pem"))
    with pytest.raises(ValueError, match="CAMERA_INIT_CA_CERT"):
        asyncio.run(vendor_init.check_status("192.0.2.10"))
    with pytest.raises(ValueError, match="CAMERA_INIT_CA_CERT"):
        asyncio.run(vendor_init.initialize_camera("192.0.2.10", "admin", "pw"))
