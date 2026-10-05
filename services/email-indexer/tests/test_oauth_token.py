"""WARP-3788 — token delivery stays internal, authenticated and unlogged."""
from __future__ import annotations

import inspect
import base64
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/ for _shared

import aioimaplib
import aiosmtplib
import httpx
import pytest

import orchestrator_client as oc
from errors import OAuthTokenUnavailable


@pytest.fixture
def token_client(monkeypatch):
    monkeypatch.setattr(oc, "SERVICE_TOKEN", "email-service-bearer")
    monkeypatch.setattr(oc, "ORCHESTRATOR_URL", "https://orchestrator:3000")
    monkeypatch.setattr(oc, "httpx_client_kwargs", lambda: {"cert": ("cert.pem", "key.pem"), "verify": "ca.pem"})
    seen = {}

    def install(status=200, body=None, error=None):
        class Response:
            status_code = status

            def json(self):
                if isinstance(body, Exception):
                    raise body
                return body

        class Client:
            def __init__(self, **kwargs):
                seen["client"] = kwargs

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def get(self, url, **kwargs):
                seen["url"] = url
                seen["request"] = kwargs
                if error:
                    raise error
                return Response()

        monkeypatch.setattr(oc.httpx, "AsyncClient", Client)

    return install, seen


@pytest.mark.asyncio
async def test_token_request_is_account_bound_service_authenticated_and_no_store(token_client, caplog):
    install, seen = token_client
    install(body={"accessToken": "short-lived-secret"})
    assert await oc.get_oauth_access_token("account-1") == "short-lived-secret"
    assert seen["url"] == "https://orchestrator:3000/api/email/account-1/oauth-token"
    assert seen["request"]["headers"] == {
        "Authorization": "Bearer email-service-bearer",
        "Cache-Control": "no-store",
    }
    assert seen["client"] == {
        "timeout": 10.0, "cert": ("cert.pem", "key.pem"), "verify": "ca.pem",
    }
    assert "short-lived-secret" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("status,reconnect", [(401, True), (403, True), (404, True), (409, True), (503, False)])
async def test_refused_token_is_closed_set_and_distinguishes_temporary_failure(token_client, caplog, status, reconnect):
    install, _ = token_client
    secret = "provider-response-with-token"
    install(status, body=ValueError(secret))
    with pytest.raises(OAuthTokenUnavailable) as caught:
        await oc.get_oauth_access_token("account-1")
    assert caught.value.needs_reconnect is reconnect
    assert secret not in str(caught.value) and secret not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [None, [], {}, {"accessToken": None}, {"accessToken": ""}, {"accessToken": "bad\nTOKEN"}, {"accessToken": "bad\x00TOKEN"}, ValueError("token-in-json-error")])
async def test_bad_token_response_is_never_returned_or_logged(token_client, caplog, body):
    install, _ = token_client
    install(body=body)
    with pytest.raises(OAuthTokenUnavailable) as caught:
        await oc.get_oauth_access_token("account-1")
    assert "token-in-json-error" not in str(caught.value)
    assert "TOKEN" not in caplog.text


@pytest.mark.asyncio
async def test_token_network_failure_does_not_expose_exception(token_client, caplog):
    install, _ = token_client
    install(error=httpx.RequestError("private-access-token"))
    with pytest.raises(OAuthTokenUnavailable) as caught:
        await oc.get_oauth_access_token("account-1")
    assert caught.value.needs_reconnect is False
    assert "private-access-token" not in str(caught.value) + caplog.text


@pytest.mark.asyncio
async def test_missing_service_bearer_never_makes_request(token_client, monkeypatch):
    install, seen = token_client
    install(body={"accessToken": "secret"})
    monkeypatch.setattr(oc, "SERVICE_TOKEN", "")
    with pytest.raises(OAuthTokenUnavailable):
        await oc.get_oauth_access_token("account-1")
    assert seen == {}


def test_pinned_native_libraries_support_selected_oauth_helpers():
    # Exercise the actual pinned imports rather than assuming APIs from a fake.
    assert list(inspect.signature(aioimaplib.IMAP4.xoauth2).parameters) == ["self", "user", "token"]
    assert "oauth_token_generator" in inspect.signature(aiosmtplib.send).parameters
    assert callable(aiosmtplib.SMTP.auth_xoauth2)


def test_native_imap_debug_command_cannot_expose_encoded_access_token(caplog):
    # Use the real pinned library's send diagnostic, not only application logs.
    import idle  # installs the narrow native diagnostic filter
    from aioimaplib import aioimaplib as native

    secret = "private-access-token"
    sasl = base64.b64encode(f"user=me@example.com\1auth=Bearer {secret}\1\1".encode()).decode()
    sent = []

    class Transport:
        def write(self, data):
            sent.append(data)

    class Client:
        transport = Transport()

    with caplog.at_level(logging.DEBUG, logger=native.log.name):
        native.IMAP4ClientProtocol.send(Client(), f"A01 AUTHENTICATE XOAUTH2 {sasl}", scrub=secret)
    assert sasl.encode() in sent[0]  # protocol receives the original credential
    assert secret not in caplog.text and sasl not in caplog.text
    assert "IMAP OAuth authentication command" in caplog.text
