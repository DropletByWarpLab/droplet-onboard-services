"""Shared pytest fixtures for services/camera-discovery.

Seed test infrastructure for the CI coverage guard. Sets env-var defaults that
make the service's top-level module importable in a test context.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("ROUTING_SERVICE_URL", "http://localhost:8080")
os.environ.setdefault("ROUTING_SERVICE_TOKEN", "pytest-fake-token")
os.environ.setdefault("FRIGATE_URL", "http://localhost:5000")
os.environ.setdefault("MQTT_BROKER", "mqtt://localhost:1883")
os.environ.setdefault("DEVICE_SECRET", "pytest-fake-secret")
os.environ.setdefault("CAMERA_SUBNET", "192.168.100.0/24")

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))
