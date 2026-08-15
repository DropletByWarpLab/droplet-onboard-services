"""Filesystem watcher for the Nextcloud data volume.

Uses watchdog to receive real-time events when files are created, modified,
or deleted under /data/nextcloud/data/{user}/files/ and (WARP-1140) the
shared groupfolder tree /data/nextcloud/data/__groupfolders/{id}/. On each
event, the pipeline extracts text -> chunks -> embeds -> upserts into
pgvector, and records an explicit per-file FileIndexStatus row (WARP-1139:
search must be able to say "still indexing", never guess from row absence).

WARP-1264: a watched groupfolder id is resolved to its owning Department
(kind + display name) via a TTL-cached Postgres lookup (`Department
.ncGroupfolderId`). kind=HOUSEHOLD keeps the legacy `__household__` sentinel
(zero reindex — see `_lookup_department_for_groupfolder`); any other kind
emits `__dept_<uuid>__`. An unrecognized groupfolder id is skipped, never
guessed into a corpus.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

from watchdog.events import FileDeletedEvent, FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.polling import PollingObserver

from config import NEXTCLOUD_DATA_ROOT, SHARED_FOLDER_NAME, HOUSEHOLD_USER_ID
from extractors.registry import dispatch
from chunker import chunk_spans, format_chunk_with_header
from embedder import embed_texts
from db import (
    upsert_chunk,
    delete_chunks_for_file,
    delete_chunks_for_path,
    prune_excess_chunks,
    set_index_status,
    delete_index_status,
    fetch_index_status_map,
)
from mqtt_client import publish

logger = logging.getLogger(__name__)

# ── WARP-1842: explicit Office/ODF MIME registrations ──
# The shipped image (python:3.12-slim) has NO system MIME tables — every
# path in `mimetypes.knownfiles` is absent — and Python 3.12's built-in
# table lacks OOXML/ODF. Left to the OS, `guess_type("a.docx")` returned
# `(None, None)`, `_sniff_text_mime` correctly refused the zip magic (NUL
# bytes), and every Office/ODF document landed `skipped/unknown_type`
# before `dispatch()` could route to the existing docx/pptx extractors.
# Register the types in code so guessing never depends on OS tables (the
# Dockerfile also installs Debian `media-types` as belt-and-suspenders,
# but correctness must not hinge on an image detail).
#
# WARP-1842 registered OOXML + legacy Word + ODF; at that point .xlsx and
# the ODF family had no extractor and took the honest
# `skipped/unsupported_or_failed_extraction` path via dispatch() → None.
# WARP-2052 supplies those extractors, and adds legacy .xls here — Python's
# built-in table happens to know that one, but relying on a built-in for
# some extensions and an explicit entry for others is the exact split that
# made this fail silently the first time.
OFFICE_MIME_TYPES: dict[str, str] = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword",
    ".xls": "application/vnd.ms-excel",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".odg": "application/vnd.oasis.opendocument.graphics",
}


def register_office_mime_types() -> None:
    """Idempotently register the Office/ODF MIME types (WARP-1842).

    ``mimetypes.add_type`` overwrites the extension mapping and de-dupes
    the inverse map, so repeat calls converge on the same table. Runs at
    module import; tests re-run it against a pristine ``MimeTypes`` DB to
    simulate the container's bare tables.
    """
    for ext, mime in OFFICE_MIME_TYPES.items():
        mimetypes.add_type(mime, ext)


register_office_mime_types()

# Nextcloud data layout: {root}/{user}/files/{relative_path}
USER_FILES_PATTERN = re.compile(
    r"^(?P<user>[^/]+)/files/(?P<relpath>.+)$"
)

# WARP-1140: shared "Household" groupfolder layout. The groupfolders app
# stores content OUTSIDE user homes: {root}/__groupfolders/{folderId}/{path}.
# (`__groupfolders/trash/…` and `__groupfolders/versions/…` don't match the
# \d+ folder-id segment and are deliberately excluded.) Before this pattern
# existed the shared space was silently never content-indexed — Household
# keyword/semantic search could not match anything.
GROUPFOLDERS_PATTERN = re.compile(
    r"^__groupfolders/(?P<gfid>\d+)/(?P<relpath>.+)$"
)

# ── Debounce ──
# Nextcloud uploads generate create + modify events in rapid succession.
# We debounce per-path: delay indexing by DEBOUNCE_SECONDS and reset the
# timer on each new event for the same path.
DEBOUNCE_SECONDS = 2.0
_debounce_timers: dict[str, threading.Timer] = {}
_debounce_lock = threading.Lock()


@dataclass(frozen=True)
class WatchTarget:
    """A watched file resolved to its index identity.

    - ``index_user``: FileContentChunk/FileIndexStatus owner — the Nextcloud
      home user, or the ``__household__`` sentinel for groupfolder content.
    - ``stored_path``: display path persisted on the chunk rows —
      ``/<relpath>`` for home files, ``/<SHARED_FOLDER_NAME>/<relpath>`` for
      groupfolder files (the path household members see in their own home).
    - ``relpath``: path relative to the watched subtree (logging + MQTT).
    - ``cache_path``: the ``oc_filecache.path`` value used to resolve the
      Nextcloud numeric file id.
    - ``home_user``: the NC home owner for home files; None for groupfolders.
    """

    index_user: str
    stored_path: str
    relpath: str
    cache_path: str
    home_user: Optional[str]


def _parse_watch_target(absolute_path: str) -> Optional[WatchTarget]:
    """Parse an absolute data-dir path into a WatchTarget (or None)."""
    try:
        rel = os.path.relpath(absolute_path, NEXTCLOUD_DATA_ROOT)
    except ValueError:
        return None
    m = USER_FILES_PATTERN.match(rel)
    if m:
        user, relpath = m.group("user"), m.group("relpath")
        return WatchTarget(
            index_user=user,
            stored_path=f"/{relpath}",
            relpath=relpath,
            cache_path=f"files/{relpath}",
            home_user=user,
        )
    g = GROUPFOLDERS_PATTERN.match(rel)
    if g:
        gfid = int(g.group("gfid"))
        relpath = g.group("relpath")
        dept = _lookup_department_for_groupfolder(gfid)
        if dept is None:
            # WARP-1264: fail-closed — an unrecognized groupfolder id must
            # never be attributed to a personal (or any) corpus.
            logger.warning(
                "Unknown groupfolder id=%d for %s — skipping (no Department row)",
                gfid, rel,
            )
            return None
        if dept["kind"] == "HOUSEHOLD":
            # Legacy sentinel preserved verbatim — no reindex of existing rows.
            index_user = HOUSEHOLD_USER_ID
            folder_name = SHARED_FOLDER_NAME
        else:
            index_user = f"__dept_{dept['id']}__"
            folder_name = dept["name"]
        return WatchTarget(
            index_user=index_user,
            stored_path=f"/{folder_name}/{relpath}",
            relpath=relpath,
            cache_path=rel,  # "__groupfolders/<id>/<relpath>"
            home_user=None,
        )
    return None


# ── WARP-1264: groupfolder id -> Department lookup, TTL-cached ─────────────
#
# Re-queried lazily on cache miss (no `while True` scheduler thread — this
# service's apscheduler wiring is dedicated to the daily transcription pass;
# a low-churn, read-through cache keyed by an id that only changes at
# department-provisioning time doesn't warrant its own scheduled job).

_GF_DEPT_CACHE_TTL_SECONDS = 300.0
_gf_dept_cache: dict[int, tuple[Optional[dict], float]] = {}
_gf_dept_cache_lock = threading.Lock()

# WARP-1264: graceful-degradation sentinel. The Department lookup is an
# *enhancement* layered over the pre-WARP-1264 default — where ALL groupfolder
# content indexed under the household sentinel with zero DB dependency. When
# Postgres is unreachable we degrade to that legacy default rather than letting
# a connection error propagate out of `_parse_watch_target` (a pure path parse
# that also runs in on_deleted / reconcile / crash-recovery, none of which can
# assume DB reachability). The household branch reads only `kind`, so id/name
# are placeholders. This value is deliberately NEVER cached, so a real
# department resolves on the next event as soon as the DB recovers — a
# transient blip must never pin a real department to the household corpus for
# the TTL window.
_HOUSEHOLD_FALLBACK: dict = {"id": None, "kind": "HOUSEHOLD", "name": SHARED_FOLDER_NAME}


def _lookup_department_for_groupfolder(gfid: int) -> Optional[dict]:
    """Resolve a groupfolder id to its Department `{id, kind, name}`.

    TTL-cached (`_GF_DEPT_CACHE_TTL_SECONDS`) so the hot indexing path
    doesn't round-trip to Postgres on every file event. Returns None for an
    unrecognized groupfolder id — callers must skip rather than guess.

    Resilient to a DB outage: a pure path parse must never be coupled to a
    mandatory, blocking DB round-trip. If the lookup can't reach Postgres it
    degrades to `_HOUSEHOLD_FALLBACK` (the legacy pre-WARP-1264 behaviour)
    instead of raising — the failure is logged, not swallowed, and the
    fallback is not cached so the real department resolves once the DB is back.
    """
    now = time.time()
    with _gf_dept_cache_lock:
        cached = _gf_dept_cache.get(gfid)
        if cached is not None and (now - cached[1]) < _GF_DEPT_CACHE_TTL_SECONDS:
            return cached[0]

    from db import fetch_department_for_groupfolder

    try:
        dept = fetch_department_for_groupfolder(gfid)
    except Exception as e:
        # Degrade to the legacy household corpus rather than aborting the
        # caller (delete / reconcile / index). Not cached — retried next event.
        logger.warning(
            "groupfolder %d department lookup failed (%s) — degrading to the "
            "household sentinel (not cached; re-attempted on the next event)",
            gfid,
            e,
        )
        return _HOUSEHOLD_FALLBACK

    with _gf_dept_cache_lock:
        _gf_dept_cache[gfid] = (dept, now)
    return dept


def _is_ignored_basename(basename: str) -> bool:
    """Hidden files, Nextcloud upload part-files, and transfer markers."""
    return (
        basename.startswith(".")
        or basename.endswith(".part")
        or basename.endswith(".ocTransferId")
    )


# ── Nextcloud file ID resolution (shared connection) ──

_nc_conn = None
_nc_conn_lock = threading.Lock()


def _get_nc_conn():
    """Get or create a connection to the Nextcloud DB (shared Postgres)."""
    global _nc_conn
    import psycopg2
    from config import NEXTCLOUD_DATABASE_URL

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

        # WARP-1327: never derive this inline with str.replace — see
        # config.derive_nextcloud_db_url for why (it rewrote the username).
        _nc_conn = psycopg2.connect(NEXTCLOUD_DATABASE_URL)
        _nc_conn.autocommit = True
        return _nc_conn


def _resolve_nc_file_id(user: str, relpath: str) -> int | None:
    """Resolve a Nextcloud file ID from the oc_filecache table."""
    cache_path = f"files/{relpath}"

    try:
        conn = _get_nc_conn()
        with conn.cursor() as cur:
            cur.execute(
                # Schema-qualified (WARP-1327/1328): an unqualified name is
                # silently skipped when the role lacks USAGE on the schema —
                # "does not exist" instead of "permission denied".
                "SELECT numeric_id FROM public.oc_storages WHERE id = %s",
                (f"home::{user}",),
            )
            row = cur.fetchone()
            if not row:
                return None
            storage_id = row[0]

            cur.execute(
                "SELECT fileid FROM public.oc_filecache WHERE storage = %s AND path = %s",
                (storage_id, cache_path),
            )
            row = cur.fetchone()
            return row[0] if row else None
    except Exception as e:
        # WARNING, not debug: a resolution failure means the file will land
        # `failed / nc_file_id_unresolved` — a 100%-failure condition was
        # invisible at debug level (WARP-1329 finding).
        logger.warning("Failed to resolve fileId for %s/%s: %s", user, relpath, e)
        return None


def _resolve_gf_file_id(cache_path: str) -> int | None:
    """WARP-1140: resolve a groupfolder file ID from oc_filecache.

    Groupfolder content rows live in the filecache with
    ``path = '__groupfolders/<id>/<relpath>'`` (no per-user home storage),
    so the lookup keys on the path alone — the ``__groupfolders/`` prefix is
    namespaced enough that at most one live row matches.
    """
    try:
        conn = _get_nc_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT fileid FROM public.oc_filecache WHERE path = %s "
                "ORDER BY fileid ASC LIMIT 1",
                (cache_path,),
            )
            row = cur.fetchone()
            return row[0] if row else None
    except Exception as e:
        logger.warning("Failed to resolve groupfolder fileId for %s: %s", cache_path, e)
        return None


def _resolve_file_id(target: WatchTarget) -> int | None:
    """Resolve the Nextcloud numeric file id for either watch layout."""
    if target.home_user is not None:
        return _resolve_nc_file_id(target.home_user, target.relpath)
    return _resolve_gf_file_id(target.cache_path)


# ── WARP-1139: explicit per-file index status (best-effort writes) ──

def _set_status(
    target: WatchTarget,
    status: str,
    *,
    nc_file_id: Optional[int] = None,
    reason: Optional[str] = None,
) -> None:
    """Record the explicit FileIndexStatus row for this file.

    Best-effort by design: a deployment where the FileIndexStatus migration
    hasn't run yet (or the DB briefly blips) must not break indexing itself —
    the status row is the honesty layer, not the pipeline.
    """
    try:
        set_index_status(
            target.index_user,
            target.stored_path,
            status,
            nc_file_id=nc_file_id,
            reason=reason,
        )
    except Exception as e:
        logger.debug(
            "index-status write (%s) failed for %s: %s",
            status,
            target.stored_path,
            e,
        )


# ── WARP-1139: extensionless plain-text sniffing ──

TEXT_SNIFF_BYTES = 8192


def _sniff_text_mime(path: str) -> str | None:
    """Fallback MIME for files `mimetypes` can't classify (no extension).

    A file literally named ``burrito`` used to be skipped silently — never
    indexed AND leaving no trace. If the head of the file decodes as UTF-8
    (and contains no NUL bytes), treat it as ``text/plain`` so the text
    extractor picks it up; anything else stays unknown (→ explicit
    ``skipped`` status, not silence).
    """
    try:
        with open(path, "rb") as f:
            head = f.read(TEXT_SNIFF_BYTES)
    except OSError:
        return None
    if not head or b"\x00" in head:
        return None
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as e:
        # A multibyte char split at the read boundary is fine; a decode
        # error anywhere earlier means genuinely binary content.
        if e.start < len(head) - 4:
            return None
    return "text/plain"


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

    def on_moved(self, event):
        if event.is_directory:
            return
        # WARP-1359: Nextcloud WebDAV writes are atomic — the upload lands as
        # `<name>.ocTransferId….part` (create event filtered by
        # _is_ignored_basename), then a rename moves it onto the final path.
        # That rename is the ONLY event a brand-new file ever produces, so it
        # must index the destination. For a genuine rename the source path's
        # index must also go, or its chunks linger under the old path.
        if not _is_ignored_basename(os.path.basename(event.src_path)):
            self.on_deleted(FileDeletedEvent(event.src_path))
        self._schedule(event.dest_path)

    def on_deleted(self, event):
        if event.is_directory:
            return
        # For deletes we don't debounce — act immediately.
        try:
            target = _parse_watch_target(event.src_path)
            if not target:
                return
            file_id = _resolve_file_id(target)
            if file_id:
                delete_chunks_for_file(file_id)
                publish(
                    f"droplet/index/{target.index_user}/deleted",
                    {"path": target.relpath, "ncFileId": file_id},
                )
                logger.info(
                    "Deleted index for %s%s (fileId=%d)",
                    target.index_user, target.stored_path, file_id,
                )
            else:
                # IDX-09: Nextcloud may purge the oc_filecache row before/at the
                # same time as the inotify delete reaches us, so the fileId is
                # unresolvable. Without a fallback the file's chunks are never
                # deleted → orphaned vectors keep surfacing in search. Delete by
                # the (userId, path) the watcher stored instead.
                deleted = delete_chunks_for_path(target.index_user, target.stored_path)
                if deleted:
                    publish(
                        f"droplet/index/{target.index_user}/deleted",
                        {"path": target.relpath, "ncFileId": None},
                    )
                    logger.info(
                        "Deleted index for %s%s by path (no fileId; %d chunk(s))",
                        target.index_user, target.stored_path, deleted,
                    )
                else:
                    logger.debug(
                        "on_deleted: no fileId and no chunks by path for %s%s",
                        target.index_user, target.stored_path,
                    )
            # WARP-1139: the file is gone — drop its explicit status row so it
            # doesn't linger as a stale 'ready'/'indexing'. Best-effort.
            try:
                delete_index_status(target.index_user, target.stored_path)
            except Exception as e:
                logger.debug(
                    "index-status delete failed for %s: %s", target.stored_path, e
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
            # WARP-1139: a crash mid-pipeline must leave an explicit 'failed'
            # row, not a file stuck at 'indexing' (or worse, no trace at all).
            target = _parse_watch_target(path)
            if target:
                _set_status(target, "failed", reason=str(e))

    def _index(self, path: str) -> None:
        target = _parse_watch_target(path)
        if not target:
            return

        # Skip hidden files, part files (Nextcloud uploads in progress), and tiny files.
        basename = os.path.basename(target.relpath)
        if _is_ignored_basename(basename):
            return

        try:
            size = os.path.getsize(path)
        except OSError:
            return
        if size == 0:
            return
        # Oversized files (> MAX_INDEX_BYTES) are skipped by extractors.dispatch
        # with `reason=oversized` in the log line.

        # WARP-1139: the file is now visibly "indexing" — search surfaces can
        # say "still indexing" instead of pretending it doesn't exist.
        _set_status(target, "indexing")

        # Extract — dispatch picks the right extractor by MIME and returns None
        # for unsupported / oversized / failed paths.
        mime, _ = mimetypes.guess_type(path)
        if mime is None:
            # WARP-1139: extensionless files (e.g. a file named "burrito")
            # used to be skipped silently here. Sniff for plain text first.
            mime = _sniff_text_mime(path)
        if mime is None:
            _set_status(target, "skipped", reason="unknown_type")
            return
        doc = dispatch(path, mime)
        if doc is None:
            _set_status(target, "skipped", reason="unsupported_or_failed_extraction")
            return
        # WARP-287: extractors emit spans; derive the empty-extraction
        # guard's input from them rather than the now-removed `text` key.
        spans = doc.get("spans") if isinstance(doc, dict) else None
        full_text = "\n\n".join(s.text for s in (spans or []) if getattr(s, "text", ""))
        if not full_text or len(full_text.strip()) < 10:
            _set_status(target, "skipped", reason="empty_extraction")
            return

        # Resolve Nextcloud file ID
        file_id = _resolve_file_id(target)
        if not file_id:
            logger.debug("No fileId for %s — skipping", target.stored_path)
            _set_status(target, "failed", reason="nc_file_id_unresolved")
            return

        # Chunk — span-scoped + sentence-aware. Each Chunk carries its
        # anchor (WARP-287) and section_path (WARP-435).
        chunks = chunk_spans(spans or [])
        if not chunks:
            _set_status(target, "skipped", reason="no_chunks")
            return

        # WARP-435: section-aware contextual header per chunk. The
        # section_path rides on the Chunk (from its source span), so no
        # global-offset lookup is needed.
        display_filename = os.path.basename(target.relpath) or target.relpath
        prefixed_chunks: list[str] = [
            format_chunk_with_header(c.text, display_filename, c.section_path)
            for c in chunks
        ]

        # Embed (prefixed text — the exact string also persisted on
        # FileContentChunk.text so search hits show the section context).
        vectors = embed_texts(prefixed_chunks)
        if len(vectors) != len(prefixed_chunks):
            logger.warning("Embedding count mismatch for %s", target.stored_path)
            _set_status(
                target, "failed", nc_file_id=file_id, reason="embedding_count_mismatch"
            )
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
                    "watcher: anchor serialize failed for %s chunk %d: %s",
                    target.stored_path,
                    idx,
                    e,
                )
                chunk_metadata["anchor"] = None
            chunk_metadata["sectionPath"] = list(chunk.section_path)
            upsert_chunk(
                target.index_user,
                file_id,
                target.stored_path,
                idx,
                prefixed_text,
                vec,
                metadata=chunk_metadata,
            )

        # Prune excess chunks if the file shrunk
        prune_excess_chunks(file_id, len(prefixed_chunks) - 1)

        _set_status(target, "ready", nc_file_id=file_id)

        publish(f"droplet/index/{target.index_user}/indexed", {
            "path": target.relpath,
            "ncFileId": file_id,
            "chunks": len(prefixed_chunks),
        })
        logger.info(
            "Indexed %s%s -> %d chunks",
            target.index_user, target.stored_path, len(prefixed_chunks),
        )


# ── WARP-1139/WARP-1140: startup reconcile scan ──

# Rows in these states get re-run by the reconcile scan: 'indexing' means a
# previous run crashed mid-pipeline; 'failed' gets one retry per process
# start (transient causes like the gateway being down usually clear).
RECONCILE_RETRY_STATUSES = {"indexing", "failed"}

# WARP-1842: 'skipped' is terminal EXCEPT for reasons a code fix genuinely
# resolves. `unknown_type` rows exist because the container had no MIME
# tables (Office/ODF guessed None); with the types now registered above,
# those rows heal on the next startup scan. Other skip reasons
# (empty_extraction / unsupported_or_failed_extraction / no_chunks) stay
# terminal — retrying them would re-run the whole skipped corpus on every
# restart for an outcome that cannot change.
RECONCILE_RETRY_SKIP_REASONS = {"unknown_type"}


def iter_watch_paths() -> Iterator[str]:
    """Yield the absolute path of every file in the watched subtrees:
    ``{root}/{user}/files/**`` and ``{root}/__groupfolders/**``.

    Walking only these subtrees (instead of the whole data dir) keeps the
    scan away from `appdata_*` previews and trash/version trees.
    """
    root = NEXTCLOUD_DATA_ROOT
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return
    for entry in entries:
        base = (
            os.path.join(root, entry)
            if entry == "__groupfolders"
            else os.path.join(root, entry, "files")
        )
        if not os.path.isdir(base):
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            for fn in filenames:
                yield os.path.join(dirpath, fn)


def reconcile_index(handler: IndexHandler | None = None) -> dict:
    """One-shot reconcile of the on-disk tree against the explicit index state.

    The inotify watcher only sees events that happen while it is running:
    anything uploaded before the file-indexer started (first boot, restart,
    crash window) was previously NEVER indexed — and left no trace, so search
    said "no match" for content that simply hadn't been looked at. Walk the
    watched subtrees once and index every file that (a) has no
    FileIndexStatus row, (b) is stuck in a retryable state ('indexing' /
    'failed', or — WARP-1842 — 'skipped' with a reason in
    RECONCILE_RETRY_SKIP_REASONS, which the current code genuinely
    resolves), or (c) changed on disk after its last status write.

    Runs in a daemon thread at startup (a one-shot pass, not a scheduling
    loop — the apscheduler rule governs recurring schedules).
    """
    handler = handler or IndexHandler()
    try:
        status_map = fetch_index_status_map()
    except Exception as e:
        logger.warning(
            "reconcile: cannot read FileIndexStatus (%s) — skipping scan", e
        )
        return {"scanned": 0, "processed": 0}

    scanned = 0
    processed = 0
    for abs_path in iter_watch_paths():
        target = _parse_watch_target(abs_path)
        if not target:
            continue
        if _is_ignored_basename(os.path.basename(target.relpath)):
            continue
        scanned += 1
        row = status_map.get((target.index_user, target.stored_path))
        if row is not None:
            status, updated_at = row[0], row[1]
            # WARP-1842: `reason` is the map's third element. Tolerate the
            # legacy 2-tuple shape (a caller predating the reason column in
            # fetch_index_status_map): no reason available means the
            # pre-1842 behaviour — the row is not skip-retried.
            reason = row[2] if len(row) > 2 else None
            retry = status in RECONCILE_RETRY_STATUSES or (
                status == "skipped" and reason in RECONCILE_RETRY_SKIP_REASONS
            )
            if not retry:
                try:
                    if os.path.getmtime(abs_path) <= updated_at:
                        continue  # already looked at, unchanged since
                except OSError:
                    continue
        try:
            handler._index(abs_path)
            processed += 1
        except Exception as e:
            logger.error("reconcile: indexing failed for %s: %s", abs_path, e)
            _set_status(target, "failed", reason=str(e))
    logger.info("reconcile: scanned %d file(s), processed %d", scanned, processed)
    return {"scanned": scanned, "processed": processed}


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
