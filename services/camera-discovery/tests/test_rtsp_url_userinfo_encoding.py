"""WARP-1873 — the prober's INTERNAL stream URL remains parseable and decodable.

The internal form leaves userinfo sub-delimiters literal and encodes characters
that could change the URL's authority. The verifier decodes it once. This is
separate from the Frigate config form: Frigate re-encodes matching usernames'
raw passwords before ffmpeg decodes them once. See test_rtsp_url.py for the
end-to-end assertions on what the camera receives (WARP-3505).
"""

from __future__ import annotations

from urllib.parse import urlsplit

import pytest

import rtsp_prober

USER, PW = "admin", "T3stCamPw!"
PATH = "/profile2/media.smp"


def _patch_probe(monkeypatch, user=USER, pw=PW, port=554):
    """Drive probe_camera to the credentialed branch without a live camera."""

    async def only_our_port(ip, ports=None, timeout=2.0):
        return [port]

    async def no_anonymous_stream(ip, p, timeout=2.0):
        return None

    async def creds_match(ip, p, timeout=2.0):
        return (PATH, user, pw)

    monkeypatch.setattr(rtsp_prober, "scan_ports", only_our_port)
    monkeypatch.setattr(rtsp_prober, "probe_rtsp_stream", no_anonymous_stream)
    monkeypatch.setattr(rtsp_prober, "probe_rtsp_with_credentials", creds_match)


class TestSubDelimsTravelLiterally:
    @pytest.mark.asyncio
    async def test_bang_password_is_not_percent_encoded(self, monkeypatch):
        """The live regression: `!` is a legal userinfo sub-delim."""
        _patch_probe(monkeypatch)
        info = await rtsp_prober.probe_camera("192.168.9.219")

        assert info is not None
        assert "%21" not in info["rtsp_url"]
        assert f"{USER}:{PW}@" in info["rtsp_url"]

    @pytest.mark.asyncio
    async def test_internal_sub_delim_stays_literal(self, monkeypatch):
        """The INTERNAL representation leaves this legal userinfo sub-delim literal.

        This checks the stored internal spelling; test_rtsp_url.py checks the
        Frigate/ffmpeg boundary and the password finally sent to the camera.
        """
        _patch_probe(monkeypatch)
        info = await rtsp_prober.probe_camera("192.168.9.219")

        userinfo = urlsplit(info["rtsp_url"]).netloc.rsplit("@", 1)[0]
        raw_user, _, raw_pw = userinfo.partition(":")

        assert raw_user == USER
        assert raw_pw == PW

    @pytest.mark.parametrize("pw", ["p$ss", "a&b", "x=y", "co,ma", "semi;colon",
                                    "quo'te", "pa(ren)s", "plus+", "star*", "b!ng"])
    @pytest.mark.asyncio
    async def test_every_sub_delim_survives(self, monkeypatch, pw):
        """RFC 3986 sub-delims are all legal in userinfo — none may be escaped."""
        _patch_probe(monkeypatch, pw=pw)
        info = await rtsp_prober.probe_camera("192.168.9.219")

        raw = urlsplit(info["rtsp_url"]).netloc.rsplit("@", 1)[0].partition(":")[2]
        assert raw == pw
        assert "%" not in raw


class TestAmbiguousCharactersStayEncoded:
    """Characters that would break the parse must still be escaped — leaving
    them literal would be a worse bug than the one being fixed."""

    @pytest.mark.parametrize("pw,escape", [("pa@ss", "%40"), ("pa/ss", "%2F"),
                                           ("pa ss", "%20"), ("pa%ss", "%25")])
    @pytest.mark.asyncio
    async def test_reserved_characters_are_escaped(self, monkeypatch, pw, escape):
        _patch_probe(monkeypatch, pw=pw)
        info = await rtsp_prober.probe_camera("192.168.9.219")

        assert escape in info["rtsp_url"]
        # The host must still parse out cleanly — that is the whole point of
        # escaping these rather than passing them through.
        assert urlsplit(info["rtsp_url"]).hostname == "192.168.9.219"

    @pytest.mark.asyncio
    async def test_colon_in_password_is_escaped(self, monkeypatch):
        """The INTERNAL form encodes password colons for consistent URL parsing."""
        _patch_probe(monkeypatch, pw="pa:ss")
        info = await rtsp_prober.probe_camera("192.168.9.219")

        assert "%3A" in info["rtsp_url"].upper()
        assert urlsplit(info["rtsp_url"]).username == USER


class TestInternalRoundTripStillHolds:
    @pytest.mark.asyncio
    async def test_verify_stream_recovers_the_password(self, monkeypatch):
        """The prober's own consumer unquotes, so it must still see the real
        password — the fix must not trade the external consumer for it."""
        _patch_probe(monkeypatch)
        info = await rtsp_prober.probe_camera("192.168.9.219")

        seen = {}

        async def capture(host, port, path, user, pw, timeout=5.0):
            seen.update(host=host, port=port, path=path, user=user, pw=pw)
            return True

        monkeypatch.setattr(rtsp_prober, "_try_credentials_once", capture)
        assert await rtsp_prober.verify_stream(info["rtsp_url"]) is True
        assert seen["user"] == USER
        assert seen["pw"] == PW

    @pytest.mark.asyncio
    async def test_roundtrip_holds_for_an_escaped_password(self, monkeypatch):
        """Escaped characters must still decode correctly on the way back in."""
        _patch_probe(monkeypatch, pw="pa@ss")
        info = await rtsp_prober.probe_camera("192.168.9.219")

        seen = {}

        async def capture(host, port, path, user, pw, timeout=5.0):
            seen["pw"] = pw
            return True

        monkeypatch.setattr(rtsp_prober, "_try_credentials_once", capture)
        await rtsp_prober.verify_stream(info["rtsp_url"])
        assert seen["pw"] == "pa@ss"
