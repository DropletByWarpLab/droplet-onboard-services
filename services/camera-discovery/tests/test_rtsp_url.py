"""WARP-3505 — a camera's password must reach the camera exactly as typed.

The QA finding behind this file: the URL we wrote into Frigate carried the
password percent-encoded (``C%40mera!2024``), but Frigate 0.17 percent-encodes
the password itself (``escape_special_characters``) before ffmpeg URL-decodes it
once — so the encoding was applied twice and the camera received
``C%40mera!2024``: 401 forever, then a Hanwha lockout. Raw ``WarpLab123!`` works
on the real camera; ``%21`` was the WARP-1873 failure, which had been put down to
"ffmpeg does not decode userinfo" (it does, once).

Every assertion here is made on what the CAMERA receives, by running the stored
path through the Frigate + ffmpeg emulation in ``frigate_emulator``. Looking at the
stored URL is exactly the mistake that let this through.
"""

from __future__ import annotations

import pytest
from time import perf_counter

import rtsp_url
from tests.frigate_emulator import camera_connects_to, camera_receives, frigate_escape

IP, PORT, PATH = "192.168.9.219", 554, "/profile2/media.smp"

# The four passwords QA named, then the characters each part of the chain treats
# specially: '%' (decoded), '+' (not decoded by ffmpeg), '&=', non-ASCII, and
# the unreserved set.
PASSWORDS = [
    "C@mera!2024",
    "Qa@2024#x",
    "p:ss/w?rd",
    "WarpLab123!",
    "100%sure",
    "a+b=c&d",
    "ünïcode✓pw",
    "~tilde.-_",
    "x@y@z",
]
# Frigate's regex matches [A-Za-z0-9_-]+ ; everything else must go through as
# percent-encoded because nothing re-encodes it.
MATCHING_USERS = ["admin", "svc_cam-1", "Root", "u"]
OTHER_USERS = ["john.doe", "ops@example.com", "ünï", "a b"]


def stored_path(user: str, pw: str) -> str:
    """What lands in Frigate's config for a credentials add: internal URL -> boundary."""
    return rtsp_url.to_frigate_url(rtsp_url.internal_url(user, pw, IP, PORT, PATH))


class TestEmulator:
    def test_pre_encoded_password_is_encoded_twice_and_the_camera_gets_the_percent_escape(self):
        """The bug, reproduced: this is what the old code stored."""
        old_stored = f"rtsp://admin:C%40mera!2024@{IP}:{PORT}{PATH}"
        assert camera_receives(old_stored) == ("admin", "C%40mera!2024")

    def test_raw_password_survives_frigate_then_ffmpeg(self):
        raw_stored = f"rtsp://admin:C@mera!2024@{IP}:{PORT}{PATH}"
        assert camera_receives(raw_stored) == ("admin", "C@mera!2024")

    def test_a_username_outside_frigates_pattern_is_left_alone_by_frigate(self):
        stored = f"rtsp://john.doe:C%40mera%212024@{IP}:{PORT}{PATH}"
        assert frigate_escape(stored) == stored
        assert camera_receives(stored) == ("john.doe", "C@mera!2024")


class TestPasswordArrivesAsTyped:
    @pytest.mark.parametrize("pw", PASSWORDS)
    @pytest.mark.parametrize("user", MATCHING_USERS)
    def test_matching_username_stores_the_password_raw(self, user, pw):
        stored = stored_path(user, pw)
        assert f"{user}:{pw}@{IP}" in stored  # raw, not pre-encoded
        assert camera_receives(stored) == (user, pw)

    @pytest.mark.parametrize("pw", PASSWORDS)
    @pytest.mark.parametrize("user", OTHER_USERS)
    def test_other_username_stores_both_percent_encoded(self, user, pw):
        stored = stored_path(user, pw)
        assert frigate_escape(stored) == stored  # nothing re-encodes it
        assert camera_receives(stored) == (user, pw)

    def test_the_four_passwords_named_in_review(self):
        for pw in ("C@mera!2024", "Qa@2024#x", "p:ss/w?rd", "WarpLab123!"):
            assert camera_receives(stored_path("admin", pw)) == ("admin", pw)

    def test_the_path_and_host_are_untouched(self):
        stored = frigate_escape(stored_path("admin", "p:ss/w?rd"))
        assert stored.endswith(f"@{IP}:{PORT}{PATH}")
        assert stored.startswith("rtsp://admin:")

    def test_query_string_survives(self):
        path = "/cam/realmonitor?channel=1&subtype=0"
        stored = rtsp_url.to_frigate_url(rtsp_url.internal_url("admin", "C@mera!2024", IP, PORT, path))
        assert frigate_escape(stored).endswith(path)
        assert camera_receives(stored) == ("admin", "C@mera!2024")


class TestRefusals:
    @pytest.mark.parametrize("pw", ["has space", "tab\there", "nbsp here", "brace{", "}brace", "{FRIGATE_X}"])
    def test_a_raw_password_cannot_hold_whitespace_or_braces(self, pw):
        """Frigate str.format()s the config (braces) and its regex stops at whitespace."""
        with pytest.raises(rtsp_url.UnsafeStreamUrl) as err:
            rtsp_url.frigate_userinfo("admin", pw)
        assert err.value.field == "password"
        assert pw not in str(err.value)

    @pytest.mark.parametrize("pw", ["has space", "brace{", "{FRIGATE_X}"])
    def test_but_the_encoded_form_has_no_such_limit(self, pw):
        """A username Frigate's regex does not match takes the percent-encoded form."""
        stored = stored_path("john.doe", pw)
        assert " " not in stored and "{" not in stored
        assert camera_receives(stored) == ("john.doe", pw)

    def test_a_username_cannot_hold_a_colon(self):
        """ffmpeg URL-decodes the userinfo and THEN splits at the first ':'."""
        with pytest.raises(rtsp_url.UnsafeStreamUrl) as err:
            rtsp_url.frigate_userinfo("ad:min", "pw")
        assert err.value.field == "username"

    @pytest.mark.parametrize("value", ["a\r\nb", "a\x00b", "a\x7fb"])
    def test_control_characters_are_refused_everywhere(self, value):
        for user, pw in ((value, "pw"), ("admin", value), ("john.doe", value)):
            with pytest.raises(rtsp_url.UnsafeStreamUrl):
                rtsp_url.frigate_userinfo(user, pw)

    def test_a_lone_surrogate_is_refused_not_crashed_on(self):
        with pytest.raises(rtsp_url.UnsafeStreamUrl):
            rtsp_url.frigate_userinfo("admin", "bad\ud800pw")

    @pytest.mark.parametrize("pw", ["/", "=", "&", "?", "profile2", "/profile2"])
    def test_a_password_that_also_appears_in_the_address_would_be_rewritten_there(self, pw):
        """Frigate does path.replace(pw, quote_plus(pw)) over the WHOLE string."""
        try:
            stored = stored_path("admin", pw)
        except rtsp_url.UnsafeStreamUrl as err:
            assert err.field == "password"
            return
        # Not refused: then it must still arrive, and the address must be intact.
        assert camera_receives(stored) == ("admin", pw)
        assert frigate_escape(stored).endswith(f"@{IP}:{PORT}{PATH}")

    @pytest.mark.parametrize(
        "url",
        [
            f"rtsp://admin:%40@{IP}:{PORT}{PATH}",  # '@' is the separator after the password too
            f"rtsp://admin:%3A@{IP}",  # ':' is in "rtsp:" and "admin:", and there is no port
            f"rtsp://admin:%2F@{IP}",  # '/' is in "://", and there is no path
            f"rtsp://admin:%2F%2F@{IP}",
            f"rtsp://admin:min%3A@{IP}",  # 'min:' also ends the username and its separator
            f"rtsp://admin:min%3Amin@{IP}",  # an occurrence crosses from username into password
        ],
    )
    def test_a_password_that_is_a_fragment_of_the_url_outside_the_address_is_refused_too(self, url):
        """The same whole-string replace: Frigate would rewrite "rtsp://" or the '@' that ends
        the userinfo, not just the password."""
        with pytest.raises(rtsp_url.UnsafeStreamUrl) as err:
            rtsp_url.to_frigate_url(url)
        assert err.value.field == "password"

    @pytest.mark.parametrize(
        "path",
        ["/{FRIGATE_CAMERA_X_PASSWORD}", "/a b", "/a\tb", "/x\r\nCSeq: 9", "/}"],
    )
    def test_the_address_cannot_hold_template_or_whitespace_characters(self, path):
        """SEC-INJ-5: Frigate expands {FRIGATE_*}; an ONVIF device chooses its own path."""
        with pytest.raises(rtsp_url.UnsafeStreamUrl) as err:
            rtsp_url.to_frigate_url(f"rtsp://{IP}:{PORT}{path}")
        assert err.value.field == "address"

    def test_not_rtsp_is_refused(self):
        with pytest.raises(rtsp_url.UnsafeStreamUrl):
            rtsp_url.to_frigate_url("http://192.168.9.219/x")

    def test_a_bad_port_is_refused_not_crashed_on(self):
        with pytest.raises(rtsp_url.UnsafeStreamUrl):
            rtsp_url.to_frigate_url("rtsp://192.168.9.219:99999/x")


# Where an '@' can sit after the host: path, query, both, bare.
AT_TAILS = ["/a@b", "/stream?token=a@b", "/a@b?x=1", "/a?x=@", "/@", "/p/@host"]


class TestAtSignAfterTheAddress:
    """QA-N1 — Frigate's pattern runs to the LAST '@' of the whole string, not of the
    authority. For a username it matches, an '@' in the stream path or query pulls
    the HOST into the password; ffmpeg then reads the authority up to the first '/'
    or '?', finds whatever Frigate left behind, and sends the credentials THERE. An
    ONVIF device names its own stream path, so that host is the device's to choose."""

    def test_the_failure_reproduced(self):
        stored = f"rtsp://admin:pw@{IP}:{PORT}/a@b"
        assert camera_receives(stored) == ("admin", f"pw@{IP}:{PORT}/a")  # not "pw"
        assert camera_connects_to(stored) == "b"  # not the camera

    @pytest.mark.parametrize("tail", AT_TAILS)
    @pytest.mark.parametrize("user", MATCHING_USERS)
    def test_a_username_stored_as_typed_is_refused_an_at_sign_in_the_address(self, user, tail):
        with pytest.raises(rtsp_url.UnsafeStreamUrl) as err:
            rtsp_url.to_frigate_url(rtsp_url.internal_url(user, "pw", IP, PORT, tail))
        assert err.value.field == "address"
        assert "pw" not in str(err.value)

    @pytest.mark.parametrize("tail", AT_TAILS)
    @pytest.mark.parametrize("user", OTHER_USERS)
    def test_every_other_username_reaches_the_right_host_with_the_typed_password(self, user, tail):
        """Frigate's pattern does not match these, so nothing re-reads the string; ffmpeg
        ends the authority at the first '/' or '?'."""
        stored = rtsp_url.to_frigate_url(rtsp_url.internal_url(user, "C@mera!2024", IP, PORT, tail))
        assert camera_receives(stored) == (user, "C@mera!2024")
        assert camera_connects_to(stored) == f"{IP}:{PORT}"
        assert stored.endswith(f"@{IP}:{PORT}{tail}")

    @pytest.mark.parametrize("pw", ["x@y@z", "@@", ":@"])
    def test_an_at_sign_in_the_PASSWORD_is_not_one_in_the_address(self, pw):
        stored = stored_path("admin", pw)
        assert camera_receives(stored) == ("admin", pw)
        assert camera_connects_to(stored) == f"{IP}:{PORT}"

    def test_a_url_with_no_sign_in_is_not_touched(self):
        url = f"rtsp://{IP}:{PORT}/a@b"
        assert rtsp_url.to_frigate_url(url) == url


class TestToFrigateUrl:
    def test_a_url_without_a_sign_in_is_unchanged(self):
        url = f"rtsp://{IP}:{PORT}{PATH}"
        assert rtsp_url.to_frigate_url(url) == url

    def test_rtsps_keeps_its_scheme(self):
        stored = rtsp_url.to_frigate_url(f"rtsps://admin:p%40ss@{IP}:322{PATH}")
        assert stored == f"rtsps://admin:p@ss@{IP}:322{PATH}"

    def test_an_empty_password_stays_empty(self):
        stored = rtsp_url.to_frigate_url(f"rtsp://admin:@{IP}:{PORT}{PATH}")
        assert camera_receives(stored) == ("admin", "")

    def test_the_warp_1873_form_still_round_trips(self):
        """The internal form keeps RFC 3986 sub-delims literal; decoding it must be exact."""
        internal = rtsp_url.internal_url("admin", "T3stCamPw!", IP, PORT, PATH)
        assert "T3stCamPw!" in internal and "%21" not in internal
        assert camera_receives(rtsp_url.to_frigate_url(internal)) == ("admin", "T3stCamPw!")


class TestInternalUrl:
    @pytest.mark.parametrize("pw", PASSWORDS)
    def test_always_parses_and_never_leaks_a_delimiter_into_the_authority(self, pw):
        """The orchestrator redacts userinfo with a regex that stops at '/' or '@'."""
        from urllib.parse import unquote, urlsplit

        url = rtsp_url.internal_url("admin", pw, IP, PORT, PATH)
        parts = urlsplit(url)
        assert parts.hostname == IP and parts.port == PORT and parts.path == PATH
        assert unquote(parts.password) == pw
        userinfo = url.split("://", 1)[1].split(f"@{IP}", 1)[0]
        assert not any(c in userinfo.split(":", 1)[1] for c in "/@?#")


class TestScrub:
    @pytest.mark.parametrize(
        "text",
        [
            "Invalid path rtsp://admin:C@mera!2024@192.168.9.5:554/profile2/media.smp for camera x",
            '{"path": "rtsp://admin:s3cret!@192.168.9.5/x", "roles": ["detect"]}',
            "rtsps://u:p%40ss@host/x failed",
        ],
    )
    def test_removes_the_credentials_from_a_url_in_free_text(self, text):
        out = rtsp_url.scrub_credentials(text)
        for secret in ("C@mera!2024", "s3cret", "p%40ss", "admin:", "u:p"):
            assert secret not in out
        assert "rtsp" in out  # the rest of the message is kept

    def test_leaves_text_without_credentials_alone(self):
        text = "Frigate rejected camera front: rtsp://192.168.9.5:554/live is not reachable"
        assert rtsp_url.scrub_credentials(text) == text

    def test_scrubs_credentials_from_multiple_whitespace_delimited_urls(self):
        text = (
            "invalid paths rtsp://front:front-secret@front.local/live "
            "and rtsps://garage:garage-secret@garage.local/main"
        )

        out = rtsp_url.scrub_credentials(text)

        assert out == (
            "invalid paths rtsp://***@front.local/live "
            "and rtsps://***@garage.local/main"
        )
        assert "front-secret" not in out
        assert "garage-secret" not in out

    def test_scans_a_long_repeated_scheme_token_in_bounded_time(self):
        text = "rtsp://" * 30_000
        started = perf_counter()
        assert rtsp_url.scrub_credentials(text) == text
        assert perf_counter() - started < 2.0


class TestStreamPath:
    @pytest.mark.parametrize("path", ["/profile2/media.smp", "/cam/realmonitor?channel=1&subtype=0", "/"])
    def test_accepts(self, path):
        assert rtsp_url.is_valid_stream_path(path)

    @pytest.mark.parametrize("path", ["", "no-slash", "/{X}", "/a b", "/a\nb", "/a\x00b"])
    def test_refuses(self, path):
        assert not rtsp_url.is_valid_stream_path(path)
