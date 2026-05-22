"""Tests for WARP-400 §5 vendor RTSP URL builder.

The accept_camera flow used to hand Frigate a placeholder URL (or
the wrong Hikvision-shape default for any vendor whose probe missed)
which left Hanwha + Reolink rigs in permanent "loading". The
build_rtsp_url helper closes that gap by picking the right path per
vendor and URL-escaping the embedded credential.
"""

from __future__ import annotations

import pytest

from frigate_client import (
    VENDOR_RTSP_TEMPLATES,
    UnsupportedVendor,
    build_rtsp_url,
)


class TestBuildRtspUrl:
    def test_hanwha_uses_profile2_media_smp(self):
        url = build_rtsp_url("hanwha", "192.168.20.176", "admin", "Droplet123!")
        # Apostrophe is URL-safe and gets passed through; '!' is also safe.
        assert url == "rtsp://admin:Droplet123%21@192.168.20.176:554/profile2/media.smp"

    def test_hikvision_uses_streaming_channels_101(self):
        url = build_rtsp_url("hikvision", "10.0.0.5", "admin", "secret")
        assert "/Streaming/Channels/101" in url

    def test_axis_uses_axis_media(self):
        assert "/axis-media/media.amp" in build_rtsp_url("axis", "10.0.0.5", "u", "p")

    def test_dahua_uses_realmonitor(self):
        assert "channel=1&subtype=0" in build_rtsp_url("dahua", "10.0.0.5", "u", "p")

    def test_reolink_uses_h264preview(self):
        assert "/h264Preview_01_main" in build_rtsp_url("reolink", "10.0.0.5", "u", "p")

    def test_amcrest_uses_realmonitor(self):
        assert "channel=1&subtype=0" in build_rtsp_url("amcrest", "10.0.0.5", "u", "p")

    def test_unknown_vendor_raises(self):
        with pytest.raises(UnsupportedVendor):
            build_rtsp_url("nonexistent_brand", "10.0.0.5", "u", "p")

    def test_empty_ip_raises(self):
        with pytest.raises(ValueError):
            build_rtsp_url("hanwha", "", "u", "p")

    def test_case_insensitive_vendor(self):
        # Camera-discovery's vendor_init normalises but defensive callers may not.
        url = build_rtsp_url("Hanwha", "10.0.0.5", "u", "p")
        assert "/profile2/media.smp" in url
        # Mixed case + whitespace
        url = build_rtsp_url("  HIKVISION  ", "10.0.0.5", "u", "p")
        assert "/Streaming/Channels/101" in url

    def test_special_chars_in_credentials_are_url_encoded(self):
        # The notorious password-with-@ case — without escaping the URL
        # parses as user="u" / host="p@ss@10.0.0.5" and the camera 401s.
        url = build_rtsp_url("hanwha", "10.0.0.5", "admin", "p@ss/word#1")
        # `@` becomes %40, `/` becomes %2F, `#` becomes %23.
        assert "admin:p%40ss%2Fword%231@10.0.0.5" in url

    def test_empty_credentials_emit_empty_userinfo(self):
        # Camera-discovery does sometimes call this before a password is set;
        # the result should still be a parseable URL (Frigate will surface
        # the auth error). NOT a build-time exception.
        url = build_rtsp_url("hanwha", "10.0.0.5", "", "")
        assert url == "rtsp://:@10.0.0.5:554/profile2/media.smp"

    def test_every_template_covers_known_vendors(self):
        # Locks the supported-vendor list against accidental removal.
        expected = {"hanwha", "hikvision", "axis", "dahua", "reolink", "amcrest"}
        assert set(VENDOR_RTSP_TEMPLATES.keys()) == expected
