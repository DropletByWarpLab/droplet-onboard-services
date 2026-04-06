"""File Sync Daemon — watches configured folders and keeps file metadata in sync."""

from __future__ import annotations

import logging
import signal
import sys
import time

from src import db, mqtt_client
from scanner import scan_target
from scheduler import SyncScheduler
from watcher import TargetWatcher

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    logger.info("File Sync Daemon starting...")

    # Connect to MQTT
    mqtt_client.connect()
    logger.info("Connected to MQTT broker")

    # Verify DB connection
    try:
        db.get_connection()
        logger.info("Connected to PostgreSQL")
    except Exception as e:
        logger.error("Failed to connect to PostgreSQL: %s", e)
        sys.exit(1)

    # Initialize components
    scheduler = SyncScheduler()
    watcher = TargetWatcher()

    # Load targets and start watching
    def reload_targets(*args):
        logger.info("Reloading sync targets...")
        targets = db.get_sync_targets()

        # Update scheduler
        scheduler.load_targets()

        # Update watchers
        watcher.stop_all()
        for target in targets:
            watcher.start_watching(target)

    # Subscribe to config changes
    mqtt_client.subscribe("droplet/sync/config/changed", lambda topic, payload: reload_targets())

    # Subscribe to manual trigger requests
    mqtt_client.subscribe("droplet/sync/+/trigger", lambda topic, payload: (
        scheduler.trigger_scan(payload.get("targetId", "")) if isinstance(payload, dict) else None
    ))

    # Initial load
    reload_targets()

    # Run initial scan for all targets
    targets = db.get_sync_targets()
    for target in targets:
        logger.info("Running initial scan for '%s'...", target.label)
        scan_target(target)

    # Start scheduler
    scheduler.start()
    logger.info("File Sync Daemon running")

    # Graceful shutdown
    shutdown = False

    def handle_signal(signum, frame):
        nonlocal shutdown
        shutdown = True
        logger.info("Received signal %d, shutting down...", signum)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # Main loop
    try:
        while not shutdown:
            time.sleep(1)
    finally:
        scheduler.stop()
        watcher.stop_all()
        mqtt_client.disconnect()
        logger.info("File Sync Daemon stopped")


if __name__ == "__main__":
    main()
