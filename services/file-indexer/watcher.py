"""Filesystem watcher for the Nextcloud data volume.

Uses watchdog to receive real-time events when files are created, modified,
or deleted under /data/nextcloud/data/{user}/files/. On each event, the
pipeline extracts text -> chunks -> embeds -> upserts into pgvector.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.polling import PollingObserver

from config import NEXTCLOUD_DATA_ROOT
from extractors.registry import dispatch
from chunker import chunk_spans, format_chunk_with_header
from embedder import embed_texts
from db import upsert_chunk, delete_chunks_for_file, delete_chunks_for_path, prune_excess_chunks
from mqtt_client import publish

logger = logging.getLogger(__name__)

# Nextcloud data layout: {root}/{user}/files/{relative_path}
USER_FILES_PATTERN = re.compile(
    r"^(?P<user>[^/]+)/files/(?P<relpath>.+)$"
)

# ── Debounce ──
# Nextcloud uploads generate create + modify events in rapid succession.
# We debounce per-path: delay indexing by DEBOUNCE_SECONDS and reset the
# timer on each new event for the same path.
DEBOUNCE_SECONDS = 2.0
_debounce_timers: dict[str, threading.Timer] = {}
_debounce_lock = threading.Lock()


def _parse_nc_path(absolute_path: str) -> tuple[str, str] | None:
    """Parse a Nextcloud data path into (username, relative_path)."""
    try:
        rel = os.path.relpath(absolute_path, NEXTCLOUD_DATA_ROOT)
    except ValueError:
        return None
    m = USER_FILES_PATTERN.match(rel)
    if not m:
        return None
    return m.group("user"), m.group("relpath")


# ── Nextcloud file ID resolution (shared connection) ──

_nc_conn = None
_nc_conn_lock = threading.Lock()


def _get_nc_conn():
    """Get or create a connection to the Nextcloud DB (shared Postgres)."""
    global _nc_conn
    import psycopg2
    from config import DATABASE_URL

    with _nc_conn_lock:
        if _nc_conn is not None:
            try:
                # Quick liveness check
                with _nc_conn.cursor() as cur:
                    cur.execute("SELECT 1")
                return _nc_conn
            except Exception:
                try:
                    _nc_conn.close()
                except Exception:
                    pass
                _nc_conn = None

        nc_url = DATABASE_URL.replace("/droplet", "/nextcloud")
        _nc_conn = psycopg2.connect(nc_url)
        _nc_conn.autocommit = True
        return _nc_conn


def _resolve_nc_file_id(user: str, relpath: str) -> int | None:
    """Resolve a Nextcloud file ID from the oc_filecache table."""
    cache_path = f"files/{relpath}"

    try:
        conn = _get_nc_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT numeric_id FROM oc_storages WHERE id = %s",
                (f"home::{user}",),
            )
            row = cur.fetchone()
            if not row:
                return None
            storage_id = row[0]

            cur.execute(
                "SELECT fileid FROM oc_filecache WHERE storage = %s AND path = %s",
                (storage_id, cache_path),
            )
            row = cur.fetchone()
            return row[0] if row else None
    except Exception as e:
        logger.debug("Failed to resolve fileId for %s/%s: %s", user, relpath, e)
        return None


# ── Event handler ──

class IndexHandler(FileSystemEventHandler):
    """Handle file events and trigger the indexing pipeline."""

    def on_created(self, event):
        if event.is_directory:
            return
        self._schedule(event.src_path)

    def on_modified(self, event):
        if event.is_directory:
            return
        self._schedule(event.src_path)

    def on_deleted(self, event):
        if event.is_directory:
            return
        # For deletes we don't debounce — act immediately.
        try:
            parsed = _parse_nc_path(event.src_path)
            if not parsed:
                return
            user, relpath = parsed
            file_id = _resolve_nc_file_id(user, relpath)
            if file_id:
                delete_chunks_for_file(file_id)
                publish(f"droplet/index/{user}/deleted", {"path": relpath, "ncFileId": file_id})
                logger.info("Deleted index for %s/%s (fileId=%d)", user, relpath, file_id)
            else:
                # IDX-09: Nextcloud may purge the oc_filecache row before/at the
                # same time as the inotify delete reaches us, so the fileId is
                # unresolvable. Without a fallback the file's chunks are never
                # deleted → orphaned vectors keep surfacing in search. Delete by
                # the (userId, path) the watcher stored ("/<relpath>") instead.
                deleted = delete_chunks_for_path(user, f"/{relpath}")
                if deleted:
                    publish(f"droplet/index/{user}/deleted", {"path": relpath, "ncFileId": None})
                    logger.info(
                        "Deleted index for %s/%s by path (no fileId; %d chunk(s))",
                        user, relpath, deleted,
                    )
                else:
                    logger.debug(
                        "on_deleted: no fileId and no chunks by path for %s/%s",
                        user, relpath,
                    )
        except Exception as e:
            logger.warning("on_deleted error for %s: %s", event.src_path, e)

    def _schedule(self, path: str) -> None:
        """Debounce: delay indexing by DEBOUNCE_SECONDS, resetting on repeat events."""
        with _debounce_lock:
            existing = _debounce_timers.get(path)
            if existing:
                existing.cancel()
            timer = threading.Timer(DEBOUNCE_SECONDS, self._run_index, args=(path,))
            timer.daemon = True
            _debounce_timers[path] = timer
            timer.start()

    def _run_index(self, path: str) -> None:
        """Run the indexing pipeline, called after debounce expires."""
        with _debounce_lock:
            _debounce_timers.pop(path, None)
        try:
            self._index(path)
        except Exception as e:
            logger.error("Indexing failed for %s: %s", path, e, exc_info=True)

    def _index(self, path: str) -> None:
        parsed = _parse_nc_path(path)
        if not parsed:
            return
        user, relpath = parsed

        # Skip hidden files, part files (Nextcloud uploads in progress), and tiny files.
        basename = os.path.basename(relpath)
        if basename.startswith(".") or basename.endswith(".part") or basename.endswith(".ocTransferId"):
            return

        try:
            size = os.path.getsize(path)
        except OSError:
            return
        if size == 0:
            return
        # Oversized files (> MAX_INDEX_BYTES) are skipped by extractors.dispatch
        # with `reason=oversized` in the log line — no DB write.

        # Extract — dispatch picks the right extractor by MIME and returns None
        # for unsupported / oversized / failed paths.
        mime, _ = mimetypes.guess_type(path)
        if mime is None:
            return  # unknown type, skip silently
        doc = dispatch(path, mime)
        if doc is None:
            return
        # WARP-287: extractors emit spans; derive the empty-extraction
        # guard's input from them rather than the now-removed `text` key.
        spans = doc.get("spans") if isinstance(doc, dict) else None
        full_text = "\n\n".join(s.text for s in (spans or []) if getattr(s, "text", ""))
        if not full_text or len(full_text.strip()) < 10:
            return

        # Resolve Nextcloud file ID
        file_id = _resolve_nc_file_id(user, relpath)
        if not file_id:
            logger.debug("No fileId for %s/%s — skipping", user, relpath)
            return

        # Chunk — span-scoped + sentence-aware. Each Chunk carries its
        # anchor (WARP-287) and section_path (WARP-435).
        chunks = chunk_spans(spans or [])
        if not chunks:
            return

        # WARP-435: section-aware contextual header per chunk. The
        # section_path rides on the Chunk (from its source span), so no
        # global-offset lookup is needed.
        display_filename = os.path.basename(relpath) or relpath
        prefixed_chunks: list[str] = [
            format_chunk_with_header(c.text, display_filename, c.section_path)
            for c in chunks
        ]

        # Embed (prefixed text — the exact string also persisted on
        # FileContentChunk.text so search hits show the section context).
        vectors = embed_texts(prefixed_chunks)
        if len(vectors) != len(prefixed_chunks):
            logger.warning("Embedding count mismatch for %s/%s", user, relpath)
            return

        # WARP-214: forward ExtractedDoc.metadata (chain[], subtitle_source) to
        # the chunk row so the dashboard can render breadcrumbs + source-channel
        # badges from /api/files/knowledge/{recent,search}.
        # WARP-287: overlay each chunk's anchor under metadata.anchor.
        # WARP-435: overlay each chunk's sectionPath alongside it.
        doc_metadata = doc.get("metadata") if isinstance(doc, dict) else None
        for idx, (chunk, prefixed_text, vec) in enumerate(
            zip(chunks, prefixed_chunks, vectors)
        ):
            chunk_metadata = dict(doc_metadata or {})
            try:
                chunk_metadata["anchor"] = chunk.anchor.model_dump()
            except Exception as e:  # pragma: no cover - defensive
                logger.warning(
                    "watcher: anchor serialize failed for %s/%s chunk %d: %s",
                    user,
                    relpath,
                    idx,
                    e,
                )
                chunk_metadata["anchor"] = None
            chunk_metadata["sectionPath"] = list(chunk.section_path)
            upsert_chunk(
                user,
                file_id,
                f"/{relpath}",
                idx,
                prefixed_text,
                vec,
                metadata=chunk_metadata,
            )

        # Prune excess chunks if the file shrunk
        prune_excess_chunks(file_id, len(prefixed_chunks) - 1)

        publish(f"droplet/index/{user}/indexed", {
            "path": relpath,
            "ncFileId": file_id,
            "chunks": len(prefixed_chunks),
        })
        logger.info("Indexed %s/%s -> %d chunks", user, relpath, len(prefixed_chunks))


def start_watcher() -> Observer:
    """Start watching the Nextcloud data root for file changes.

    By default uses inotify-based `Observer` (efficient, real-time). Setting
    `WATCHER_MODE=polling` switches to `PollingObserver`, which periodically
    walks the tree instead of relying on kernel events. Polling is needed
    in test stacks (WARP-215) and any cross-container/Docker overlay setup
    where inotify events from one container don't reliably reach another
    container's mount namespace. Polling is significantly slower (~5s
    detection latency vs. milliseconds), so it is opt-in only.
    """
    handler = IndexHandler()
    mode = os.environ.get("WATCHER_MODE", "inotify").lower()
    if mode == "polling":
        observer: Observer = PollingObserver(timeout=2.0)
        logger.info("WATCHER_MODE=polling — using PollingObserver (5s detection latency)")
    else:
        observer = Observer()
    observer.schedule(handler, NEXTCLOUD_DATA_ROOT, recursive=True)
    observer.start()
    logger.info("Watching %s for file changes", NEXTCLOUD_DATA_ROOT)
    return observer
