"""Real-time filesystem watcher using watchdog."""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone

from watchdog.events import FileSystemEventHandler, FileSystemEvent
from watchdog.observers import Observer

from src import db, mqtt_client
from scanner import compute_hash, guess_mime_type

logger = logging.getLogger(__name__)


class DebouncedHandler(FileSystemEventHandler):
    """Handles filesystem events with debouncing."""

    def __init__(self, target: db.SyncTarget, debounce_seconds: float = 0.5):
        self.target = target
        self.debounce_seconds = debounce_seconds
        self._pending: dict[str, tuple[str, float]] = {}  # path -> (action, timestamp)
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None

    def _queue_event(self, path: str, action: str):
        with self._lock:
            self._pending[path] = (action, time.time())

            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(self.debounce_seconds, self._process_queue)
            self._timer.start()

    def _process_queue(self):
        with self._lock:
            pending = dict(self._pending)
            self._pending.clear()

        for file_path, (action, _) in pending.items():
            try:
                rel_path = os.path.relpath(file_path, self.target.path)
                name = os.path.basename(file_path)

                if action == "deleted":
                    db.delete_file_entry(self.target.id, rel_path)
                else:
                    if os.path.exists(file_path):
                        stat = os.stat(file_path)
                        is_dir = os.path.isdir(file_path)
                        file_hash = None if is_dir else compute_hash(file_path)
                        db.upsert_file_entry(
                            target_id=self.target.id,
                            path=rel_path,
                            name=name,
                            is_directory=is_dir,
                            size=0 if is_dir else stat.st_size,
                            mime_type=None if is_dir else guess_mime_type(name),
                            file_hash=file_hash,
                            modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
                        )

                mqtt_client.publish(
                    f"droplet/sync/{self.target.id}/changed",
                    {"path": rel_path, "action": action, "targetId": self.target.id},
                )
            except Exception as e:
                logger.error("Error processing watcher event for %s: %s", file_path, e)

    def on_created(self, event: FileSystemEvent):
        self._queue_event(event.src_path, "created")

    def on_modified(self, event: FileSystemEvent):
        if not event.is_directory:
            self._queue_event(event.src_path, "modified")

    def on_deleted(self, event: FileSystemEvent):
        self._queue_event(event.src_path, "deleted")

    def on_moved(self, event: FileSystemEvent):
        self._queue_event(event.src_path, "deleted")
        if hasattr(event, "dest_path"):
            self._queue_event(event.dest_path, "created")


class TargetWatcher:
    """Manages watchdog observers for sync targets."""

    def __init__(self):
        self._observers: dict[str, Observer] = {}

    def start_watching(self, target: db.SyncTarget) -> None:
        if target.id in self._observers:
            return

        if not os.path.isdir(target.path):
            logger.warning("Cannot watch non-existent directory: %s", target.path)
            return

        handler = DebouncedHandler(target)
        observer = Observer()
        observer.schedule(handler, target.path, recursive=True)
        observer.start()
        self._observers[target.id] = observer
        logger.info("Started watching: %s (%s)", target.label, target.path)

    def stop_watching(self, target_id: str) -> None:
        observer = self._observers.pop(target_id, None)
        if observer:
            observer.stop()
            observer.join(timeout=5)

    def stop_all(self) -> None:
        for target_id in list(self._observers.keys()):
            self.stop_watching(target_id)
