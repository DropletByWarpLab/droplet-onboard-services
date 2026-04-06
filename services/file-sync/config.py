"""Environment-based configuration."""

import os

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://droplet:droplet@localhost:5432/droplet")
MQTT_BROKER = os.getenv("MQTT_BROKER", "mqtt://broker:1883")
FILES_ROOT = os.getenv("FILES_ROOT", "/data/files")
