"""WARP-465 D1 follow-up — MQTT bridge for `email/<accountId>/new`.

The orchestrator's existing WS bridge subscribes to `email/+/new`
topics so the dashboard's email tabs refresh without a poll. This
service publishes one message per successfully-ingested mail.

Best-effort: a wedged broker NEVER blocks the IDLE loop. The MQTT
client runs in its own thread (paho's `loop_start`) and exposes a
thread-safe `publish` we can call from async code without an
asyncio bridge.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import paho.mqtt.client as mqtt

from _shared.internal_tls import paho_configure

logger = logging.getLogger(__name__)

# WARP-235: the compose service name is `broker`, the listener is mTLS-only
# (:8883) and identity is the client cert CN — the old username/password pair
# is retired. MQTT_TLS=0 keeps a plaintext connection for dev brokers.
MQTT_HOST = os.environ.get("MQTT_HOST", "broker")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "8883"))
MQTT_TLS = os.environ.get("MQTT_TLS", "1") == "1"

_client: Optional[mqtt.Client] = None


def start() -> None:
    """Connect + start the paho loop in its own thread. Idempotent."""
    global _client
    if _client is not None:
        return
    client = mqtt.Client(client_id="email-indexer")
    if MQTT_TLS:
        # WARP-235: present this service's bundle; identity = cert CN.
        paho_configure(client)
    try:
        client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
        client.loop_start()
        _client = client
        logger.info("mqtt bridge connected to %s:%d", MQTT_HOST, MQTT_PORT)
    except OSError as exc:
        # Non-fatal: dashboard refresh just falls back to its existing
        # polling cadence. Reconnect happens on next call when paho's
        # background thread re-establishes.
        logger.warning("mqtt bridge connect failed: %s", exc)


def stop() -> None:
    global _client
    if _client is None:
        return
    try:
        _client.loop_stop()
        _client.disconnect()
    except Exception as exc:  # noqa: BLE001 — shutdown best-effort
        logger.warning("mqtt bridge stop failed: %s", exc)
    _client = None


def publish_new_mail(account_id: str, thread_id: str, message_id: str) -> None:
    """Best-effort publish on `email/<account_id>/new`."""
    if _client is None:
        return
    topic = f"email/{account_id}/new"
    payload = (
        '{"threadId":"%s","messageId":"%s"}'
        % (thread_id.replace('"', '\\"'), message_id.replace('"', '\\"'))
    )
    try:
        _client.publish(topic, payload, qos=0, retain=False)
    except Exception as exc:  # noqa: BLE001 — never raise into IDLE
        logger.warning("mqtt publish failed: %s", exc)
