"""Directory scanning and change detection."""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from src import db

logger = logging.getLogger(__name__)


@dataclass
class ScanResult:
    files_scanned: int = 0
    created: int = 0
    modified: int = 0
    deleted: int = 0


def compute_hash(file_path: str) -> str:
    """Compute SHA-256 hash of a file using 64KB streaming chunks."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def guess_mime_type(filename: str) -> str | None:
    mime, _ = mimetypes.guess_type(filename)
    return mime


def scan_target(target: db.SyncTarget) -> ScanResult:
    """Walk a sync target directory and sync file entries with the DB."""
    result = ScanResult()
    target_path = Path(target.path)

    if not target_path.exists() or not target_path.is_dir():
        logger.warning("Target path does not exist: %s", target.path)
        return result

    # Get existing entries from DB
    existing = db.get_file_entries(target.id)
    seen_paths: set[str] = set()

    # Walk the filesystem
    for root, dirs, files in os.walk(target_path):
        # Process directories
        for dirname in dirs:
            abs_path = os.path.join(root, dirname)
            rel_path = os.path.relpath(abs_path, target_path)
            seen_paths.add(rel_path)

            if rel_path not in existing:
                stat = os.stat(abs_path)
                db.upsert_file_entry(
                    target_id=target.id,
                    path=rel_path,
                    name=dirname,
                    is_directory=True,
                    size=0,
                    mime_type=None,
                    file_hash=None,
                    modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
                )
                result.created += 1

        # Process files
        for filename in files:
            abs_path = os.path.join(root, filename)
            rel_path = os.path.relpath(abs_path, target_path)
            seen_paths.add(rel_path)
            result.files_scanned += 1

            try:
                stat = os.stat(abs_path)
                file_hash = compute_hash(abs_path)
                modified_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)

                existing_entry = existing.get(rel_path)

                if existing_entry is None:
                    # New file
                    db.upsert_file_entry(
                        target_id=target.id,
                        path=rel_path,
                        name=filename,
                        is_directory=False,
                        size=stat.st_size,
                        mime_type=guess_mime_type(filename),
                        file_hash=file_hash,
                        modified_at=modified_at,
                    )
                    result.created += 1
                elif existing_entry.hash != file_hash:
                    # Modified file
                    db.upsert_file_entry(
                        target_id=target.id,
                        path=rel_path,
                        name=filename,
                        is_directory=False,
                        size=stat.st_size,
                        mime_type=guess_mime_type(filename),
                        file_hash=file_hash,
                        modified_at=modified_at,
                    )
                    result.modified += 1
            except OSError as e:
                logger.warning("Error scanning file %s: %s", abs_path, e)

    # Detect deletions: entries in DB but not on disk
    for path_key in existing:
        if path_key not in seen_paths:
            db.delete_file_entry(target.id, path_key)
            result.deleted += 1

    # Mark sync complete
    db.mark_sync_complete(target.id)

    logger.info(
        "Scan complete for '%s': %d scanned, %d created, %d modified, %d deleted",
        target.label, result.files_scanned, result.created, result.modified, result.deleted,
    )
    return result
