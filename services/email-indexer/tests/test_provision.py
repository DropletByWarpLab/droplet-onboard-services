"""WARP-2734 — verify the mailbox, then encrypt. Never the other way round.

The failure this suite exists to prevent is not a crash. It is an
`EmailAccount` row written for a credential nobody ever tested: the owner is
told their mailbox is connected, `imapStatus` says `idle`, and the only symptom
is that no mail ever arrives. Silence is the hardest failure to attribute, and
this module's whole job is to make it impossible.
"""
from __future__ import annotations

import asyncio
import ssl

import pytest
from cryptography.fernet import Fernet

import creds
import provision


@pytest.fixture(autouse=True)
def _fernet():
    """A real Fernet with a throwaway key — the encrypt path is exercised for
    real rather than mocked, because a mocked encrypt would prove nothing about
    the ciphertext this service must be able to read back."""
    creds._set_for_tests(Fernet(Fernet.generate_key()))
    yield
    creds._set_for_tests(None)


def test_encrypt_round_trips():
    token = creds.encrypt("hunter2")
    assert token != "hunter2"
    assert creds.decrypt(token) == "hunter2"


def test_encrypt_raises_before_init():
    """Asymmetric with `decrypt`, which returns None — and deliberately so.

    A failed decrypt is one account the IDLE pool skips. A failed encrypt is an
    account the operator believes they connected. The first is survivable; the
    second is a silent lie, so it raises."""
    creds._set_for_tests(None)
    with pytest.raises(RuntimeError):
        creds.encrypt("hunter2")


def _probe(monkeypatch, result: provision.ProbeResult):
    async def fake(*_a, **_k):
        return result

    monkeypatch.setattr(provision, "probe_imap", fake)


def test_provision_returns_ciphertext_when_the_mailbox_answers(monkeypatch):
    _probe(monkeypatch, provision.ProbeResult(True))
    result, ciphertext = asyncio.run(
        provision.provision("mail.example", 993, True, "u", "hunter2")
    )
    assert result.ok is True
    assert ciphertext is not None
    assert creds.decrypt(ciphertext) == "hunter2"


def test_provision_encrypts_NOTHING_when_the_probe_fails(monkeypatch):
    """The whole point of the module.

    Encrypting anyway would leave the caller holding a valid ciphertext for a
    credential that does not work — and the orchestrator would happily store
    it, because a ciphertext is a ciphertext."""
    _probe(monkeypatch, provision.ProbeResult(False, provision.REASONS["auth_failed"]))
    result, ciphertext = asyncio.run(
        provision.provision("mail.example", 993, True, "u", "hunter2")
    )
    assert result.ok is False
    assert ciphertext is None


@pytest.mark.parametrize("reason", sorted(provision.REASONS.values()))
def test_every_reason_is_a_closed_set_member(reason):
    """🔴 A reason must never be the IMAP server's own text.

    Server rejection strings are attacker-influenced and routinely echo the
    credential back — "LOGIN failed for user@example.com" is the common shape.
    The set is closed so a future branch cannot widen it by accident."""
    assert reason.islower()
    assert " " not in reason
    assert "@" not in reason


class _FakeResp:
    def __init__(self, result: str):
        self.result = result
        self.lines = [b"NO LOGIN failed for someone@example.com"]


class _FakeClient:
    """Records what it was asked to do; never touches a socket."""

    def __init__(self, login_result: str = "OK", raises: Exception | None = None):
        self._login_result = login_result
        self._raises = raises
        self.logged_out = False

    async def wait_hello_from_server(self):
        return None

    async def login(self, _u, _p):
        if self._raises is not None:
            raise self._raises
        return _FakeResp(self._login_result)

    async def logout(self):
        self.logged_out = True


def _client(monkeypatch, client):
    monkeypatch.setattr(provision.aioimaplib, "IMAP4_SSL", lambda **_k: client)
    monkeypatch.setattr(provision.aioimaplib, "IMAP4", lambda **_k: client)


def test_probe_reports_auth_failed_without_echoing_the_server(monkeypatch):
    client = _FakeClient(login_result="NO")
    _client(monkeypatch, client)
    result = asyncio.run(provision.probe_imap("mail.example", 993, True, "u", "p"))
    assert result.ok is False
    assert result.reason == provision.REASONS["auth_failed"]
    # The server's own line carried an address. It must not be in the reason.
    assert "example.com" not in (result.reason or "")


def test_probe_logs_out_even_on_a_rejected_login(monkeypatch):
    """A probe that leaves a session open holds a connection on somebody
    else's mail server every time an operator mistypes a password."""
    client = _FakeClient(login_result="NO")
    _client(monkeypatch, client)
    asyncio.run(provision.probe_imap("mail.example", 993, True, "u", "p"))
    assert client.logged_out is True


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (ssl.SSLError("bad cert"), "tls_failed"),
        (OSError("no route to host"), "unreachable"),
    ],
)
def test_probe_maps_failures_to_closed_reasons(monkeypatch, exc, expected):
    _client(monkeypatch, _FakeClient(raises=exc))
    result = asyncio.run(provision.probe_imap("mail.example", 993, True, "u", "p"))
    assert result.ok is False
    assert result.reason == provision.REASONS[expected]


def test_probe_times_out_rather_than_hanging_a_form_submit(monkeypatch):
    class _Slow(_FakeClient):
        async def login(self, _u, _p):
            await asyncio.sleep(10)

    monkeypatch.setattr(provision, "PROBE_TIMEOUT_SECONDS", 0.05)
    _client(monkeypatch, _Slow())
    result = asyncio.run(provision.probe_imap("mail.example", 993, True, "u", "p"))
    assert result.ok is False
    assert result.reason == provision.REASONS["timeout"]
