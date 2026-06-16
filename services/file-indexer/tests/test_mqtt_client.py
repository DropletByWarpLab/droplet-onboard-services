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
