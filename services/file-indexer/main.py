"""File indexer daemon — watches Nextcloud data for file changes, extracts
text, computes embeddings, and stores them in pgvector for semantic search.

Entry point for Docker. Runs forever until SIGINT/SIGTERM.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import time

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("file-indexer")


def main():
    from config import NEXTCLOUD_DATA_ROOT, AI_GATEWAY_GRPC_URL

    logger.info("Droplet file-indexer starting")
    logger.info("  Nextcloud data: %s", NEXTCLOUD_DATA_ROOT)
    logger.info("  AI gateway gRPC: %s", AI_GATEWAY_GRPC_URL)

    # Ensure the data root exists (it's a read-only volume mount)
    if not os.path.isdir(NEXTCLOUD_DATA_ROOT):
        logger.warning(
            "NEXTCLOUD_DATA_ROOT %s does not exist yet. "
            "Waiting for the Nextcloud container to populate it...",
            NEXTCLOUD_DATA_ROOT,
        )
        # Wait up to 60s for the volume to appear
        for _ in range(60):
            if os.path.isdir(NEXTCLOUD_DATA_ROOT):
                break
            time.sleep(1)
        else:
            logger.error("Data root never appeared. Exiting.")
            sys.exit(1)

    # Connect services
    from mqtt_client import connect as connect_mqtt
    from db import get_conn

    try:
        connect_mqtt()
    except Exception:
        logger.warning("MQTT broker unavailable — indexing will work, events won't publish")

    try:
        get_conn()
    except Exception as e:
        logger.error("Cannot connect to PostgreSQL: %s", e)
        sys.exit(1)

    # WARP-203: subscribe to brain-memory uploads from the orchestrator.
    # Non-fatal if MQTT is unavailable — the subscriber is registered
    # locally and will queue if the broker comes online later.
    try:
        from brain_ingest import start_brain_ingest
        start_brain_ingest()
    except Exception:
        logger.warning("brain_ingest: failed to subscribe — chat-attached files won't index")

    # WARP-218: reconcile any items stuck mid-transcription before the
    # scheduler starts ticking, so a crashed run doesn't leave rows in
    # 'indexing' forever. Non-fatal if the DB is briefly unavailable —
    # the next daily run will retry.
    try:
        import transcription_worker
        transcription_worker.reconcile_at_startup()
    except Exception:
        logger.warning("transcription_worker.reconcile: failed at startup (non-fatal)")

    # WARP-218: subscribe to the orchestrator's "run one" command topic so
    # /transcribe-now overrides land here. Handler dispatches to the worker
    # synchronously on the paho network thread — same shape as brain_ingest.
    def _handle_run_one(payload: dict) -> None:
        item_id = payload.get("itemId")
        if not isinstance(item_id, str) or not item_id:
            logger.warning("run_one: missing or invalid itemId in payload: %r", payload)
            return
        try:
            import transcription_worker
            transcription_worker.run_one(item_id)
        except Exception:
            logger.exception("transcription_worker.run_one crashed for %s", item_id)
    try:
        from mqtt_client import subscribe as mqtt_subscribe
        mqtt_subscribe("droplet/transcription/run-one", _handle_run_one)
    except Exception:
        logger.warning("transcription_worker: run-one subscribe failed (non-fatal)")

    # WARP-218: start the daily scheduler. Per CLAUDE.md, scheduling work
    # uses apscheduler — never while-True loops. The scheduler runs on its
    # own asyncio loop in a daemon thread because main()'s primary
    # blocking surface is still the watchdog Observer (started below).
    import asyncio
    import threading
    scheduler_holder: dict = {}
    scheduler_loop: dict = {}

    def _scheduler_thread():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        scheduler_loop["loop"] = loop
        try:
            import scheduler_service
            scheduler_holder["scheduler"] = scheduler_service.build_scheduler()
        except Exception:
            logger.exception("scheduler_service.build_scheduler failed")
            return
        try:
            loop.run_forever()
        finally:
            loop.close()

    sched_thread = threading.Thread(
        target=_scheduler_thread, name="warp218-scheduler", daemon=True
    )
    sched_thread.start()

    # Start watching
    from watcher import start_watcher
    observer = start_watcher()

    # Graceful shutdown
    def shutdown(sig, _frame):
        logger.info("Shutting down (signal %s)...", sig)
        sched = scheduler_holder.get("scheduler")
        if sched is not None:
            try:
                sched.shutdown(wait=False)
            except Exception:
                pass
        loop = scheduler_loop.get("loop")
        if loop is not None and loop.is_running():
            try:
                loop.call_soon_threadsafe(loop.stop)
            except Exception:
                pass
        observer.stop()
        observer.join(timeout=5)
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Block main thread on the watchdog Observer. The Observer's own
    # internal scheduling is event-driven (inotify), so the `while
    # observer.is_alive()` here is the canonical "wait for thread to
    # exit" pattern, not a scheduling loop.
    try:
        while observer.is_alive():
            observer.join(timeout=1)
    except KeyboardInterrupt:
        observer.stop()
        observer.join()


if __name__ == "__main__":
    main()
