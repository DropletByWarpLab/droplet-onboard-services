"""How a camera's sign-in is written into an RTSP URL (WARP-3505, WARP-1873).

Two representations of "this camera's stream URL, with its username/password":

INTERNAL (``internal_url``)
    What camera-discovery keeps in its pending/known records, verifies with
    (``verify_stream`` URL-decodes it), and hands to the orchestrator, which strips
    the userinfo with a regex that stops at ``/`` and ``@`` (NET-05). It has to
    ALWAYS parse and the password has to be removable, so the userinfo is
    percent-encoded; only RFC 3986 sub-delims (``!$&'()*+,;=``) stay literal.

FRIGATE (``to_frigate_url``)
    What Frigate's config must hold. This is NOT the internal form, and writing the
    internal form there is exactly the bug this module exists to prevent.

Why the Frigate form differs
----------------------------
Three parties read the userinfo between us and the camera, and the password the
camera finally gets is the product of all three:

1. **Frigate 0.17** runs ``escape_special_characters`` (frigate/util/builtin.py)
   over every ffmpeg input path before handing it to ffmpeg::

       REGEX_RTSP_CAMERA_USER_PASS = r":\\/\\/[a-zA-Z0-9_-]+:[\\S]+@"

       found = re.search(REGEX_RTSP_CAMERA_USER_PASS, path).group(0)[3:-1]
       pw = found[(found.index(":") + 1):]
       return path.replace(pw, urllib.parse.quote_plus(pw))

   When the username is ``[A-Za-z0-9_-]+`` Frigate therefore percent-encodes the
   PASSWORD ITSELF (everything after the first ``:`` up to the last ``@``).

2. **ffmpeg** splits the authority at its last ``@``, URL-decodes the
   ``user:password`` text ONCE, then splits that at the first ``:``.

3. **The camera** gets whatever ffmpeg computed.

So for a username Frigate's regex matches, the password must be stored RAW:
Frigate encodes it, ffmpeg decodes it, the camera gets what was typed. Storing it
pre-encoded (``C%40mera!2024``) has Frigate encode the ``%`` again, ffmpeg decodes
one layer, and the camera is sent ``C%40mera!2024`` — 401 on every retry, and a
Hanwha locks the account after ~5. That was the WARP-1873 failure, which was put
down to "ffmpeg does not percent-decode userinfo" (it does, once) and "fixed" for
``!`` alone by leaving sub-delims literal; ``@``, ``/``, ``:``, ``?``, ``#`` and
``%`` stayed broken. Live evidence: raw ``WarpLab123!`` works on the real Hanwha.

For any other username Frigate's regex does not match, nothing re-encodes the
password, and ffmpeg's single decode is the only layer: store it percent-encoded.

A raw password cannot contain braces (Frigate ``str.format``s the config, so
``{FRIGATE_*}`` is a placeholder and a lone brace is an error that stops Frigate
starting) or whitespace (the regex's ``\\S+`` stops there, and the URL would not
parse). Those are refused, with the field named and the value never echoed.
"""

from __future__ import annotations

import re
from urllib.parse import quote, quote_plus, unquote, urlsplit

# Frigate's REGEX_RTSP_CAMERA_USER_PASS username class.
FRIGATE_USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# Sub-delims RFC 3986 allows in userinfo. Kept literal in the INTERNAL form so a
# stored URL stays readable and so the WARP-1873 form is unchanged; they are never
# the reason a URL fails to parse. The FRIGATE form does not use this set.
INTERNAL_USERINFO_SAFE = "!$&'()*+,;="

# Never legal in a stream address or a raw password: braces (Frigate str.format,
# SEC-INJ-5), whitespace (URL parsing, Frigate's \S+), controls (header injection).
_UNSAFE = re.compile(r"[{}\s\x00-\x1f\x7f]")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

# A URL carrying userinfo, in free text (a Frigate error, a log line). Greedy to
# the LAST '@' of the whitespace-delimited token — the same reading Frigate and
# ffmpeg take — so a password containing '@' or '/' is removed whole.
_URL_WITH_USERINFO = re.compile(r"(?i)(rtsps?://)\S*@")


class UnsafeStreamUrl(ValueError):
    """A credential or address that cannot be written into a Frigate stream URL.

    ``field`` names what is wrong ("username", "password" or "address"); the
    message never contains the value.
    """

    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field
        self.message = message


def _check_encodable(field: str, value: str) -> None:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise UnsafeStreamUrl(field, f"{field} contains invalid characters") from None
    if _CONTROL.search(value):
        raise UnsafeStreamUrl(field, f"{field} contains invalid characters")


def frigate_userinfo(user: str, pw: str) -> str:
    """The ``user:password`` text Frigate's config must hold for this account.

    Raises UnsafeStreamUrl when the account cannot be expressed. Callers use this
    to refuse a bad credential BEFORE any attempt on the camera is spent on it.
    """
    _check_encodable("username", user)
    _check_encodable("password", pw)
    if ":" in user:
        # ffmpeg decodes the userinfo and THEN splits at the first ':'.
        raise UnsafeStreamUrl("username", "username cannot contain a colon")
    if FRIGATE_USERNAME_RE.fullmatch(user):
        if _UNSAFE.search(pw):
            raise UnsafeStreamUrl(
                "password",
                "password cannot contain spaces or curly braces for this camera account",
            )
        return f"{user}:{pw}"
    return f"{quote(user, safe='')}:{quote(pw, safe='')}"


def internal_url(user: str, pw: str, ip: str, port: int, path: str) -> str:
    """The INTERNAL stream URL: parseable, redactable, decodable."""
    return (
        f"rtsp://{quote(user, safe=INTERNAL_USERINFO_SAFE)}"
        f":{quote(pw, safe=INTERNAL_USERINFO_SAFE)}"
        f"@{ip}:{port}{path}"
    )


def is_valid_stream_path(path: str) -> bool:
    """A path (optionally with a query) fit to follow ``rtsp://host:port``."""
    return bool(path) and path.startswith("/") and not _UNSAFE.search(path)


def to_frigate_url(url: str) -> str:
    """Rewrite an INTERNAL stream URL into the form Frigate's config must hold.

    A URL with no userinfo is returned unchanged (after the same safety checks).
    Raises UnsafeStreamUrl for a URL Frigate cannot be given safely.
    """
    if _UNSAFE.search(url):
        # Checked on the whole string, not on urlsplit's pieces: urlsplit silently
        # drops tabs and newlines, which would hide exactly what is being refused.
        raise UnsafeStreamUrl("address", "stream address contains characters that cannot be used")
    try:
        parts = urlsplit(url)
        port = parts.port  # raises ValueError on a bad port
    except ValueError:
        raise UnsafeStreamUrl("address", "stream address is not valid") from None
    if parts.scheme not in ("rtsp", "rtsps") or not parts.hostname:
        raise UnsafeStreamUrl("address", "stream address must be rtsp:// or rtsps://")
    if parts.username is None:
        return url

    user = unquote(parts.username)
    pw = unquote(parts.password or "")
    userinfo = frigate_userinfo(user, pw)

    host = parts.hostname
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    hostport = host if port is None else f"{host}:{port}"
    rest = f"{hostport}{parts.path}" + (f"?{parts.query}" if parts.query else "")
    if FRIGATE_USERNAME_RE.fullmatch(user) and "@" in rest:
        # Frigate's greedy match ends at the LAST '@', including one in the
        # stream path/query. It would encode the camera host as password text
        # and send the credentials to the host left after that final '@'.
        raise UnsafeStreamUrl(
            "address", "stream address cannot contain an at sign for this camera account"
        )
    stored = f"{parts.scheme}://{userinfo}@{rest}"
    if FRIGATE_USERNAME_RE.fullmatch(user) and pw:
        # Frigate does path.replace(pw, quote_plus(pw)) over the WHOLE string, so a
        # password occurrence outside its field (even across the field boundary)
        # would change the username, scheme or camera address too.
        escaped_pw = quote_plus(pw)
        expected = f"{parts.scheme}://{user}:{escaped_pw}@{rest}"
        if escaped_pw != pw and stored.replace(pw, escaped_pw) != expected:
            raise UnsafeStreamUrl(
                "password", "password cannot also appear elsewhere in the camera's stream URL"
            )
    return stored


def scrub_credentials(text: str) -> str:
    """Remove ``user:password@`` from any RTSP URL in ``text`` (for logs and errors).

    Frigate echoes the config path in some of its error replies, and that path
    carries the camera's password.
    """
    return _URL_WITH_USERINFO.sub(r"\1***@", text)
