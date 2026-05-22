"""WARP-400 §5 — accept_camera uses build_rtsp_url when vendor known.

Verifies the plumbing between `vendor_initialize` and `accept_camera`:
after a successful init, the cred cache lets accept_camera build the
right per-vendor URL instead of handing Frigate the probe's guess.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, patch

import main as cd_main


@pytest.fixture(autouse=True)
def reset_state():
    """Each test starts with empty caches + no MAC restrictions."""
    cd_main.pending_cameras.clear()
    cd_main.known_cameras.clear()
    cd_main.rejected_macs.clear()
    cd_main._auto_init_attempted.clear()
    cd_main._initialized_creds.clear()
    yield
    cd_main.pending_cameras.clear()
    cd_main.known_cameras.clear()
    cd_main.rejected_macs.clear()
    cd_main._auto_init_attempted.clear()
    cd_main._initialized_creds.clear()


def _stub_camera(mac: str = "AA:BB:CC:00:11:22", ip: str = "192.168.20.176") -> dict:
    return {
        "mac": mac,
        "ip": ip,
        "rtsp_url": f"rtsp://{ip}:554/stream1",  # the probe's placeholder
        "hostname": "XNV-C8083R-E43022502AFD",
        "name": "hanwha_dome",
    }


@pytest.mark.asyncio
async def test_accept_uses_vendor_url_when_init_creds_present():
    mac = "AA:BB:CC:00:11:22"
    ip = "192.168.20.176"
    cd_main.pending_cameras[mac] = _stub_camera(mac, ip)
    cd_main._initialized_creds[ip] = {
        "vendor": "hanwha",
        "username": "admin",
        "password": "Droplet123!",
    }

    add_camera_mock = AsyncMock(return_value=True)
    with patch.object(cd_main.frigate, "add_camera", add_camera_mock):
        result = await cd_main.accept_camera(mac)

    assert result["status"] == "accepted"
    # Verify Frigate was called with the vendor-aware URL, NOT the probe URL.
    add_camera_mock.assert_called_once()
    args = add_camera_mock.call_args
    rtsp_url_passed = args[0][1]
    assert "/profile2/media.smp" in rtsp_url_passed, (
        f"expected Hanwha-shape URL, got {rtsp_url_passed}"
    )
    assert "admin:Droplet123%21@" in rtsp_url_passed, (
        f"expected URL-escaped credentials, got {rtsp_url_passed}"
    )
    # And the camera record gets the new URL too (so a future re-add doesn't drift).
    assert "/profile2/media.smp" in cd_main.known_cameras[mac]["rtsp_url"]
    assert cd_main.known_cameras[mac]["vendor"] == "hanwha"


@pytest.mark.asyncio
async def test_accept_falls_back_to_probe_url_when_no_creds():
    mac = "AA:BB:CC:00:11:22"
    ip = "192.168.20.99"
    cd_main.pending_cameras[mac] = _stub_camera(mac, ip)
    # No _initialized_creds entry — accept_camera should pass through the
    # probe's URL untouched.

    add_camera_mock = AsyncMock(return_value=True)
    with patch.object(cd_main.frigate, "add_camera", add_camera_mock):
        await cd_main.accept_camera(mac)

    args = add_camera_mock.call_args
    rtsp_url_passed = args[0][1]
    assert rtsp_url_passed == f"rtsp://{ip}:554/stream1"


@pytest.mark.asyncio
async def test_accept_falls_back_when_vendor_has_no_template():
    mac = "AA:BB:CC:00:11:22"
    ip = "192.168.20.176"
    cd_main.pending_cameras[mac] = _stub_camera(mac, ip)
    cd_main._initialized_creds[ip] = {
        "vendor": "ubiquiti",  # not in VENDOR_RTSP_TEMPLATES
        "username": "admin",
        "password": "x",
    }

    add_camera_mock = AsyncMock(return_value=True)
    with patch.object(cd_main.frigate, "add_camera", add_camera_mock):
        await cd_main.accept_camera(mac)

    args = add_camera_mock.call_args
    rtsp_url_passed = args[0][1]
    # Should be the probe's placeholder, not a fabricated URL.
    assert rtsp_url_passed == f"rtsp://{ip}:554/stream1"


@pytest.mark.asyncio
async def test_reject_clears_cred_cache_for_that_ip():
    mac = "AA:BB:CC:00:11:22"
    ip = "192.168.20.176"
    cd_main.pending_cameras[mac] = _stub_camera(mac, ip)
    cd_main._initialized_creds[ip] = {"vendor": "hanwha", "username": "admin", "password": "x"}

    await cd_main.reject_camera(mac)

    assert ip not in cd_main._initialized_creds
    assert mac in cd_main.rejected_macs


@pytest.mark.asyncio
async def test_accept_unknown_mac_404s():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await cd_main.accept_camera("does:not:exist:00:00:00")
    assert exc.value.status_code == 404
