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


# ── WARP-1029 ────────────────────────────────────────────────────────────
#
# `verify=` alone did not make the pin meaningful. Both Hanwha probes walked
# `https` AND `http`, `continue`-ing to plaintext on ANY httpx.HTTPError —
# including a pinned-TLS handshake failure. An active on-path attacker could
# break the handshake, watch the caller retry over plain HTTP, serve its own
# `PublicKey` on that channel, and recover the admin password about to be
# POSTed. So a configured CA cert defended only against a PASSIVE
# eavesdropper, never the active MITM a pin implies.


class _SchemeRecordingClient:
    """Records every URL requested and fails them all, so a probe is forced
    to walk its whole scheme list — which is exactly what we assert on."""

    def __init__(self, **kwargs):
        self.requested: list[str] = []

    async def get(self, url, **kwargs):
        self.requested.append(url)
        raise vendor_init.httpx.ConnectError("handshake failed")

    async def post(self, url, **kwargs):
        self.requested.append(url)
        raise vendor_init.httpx.ConnectError("handshake failed")


def _schemes_tried(client: _SchemeRecordingClient) -> set[str]:
    return {url.split("://", 1)[0] for url in client.requested}


def test_status_probe_drops_the_plaintext_fallback_when_pinned(monkeypatch, tmp_path):
    cert = tmp_path / "camera-ca.pem"
    cert.write_text("cert")
    monkeypatch.setenv("CAMERA_INIT_CA_CERT", str(cert))

    client = _SchemeRecordingClient()
    hanwha = vendor_init.HanwhaInitializer()
    assert asyncio.run(hanwha._fetch_status(client, "192.0.2.10")) is None

    # The password POST is built from this probe's base URL, so a plaintext
    # retry here is what hands the secret to the attacker.
    assert _schemes_tried(client) == {"https"}
    assert not any(url.startswith("http://") for url in client.requested)


def test_vendor_match_probe_is_https_only_when_pinned(monkeypatch, tmp_path):
    cert = tmp_path / "camera-ca.pem"
    cert.write_text("cert")
    monkeypatch.setenv("CAMERA_INIT_CA_CERT", str(cert))

    client = _SchemeRecordingClient()
    hanwha = vendor_init.HanwhaInitializer()
    assert asyncio.run(hanwha.matches(client, "192.0.2.10")) is False

    # This one tried plaintext FIRST, so under a pin the very first packet
    # was a downgrade.
    assert _schemes_tried(client) == {"https"}


def test_unpinned_probes_keep_the_historical_scheme_order(monkeypatch):
    # The fallback exists for fresh-from-box cameras with no capturable cert
    # (see _tls_verify). Unpinned behaviour must stay byte-for-byte identical
    # or this fix breaks the default first-run path it is meant to protect.
    monkeypatch.delenv("CAMERA_INIT_CA_CERT", raising=False)
    hanwha = vendor_init.HanwhaInitializer()

    status_client = _SchemeRecordingClient()
    asyncio.run(hanwha._fetch_status(status_client, "192.0.2.10"))
    assert [url.split("://", 1)[0] for url in status_client.requested] == [
        "https",
        "http",
    ]

    match_client = _SchemeRecordingClient()
    asyncio.run(hanwha.matches(match_client, "192.0.2.10"))
    assert [url.split("://", 1)[0] for url in match_client.requested] == [
        "http",
        "https",
    ]


def test_probe_schemes_helper_reads_the_pin_directly(monkeypatch, tmp_path):
    # Pins the predicate itself, so a future caller that forgets to route
    # through _probe_schemes is the only way to regress this.
    monkeypatch.delenv("CAMERA_INIT_CA_CERT", raising=False)
    assert vendor_init._probe_schemes(("https", "http")) == ("https", "http")

    cert = tmp_path / "camera-ca.pem"
    cert.write_text("cert")
    monkeypatch.setenv("CAMERA_INIT_CA_CERT", str(cert))
    assert vendor_init._probe_schemes(("https", "http")) == ("https",)
    assert vendor_init._probe_schemes(("http", "https")) == ("https",)
