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


def connect() -> None:
    global _client
    parsed = urlparse(MQTT_BROKER)
    host = parsed.hostname or "localhost"
    port = parsed.port or 1883
    username = parsed.username
    password = parsed.password

    _client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if username:
        _client.username_pw_set(username, password)
    _client.on_message = _on_message
    _client.connect(host, port, keepalive=60)
    _client.loop_start()
    logger.info("Connected to MQTT broker at %s:%d", host, port)


def publish(topic: str, payload: dict) -> None:
    if _client is None or not _client.is_connected():
        logger.debug("MQTT not connected, skipping publish to %s", topic)
        return
    _client.publish(topic, json.dumps(payload))


def subscribe(topic: str, handler: Callable[[dict], None]) -> None:
    """Register a handler for `topic` and tell the broker to deliver it.

    Re-registering replaces the previous handler. Safe to call before
    `connect()` — the topic is queued and the broker subscribe will
    fire after `connect()` runs.
    """
    _handlers[topic] = handler
    if _client is not None:
        _client.subscribe(topic)
        logger.info("Subscribed to MQTT topic %s", topic)
