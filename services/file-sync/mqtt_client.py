"""MQTT publish/subscribe wrapper."""

from __future__ import annotations

import json
import logging
from urllib.parse import urlparse

import paho.mqtt.client as mqtt

from config import MQTT_BROKER

logger = logging.getLogger(__name__)

_client: mqtt.Client | None = None
_callbacks: dict[str, list] = {}


def connect() -> mqtt.Client:
    global _client
    parsed = urlparse(MQTT_BROKER)
    host = parsed.hostname or "broker"
    port = parsed.port or 1883

    _client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    def on_connect(client, userdata, flags, reason_code, properties):
        logger.info("Connected to MQTT broker at %s:%d", host, port)
        # Re-subscribe on reconnect
        for topic in _callbacks:
            client.subscribe(topic)

    def on_message(client, userdata, msg):
        topic = msg.topic
        try:
            payload = json.loads(msg.payload.decode())
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = msg.payload.decode()

        for pattern, handlers in _callbacks.items():
            if mqtt.topic_matches_sub(pattern, topic):
                for handler in handlers:
                    try:
                        handler(topic, payload)
                    except Exception as e:
                        logger.error("MQTT handler error for %s: %s", topic, e)

    _client.on_connect = on_connect
    _client.on_message = on_message
    _client.connect(host, port, keepalive=60)
    _client.loop_start()
    return _client


def publish(topic: str, payload: dict) -> None:
    if _client and _client.is_connected():
        _client.publish(topic, json.dumps(payload))


def subscribe(topic: str, handler) -> None:
    if topic not in _callbacks:
        _callbacks[topic] = []
        if _client and _client.is_connected():
            _client.subscribe(topic)
    _callbacks[topic].append(handler)


def disconnect() -> None:
    if _client:
        _client.loop_stop()
        _client.disconnect()
