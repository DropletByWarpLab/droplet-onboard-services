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


def _run_fips_boot_self_test() -> None:
    """WARP-229: assert the OpenSSL FIPS provider is loaded + enforcing.

    Gating: `DROPLET_FIPS_REQUIRED` env var.
      "true" / "1"           → enforce; exit 1 on failure
      "false" / "0" / unset  → skip with note (dev/CI default)

    The container's Dockerfile sets `OPENSSL_CONF=/etc/ssl/openssl-fips.cnf`
    and ships the FIPS module config alongside; the only way the
    self-test can fail at this point is a misconfiguration in the image
    OR the validated `fips.so` not having been layered on yet (operator
    task — see Dockerfile comment).
    """
    raw = os.environ.get("DROPLET_FIPS_REQUIRED")
    if raw is None or raw.lower() in ("false", "0", "no"):
        logger.info(
            "FIPS boot self-test skipped (DROPLET_FIPS_REQUIRED=%s)",
            raw if raw is not None else "<unset>",
        )
        return

    # Lazy import — `_shared` is only laid into the image at build time
    # by `COPY services/_shared/...`. Running main.py directly outside
    # Docker would miss the helper; the env-gated skip above prevents
    # that path from breaking dev workflows.
    sys.path.insert(0, "/app")
    try:
        from _shared.fips_selftest import assert_fips_at_boot_or_exit
    except ImportError as err:
        logger.error(
            "FIPS boot self-test required but the helper isn't importable: %s. "
            "This usually means the image was built with an out-of-date Dockerfile.",
            err,
        )
        sys.exit(1)
    # Logs structured JSON + exits non-zero on failure; if it returns,
    # the provider is loaded AND enforcing.
    assert_fips_at_boot_or_exit("file-indexer")


def build_http_app():
    """Construct the file-indexer's FastAPI app.

    Module-level (rather than inlined in the server thread) so the routes
    are importable by tests without standing up uvicorn. Lives here, next
    to its only caller, to keep the indexer's single HTTP surface in one
    place.
    """
    from fastapi import FastAPI, HTTPException

    api = FastAPI()

    @api.get("/health")
    def health() -> dict:
        """Liveness probe for the orchestrator health-monitor + Docker
        healthcheck (WARP-598). file-indexer is otherwise MQTT/watcher-
        driven; a 200 here means the HTTP surface — and therefore the
        process hosting the watcher + scheduler threads — is alive. Kept
        dependency-free so the probe never blocks on the DB/MQTT/gRPC
        backends, matching routing's best-effort posture.
        """
        return {"status": "ok", "service": "file-indexer"}

    @api.post("/reindex/{file_id}")
    def reindex_file_endpoint(file_id: str) -> dict:
        """Re-extract a single file atomically. See brain_ingest.reindex_one."""
        from brain_ingest import reindex_one

        try:
            return reindex_one(file_id)
        except ValueError as e:
            # not-found / file-missing / extractor-unavailable
            raise HTTPException(status_code=404, detail=str(e))
        except RuntimeError as e:
            # empty extraction / chunker produced nothing
            raise HTTPException(status_code=422, detail=str(e))

    return api


def main():
    from config import NEXTCLOUD_DATA_ROOT, AI_GATEWAY_GRPC_URL

    _run_fips_boot_self_test()

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
    import threading
    scheduler_holder: dict = {}
    scheduler_loop: dict = {}

    def _scheduler_thread():
        # The loop/ordering logic lives in scheduler_service.run_scheduler_loop
        # so it is reachable from a test — apscheduler >= 3.11 requires the
        # scheduler to be built from inside the running loop, and that ordering
        # is exactly what regressed. See its docstring.
        try:
            import scheduler_service
        except Exception:
            logger.exception("scheduler_service import failed")
            return
        scheduler_service.run_scheduler_loop(scheduler_holder, scheduler_loop)

    sched_thread = threading.Thread(
        target=_scheduler_thread, name="warp218-scheduler", daemon=True
    )
    sched_thread.start()

    # WARP-287/WARP-598: the file-indexer HTTP surface (admin re-index +
    # /health). file-indexer is otherwise MQTT-driven; the orchestrator's
    # admin reindex route needs a request/response surface (so it can
    # return `chunksWritten` synchronously to the admin caller), and the
    # orchestrator health-monitor polls /health. The app is built by
    # build_http_app(); it runs in a daemon thread alongside the watcher —
    # uvicorn runs its own asyncio loop, independent of the apscheduler
    # thread above.
    def _http_server_thread():
        try:
            import uvicorn

            # WARP-1061: DROPLET_INTERNAL_TLS=1 serves the /data/service-tls
            # bundle + REQUIRES a CA-signed client cert (the orchestrator's
            # health probe / admin-reindex client presents one); unset/0
            # keeps the plain-HTTP listener byte-identical to before.
            from _shared.internal_tls import uvicorn_ssl_kwargs

            api = build_http_app()
            port = int(os.environ.get("FILE_INDEXER_HTTP_PORT", "8090"))
            uvicorn.run(
                api, host="0.0.0.0", port=port, log_level="info",
                **uvicorn_ssl_kwargs(),
            )
        except Exception:
            logger.exception("file-indexer HTTP server failed to start")
            os._exit(1)

    http_thread = threading.Thread(
        target=_http_server_thread, name="warp287-http", daemon=True
    )
    http_thread.start()

    # Start watching
    from watcher import start_watcher, reconcile_index
    observer = start_watcher()

    # WARP-1139/WARP-1140: one-shot reconcile scan. inotify only reports
    # events that happen while we're running, so anything uploaded before
    # this process started (first boot, restarts, crash windows) would
    # otherwise never be indexed — and search would say "no match" for
    # content that was simply never looked at. Runs in a daemon thread so
    # a large backlog doesn't delay live event handling; it's a single
    # pass, not a scheduling loop (the apscheduler rule governs schedules).
    reconcile_thread = threading.Thread(
        target=reconcile_index, name="warp1140-reconcile", daemon=True
    )
    reconcile_thread.start()

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
