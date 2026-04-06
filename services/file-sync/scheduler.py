"""Periodic sync scheduling."""

from __future__ import annotations

import logging
import threading
import time

import schedule

from src import db, mqtt_client
from src.scanner import scan_target

logger = logging.getLogger(__name__)


class SyncScheduler:
    """Schedules periodic scans for sync targets."""

    def __init__(self):
        self._running = False
        self._thread: threading.Thread | None = None

    def load_targets(self) -> None:
        """Load sync targets from DB and schedule them."""
        schedule.clear()
        targets = db.get_sync_targets()

        for target in targets:
            schedule.every(target.interval_min).minutes.do(
                self._run_scan, target=target
            ).tag(target.id)
            logger.info(
                "Scheduled scan for '%s' every %d minutes",
                target.label, target.interval_min,
            )

    def _run_scan(self, target: db.SyncTarget) -> None:
        """Execute a scan and publish results via MQTT."""
        logger.info("Starting scan for '%s'", target.label)
        mqtt_client.publish(
            f"droplet/sync/{target.id}/started",
            {"targetId": target.id},
        )

        result = scan_target(target)

        mqtt_client.publish(
            f"droplet/sync/{target.id}/complete",
            {
                "targetId": target.id,
                "filesScanned": result.files_scanned,
                "created": result.created,
                "modified": result.modified,
                "deleted": result.deleted,
            },
        )

    def trigger_scan(self, target_id: str) -> None:
        """Run an immediate scan for a specific target."""
        targets = db.get_sync_targets()
        for t in targets:
            if t.id == target_id:
                threading.Thread(target=self._run_scan, args=(t,), daemon=True).start()
                return
        logger.warning("Target %s not found for triggered scan", target_id)

    def start(self) -> None:
        """Start the scheduler loop in a background thread."""
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while self._running:
            schedule.run_pending()
            time.sleep(1)

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
