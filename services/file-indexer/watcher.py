"""Filesystem watcher for the Nextcloud data volume.

Uses watchdog to receive real-time events when files are created, modified,
or deleted under /data/nextcloud/data/{user}/files/. On each event, the
pipeline extracts text → chunks → embeds → upserts into pgvector.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

from watchdog.events import FileSystemEventHandler, FileModifiedEvent, FileCreatedEvent, FileDeletedEvent
from watchdog.observers import Observer

from config import NEXTCLOUD_DATA_ROOT
from extractors import extract_text
from chunker import chunk_text
from embedder import embed_texts
from db import upsert_chunk, delete_chunks_for_file, prune_excess_chunks
from mqtt_client import publish

logger = logging.getLogger(__name__)

# Nextcloud data layout: {root}/{user}/files/{relative_path}
USER_FILES_PATTERN = re.compile(
    r"^(?P<user>[^/]+)/files/(?P<relpath>.+)$"
)


def _parse_nc_path(absolute_path: str) -> tuple[str, str] | None:
    """Parse a Nextcloud data path into (username, relative_path).

    Returns None if the path isn't inside a user's files/ directory
    (e.g. appdata, cache, or trashbin).
    """
    try:
        rel = os.path.relpath(absolute_path, NEXTCLOUD_DATA_ROOT)
    except ValueError:
        return None
    m = USER_FILES_PATTERN.match(rel)
    if not m:
        return None
    return m.group("user"), m.group("relpath")


def _resolve_nc_file_id(user: str, relpath: str) -> int | None:
    """Resolve a Nextcloud file ID from the oc_filecache table.

    The file-indexer reads from Nextcloud's Postgres database (shared db)
    to get the numeric fileId that the versions/favorites/trash endpoints
    reference. This avoids an HTTP round-trip to the orchestrator.
    """
    import psycopg2
    from config import DATABASE_URL

    # Nextcloud stores the cache path as "files/{relpath}" (no leading /).
    cache_path = f"files/{relpath}"

    try:
        conn = psycopg2.connect(
            DATABASE_URL.replace("/droplet", "/nextcloud")
        )
        conn.autocommit = True
        with conn.cursor() as cur:
            # oc_storages maps each user to a numeric storage id.
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


class IndexHandler(FileSystemEventHandler):
    """Handle file events and trigger the indexing pipeline."""

    def on_created(self, event):
        if event.is_directory:
            return
        self._index(event.src_path)

    def on_modified(self, event):
        if event.is_directory:
            return
        self._index(event.src_path)

    def on_deleted(self, event):
        if event.is_directory:
            return
        parsed = _parse_nc_path(event.src_path)
        if not parsed:
            return
        user, relpath = parsed
        file_id = _resolve_nc_file_id(user, relpath)
        if file_id:
            delete_chunks_for_file(file_id)
            publish(f"droplet/index/{user}/deleted", {"path": relpath, "ncFileId": file_id})
            logger.info("Deleted index for %s/%s (fileId=%d)", user, relpath, file_id)

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
        if size == 0 or size > 100 * 1024 * 1024:  # Skip empty or >100MB
            return

        # Extract
        text = extract_text(path)
        if not text or len(text.strip()) < 10:
            return

        # Resolve Nextcloud file ID
        file_id = _resolve_nc_file_id(user, relpath)
        if not file_id:
            logger.debug("No fileId for %s/%s — skipping", user, relpath)
            return

        # Chunk
        chunks = chunk_text(text)
        if not chunks:
            return

        # Embed
        try:
            vectors = embed_texts(chunks)
        except Exception as e:
            logger.warning("Embedding failed for %s/%s: %s", user, relpath, e)
            return

        if len(vectors) != len(chunks):
            logger.warning("Embedding count mismatch for %s/%s", user, relpath)
            return

        # Upsert
        for idx, (chunk, vec) in enumerate(zip(chunks, vectors)):
            upsert_chunk(user, file_id, f"/{relpath}", idx, chunk, vec)

        # Prune excess chunks if the file shrunk
        prune_excess_chunks(file_id, len(chunks) - 1)

        publish(f"droplet/index/{user}/indexed", {
            "path": relpath,
            "ncFileId": file_id,
            "chunks": len(chunks),
        })
        logger.info("Indexed %s/%s → %d chunks", user, relpath, len(chunks))


def start_watcher() -> Observer:
    """Start watching the Nextcloud data root for file changes."""
    handler = IndexHandler()
    observer = Observer()
    observer.schedule(handler, NEXTCLOUD_DATA_ROOT, recursive=True)
    observer.start()
    logger.info("Watching %s for file changes", NEXTCLOUD_DATA_ROOT)
    return observer
