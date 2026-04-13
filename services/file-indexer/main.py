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

    # Start watching
    from watcher import start_watcher
    observer = start_watcher()

    # Graceful shutdown
    def shutdown(sig, _frame):
        logger.info("Shutting down (signal %s)...", sig)
        observer.stop()
        observer.join(timeout=5)
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Block main thread
    try:
        while observer.is_alive():
            observer.join(timeout=1)
    except KeyboardInterrupt:
        observer.stop()
        observer.join()


if __name__ == "__main__":
    main()
