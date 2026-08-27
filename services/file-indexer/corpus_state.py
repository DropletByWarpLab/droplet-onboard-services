"""Which embedding model built the corpus that is currently in the database.

WARP-2196. The MiniLM -> bge-small-en-v1.5 re-embed is OPERATOR-GATED: no
migration deletes the corpus out from under a running appliance, and the
operator picks the maintenance window (``scripts/rag-re-embed.sh``).

Operator-gated is only safer than auto-run if skipping the step fails LOUD.
Otherwise a box takes the update, keeps indexing, and quietly accumulates bge
vectors alongside a MiniLM corpus. Both models emit 384 dimensions, so
Postgres stores and compares them side by side without a word of complaint;
cosine distance ACROSS the two spaces is noise; and once mixed there is no way
to tell which row came from which model. Search becomes confidently wrong,
permanently. That is strictly worse than a scheduled outage.

So the box records what built the corpus and refuses to add to a corpus it did
not build.

WHERE THE MARKER LIVES, AND WHY
-------------------------------
A ``WorkspaceSetting`` row keyed ``ai.embedding.corpusModel``.

* **Same database as the thing it describes.** The marker has to stay in sync
  with ``FileContentChunk`` across pg_dump/pg_restore. A file on the data
  volume would survive a database restore that rolled the corpus back, and
  then confidently describe vectors that are no longer there. This is state
  ABOUT the corpus, so it belongs beside the corpus.
* **No schema change, so no boot-ordering hazard.** ``WorkspaceSetting``
  exists on every deployed box already. A purpose-built table would be
  created by a Prisma migration that runs at ORCHESTRATOR boot, and the
  file-indexer can start first — the guard would then have to tolerate "my
  own state table does not exist yet", which is precisely the ambiguity it
  exists to remove.
* **The `ai` section is machine-owned.** It is deliberately excluded from the
  settings route's ``SECTION_VALUES`` (see ``routes/settings.ts``), so no
  dashboard surface can read or edit this key. Writing orchestrator-owned
  tables from this service is established practice (``BrainMemoryItem``,
  ``FileIndexStatus``).

Per-chunk provenance — the column that would make this incremental rather
than all-or-nothing — is WARP-2210 and is deliberately NOT implemented here.
This marker is corpus-wide on purpose: it is the cheap guard that makes the
gate safe today, not the long-term model.

FAIL-CLOSED ON WRITES, NOT READS
--------------------------------
A stale box keeps answering queries from its existing corpus, which is
internally consistent and perfectly useful, and refuses to mix new vectors
into it. Blocking reads would convert "you owe us a maintenance window" into a
total search outage on a box whose data is fine. Deletes stay open too: they
are how the operator script's work lands and how the watcher retires files the
user removed.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from config import EMBEDDING_MODEL

logger = logging.getLogger(__name__)

#: ``WorkspaceSetting.key`` holding the model id that built the current corpus.
CORPUS_MODEL_KEY = "ai.embedding.corpusModel"

#: The operator's recovery path. Named in every error this module raises —
#: an error that does not say what to run is the failure mode here.
RE_EMBED_COMMAND = "scripts/rag-re-embed.sh"
RE_EMBED_RUNBOOK = "docs/RAG_RE_EMBED_RUNBOOK.md"

#: `check_corpus_model` outcomes.
VERDICT_STAMPED = "stamped"  # empty corpus — marker written, indexing allowed
VERDICT_MATCH = "match"  # marker agrees with EMBEDDING_MODEL
VERDICT_BLOCKED = "blocked"  # mismatch (or unprovable) — writes refused


class CorpusModelMismatch(RuntimeError):
    """Raised on any attempt to add chunks to a corpus another model built."""


# Module-level because the gate has to be reachable from `db.upsert_chunk`
# without threading a handle through watcher / brain_ingest / transcription
# worker. Set once at startup by `check_corpus_model`.
_write_block_reason: Optional[str] = None


def writes_blocked() -> bool:
    return _write_block_reason is not None


def write_block_reason() -> Optional[str]:
    return _write_block_reason


def clear_write_block() -> None:
    global _write_block_reason
    _write_block_reason = None


def block_writes(reason: str) -> None:
    global _write_block_reason
    _write_block_reason = reason


def raise_if_write_blocked() -> None:
    """Gate every chunk INSERT. No-op unless the startup check blocked us."""
    if _write_block_reason is not None:
        raise CorpusModelMismatch(_write_block_reason)


def read_corpus_model(conn) -> Optional[str]:
    """Return the model id recorded for the current corpus, or None.

    None means "never stamped" — either a fresh box or a corpus built before
    this guard existed. The caller decides which, by looking at whether any
    chunks exist; this function does not guess.
    """
    with conn.cursor() as cur:
        cur.execute(
            'SELECT "valueJson" FROM "WorkspaceSetting" WHERE "key" = %s',
            (CORPUS_MODEL_KEY,),
        )
        row = cur.fetchone()
    if not row or row[0] is None:
        return None
    value = row[0]
    # psycopg2 decodes jsonb to a Python object; a plain text column (or a
    # driver without the jsonb adapter registered) hands back the raw string.
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return value or None
    return str(value) if value is not None else None


def stamp_corpus_model(conn, model: str) -> None:
    """Record ``model`` as the producer of the current corpus.

    ``WorkspaceSetting.updatedAt`` is Prisma-side ``@updatedAt``, i.e. the
    application sets it — raw SQL has to do so explicitly or the column would
    never move. ``id`` is a Prisma-side uuid default for the same reason, so
    the INSERT supplies one via ``gen_random_uuid()::text``. The cast is not
    cosmetic: the column is Prisma ``String`` (TEXT) while the function returns
    ``uuid``, and the explicit cast is the house pattern —
    ``20260525130200_warp_455_file_scope/migration.sql`` does exactly this for
    ``File.id``.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "WorkspaceSetting"
                ("id", "key", "section", "type", "valueJson",
                 "createdAt", "updatedAt")
            VALUES (gen_random_uuid()::text, %s, 'ai'::"SettingSection",
                    'string'::"SettingType", %s::jsonb, NOW(), NOW())
            ON CONFLICT ("key") DO UPDATE SET
                "valueJson" = EXCLUDED."valueJson",
                "updatedAt" = NOW()
            """,
            (CORPUS_MODEL_KEY, json.dumps(model)),
        )
    logger.info("corpus_state: corpus marked as embedded by %s", model)


def count_chunks(conn) -> int:
    """How many chunks are in the corpus right now."""
    with conn.cursor() as cur:
        cur.execute('SELECT count(*) FROM "FileContentChunk"')
        row = cur.fetchone()
    return int(row[0]) if row else 0


def _mismatch_message(marker: Optional[str], configured: str, chunks: int) -> str:
    """Build the operator-facing block message.

    Everything needed to act is in here: which model the corpus holds, which
    one this box is configured for, how much is affected, the exact command,
    and the runbook. Callers log it and it is also the exception text, so an
    operator hits the same words in the container log and in a failed index.
    """
    if marker is None:
        provenance = (
            "the existing corpus predates this guard, so the model that "
            "produced it is unknown (on any box upgrading through WARP-2196 "
            "it is all-MiniLM-L6-v2)"
        )
    else:
        provenance = f"the existing corpus was embedded by {marker}"

    return (
        "REFUSING TO INDEX: embedding-model mismatch. "
        f"{provenance}, but EMBEDDING_MODEL is {configured}. "
        f"{chunks} chunk(s) would be mixed across two different vector "
        "spaces. Both models emit 384 dimensions, so Postgres would accept "
        "the mixed rows silently and cosine distance between them is "
        "meaningless — search would be wrong with no error and no way to "
        "tell the rows apart afterwards. "
        "Reads are unaffected: the existing corpus still serves queries. "
        f"To fix, run {RE_EMBED_COMMAND} (deletes the corpus and the index "
        "status so it is rebuilt with the configured model), then recreate "
        "the file-indexer. To revert instead, restore EMBEDDING_MODEL to "
        f"{marker or 'the model that built the corpus'} and recreate this "
        f"service. Full procedure: {RE_EMBED_RUNBOOK}"
    )


def check_corpus_model(conn, model: Optional[str] = None) -> str:
    """Startup gate. Returns one of the ``VERDICT_*`` constants.

    * empty corpus (fresh box, or the operator script just ran) -> stamp the
      configured model and allow indexing. An appliance's first boot must
      never require an operator step, and re-stamping on an empty corpus is
      what makes the re-embed self-completing rather than leaving a "mark it
      done" step for someone to forget.
    * marker == configured -> allow.
    * anything else, including a corpus with no marker at all -> block writes.

    A corpus with chunks but no marker is the upgrade path and the single most
    important case: treating "no marker" as "probably fine" would let the
    mixed-space corpus build up silently on every existing appliance.
    """
    configured = model or EMBEDDING_MODEL
    try:
        marker = read_corpus_model(conn)
        chunks = count_chunks(conn)
    except Exception as e:
        # We could not establish that the corpus matches, so we do not get to
        # assume it does. Blocking a healthy box until the DB recovers costs
        # us indexing latency; guessing costs us the corpus.
        reason = (
            "REFUSING TO INDEX: could not verify which embedding model built "
            f"the corpus ({e}). Writes stay blocked until the check succeeds; "
            "reads are unaffected. If this persists, check the database, then "
            f"see {RE_EMBED_RUNBOOK} (recovery: {RE_EMBED_COMMAND})."
        )
        logger.error(reason)
        block_writes(reason)
        return VERDICT_BLOCKED

    if chunks == 0:
        # Nothing to be inconsistent with.
        stamp_corpus_model(conn, configured)
        clear_write_block()
        return VERDICT_STAMPED

    if marker == configured:
        clear_write_block()
        return VERDICT_MATCH

    reason = _mismatch_message(marker, configured, chunks)
    logger.error(reason)
    block_writes(reason)
    return VERDICT_BLOCKED
