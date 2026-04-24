"""Shared pytest fixtures for services/file-indexer.

Seed test infrastructure for the CI coverage guard. Sets safe defaults so
config-time env reads and module imports succeed in a test context.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault(
    "DATABASE_URL", "postgresql://droplet:droplet@localhost:5432/droplet"
)
os.environ.setdefault("MQTT_BROKER", "mqtt://localhost:1883")
os.environ.setdefault("NEXTCLOUD_DATA_ROOT", "/tmp/droplet-tests-nc-data")
os.environ.setdefault("AI_GATEWAY_GRPC_URL", "localhost:50051")

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))
