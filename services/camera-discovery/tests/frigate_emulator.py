"""What Frigate and ffmpeg do to a camera's RTSP URL, as plain functions.

Test support, not a test. WARP-3505: the password a camera finally receives is
the product of THREE parties, and every previous test only ever looked at the
first one (the URL we wrote):

1. **Frigate 0.17** runs ``escape_special_characters`` (frigate/util/builtin.py)
   over each ffmpeg input path before it reaches ffmpeg::

       REGEX_RTSP_CAMERA_USER_PASS = r":\\/\\/[a-zA-Z0-9_-]+:[\\S]+@"

       found = re.search(REGEX_RTSP_CAMERA_USER_PASS, path).group(0)[3:-1]
       pw = found[(found.index(":") + 1):]
       return path.replace(pw, urllib.parse.quote_plus(pw))

   When the username is ``[A-Za-z0-9_-]+`` Frigate therefore percent-encodes the
   password ITSELF (up to the last ``@``). A password that was already
   percent-encoded is encoded twice.

2. **ffmpeg** (libavformat ``av_url_split`` + ``ff_http_auth_create_response``)
   splits the authority at its last ``@``, URL-decodes the ``user:password``
   text ONCE (``ff_urldecode(auth, 0)`` — ``+`` is not turned into a space),
   and splits that at the first ``:``.

3. **The camera** receives whatever ffmpeg computed.

Keeping the emulation here means the rule it encodes is written once and read
by every test that asserts what a camera receives.
"""

from __future__ import annotations

import re
import urllib.parse

# frigate/util/builtin.py
FRIGATE_REGEX_RTSP_CAMERA_USER_PASS = re.compile(r":\/\/[a-zA-Z0-9_-]+:[\S]+@")


def frigate_escape(path: str) -> str:
    """frigate.util.builtin.escape_special_characters, verbatim."""
    if len(path) > 1000:
        raise ValueError("Input too long to check")
    try:
        found = FRIGATE_REGEX_RTSP_CAMERA_USER_PASS.search(path).group(0)[3:-1]
        pw = found[(found.index(":") + 1):]
        return path.replace(pw, urllib.parse.quote_plus(pw))
    except AttributeError:
        # path does not have user:pass
        return path


def ffmpeg_credentials(url: str) -> tuple[str, str]:
    """The (username, password) ffmpeg's RTSP client authenticates with."""
    rest = url.split("://", 1)[1]
    # av_url_split: the authority ends at the first '/', '?' or '#'; the
    # userinfo ends at the LAST '@' inside it.
    authority = re.split(r"[/?#]", rest, maxsplit=1)[0]
    userinfo, at, _host = authority.rpartition("@")
    assert at, f"no userinfo in {url!r}"
    # ff_urldecode(auth, decode_plus_sign=0): percent-decode once, '+' untouched.
    decoded = urllib.parse.unquote(userinfo)
    user, _, password = decoded.partition(":")
    return user, password


def camera_receives(stored_path: str) -> tuple[str, str]:
    """The credentials the camera sees for a path stored in Frigate's config."""
    return ffmpeg_credentials(frigate_escape(stored_path))
