"""MQTT pub/sub helper for the file-indexer.

Originally publish-only — extended in WARP-203 to subscribe to the
`droplet/files/brain/uploaded` topic the orchestrator publishes when a
chat-attached file lands. Each registered handler runs on the paho
network thread; handlers must be idempotent + non-blocking.
"""

from __future__ import annotations

import json
import logging
from typing import Callable, Optional
from urllib.parse import urlparse

import paho.mqtt.client as mqtt

from _shared.internal_tls import paho_configure
from config import MQTT_BROKER

logger = logging.getLogger(__name__)

_client: Optional[mqtt.Client] = None
# Topic -> handler. We only need one handler per topic in this service
# (the brain ingest pipeline fans out internally), so a flat dict beats
# the per-topic Set the orchestrator's mqtt service uses.
_handlers: dict[str, Callable[[dict], None]] = {}


def _on_message(_client, _userdata, msg) -> None:
    """paho callback — route incoming messages to registered handlers."""
    handler = _handlers.get(msg.topic)
    if handler is None:
        logger.debug("MQTT message on %s with no handler", msg.topic)
        return
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        logger.warning("Skipping malformed MQTT payload on %s", msg.topic)
        return
    try:
        handler(payload)
    except Exception:  # pragma: no cover - defensive log path
        logger.exception("Handler for %s raised", msg.topic)


def _on_connect(client, _userdata, _flags, _reason_code, _properties=None) -> None:
    """paho callback — (re)subscribe every registered topic on each connect.

    paho's broker subscriptions are session state: they're lost on a broker
    restart / disconnect, and paho does NOT replay them on auto-reconnect.
    Without this, after any broker blip the file-indexer permanently stops
    receiving `droplet/files/brain/uploaded` (chat-attached file indexing) and
    `droplet/transcription/run-one` (transcribe-now), silently. Re-subscribing
    here also makes `subscribe()` order-independent: a handler registered
    before `connect()` is wired on the first connect. (WARP-203 / IDX-06.)
    """
    if _reason_code != 0:
        logger.warning("MQTT connect refused: %s", _reason_code)
        return
    if not _handlers:
        return
    for topic in _handlers:
        client.subscribe(topic)
    logger.info(
        "MQTT (re)connected — re-subscribed %d topic(s): %s",
        len(_handlers), ", ".join(sorted(_handlers)),
    )


def connect() -> None:
    global _client
    parsed = urlparse(MQTT_BROKER)
    use_tls = parsed.scheme == "mqtts"
    host = parsed.hostname or "localhost"
    port = parsed.port or (8883 if use_tls else 1883)
    username = parsed.username
    password = parsed.password

    _client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if use_tls:
        # WARP-235: identity is the client cert CN; no username/password.
        paho_configure(_client)
    elif username:
        _client.username_pw_set(username, password)
    _client.on_message = _on_message
    # Re-subscribe on every (re)connect — paho drops subscriptions across a
    # broker disconnect and doesn't replay them (IDX-06).
    _client.on_connect = _on_connect
    _client.connect(host, port, keepalive=60)
    _client.loop_start()
    logger.info("Connected to MQTT broker at %s:%d (tls=%s)", host, port, use_tls)


def publish(topic: str, payload: dict) -> None:
    if _client is None or not _client.is_connected():
        logger.debug("MQTT not connected, skipping publish to %s", topic)
        return
    _client.publish(topic, json.dumps(payload))


def subscribe(topic: str, handler: Callable[[dict], None]) -> None:
    """Register a handler for `topic` and tell the broker to deliver it.

    Re-registering replaces the previous handler. Safe to call before
    `connect()`: the handler is recorded in `_handlers` and the `_on_connect`
    callback subscribes every registered topic on the next (re)connect, so the
    broker subscribe fires regardless of call order. When called after the
    client is already connected, we also subscribe immediately so the topic
    takes effect without waiting for a reconnect.
    """
    _handlers[topic] = handler
    if _client is not None and _client.is_connected():
        _client.subscribe(topic)
        logger.info("Subscribed to MQTT topic %s", topic)
