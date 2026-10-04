"""File indexer daemon — watches Nextcloud data for file changes, extracts
text, computes embeddings, and stores them in pgvector for semantic search.

Entry point for Docker. Runs forever until SIGINT/SIGTERM.
"""

from __future__ import annotations

import hmac
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

try:  # fastapi's own dependency; absent only in minimal non-HTTP test envs
    from starlette.requests import HTTPConnection
except ImportError:  # pragma: no cover
    HTTPConnection = None  # type: ignore[assignment,misc]

# WARP-3625: inbound bearer, shared with the orchestrator's reindex call
# (FILE_INDEXER_SERVICE_TOKEN). Read at import; require_bearer looks the module
# global up at call time so tests can monkeypatch it (web-fetch precedent).
FILE_INDEXER_SERVICE_TOKEN = os.environ.get("FILE_INDEXER_SERVICE_TOKEN", "").strip()

# /health stays reachable without a token (Docker healthcheck, health monitor).
AUTH_EXEMPT_PATHS = frozenset({"/health"})


def require_bearer(conn: HTTPConnection) -> None:
    """Reject requests without a matching `Authorization: Bearer <token>`.

    Fails CLOSED: an unset FILE_INDEXER_SERVICE_TOKEN yields 503 on every
    non-/health route rather than letting any container on the bridge trigger
    reindex work. Same posture as web-fetch / erp-sql-bridge.
    """
    from fastapi import HTTPException

    if conn.url.path in AUTH_EXEMPT_PATHS:
        return
    if not FILE_INDEXER_SERVICE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="file-indexer auth is not configured (FILE_INDEXER_SERVICE_TOKEN unset)",
        )
    header = conn.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    # compare_digest raises on non-ASCII str; encode so a bad header is a 401.
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        token.strip().encode("utf-8"), FILE_INDEXER_SERVICE_TOKEN.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")


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
    from fastapi import Depends, FastAPI, HTTPException
    from fastapi.responses import JSONResponse

    api = FastAPI(dependencies=[Depends(require_bearer)])

    @api.get("/health")
    def health():
        """Liveness probe for the orchestrator health-monitor + Docker
        healthcheck (WARP-598). file-indexer is otherwise MQTT/watcher-
        driven; a 200 here means the HTTP surface — and therefore the
        process hosting the watcher + scheduler threads — is alive. Kept
        dependency-free so the probe never blocks on the DB/MQTT/gRPC
        backends, matching routing's best-effort posture.

        WARP-3193 QUAL-11: an extractor that cannot be imported (a missing
        libmagic, `srt`, ...) silently skips every file of its type, so it is
        a 503 `degraded` naming the modules, not a green probe. The check is
        local (module imports only) and cached by Python after the first call.
        """
        from extractors.registry import extractor_import_failures

        failures = extractor_import_failures()
        if failures:
            return JSONResponse(
                status_code=503,
                content={
                    "status": "degraded",
                    "service": "file-indexer",
                    "extractorImportErrors": failures,
                },
            )
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


def _enforce_corpus_state(conn_factory) -> None:
    """WARP-2196 startup gate: may this box add to the corpus it already has?

    A mismatch blocks chunk WRITES and logs an actionable ERROR; it does NOT
    exit. The service stays up on purpose — reads keep working, the existing
    corpus keeps serving queries, and the operator runs the re-embed in a
    window of their choosing. Exiting would take search down entirely over a
    corpus that is still internally consistent.

    Every failure path here blocks writes. `check_corpus_model` already
    fail-closes on its own read/count errors, but a throw from `conn_factory`
    (it re-probes and can reconnect), from the stamping write, or from
    anywhere else in this block would otherwise leave the block reason UNSET
    and let writes proceed against a possibly-stale corpus — fail-open on the
    escape path of a guard whose whole job is to fail closed.

    Extracted from `main()` so it can be tested directly; `main()` is not
    unit-runnable (fips self-test, volume wait, uvicorn).
    """
    try:
        from corpus_state import (
            VERDICT_BLOCKED,
            block_writes,
            check_corpus_model,
        )
    except Exception:
        # corpus_state is unimportable. Nothing to set — but `db.upsert_chunk`
        # imports `raise_if_write_blocked` from it on every call, so the same
        # ImportError propagates there and writes already fail closed. Log it
        # loudly; this is a broken image, not a corpus problem.
        logger.exception(
            "corpus_state: module could not be imported — chunk writes will "
            "fail closed. This is a build/deploy defect."
        )
        return

    try:
        verdict = check_corpus_model(conn_factory())
    except Exception as e:
        reason = (
            "REFUSING TO INDEX: the embedding-model startup check itself "
            f"failed ({e}), so it is not known whether this box may add to "
            "the corpus it has. Writes are blocked; reads are unaffected. "
            "Restart the file-indexer once the database is healthy. If it "
            "persists, see docs/RAG_RE_EMBED_RUNBOOK.md "
            "(recovery: scripts/rag-re-embed.sh)."
        )
        logger.exception("corpus_state: startup check crashed")
        logger.error(reason)
        block_writes(reason)
        return

    if verdict == VERDICT_BLOCKED:
        logger.error(
            "file-indexer is running in READ-ONLY mode: no new chunks "
            "will be written until the corpus is re-embedded."
        )


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

    # WARP-2196: establish whether this box is allowed to add to the corpus it
    # already has. Runs BEFORE the brain-ingest subscription and the reconcile
    # thread below, so no write path can start before the verdict is in.
    _enforce_corpus_state(get_conn)

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
