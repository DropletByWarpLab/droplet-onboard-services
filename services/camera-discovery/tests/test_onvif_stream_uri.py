"""WARP-3505 — ONVIF GetStreamUri with typed credentials, as a tri-state.

Why a tri-state: the credentials flow runs RTSP first and only asks ONVIF for a
stream path when RTSP found none. By then nothing has checked the password, so
ONVIF's answer decides what the operator is told:

  * ``ok``            — a stream URI; probe that path.
  * ``auth_failed``   — the camera refused the credentials (SOAP NotAuthorized or
                        HTTP 401): a WRONG PASSWORD, not "no stream path".
  * ``unsupported``   — no ONVIF here (refused, timed out, no profiles, library
                        missing): stay on "couldn't find the stream path".

The old ``probe_onvif_device`` swallowed every failure into ``None``, which made
the first two indistinguishable.

Nothing an exception says may be logged: onvif/zeep errors can quote the request.
"""

from __future__ import annotations

import logging
import sys
import types

import pytest

import onvif_scanner


class _TransportError(Exception):
    """zeep.exceptions.TransportError shape: carries the HTTP status."""

    def __init__(self, status_code, message="Server returned response"):
        super().__init__(f"{message} ({status_code})")
        self.status_code = status_code


class _Fault(Exception):
    """zeep.exceptions.Fault / onvif.ONVIFError shape: the SOAP fault text."""


class _Profile:
    token = "profile_1"


class _Media:
    def __init__(self, uri="rtsp://192.168.9.5:554/onvif/profile1", profiles=(_Profile(),), error=None):
        self._uri, self._profiles, self._error = uri, list(profiles), error
        self.requested = None

    def GetProfiles(self):
        if self._error:
            raise self._error
        return self._profiles

    def GetStreamUri(self, request):
        self.requested = request
        return types.SimpleNamespace(Uri=self._uri)


def install_onvif(monkeypatch, *, media=None, ctor_error=None):
    seen = {}

    class ONVIFCamera:
        def __init__(self, ip, port, username, password):
            seen["args"] = (ip, port, username, password)
            if ctor_error:
                raise ctor_error

        def create_media_service(self):
            return media or _Media()

    module = types.ModuleType("onvif")
    module.ONVIFCamera = ONVIFCamera
    monkeypatch.setitem(sys.modules, "onvif", module)
    return seen


class TestClassify:
    @pytest.mark.parametrize(
        "error",
        [
            _TransportError(401),
            _Fault("Sender not Authorized"),
            _Fault("env:Sender ter:NotAuthorized"),
            _Fault("Unauthorized"),
            Exception("401 Client Error: Unauthorized for url: http://192.168.9.5/onvif/device_service"),
        ],
    )
    def test_a_refusal_of_the_credentials(self, error):
        assert onvif_scanner.classify_onvif_error(error) == "auth_failed"

    @pytest.mark.parametrize(
        "error",
        [
            ConnectionRefusedError(),
            TimeoutError(),
            OSError("Network is unreachable"),
            _TransportError(404),
            _TransportError(500),
            _Fault("Action not supported"),
            ValueError("boom"),
        ],
    )
    def test_anything_else_is_just_not_supported(self, error):
        assert onvif_scanner.classify_onvif_error(error) == "unsupported"


class TestOnvifStreamUri:
    @pytest.mark.asyncio
    async def test_returns_the_stream_uri_and_sends_the_typed_credentials(self, monkeypatch):
        seen = install_onvif(monkeypatch)
        status, uri = await onvif_scanner.onvif_stream_uri("192.168.9.5", 80, "admin", "s3cret!")
        assert (status, uri) == ("ok", "rtsp://192.168.9.5:554/onvif/profile1")
        assert seen["args"] == ("192.168.9.5", 80, "admin", "s3cret!")

    @pytest.mark.asyncio
    async def test_a_wrong_password_is_auth_failed(self, monkeypatch):
        install_onvif(monkeypatch, ctor_error=_Fault("Sender not Authorized"))
        assert await onvif_scanner.onvif_stream_uri("192.168.9.5", 80, "admin", "wrong") == ("auth_failed", None)

    @pytest.mark.asyncio
    async def test_a_refusal_later_in_the_conversation_is_auth_failed_too(self, monkeypatch):
        install_onvif(monkeypatch, media=_Media(error=_TransportError(401)))
        assert await onvif_scanner.onvif_stream_uri("192.168.9.5", 80, "admin", "wrong") == ("auth_failed", None)

    @pytest.mark.asyncio
    async def test_no_onvif_service_is_unsupported(self, monkeypatch):
        install_onvif(monkeypatch, ctor_error=ConnectionRefusedError())
        assert await onvif_scanner.onvif_stream_uri("192.168.9.5", 80, "admin", "pw") == ("unsupported", None)

    @pytest.mark.asyncio
    async def test_no_profiles_is_unsupported(self, monkeypatch):
        install_onvif(monkeypatch, media=_Media(profiles=()))
        assert await onvif_scanner.onvif_stream_uri("192.168.9.5", 80, "admin", "pw") == ("unsupported", None)

    @pytest.mark.asyncio
    async def test_the_library_missing_is_unsupported(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "onvif", None)  # `import onvif` raises ImportError
        assert await onvif_scanner.onvif_stream_uri("192.168.9.5", 80, "admin", "pw") == ("unsupported", None)

    @pytest.mark.asyncio
    async def test_what_the_error_says_is_never_logged(self, monkeypatch, caplog):
        """zeep errors can quote the SOAP request, which carries the password."""
        caplog.set_level(logging.DEBUG)
        install_onvif(monkeypatch, ctor_error=_Fault("rejected UsernameToken admin:s3cret-pw digest"))
        await onvif_scanner.onvif_stream_uri("192.168.9.5", 80, "admin", "s3cret-pw")
        assert "s3cret" not in caplog.text
