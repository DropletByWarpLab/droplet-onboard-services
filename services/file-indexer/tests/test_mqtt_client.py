"""IDX-06 — MQTT handlers must be re-subscribed on every (re)connect.

paho drops broker subscriptions across a disconnect and does not replay them
on auto-reconnect, so without an on_connect re-subscribe the file-indexer
silently stops receiving `droplet/files/brain/uploaded` (chat-attach) and
`droplet/transcription/run-one` (transcribe-now) after any broker blip. These
tests pin the on_connect replay and the order-independence of subscribe().
"""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def mc(monkeypatch):
    """Fresh mqtt_client module with an empty handler table per test."""
    mod = importlib.reload(importlib.import_module("mqtt_client"))
    monkeypatch.setattr(mod, "_handlers", {}, raising=True)
    monkeypatch.setattr(mod, "_client", None, raising=True)
    return mod


class _FakeClient:
    def __init__(self, connected=True):
        self._connected = connected
        self.subscribed: list[str] = []

    def is_connected(self):
        return self._connected

    def subscribe(self, topic):
        self.subscribed.append(topic)


def test_on_connect_resubscribes_all_registered_topics(mc):
    mc._handlers["droplet/files/brain/uploaded"] = lambda p: None
    mc._handlers["droplet/transcription/run-one"] = lambda p: None
    fake = _FakeClient()

    mc._on_connect(fake, None, None, 0)

    assert sorted(fake.subscribed) == [
        "droplet/files/brain/uploaded",
        "droplet/transcription/run-one",
    ]


def test_on_connect_no_handlers_is_noop(mc):
    fake = _FakeClient()
    mc._on_connect(fake, None, None, 0)
    assert fake.subscribed == []


def test_on_connect_replays_after_reconnect(mc):
    """A second connect (simulating a broker reconnect) re-issues the
    subscribe — the regression that previously lost the topic silently."""
    mc._handlers["droplet/files/brain/uploaded"] = lambda p: None
    fake = _FakeClient()

    mc._on_connect(fake, None, None, 0)  # first connect
    mc._on_connect(fake, None, None, 0)  # reconnect

    assert fake.subscribed == [
        "droplet/files/brain/uploaded",
        "droplet/files/brain/uploaded",
    ]


def test_subscribe_before_connect_is_queued_then_wired_on_connect(mc):
    """Registering a handler before connect() must still reach the broker via
    on_connect (the previously-false docstring claim)."""
    handler = lambda p: None
    mc.subscribe("droplet/files/brain/uploaded", handler)  # _client is None
    assert mc._handlers["droplet/files/brain/uploaded"] is handler

    fake = _FakeClient()
    mc._on_connect(fake, None, None, 0)
    assert fake.subscribed == ["droplet/files/brain/uploaded"]


def test_subscribe_when_connected_subscribes_immediately(mc):
    fake = _FakeClient(connected=True)
    mc._client = fake
    mc.subscribe("droplet/transcription/run-one", lambda p: None)
    assert fake.subscribed == ["droplet/transcription/run-one"]


def test_subscribe_when_client_set_but_not_connected_defers(mc):
    """Not connected yet → don't fire a subscribe that paho would drop; let
    on_connect handle it."""
    fake = _FakeClient(connected=False)
    mc._client = fake
    mc.subscribe("droplet/transcription/run-one", lambda p: None)
    assert fake.subscribed == []
    assert "droplet/transcription/run-one" in mc._handlers


def test_mqtts_scheme_enables_tls_and_port_8883(mc, monkeypatch, tmp_path):
    """WARP-235 — a mqtts:// broker URL must flip paho to mTLS (bundle from the
    DROPLET_TLS_* env contract) with NO username/password, defaulting to 8883."""
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))
    monkeypatch.setattr(mc, "MQTT_BROKER", "mqtts://broker:8883", raising=True)

    recorded = {}

    class FakePaho:
        def __init__(self, *a, **kw):
            pass

        def tls_set(self, ca_certs=None, certfile=None, keyfile=None):
            recorded["tls"] = (ca_certs, certfile, keyfile)

        def username_pw_set(self, *a):
            recorded["userpass"] = True

        def connect(self, host, port, keepalive=60):
            recorded["connect"] = (host, port)

        def loop_start(self):
            pass

    monkeypatch.setattr(mc.mqtt, "Client", FakePaho)
    mc.connect()
    assert recorded["connect"] == ("broker", 8883)
    assert recorded["tls"] == (
        str(tmp_path / "ca.pem"),
        str(tmp_path / "cert.pem"),
        str(tmp_path / "key.pem"),
    )
    assert "userpass" not in recorded


def test_plain_mqtt_url_keeps_userpass_and_no_tls(mc, monkeypatch):
    """Dev brokers (mqtt://) keep the inline-credential path and never tls_set."""
    monkeypatch.setattr(mc, "MQTT_BROKER", "mqtt://u:p@localhost:1883", raising=True)

    recorded = {}

    class FakePaho:
        def __init__(self, *a, **kw):
            pass

        def tls_set(self, **kw):
            recorded["tls"] = True

        def username_pw_set(self, user, password):
            recorded["userpass"] = (user, password)

        def connect(self, host, port, keepalive=60):
            recorded["connect"] = (host, port)

        def loop_start(self):
            pass

    monkeypatch.setattr(mc.mqtt, "Client", FakePaho)
    mc.connect()
    assert recorded["connect"] == ("localhost", 1883)
    assert recorded["userpass"] == ("u", "p")
    assert "tls" not in recorded
