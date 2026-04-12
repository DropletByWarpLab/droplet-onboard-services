"""MQTT publisher — notifies the orchestrator when a file has been indexed."""

from __future__ import annotations

import json
import logging
from typing import Optional
from urllib.parse import urlparse

import paho.mqtt.client as mqtt

from config import MQTT_BROKER

logger = logging.getLogger(__name__)

_client: Optional[mqtt.Client] = None


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
    _client.connect(host, port, keepalive=60)
    _client.loop_start()
    logger.info("Connected to MQTT broker at %s:%d", host, port)


def publish(topic: str, payload: dict) -> None:
    if _client is None or not _client.is_connected():
        logger.debug("MQTT not connected, skipping publish to %s", topic)
        return
    _client.publish(topic, json.dumps(payload))
